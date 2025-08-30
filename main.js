// ===== IMPORTS AND CONSTANTS =====
const {
    Plugin,
    PluginSettingTab,
    Setting,
    Modal,
    Notice,
    ItemView,
    Menu,
    MarkdownView,
    requestUrl,
    EditorSuggest,
    MarkdownRenderer,
    SuggestModal,
} = require('obsidian');
const vm = require('vm');
const COPILOT_VIEW_TYPE = 'copilot-chat-view';
const GEMINI_MODELS = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];
const MAX_API_KEYS = 5;
// Helper: robust slash command parser (e.g., "/summarize rest of args")
// Returns { name, args } or null if not a slash command
function parseSlashCommand(text) {
    const m = String(text || '').trim().match(/^\/([A-Za-z0-9-]+)(?:\s+(.*))?$/);
    if (!m) return null;
    return { name: m[1], args: m[2] ?? '' };
}
class SafeJSRunner {
    constructor(options = {}) {
        this.syncTimeoutMs = options.syncTimeoutMs ?? 2000;
        this.asyncTimeoutMs = options.asyncTimeoutMs ?? 3000;
    }
    async run(code, input) {
        const logs = [];
        const sandbox = {
            console: {
                log: (...args) =>
                    logs.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '))
            },
            Math, JSON, Date, Number, String, Boolean, Array, Object, Set, Map,
            input
        };
        const context = vm.createContext(sandbox, { name: 'copilot-js-sandbox' });
        const wrapped = `(async () => { ${code} })()`;

        let resultPromise;
        try {
            const script = new vm.Script(wrapped, { filename: 'user-code.js' });
            const maybePromise = script.runInContext(context, { timeout: this.syncTimeoutMs });
            resultPromise = Promise.resolve(maybePromise);
        } catch (err) {
            return { ok: false, error: String(err.message || err), stdout: logs.join('\n') };
        }

        const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Execution timed out')), this.asyncTimeoutMs)
        );

        try {
            const result = await Promise.race([resultPromise, timeoutPromise]);
            return { ok: true, result, stdout: logs.join('\n') };
        } catch (err) {
            return { ok: false, error: String(err.message || err), stdout: logs.join('\n') };
        }
    }
}

class ToolRegistry {
    constructor(plugin) {
        this.plugin = plugin;
        this.tools = new Map();
        this.jsRunner = new SafeJSRunner({ syncTimeoutMs: 2000, asyncTimeoutMs: 3000 });
        this.registerDefaultTools();
    }

    registerTool(def) { this.tools.set(def.name, def); }
    has(name) { return this.tools.has(name); }
    async execute(name, args) {
        const def = this.tools.get(name);
        if (!def) throw new Error(`Unknown tool: ${name}`);
        return await def.handler(args ?? {}, this.plugin);
    }

    getDeclarations(names) {
        const out = [];
        for (const [n, def] of this.tools.entries()) {
            if (!names || names.includes(n)) {
                out.push({
                    name: def.name,
                    description: def.description || '',
                    parameters: def.parameters || { type: 'object', properties: {} }
                });
            }
        }
        return out;
    }

    registerDefaultTools() {
        // math_eval
        this.registerTool({
            name: 'math_eval',
            description: 'Evaluate a mathematical expression. Supports basic arithmetic (+, -, *, /, %, ^), trigonometric functions (sin, cos, tan, asin, acos, atan), constants (pi, e) and advanced functions: log(base, n), factorial(n), avg(...numbers), abs(n), round(n), ceil(n), floor(n), lcm(a, b), hcf(a, b). for complex math use or complex math,use run_js instead.',
            parameters: {
                type: 'object',
                properties: {
                    expression: { type: 'string', description: 'e.g., log(2, 8), factorial(5), avg(1,2,3), abs(-5), sin(pi/2)' }
                },
                required: ['expression']
            },
            handler: async ({ expression }) => {
                const expr = String(expression || '').trim();

                // Enhanced validation to allow function names and commas
                if (!/^[0-9+\-*/%^().\s,a-z_]+$/.test(expr)) {
                    return { ok: false, error: 'Expression contains unsupported characters' };
                }

                try {
                    const hcf = (a, b) => {
                        while (b) {
                            [a, b] = [b, a % b];
                        }
                        return a;
                    };

                    const lcm = (a, b) => (a * b) / hcf(a, b);
                    const factorial = (n) => {
                        if (n < 0) return NaN;
                        if (n === 0) return 1;
                        let res = 1;
                        for (let i = 2; i <= n; i++) res *= i;
                        return res;
                    };

                    const scope = {
                        log: (base, n) => Math.log(n) / Math.log(base),
                        factorial,
                        avg: (...args) => args.reduce((a, b) => a + b, 0) / args.length,
                        abs: Math.abs,
                        round: Math.round,
                        ceil: Math.ceil,
                        floor: Math.floor,
                        lcm,
                        hcf,
                        sin: Math.sin,
                        cos: Math.cos,
                        tan: Math.tan,
                        asin: Math.asin,
                        acos: Math.acos,
                        atan: Math.atan,
                        pi: Math.PI,
                        e: Math.E,
                    };

                    // Treat ^ as exponent
                    const exprJS = expr.replace(/\^/g, '**');

                    // Create a function with a controlled scope
                    const res = new Function(...Object.keys(scope), `return (${exprJS});`)(...Object.values(scope));

                    return { ok: true, result: res };
                } catch (e) {
                    return { ok: false, error: String(e.message || e) };
                }
            }
        });

        // run_js
        this.registerTool({
            name: 'run_js',
            description: 'Execute short JavaScript in a sandbox. The code runs inside an async function; return a value. Use the "input" variable for input.Always use return statement',
            parameters: {
                type: 'object',
                properties: {
                    code: { type: 'string', description: 'JavaScript code to execute' },
                    input: { description: 'Optional input value exposed as "input"' }
                },
                required: ['code']
            },
            handler: async ({ code, input }) => {
                if (typeof code !== 'string' || code.length > 4000) {
                    return { ok: false, error: 'Code is missing or too long' };
                }
                // Hardened disallow-list (removed stray KATEX token, added common escalation APIs)
                if (/\b(require|module|exports|process|globalThis|global|Function|AsyncFunction|GeneratorFunction|eval|import(?:\s*KATEX_INLINE_OPEN|\.meta)|child_process|worker_threads|fs|net|tls|vm|dgram|cluster)\b/.test(code)) {
                    return { ok: false, error: 'Disallowed token in code' };
                }
                return await this.jsRunner.run(code, input);
            }
        });

        // vault_list
        this.registerTool({
            name: 'vault_list',
            description: 'List markdown files in the vault, optionally filtered by a query.',
            parameters: {
                type: 'object',
                properties: { query: { type: 'string', description: 'Filter by basename/path (case-insensitive)' } }
            },
            handler: async ({ query = '' }, plugin) => {
                const files = plugin.app.vault.getMarkdownFiles();
                const q = String(query || '').toLowerCase();
                const matches = files
                    .filter(f => !q || f.basename.toLowerCase().includes(q) || f.path.toLowerCase().includes(q))
                    .map(f => ({ basename: f.basename, path: f.path }));
                return { ok: true, result: matches };
            }
        });

        // vault_read
        this.registerTool({
            name: 'vault_read',
            description: 'Read the content of a markdown file by exact basename or full path.',
            parameters: {
                type: 'object',
                properties: { nameOrPath: { type: 'string', description: 'Basename (no .md) or full path' } },
                required: ['nameOrPath']
            },
            handler: async ({ nameOrPath }, plugin) => {
                const files = plugin.app.vault.getMarkdownFiles();
                const needle = String(nameOrPath || '').toLowerCase().replace(/\.md$/i, '');
                const file = files.find(f =>
                    f.basename.toLowerCase() === needle ||
                    f.path.toLowerCase() === (needle + '.md') ||
                    f.path.toLowerCase() === String(nameOrPath).toLowerCase()
                );
                if (!file) return { ok: false, error: 'File not found' };
                try {
                    const content = await plugin.app.vault.read(file);
                    return { ok: true, result: { path: file.path, content } };
                } catch (e) {
                    return { ok: false, error: String(e.message || e) };
                }
            }
        });

        // vault_write
        this.registerTool({
            name: 'vault_write',
            description: 'Write to a markdown file by path. mode="replace" to overwrite, mode="append" to append.',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: 'Full path to .md file' },
                    content: { type: 'string', description: 'Content to write' },
                    mode: { type: 'string', enum: ['replace', 'append'], description: 'Write mode' }
                },
                required: ['path', 'content']
            },
            handler: async ({ path, content, mode = 'append' }, plugin) => {
                try {
                    const file = plugin.app.vault.getAbstractFileByPath(path);
                    if (!file) return { ok: false, error: 'File not found: ' + path };
                    if (mode === 'replace') {
                        await plugin.app.vault.modify(file, content);
                        return { ok: true, result: { path, mode: 'replace', bytes: content.length } };
                    } else {
                        await plugin.app.vault.append(file, content);
                        return { ok: true, result: { path, mode: 'append', bytes: content.length } };
                    }
                } catch (e) {
                    return { ok: false, error: String(e.message || e) };
                }
            }
        });
    }
}
// ===== MAIN PLUGIN CLASS =====
class CopilotPlugin extends Plugin {
    async onload() {
        await this.loadSettings();
        await this.initializeUsageTracking();
        this.tools = new ToolRegistry(this);
        // Register the sidebar view
        this.registerView(COPILOT_VIEW_TYPE, (leaf) => new CopilotChatView(leaf, this));

        // Add ribbon icon
        this.addRibbonIcon('bot', 'Copilot Chat', () => {
            this.activateChatView();
        });

        // Register commands
        this.registerCommands();

        // Register context menu
        this.registerEvent(
            this.app.workspace.on('editor-menu', (menu, editor, view) => {
                this.addContextMenuItems(menu, editor, view);
            })
        );

        // Register slash commands in editor
        this.registerEditorSuggest(new SlashCommandSuggestor(this.app, this));

        // Add settings tab
        this.addSettingTab(new CopilotSettingTab(this.app, this));

        this.chatHistory = [];
        this.loadHistory();
    }

    async loadSettings() {
        const savedData = await this.loadData() || {};
        const defaultSettings = {
            apiKeys: [], // Array of {id, name, key, verified}
            selectedApiKeyId: null,
            selectedModel: 'gemini-2.5-flash',
            systemPrompt: '',
            commands: [],
            directReplace: false,
            usageData: {}
        };

        this.settings = { ...defaultSettings, ...savedData };

        // Migrate old single apiKey to new format
        if (savedData.apiKey && (!Array.isArray(this.settings.apiKeys) || this.settings.apiKeys.length === 0)) {
            const id = `key-${Date.now()}`;
            this.settings.apiKeys = [{
                id,
                name: 'Default Key',
                key: savedData.apiKey,
                verified: !!savedData.apiVerified
            }];
            this.settings.selectedApiKeyId = id;
            delete this.settings.apiKey;
            delete this.settings.apiVerified;
        }

        // Normalize apiKeys
        if (!Array.isArray(this.settings.apiKeys)) this.settings.apiKeys = [];
        this.settings.apiKeys = this.settings.apiKeys.slice(0, MAX_API_KEYS).map((k, i) => ({
            id: k.id || `key-${Date.now()}-${i}`,
            name: k.name || `Key ${i + 1}`,
            key: k.key || '',
            verified: !!k.verified
        }));
        if (!this.settings.selectedApiKeyId && this.settings.apiKeys.length > 0) {
            this.settings.selectedApiKeyId = this.settings.apiKeys[0].id;
        }

        // Ensure commands is an array
        if (!Array.isArray(this.settings.commands)) {
            this.settings.commands = [];
        }

        // Normalize commands
        this.settings.commands = this.settings.commands.map(cmd => ({
            id: cmd.id || `custom-${Date.now()}`,
            name: cmd.name || 'Unnamed',
            prompt: cmd.prompt || '',
            enabled: cmd.enabled !== undefined ? cmd.enabled : true,
            directReplace: cmd.directReplace !== undefined ? cmd.directReplace : this.settings.directReplace
        }));

        await this.saveSettings();
    }
    async saveSettings() {
        await this.saveData(this.settings);
    }

    getActiveApiKeyEntry() {
        const id = this.settings?.selectedApiKeyId;
        if (!id) return null;
        return (this.settings.apiKeys || []).find(k => k.id === id) || null;
    }

    getActiveApiKey() {
        const e = this.getActiveApiKeyEntry();
        return e?.key || '';
    }

    isActiveApiKeyVerified() {
        const e = this.getActiveApiKeyEntry();
        return !!e?.verified;
    }

    async setActiveApiKey(id) {
        this.settings.selectedApiKeyId = id || null;
        await this.saveSettings();
    }

    ensureActiveApiKeyOrNotice() {
        const entry = this.getActiveApiKeyEntry();
        if (!entry || !entry.key) {
            new Notice('Please add and activate a Gemini API key in settings');
            return false;
        }
        if (!entry.verified) {
            new Notice('Please verify your active Gemini API key in settings');
            return false;
        }
        return true;
    }

    getHistoryFilePath() {
        return this.app.vault.configDir + '/plugins/copilot/history.log';
    }

    async loadHistory() {
        const path = this.getHistoryFilePath();
        if (!await this.app.vault.adapter.exists(path)) {
            this.chatHistory = [];
            return;
        }

        const content = await this.app.vault.adapter.read(path);
        const lines = content.split('\n').filter(line => line.trim() !== '');
        this.chatHistory = lines.map(line => JSON.parse(line));
    }

    async appendHistory(session) {
        const path = this.getHistoryFilePath();
        const line = JSON.stringify(session) + '\n';
        await this.app.vault.adapter.append(path, line);
        this.chatHistory.push(session);
    }

    async clearHistory() {
        const path = this.getHistoryFilePath();
        await this.app.vault.adapter.write(path, '');
        this.chatHistory = [];
    }

    // Use ISO yyyy-mm-dd keys, safe for string comparison
    todayKey() {
        return new Date().toISOString().slice(0, 10);
    }

    async initializeUsageTracking() {
        const today = this.todayKey();

        if (!this.settings.usageData) {
            this.settings.usageData = {};
        }

        // Clean up old data (keep only last 7 days)
        const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
        for (const k of Object.keys(this.settings.usageData)) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || k < cutoff) {
                delete this.settings.usageData[k];
            }
        }

        // Initialize today's data if not exists
        if (!this.settings.usageData[today]) {
            this.settings.usageData[today] = {};
        }

        // Initialize models if not exists
        GEMINI_MODELS.forEach(model => {
            if (!this.settings.usageData[today][model]) {
                this.settings.usageData[today][model] = {
                    requests: 0,
                    tokens: 0
                };
            }
        });

        await this.saveSettings();
    }

    async trackUsage(model, tokensUsed) {
        const today = this.todayKey();

        this.settings.usageData[today] = this.settings.usageData[today] || {};
        this.settings.usageData[today][model] = this.settings.usageData[today][model] || { requests: 0, tokens: 0 };

        this.settings.usageData[today][model].requests += 1;
        this.settings.usageData[today][model].tokens += tokensUsed;

        await this.saveSettings();
    }

    getUsageForModel(model) {
        const today = this.todayKey();
        return this.settings.usageData?.[today]?.[model] || { requests: 0, tokens: 0 };
    }

    registerCommands() {
        // Open chat view
        this.addCommand({
            id: 'open-copilot-chat',
            name: 'Open Copilot Chat',
            callback: () => this.activateChatView()
        });

        // Command picker
        this.addCommand({
            id: 'run-copilot-command',
            name: 'Run Copilot Command…',
            callback: () => new CommandPickerModal(this.app, this).open()
        });

        // Register custom commands
        this.settings.commands.forEach(command => {
            if (command.enabled) {
                this.addCommand({
                    id: `copilot-custom-${command.id}`,
                    name: `Copilot: ${command.name}`,
                    editorCallback: (editor, view) => {
                        this.executeCommand(command, editor, view);
                    }
                });
            }
        });
    }

    async activateChatView() {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(COPILOT_VIEW_TYPE)[0];

        if (!leaf) {
            const rightLeaf = workspace.getRightLeaf(false);
            await rightLeaf.setViewState({
                type: COPILOT_VIEW_TYPE,
                active: true
            });
            leaf = rightLeaf;
        }

        workspace.revealLeaf(leaf);
    }

    addContextMenuItems(menu, editor, view) {
        if (!editor.somethingSelected()) return;

        menu.addSeparator();
        const subMenu = menu.addItem((item) => {
            item.setTitle('Copilot Actions').setIcon('bot');
            return item.setSubmenu();
        });

        this.settings.commands.forEach(cmd => {
            if (cmd.enabled) {
                subMenu.addItem((subItem) => {
                    subItem
                        .setTitle(cmd.name)
                        .onClick(() => {
                            this.executeCommand(cmd, editor, view);
                        });
                });
            }
        });
    }

    async executeCommand(command, editor, view) {
        if (!this.plugin.ensureActiveApiKeyOrNotice()) return;

        const selection = editor.getSelection();
        if (!selection && command.prompt.includes('{}')) {
            new Notice('Please select some text first');
            return;
        }

        try {
            const prompt = await this.processPrompt(command.prompt, selection, view);
            const { text: response } = await this.callGeminiWithTools(prompt);

            // Update usage in chat view
            const chatViews = this.app.workspace.getLeavesOfType(COPILOT_VIEW_TYPE);
            if (chatViews.length > 0) {
                const chatView = chatViews[0].view;
                if (chatView && chatView.updateUsageDisplay) {
                    chatView.updateUsageDisplay();
                }
            }

            if (command.directReplace && selection) {
                editor.replaceSelection(response);
            } else {
                new OutputModal(this.app, response, editor, selection).open();
            }
        } catch (error) {
            new Notice(`Error: ${error.message}`);
        }
    }

    async processPrompt(prompt, selection, view) {
        let processed = prompt;

        // Replace {} with selection (safe replacement to avoid $ mangling)
        if (selection) {
            processed = processed.replace(/\{\}/g, () => selection);
        }

        // Replace {activeNote} with current note content
        if (processed.includes('{activeNote}')) {
            const activeFile = view?.file;
            if (activeFile) {
                const content = await this.app.vault.read(activeFile);
                processed = processed.replace(/\{activeNote\}/g, content);
            }
        }

        return processed;
    }

    // Unified Gemini request helper used by both API paths (with or without tools)
    async requestGemini(contents, toolDecls, abortSignal) {
        const apiKey = this.getActiveApiKey();
        if (!apiKey) throw new Error('No active API key set');
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.settings.selectedModel}:generateContent?key=${apiKey}`;
        const requestBody = {
            contents,
            ...(toolDecls?.length ? { tools: [{ function_declarations: toolDecls }] } : {}),
            ...(this.settings.systemPrompt ? { system_instruction: { parts: [{ text: this.settings.systemPrompt }] } } : {})
        };
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(requestBody),
                signal: abortSignal
            });
            const json = await res.json().catch(() => null);

            if (res.status === 401 || res.status === 403) {
                const active = this.getActiveApiKeyEntry();
                if (active) {
                    active.verified = false;
                    await this.saveSettings();
                }
                const msg = json?.error?.message || `API key invalid or unauthorized (status ${res.status})`;
                throw new Error(msg);
            }
            if (!res.ok) {
                const msg = json?.error?.message || `HTTP ${res.status}`;
                throw new Error(msg);
            }

            const candidate = json?.candidates?.[0];
            const parts = candidate?.content?.parts || [];
            const textAccum = parts.map(p => p.text || '').join('');

            // Track usage - rough token estimate
            const estimatedTokens = Math.ceil((JSON.stringify(requestBody).length + textAccum.length) / 4);
            await this.trackUsage(this.settings.selectedModel, estimatedTokens);

            return { candidate, parts, text: textAccum.trim() };
        } catch (error) {
            if (error.name === 'AbortError') throw new Error('Generation stopped by user');
            console.error('Gemini API error:', error);
            throw error;
        }
    }

    async callGeminiAPI(input, abortSignal) {
        const contents = Array.isArray(input)
            ? input
            : [{ role: 'user', parts: [{ text: input }] }];
        const { text } = await this.requestGemini(contents, undefined, abortSignal);
        if (text) return text;
        throw new Error('Invalid response from API');
    }

    async callGeminiWithTools(input, toolNames, abortSignal) {
        let contents = Array.isArray(input)
            ? input
            : [{ role: 'user', parts: [{ text: input }] }];

        const toolDecls = this.tools?.getDeclarations(toolNames) || [];
        const maxIters = 6;
        let toolErrors = []; // Track tool errors for potential fallback message
        let toolCalls = []; // To store tool calls

        for (let iter = 0; iter < maxIters; iter++) {
            try {
                const { parts } = await this.requestGemini(contents, toolDecls, abortSignal);

                // If the model requested a function call
                const fcPart = parts.find(p => p.functionCall);
                if (fcPart && toolDecls.length) {
                    const call = fcPart.functionCall;
                    const name = call?.name;
                    const argsRaw = call?.args ?? call?.arguments ?? {};
                    let args = argsRaw;
                    if (typeof argsRaw === 'string') {
                        try { args = JSON.parse(argsRaw); } catch { args = { value: argsRaw }; }
                    }

                    let toolResponse;
                    let toolFailed = false;

                    try {
                        if (!this.tools?.has(name)) {
                            toolResponse = { ok: false, error: `Tool not registered: ${name}` };
                            toolFailed = true;
                            toolErrors.push(`Tool "${name}" is not available`);
                        } else {
                            toolResponse = await this.tools.execute(name, args);
                            if (!toolResponse.ok) {
                                toolFailed = true;
                                toolErrors.push(`Tool "${name}" failed: ${toolResponse.error}`);
                            }
                        }
                    } catch (e) {
                        toolResponse = { ok: false, error: String(e.message || e) };
                        toolFailed = true;
                        toolErrors.push(`Tool "${name}" error: ${e.message}`);
                    }

                    toolCalls.push({ name, args, response: toolResponse });

                    if (toolFailed && iter === maxIters - 1) {
                        const fallbackPrompt = `The requested tool operation failed. Please provide a helpful response without using tools. Previous errors: ${toolErrors.join('; ')}`;
                        contents = [
                            ...contents,
                            { role: 'model', parts },
                            { role: 'user', parts: [{ text: fallbackPrompt }] }
                        ];
                        const { text: fallbackText } = await this.requestGemini(contents, undefined, abortSignal);
                        if (fallbackText) {
                            if (!fallbackText.toLowerCase().includes('tool') && !fallbackText.toLowerCase().includes('error')) {
                                return { text: `I encountered an issue with some tools, but here's what I can help you with:\n\n${fallbackText}`, toolCalls };
                            }
                            return { text: fallbackText, toolCalls };
                        }
                    }

                    // Extend conversation with model's call and our function response
                    contents = [
                        ...contents,
                        { role: 'model', parts },
                        {
                            role: 'function',
                            parts: [{ functionResponse: { name, response: toolResponse } }]
                        }
                    ];
                    continue;
                }

                // No function call → return text
                const text = parts.map(p => p.text || '').join('').trim();
                if (text) return { text, toolCalls };

                // If we have accumulated tool errors but no text response
                if (toolErrors.length > 0) {
                    return { text: `I encountered some issues with the tools (${toolErrors.join('; ')}), but I'm here to help. Could you please rephrase your request or ask me to proceed without using those specific tools?`, toolCalls };
                }

                // Fallback: return raw parts if no text
                return { text: JSON.stringify(parts), toolCalls };
            } catch (error) {
                if (error.name === 'AbortError') throw new Error('Generation stopped by user');

                if (toolErrors.length > 0) {
                    return { text: `I encountered issues with some tools and the API. Here's what went wrong: ${toolErrors.join('; ')}. Please try rephrasing your request or asking me to help without using those specific tools.`, toolCalls };
                }

                console.error('Gemini API (tools) error:', error);
                throw error;
            }
        }

        if (toolErrors.length > 0) {
            return { text: `I encountered repeated issues with tools after multiple attempts: ${toolErrors.join('; ')}. Please try a different approach or ask me to help without using those specific tools.`, toolCalls };
        }

        throw new Error('Exceeded max tool-calling iterations');
    }

    async verifyAPIKey(apiKey) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;

        try {
            const response = await requestUrl({ url, method: 'GET' });
            return response.status === 200;
        } catch (error) {
            return false;
        }
    }
}

// ===== SIMPLE CONFIRMATION MODAL =====
class ConfirmationModal extends Modal {
    constructor(app, onConfirm) {
        super(app);
        this.onConfirm = onConfirm;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Are you sure?' });
        contentEl.createEl('p', { text: 'This will clear all chat history.' });

        const buttonContainer = contentEl.createDiv({ cls: 'copilot-button-container' });

        const confirmBtn = buttonContainer.createEl('button', {
            text: 'Yes, clear history',
            cls: 'mod-cta'
        });
        confirmBtn.addEventListener('click', () => {
            this.onConfirm();
            this.close();
        });

        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());
    }
}

// ===== COMMAND PICKER MODAL =====
class CommandPickerModal extends SuggestModal {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
        this.setPlaceholder('Type to search Copilot commands…');
    }

    getSuggestions(query) {
        const q = (query || '').toLowerCase();
        return this.plugin.settings.commands
            .filter(cmd => cmd.enabled && cmd.name.toLowerCase().includes(q));
    }

    renderSuggestion(cmd, el) {
        el.addClass('copilot-command-picker-item');
        el.createDiv({ text: cmd.name, cls: 'copilot-command-picker-name' });
        el.createDiv({
            text: (cmd.prompt || '').substring(0, 100),
            cls: 'copilot-command-picker-desc'
        });
    }

    onChooseSuggestion(cmd) {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const editor = view?.editor;
        if (!editor) {
            new Notice('Open a markdown note to run a Copilot command');
            return;
        }
        this.plugin.executeCommand(cmd, editor, view);
    }
}

// ===== CHAT VIEW CLASS =====
class CopilotChatView extends ItemView {
    constructor(leaf, plugin) {
        super(leaf);
        this.plugin = plugin;

        // Chat state
        this.messages = [];
        this.currentSuggestions = [];
        this.selectedSuggestionIndex = -1;
        this.currentSessionId = Date.now().toString();
        this.promptHistory = [];
        this.promptHistoryIndex = -1;

        // /paper logging
        this.paperFile = null;      // file for logging conversation
        this.paperAiOnly = false;   // if true → log only AI replies

        // /paper doc (working markdown document for intelligent edit/chat)
        this.paperDocFile = null;   // target .md file to ask/append/replace

        this.isLoading = false;
    }

    getViewType() {
        return COPILOT_VIEW_TYPE;
    }

    getDisplayText() {
        return 'Copilot Chat';
    }

    getIcon() {
        return 'bot';
    }

    async onOpen() {
        const container = this.containerEl.children[1];
        container.empty();
        container.addClass('copilot-sidebar-container');

        // Header
        const header = container.createDiv('copilot-header');
        const headerLeft = header.createDiv('copilot-header-left');
        headerLeft.createEl('h2', { text: 'Copilot', cls: 'copilot-title' });

        const headerRight = header.createDiv('copilot-header-right');

        // History button
        const historyBtn = headerRight.createEl('button', {
            cls: 'copilot-header-button',
            attr: { 'aria-label': 'Chat history' }
        });
        historyBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/></svg>`;
        historyBtn.addEventListener('click', () => this.showHistoryMenu(historyBtn));

        // New chat button
        const newChatBtn = headerRight.createEl('button', {
            cls: 'copilot-header-button',
            attr: { 'aria-label': 'New chat' }
        });
        newChatBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>`;
        newChatBtn.addEventListener('click', async () => {
            if (this.messages.length > 0) await this.saveCurrentSession();
            this.messages = [];
            this.currentSessionId = Date.now().toString();
            this.chatContainer.empty();
            this.addWelcomeMessage();
            // Reset paper state
            this.paperFile = null;
            this.paperAiOnly = false;
            this.paperDocFile = null;
            new Notice('Started new chat');
        });

        // Chat container
        this.chatContainer = container.createDiv('copilot-chat-container');

        // Bottom section
        const bottomSection = container.createDiv('copilot-bottom-section');

        // Input with suggestions
        const inputWrapper = bottomSection.createDiv('copilot-input-wrapper');
        this.suggestionsEl = inputWrapper.createDiv('copilot-suggestions');
        this.suggestionsEl.style.display = 'none';

        const inputContainer = inputWrapper.createDiv('copilot-input-container');
        this.inputEl = inputContainer.createEl('textarea', {
            cls: 'copilot-input',
            attr: { placeholder: '/ for commands', rows: '1' }
        });

        const sendButton = inputContainer.createEl('button', {
            cls: 'copilot-send-button',
            attr: { 'aria-label': 'Send message' }
        });
        sendButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;

        // Model selector
        const modelContainer = bottomSection.createDiv('copilot-model-container');
        GEMINI_MODELS.forEach(model => {
            const modelPill = modelContainer.createDiv({
                cls: 'copilot-model-pill',
                text: model.split('-').pop()
            });
            if (model === this.plugin.settings.selectedModel) modelPill.addClass('active');

            modelPill.addEventListener('click', async () => {
                modelContainer.querySelectorAll('.copilot-model-pill').forEach(p => p.removeClass('active'));
                modelPill.addClass('active');
                this.plugin.settings.selectedModel = model;
                await this.plugin.saveSettings();
                this.updateUsageDisplay();
                new Notice(`Switched to ${model}`, 2000);
            });
        });

        // Usage display
        this.usageContainer = bottomSection.createDiv('copilot-usage-container');
        this.updateUsageDisplay();
        this.registerInterval(window.setInterval(() => this.updateUsageDisplay(), 60000));

        // Listeners
        sendButton.addEventListener('click', () => {
            if (this.isLoading) this.stopGeneration();
            else this.sendMessage();
        });

        this.inputEl.addEventListener('keydown', (e) => {
            // Suggestions navigation - only when suggestions are visible
            if (this.suggestionsEl.style.display !== 'none' && this.currentSuggestions.length > 0) {
                if (e.key === 'Tab') {
                    e.preventDefault();
                    if (this.selectedSuggestionIndex >= 0) this.selectSuggestion(this.selectedSuggestionIndex);
                    return;
                } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    this.navigateSuggestions(1);
                    return;
                } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    this.navigateSuggestions(-1);
                    return;
                } else if (e.key === 'Enter' && this.selectedSuggestionIndex >= 0) {
                    e.preventDefault();
                    this.selectSuggestion(this.selectedSuggestionIndex);
                    return;
                } else if (e.key === 'Escape') {
                    e.preventDefault();
                    this.hideSuggestions();
                    return;
                }
            }

            // Prompt history - only when cursor is at the beginning of the input
            if (e.key === 'ArrowUp' && this.inputEl.selectionStart === 0 && this.inputEl.selectionEnd === 0) {
                if (this.promptHistory.length > 0 && this.promptHistoryIndex > 0) {
                    e.preventDefault();
                    this.promptHistoryIndex--;
                    this.inputEl.value = this.promptHistory[this.promptHistoryIndex];
                    this.inputEl.selectionStart = this.inputEl.selectionEnd = this.inputEl.value.length;
                }
                return;
            } else if (e.key === 'ArrowDown' && this.inputEl.selectionStart === this.inputEl.value.length && this.inputEl.selectionEnd === this.inputEl.value.length) {
                if (this.promptHistory.length > 0) {
                    e.preventDefault();
                    if (this.promptHistoryIndex < this.promptHistory.length - 1) {
                        this.promptHistoryIndex++;
                        this.inputEl.value = this.promptHistory[this.promptHistoryIndex];
                        this.inputEl.selectionStart = this.inputEl.selectionEnd = this.inputEl.value.length;
                    } else if (this.promptHistoryIndex === this.promptHistory.length - 1) {
                        this.promptHistoryIndex++;
                        this.inputEl.value = '';
                    }
                }
                return;
            }

            // Send on Enter
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        });

        this.inputEl.addEventListener('input', () => {
            this.inputEl.style.height = 'auto';
            this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 120) + 'px';
            this.checkForSuggestions();
        });

        // Welcome
        if (this.messages.length === 0) this.addWelcomeMessage();
    }

    updateUsageDisplay() {
        if (!this.usageContainer) return;
        const usage = this.plugin.getUsageForModel(this.plugin.settings.selectedModel);
        this.usageContainer.empty();

        const rpdEl = this.usageContainer.createDiv('copilot-usage-item');
        rpdEl.createSpan({ text: 'RPD: ', cls: 'copilot-usage-label' });
        rpdEl.createSpan({ text: usage.requests.toString(), cls: 'copilot-usage-value' });

        const tokenEl = this.usageContainer.createDiv('copilot-usage-item');
        tokenEl.createSpan({ text: 'Tokens: ', cls: 'copilot-usage-label' });
        tokenEl.createSpan({ text: this.formatTokenCount(usage.tokens), cls: 'copilot-usage-value' });
    }

    formatTokenCount(tokens) {
        if (tokens < 1000) return tokens.toString();
        if (tokens < 1_000_000) return (tokens / 1000).toFixed(1) + 'K';
        return (tokens / 1_000_000).toFixed(1) + 'M';
    }

    async onClose() {
        if (this.messages.length > 0) await this.saveCurrentSession();
        this.paperFile = null;
        this.paperAiOnly = false;
        this.paperDocFile = null;
    }

    checkForSuggestions() {
        const value = this.inputEl.value;
        const cursorPos = this.inputEl.selectionStart;
        const textBeforeCursor = value.substring(0, cursorPos);

        // 1) Detect "/paper doc <partial...>" and show file suggestions
        const paperDocMatch = textBeforeCursor.match(/\/paper\s+doc\s*([^\n]*)$/i);
        if (paperDocMatch) {
            const partial = paperDocMatch[1] || '';
            this.showPaperDocSuggestions(partial);
            return;
        }

        // 2) Default slash-command suggestions (e.g., "/summarize")
        const slashMatch = textBeforeCursor.match(/\/(\w*)$/);
        if (slashMatch) {
            this.showCommandSuggestions(slashMatch[1]);
            return;
        }

        this.hideSuggestions();
    }

    showCommandSuggestions(query) {
        const q = (query || '').toLowerCase();
        const commands = this.plugin.settings.commands
            .filter(cmd => cmd.enabled && cmd.name.toLowerCase().includes(q));

        const allSuggestions = [
            ...commands.map(cmd => ({ type: 'command', value: cmd.name, data: cmd }))
        ];

        // Add /paper helper
        if ('paper'.includes(q)) {
            allSuggestions.unshift({
                type: 'command',
                value: 'paper',
                data: { name: 'paper', prompt: 'Start/Configure paper logging and doc operations' }
            });
        }

        if (allSuggestions.length === 0) {
            this.hideSuggestions();
            return;
        }

        this.currentSuggestions = allSuggestions;
        this.displaySuggestions();
    }

    showPaperDocSuggestions(partial) {
        // Clean partial to ignore accidental leading/trailing symbols
        const clean = (partial || '').trim().replace(/^[<>"']+|[<>"']+$/g, '');
        const files = this.app.vault.getMarkdownFiles();

        let matches = files;
        if (clean) {
            const q = clean.toLowerCase();
            matches = files.filter(f =>
                f.basename.toLowerCase().includes(q) ||
                f.path.toLowerCase().includes(q)
            );
        }

        matches = matches.slice(0, 20); // limit results

        if (matches.length === 0) {
            this.hideSuggestions();
            return;
        }

        this.currentSuggestions = matches.map(file => ({
            type: 'paper-doc',
            value: file.basename,
            data: file
        }));

        this.displaySuggestions();
    }
    displaySuggestions() {
        this.suggestionsEl.empty();
        this.suggestionsEl.style.display = 'block';
        this.selectedSuggestionIndex = -1;

        this.currentSuggestions.forEach((suggestion, index) => {
            const item = this.suggestionsEl.createDiv('copilot-suggestion-item');

            if (suggestion.type === 'command') {
                item.createSpan({ text: '/', cls: 'copilot-suggestion-prefix' });
                item.createSpan({ text: suggestion.value });
            } else if (suggestion.type === 'paper-doc') {
                item.createSpan({ text: '📄 ', cls: 'copilot-suggestion-prefix' });
                item.createSpan({ text: suggestion.value });
            }

            item.addEventListener('click', () => this.selectSuggestion(index));
        });

        // Select first by default
        if (this.currentSuggestions.length > 0) {
            this.selectedSuggestionIndex = 0;
            const items = this.suggestionsEl.querySelectorAll('.copilot-suggestion-item');
            if (items[0] && items[0].classList) items[0].classList.add('selected');
        }
    }

    navigateSuggestions(direction) {
        const items = this.suggestionsEl.querySelectorAll('.copilot-suggestion-item');
        if (this.selectedSuggestionIndex >= 0) {
            const prev = items[this.selectedSuggestionIndex];
            if (prev && prev.classList) prev.classList.remove('selected');
        }

        this.selectedSuggestionIndex += direction;

        if (this.selectedSuggestionIndex < 0) this.selectedSuggestionIndex = items.length - 1;
        else if (this.selectedSuggestionIndex >= items.length) this.selectedSuggestionIndex = 0;

        const curr = items[this.selectedSuggestionIndex];
        if (curr && curr.classList) curr.classList.add('selected');
    }

    selectSuggestion(index) {
        const suggestion = this.currentSuggestions[index];
        const value = this.inputEl.value;
        const cursorPos = this.inputEl.selectionStart;
        const textBeforeCursor = value.substring(0, cursorPos);
        const textAfterCursor = value.substring(cursorPos);

        if (suggestion.type === 'command') {
            const match = textBeforeCursor.match(/\/(\w*)$/);
            const replaceLength = match ? match[0].length : 0;
            const newText = '/' + suggestion.value + ' ';
            const newValue = textBeforeCursor.substring(0, cursorPos - replaceLength) + newText + textAfterCursor;
            this.inputEl.value = newValue;
            this.inputEl.selectionStart = this.inputEl.selectionEnd = cursorPos - replaceLength + newText.length;
            this.hideSuggestions();
            this.inputEl.focus();
            return;
        }

        if (suggestion.type === 'paper-doc') {
            // Replace just the <partial> part after "/paper doc "
            const m = textBeforeCursor.match(/\/paper\s+doc\s*[^\n]*$/i);
            if (m) {
                const seg = m[0]; // substring from "/paper doc ..." to cursor
                const leadMatch = seg.match(/\/paper\s+doc\s*/i);
                const lead = leadMatch ? leadMatch[0] : '/paper doc ';
                const replaceStart = cursorPos - seg.length + lead.length;

                const inserted = `"${suggestion.value}"`; // quote to keep spaces safe
                const newValue = value.slice(0, replaceStart) + inserted + textAfterCursor;

                this.inputEl.value = newValue;
                const newCursor = replaceStart + inserted.length;
                this.inputEl.selectionStart = this.inputEl.selectionEnd = newCursor;

                this.hideSuggestions();
                this.inputEl.focus();
                return;
            }
        }

        // Fallback: hide suggestions
        this.hideSuggestions();
        this.inputEl.focus();
    }

    hideSuggestions() {
        this.suggestionsEl.style.display = 'none';
        this.currentSuggestions = [];
        this.selectedSuggestionIndex = -1;
    }

    parseAIResponse(response) {
        const lines = response.split('\n');
        const firstLine = lines[0].trim().toLowerCase();

        const actionMap = {
            ':ask:': 'ask',
            ':append:': 'append',
            ':replace:': 'replace'
        };

        for (const [directive, action] of Object.entries(actionMap)) {
            if (firstLine === directive) {
                // Join remaining lines and trim
                const content = lines.slice(1).join('\n').trim();
                return {
                    action: action,
                    content: content
                };
            }
        }

        // Check if directive is on the same line as content
        for (const [directive, action] of Object.entries(actionMap)) {
            if (firstLine.startsWith(directive)) {
                // Remove the directive from the first line
                const content = response.substring(directive.length).trim();
                return {
                    action: action,
                    content: content
                };
            }
        }

        return {
            action: 'ask',
            content: response
        };
    }

    getRelevantHistory(maxTurns = 6) {
        const docSetIndex = this.messages.findLastIndex(msg =>
            msg.docBoundary === true
        );

        const relevantMessages = docSetIndex >= 0
            ? this.messages.slice(docSetIndex + 1)
            : this.messages.slice(-maxTurns);

        return relevantMessages;
    }

    // Create a new "paper" file for logging
    async createPaperFile() {
        const now = new Date();
        const fileName = `paper-${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}.md`;
        try {
            this.paperFile = await this.app.vault.create(fileName, '');
            new Notice(`Paper file created: ${fileName}`);
        } catch (error) {
            new Notice(`Error creating paper file: ${error.message}`);
        }
    }

    async createNamedMarkdownFile(name) {
        let fileName = name.trim();
        if (!fileName.toLowerCase().endsWith('.md')) fileName += '.md';

        const files = this.app.vault.getMarkdownFiles();
        const exists = (n) => files.some(f =>
            f.path.toLowerCase() === n.toLowerCase() ||
            f.basename.toLowerCase() === n.replace(/\.md$/i, '').toLowerCase()
        );

        let candidate = fileName;
        let i = 2;
        while (exists(candidate)) {
            const base = fileName.replace(/\.md$/i, '');
            candidate = `${base} ${i}.md`;
            i++;
        }

        try {
            const created = await this.app.vault.create(candidate, '');
            return created;
        } catch (err) {
            new Notice(`Error creating "${candidate}": ${err.message}`);
            return null;
        }
    }

    findMarkdownFileByQuery(query) {
        // Sanitize: remove leading/trailing < > " ' and extra spaces
        const cleaned = (query || '')
            .toString()
            .trim()
            .replace(/^[<>"']+|[<>"']+$/g, '')
            .toLowerCase();

        const tokens = cleaned.split(/\s+/).filter(Boolean);
        const files = this.app.vault.getMarkdownFiles();

        // Prefer exact basename match
        let exact = files.find(f => f.basename.toLowerCase() === cleaned);
        if (exact) return exact;

        // Otherwise, all tokens must appear in either basename or full path
        let matches = files.filter(f => {
            const base = f.basename.toLowerCase();
            const p = f.path.toLowerCase();
            return tokens.every(t => base.includes(t) || p.includes(t));
        });

        return matches[0] || null;
    }

    async sendMessage() {
        const message = this.inputEl.value.trim();
        // Quick local answer for simple arithmetic (no API needed)
        const simpleExpr = message.replace(/,/g, '').trim();
        if (/^[0-9+\-*/%^().\s]+$/.test(simpleExpr) && /[+\-*/%^]/.test(simpleExpr)) {
            try {
                // safe: only numbers/operators allowed by regex above
                // Treat ^ as exponent, not XOR
                const quickExpr = simpleExpr.replace(/\^/g, '**');
                const quickVal = new Function(`return (${quickExpr});`)();
                if (typeof quickVal === 'number' && Number.isFinite(quickVal)) {
                    // Remove welcome, add user/assistant messages, then return
                    this.chatContainer.querySelector('.copilot-welcome')?.remove();
                    this.addMessage('user', message);
                    this.inputEl.value = '';
                    this.inputEl.style.height = 'auto';
                    this.addMessage('assistant', String(quickVal));
                    await this.saveCurrentSession();
                    return;
                }
            } catch (_) { }
        }
        if (!message) return;

        // /paper command handler (logging + doc ops setup)
        if (message.startsWith('/paper')) {
            const raw = message.slice(6).trim(); // cut "/paper"
            const m = raw.match(/^([a-z-]+)\s*(.*)$/i) || [];
            const sub = (m[1] || '').toLowerCase();
            const restRaw = (m[2] || '').trim();
            const stripQuotes = (s) => {
                s = (s ?? '').trim();
                if (!s) return s;
                const first = s[0], last = s[s.length - 1];
                if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
                    return s.slice(1, -1);
                }
                return s;
            };

            if (sub === 'off') {
                this.paperFile = null;
                this.paperAiOnly = false;
                new Notice('Paper logging disabled');
            } else if (sub === 'new') {
                await this.createPaperFile();
                if (!this.paperFile) return;
                this.paperAiOnly = false;
                new Notice('Paper logging enabled (user + AI)');
            } else if (sub === 'ai') {
                if (!this.paperFile) await this.createPaperFile();
                this.paperAiOnly = true;
                new Notice('Paper logging: AI replies only');
            } else if (sub === 'both') {
                if (!this.paperFile) await this.createPaperFile();
                this.paperAiOnly = false;
                new Notice('Paper logging: user + AI');
            } else if (sub === 'doc') {
                const arg = restRaw.toLowerCase();
                if (!restRaw || arg === 'off') {
                    this.paperDocFile = null;
                    new Notice('Cleared working document');
                    this.messages.push({
                        type: 'system',
                        content: 'Working document cleared',
                        timestamp: Date.now(),
                        docBoundary: true
                    });
                } else {
                    const name = stripQuotes(restRaw);
                    const file = this.findMarkdownFileByQuery(name);
                    if (file) {
                        this.paperDocFile = file;
                        new Notice(`Working doc set: "${file.basename}.md"`);
                        this.messages.push({
                            type: 'system',
                            content: `Working doc set: "${file.basename}.md"`,
                            timestamp: Date.now(),
                            docBoundary: true
                        });
                    } else {
                        new Notice(`No markdown file found matching: ${name}`);
                    }
                }
            } else if (sub === 'create') {
                // /paper create "name"
                const name = stripQuotes(restRaw);
                if (!name) {
                    new Notice('Usage: /paper create "Note name"');
                } else {
                    const file = await this.createNamedMarkdownFile(name);
                    if (file) {
                        this.paperDocFile = file;
                        new Notice(`Created and set working doc: "${file.basename}.md"`);
                    }
                }
            } else {
                // Default: enable logging if off, or show status
                if (!this.paperFile) {
                    await this.createPaperFile();
                    if (!this.paperFile) return;
                    this.paperAiOnly = false;
                    new Notice('Paper logging enabled (user + AI)');
                } else {
                    new Notice(`Paper logging is ON → Mode: ${this.paperAiOnly ? 'AI-only' : 'user + AI'}
Working doc: ${this.paperDocFile ? `"${this.paperDocFile.basename}.md"` : 'none'}
Try: /paper doc <name>, /paper doc off, /paper create "name"`);
                }
            }

            this.inputEl.value = '';
            this.inputEl.style.height = 'auto';
            return;
        }

        this.promptHistory.push(message);
        this.promptHistoryIndex = this.promptHistory.length;

        if (!this.ensureActiveApiKeyOrNotice()) return;

        // Remove welcome message if exists
        this.chatContainer.querySelector('.copilot-welcome')?.remove();

        // Add user message to chat
        this.addMessage('user', message);
        this.inputEl.value = '';
        this.inputEl.style.height = 'auto';

        // Show loading spinner message
        const loadingEl = this.addMessage('assistant', '', true);

        // Create abort controller for this request
        this.abortController = new AbortController();
        this.updateSendButton(true);

        const slash = parseSlashCommand(message);

        // If a working doc is set, handle intelligent doc actions (unless it's a slash command)
        if (this.paperDocFile && !slash) {
            try {
                await this.processDocAction(message, loadingEl);
                // Update usage display and autosave
                this.updateUsageDisplay();
                await this.saveCurrentSession();
            } catch (error) {
                loadingEl.remove();
                if (error.message !== 'Generation stopped by user') {
                    this.addMessage('assistant', `Error: ${error.message}`);
                }
            } finally {
                this.updateSendButton(false);
            }
            return;
        }

        try {
            let prompt = message;

            // Handle other slash commands (custom commands)
            if (slash) {
                const commandName = slash.name;
                const command = this.plugin.settings.commands.find(c =>
                    c.name.toLowerCase() === commandName.toLowerCase()
                );

                if (command) {
                    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
                    const selection = activeView ? activeView.editor.getSelection() : '';
                    const commandArgs = (slash.args || '').trim();
                    const textToProcess = commandArgs || selection;

                    if (!textToProcess && command.prompt.includes('{}')) {
                        new Notice(`Please select text or provide arguments for the ${command.name} command.`);
                        loadingEl.remove();
                        this.updateSendButton(false);
                        return;
                    }

                    prompt = await this.plugin.processPrompt(command.prompt, textToProcess, activeView);

                    // One-shot command: no multi-turn history for /commands
                    const { text: response, toolCalls } = await this.plugin.callGeminiWithTools(prompt, undefined, this.abortController.signal);
                    loadingEl.remove();
                    this.addMessage('assistant', response, false, true, toolCalls);
                    this.updateUsageDisplay();
                    await this.saveCurrentSession();
                    return;
                }
            }

            // Build multi-turn chat contents from recent history.
            // Replace the most recent user message with the processed `prompt`.
            const history = this.messages.slice();
            if (history.length && history[history.length - 1].type === 'user') {
                history[history.length - 1] = {
                    ...history[history.length - 1],
                    content: prompt
                };
            }

            // Limit to the last N messages to keep requests small
            const maxMessages = 12; // ~6 turns
            const recent = history.slice(-maxMessages);

            const contents = recent.map(m => ({
                role: m.type === 'user' ? 'user' : 'model',
                parts: [{ text: m.content }]
            }));

            const { text: response, toolCalls } = await this.plugin.callGeminiWithTools(contents, undefined, this.abortController.signal);
            // Remove loading and add response
            loadingEl.remove();
            this.addMessage('assistant', response, false, true, toolCalls);

            // Update usage display after API call
            this.updateUsageDisplay();

            // Auto-save session after each exchange
            await this.saveCurrentSession();

        } catch (error) {
            loadingEl.remove();
            if (error.message !== 'Generation stopped by user') {
                this.addMessage('assistant', `Error: ${error.message}`);
            }
        } finally {
            this.updateSendButton(false);
        }
    }

    buildDocPrompt(currentContent, userMessage, conversationHistory = []) {
        let historyContext = '';
        if (conversationHistory.length > 0) {
            historyContext = '\nPrevious conversation:\n';
            conversationHistory.forEach(msg => {
                if (msg.type === 'user') {
                    historyContext += `User: ${msg.content}\n`;
                } else if (msg.type === 'assistant') {
                    const cleaned = msg.content.replace(/^:[a-z]+:\s*\n/i, '');
                    historyContext += `Assistant: ${cleaned}\n`;
                }
            });
            historyContext += '\n---\n';
        }

        return `You are an expert editor working as an assistant.
IMPORTANT: Start your response with ONE of these directives on its own line:
:ask: - If the user is asking a question about the document
:append: - If the user wants to add content to the end
:replace: - If the user wants to modify/rewrite the document

After the directive, provide your response.

${historyContext}
Current document (Markdown):
---
${currentContent}
---

User message: ${userMessage}

Consider the conversation history when determining your action and response.`;
    }

    sanitizeModelOutput(text) {
        if (!text) return '';
        let out = text.trim();
        if (out.startsWith('```')) {
            const firstNL = out.indexOf('\n');
            if (firstNL !== -1) {
                out = out.slice(firstNL + 1);
                if (out.endsWith('```')) {
                    out = out.slice(0, -3).trim();
                }
            }
        }
        return out;
    }

    async processDocAction(message, loadingEl) {
        const fileContent = await this.app.vault.read(this.paperDocFile);
        const history = this.getRelevantHistory();
        const prompt = this.buildDocPrompt(fileContent, message, history);
        const { text: rawResponse } = await this.plugin.callGeminiWithTools(prompt, undefined, this.abortController.signal);
        const { action, content } = this.parseAIResponse(rawResponse);

        loadingEl.remove();
        this.addMessage('assistant', content);

        if (action === 'ask') return;

        const clean = this.sanitizeModelOutput(content);
        try {
            if (action === 'replace') {
                await this.app.vault.modify(this.paperDocFile, clean);
                new Notice(`Replaced content of "${this.paperDocFile.basename}.md"`);
            } else if (action === 'append') {
                await this.app.vault.append(this.paperDocFile, '\n\n' + clean + '\n');
                new Notice(`Appended to "${this.paperDocFile.basename}.md"`);
            }
        } catch (e) {
            new Notice(`Failed to update file: ${e.message}`);
        }
    }

    updateSendButton(isLoading) {
        this.isLoading = isLoading;
        const sendButton = this.containerEl.querySelector('.copilot-send-button');

        if (isLoading) {
            sendButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12"/></svg>`;
            sendButton.setAttribute('aria-label', 'Stop generation');
            sendButton.classList.add('is-loading');
        } else {
            sendButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;
            sendButton.setAttribute('aria-label', 'Send message');
            sendButton.classList.remove('is-loading');
        }
    }

    stopGeneration() {
        this.abortController?.abort();
        this.updateSendButton(false);
        new Notice('Generation stopped');
    }

    addMessage(type, content, isLoading = false, saveToMessages = true, toolCalls = []) {
        const messageEl = this.chatContainer.createDiv(`copilot-message ${type}`);

        if (saveToMessages && !isLoading) {
            this.messages.push({
                type: type,
                content: content,
                timestamp: Date.now(),
                toolCalls: toolCalls
            });
        }

        if (isLoading) {
            messageEl.innerHTML = `
            <div class="copilot-loading">
                <div class="copilot-loading-dot"></div>
                <div class="copilot-loading-dot"></div>
                <div class="copilot-loading-dot"></div>
            </div>
        `;
            return messageEl;
        }

        const jsToolCalls = toolCalls.filter(tc => tc.name === 'run_js');
        if (jsToolCalls.length > 0) {
            const details = messageEl.createEl('details');
            const summary = details.createEl('summary');
            summary.setText('Show Code');
            details.addEventListener('toggle', () => {
                summary.setText(details.open ? 'Hide Code' : 'Show Code');
            });

            // Create a container for the code content
            const codeContainer = details.createDiv();
            codeContainer.style.position = 'relative';

            // Format the code content as a markdown code block
            const codeContent = jsToolCalls.map(tc => `\`\`\`javascript
// Tool: ${tc.name}
${tc.args.code}
\`\`\``).join('\n\n');

            // Use Obsidian's MarkdownRenderer to properly render the code block with syntax highlighting
            MarkdownRenderer.render(this.app, codeContent, codeContainer, '', this);

            // Add a copy button for the code content
            const copyButton = codeContainer.createEl('button', {
                cls: 'copilot-copy-button',
                text: 'Copy'
            });
            copyButton.addEventListener('click', () => {
                const codeText = jsToolCalls.map(tc => `// Tool: ${tc.name}\n${tc.args.code}`).join('\n\n');
                navigator.clipboard.writeText(codeText);
                new Notice('Copied to clipboard');

                // Visual feedback
                const originalText = copyButton.textContent;
                copyButton.setText('Copied!');
                setTimeout(() => {
                    copyButton.setText(originalText);
                }, 2000);
            });
        }

        const messageContentEl = messageEl.createDiv({ cls: 'copilot-message-content' });

        if (type === 'assistant') {
            const modelName = this.plugin.settings.selectedModel.split('-').pop();
            const modelEl = messageEl.createDiv({ cls: 'copilot-message-model', text: modelName });
            modelEl.addEventListener('click', () => {
                navigator.clipboard.writeText(content);
                new Notice('Copied to clipboard');
            });
        }

        if (type === 'assistant') {
            MarkdownRenderer.render(this.app, content, messageContentEl, '', this);
        } else if (type === 'system') {
            messageContentEl.setText(content);
            messageEl.addClass('system-message');
        } else {
            messageContentEl.setText(content);
        }

        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        messageEl.createDiv({ cls: 'copilot-message-time', text: time });

        // Scroll to bottom
        this.chatContainer.scrollTop = this.chatContainer.scrollHeight;

        // Paper logging
        if (this.paperFile) {
            if (this.paperAiOnly) {
                if (type === 'assistant') {
                    const formatted = `${content}\n\n---\n\n`;
                    this.app.vault.append(this.paperFile, formatted);
                }
            } else {
                const formatted = `**${type === 'user' ? 'User' : 'Copilot'}**: ${content}\n\n`;
                this.app.vault.append(this.paperFile, formatted);
            }
        }

        return messageEl;
    }

    addWelcomeMessage() {
        const welcomeEl = this.chatContainer.createDiv('copilot-welcome');
        welcomeEl.innerHTML = `
            <div class="copilot-welcome-icon">🤖</div>
            <div class="copilot-welcome-title">Welcome to Copilot</div>
            <div class="copilot-welcome-subtitle">Start a conversation or use / for commands</div>
        `;
    }

    async saveCurrentSession() {
        if (this.messages.length === 0) return;

        const session = {
            id: this.currentSessionId,
            timestamp: Date.now(),
            messages: [...this.messages],
            title: this.generateSessionTitle()
        };

        const existingIndex = this.plugin.chatHistory.findIndex(s => s.id === this.currentSessionId);

        if (existingIndex !== -1) {
            this.plugin.chatHistory[existingIndex] = session;
            const path = this.plugin.getHistoryFilePath();
            const lines = this.plugin.chatHistory.map(s => JSON.stringify(s)).join('\n') + '\n';
            await this.app.vault.adapter.write(path, lines);
        } else {
            await this.plugin.appendHistory(session);
        }
    }

    generateSessionTitle() {
        const firstUserMsg = this.messages.find(m => m.type === 'user');
        return firstUserMsg
            ? firstUserMsg.content.substring(0, 50) + (firstUserMsg.content.length > 50 ? '...' : '')
            : 'New Chat';
    }

    async loadSession(sessionId) {
        const session = this.plugin.chatHistory.find(s => s.id === sessionId);
        if (!session) return;

        this.messages = [...session.messages];
        this.currentSessionId = sessionId;
        this.renderAllMessages();
    }

    renderAllMessages() {
        this.chatContainer.empty();
        for (const msg of this.messages) {
            this.addMessage(msg.type, msg.content, false, false, msg.toolCalls ?? []);
        }
    }

    showHistoryMenu(button) {
        const menu = new Menu();
        menu.dom.addClass('copilot-history-menu');

        if (this.plugin.chatHistory.length === 0) {
            menu.addItem((item) => {
                item.setTitle('No chat history').setDisabled(true);
            });
        } else {
            this.plugin.chatHistory.forEach((session) => {
                const date = new Date(session.timestamp);
                const timeStr = date.toLocaleString([], {
                    month: 'short',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit'
                });

                menu.addItem((item) => {
                    const itemDom = item.dom;
                    itemDom.addClass('copilot-history-item');

                    itemDom.empty();
                    const titleEl = itemDom.createDiv('copilot-history-title');
                    titleEl.setText(session.title);

                    const metaEl = itemDom.createDiv('copilot-history-meta');
                    metaEl.setText(`${timeStr} • ${session.messages.length} messages`);

                    item.onClick(async () => {
                        if (this.messages.length > 0 && this.currentSessionId !== session.id) {
                            await this.saveCurrentSession();
                        }
                        await this.loadSession(session.id);
                    });
                });
            });

            menu.addSeparator();

            menu.addItem((item) => {
                item.setTitle('Clear all history')
                    .setIcon('trash')
                    .onClick(() => {
                        new ConfirmationModal(this.app, async () => {
                            await this.plugin.clearHistory();
                            new Notice('Chat history cleared');
                        }).open();
                    });
            });
        }

        const rect = button.getBoundingClientRect();
        menu.showAtPosition({ x: rect.left, y: rect.bottom });
    }
}

// ===== SLASH COMMAND SUGGESTOR (EDITOR) =====
class SlashCommandSuggestor extends EditorSuggest {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
    }

    onTrigger(cursor, editor, file) {
        const line = editor.getLine(cursor.line);
        const before = line.slice(0, cursor.ch);

        // Only trigger after start of line or whitespace, then '/'
        const match = before.match(/(^|\s)\/([A-Za-z0-9-]*)$/);
        if (!match) return null;

        const startCh = cursor.ch - (match[2]?.length || 0) - 1; // include '/'
        return {
            start: { line: cursor.line, ch: startCh },
            end: cursor,
            query: match[2] || ''
        };
    }

    getSuggestions(context) {
        const q = (context.query || '').toLowerCase();
        return this.plugin.settings.commands
            .filter(cmd => cmd.enabled && cmd.name.toLowerCase().includes(q))
            .map(cmd => ({ command: cmd }));
    }

    renderSuggestion(suggestion, el) {
        const { command } = suggestion;
        el.addClass('copilot-slash-item');
        el.createDiv({ text: command.name, cls: 'copilot-slash-item-name' });
        el.createDiv({
            text: (command.prompt || '').substring(0, 80),
            cls: 'copilot-slash-item-description'
        });
    }

    selectSuggestion(suggestion, evt) {
        const { command } = suggestion;
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        const editor = view?.editor;

        if (!editor) return;

        // Clear the slash command from editor
        const cursor = editor.getCursor();
        const line = editor.getLine(cursor.line);
        const match = line.match(/(^|\s)(\/[A-Za-z0-9-]*)$/);

        if (match) {
            const start = cursor.ch - match[2].length;
            editor.replaceRange('', { line: cursor.line, ch: start }, cursor);
        }

        // Execute the command
        this.plugin.executeCommand(command, editor, view);
    }
}

// ===== OUTPUT MODAL =====
class OutputModal extends Modal {
    constructor(app, content, editor, selection) {
        super(app);
        this.content = content;
        this.editor = editor;
        this.selection = selection;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', { text: 'AI Output' });

        const outputContainer = contentEl.createDiv({ cls: 'copilot-output-container' });
        outputContainer.createEl('pre', { text: this.content });

        const buttonContainer = contentEl.createDiv({ cls: 'copilot-button-container' });

        // Replace button
        if (this.selection) {
            const replaceBtn = buttonContainer.createEl('button', { text: 'Replace Selection' });
            replaceBtn.addEventListener('click', () => {
                this.editor.replaceSelection(this.content);
                this.close();
            });
        }

        // Append button
        const appendBtn = buttonContainer.createEl('button', { text: 'Append to Note' });
        appendBtn.addEventListener('click', () => {
            const cursor = this.editor.getCursor();
            this.editor.replaceRange('\n\n' + this.content, cursor);
            this.close();
        });

        // Copy button
        const copyBtn = buttonContainer.createEl('button', { text: 'Copy to Clipboard' });
        copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(this.content);
            new Notice('Copied to clipboard');
            this.close();
        });

        // Cancel button
        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());
    }
}

// ===== SETTINGS TAB =====
class CopilotSettingTab extends PluginSettingTab {
    constructor(app, plugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.addClass('copilot-settings-container');

        containerEl.createEl('h2', { text: 'Copilot Settings' });

        // API Keys (multi)
        containerEl.createEl('h3', { text: 'API Keys' });

        const header = new Setting(containerEl)
            .setName('Manage up to 5 API keys')
            .setDesc('Add multiple Gemini API keys and activate exactly one to use');

        header.addButton(btn => {
            btn.setButtonText('Add API Key');
            btn.onClick(async () => {
                if ((this.plugin.settings.apiKeys || []).length >= MAX_API_KEYS) {
                    new Notice(`You can add up to ${MAX_API_KEYS} API keys`);
                    return;
                }
                const idx = this.plugin.settings.apiKeys.length;
                const newKey = {
                    id: `key-${Date.now()}-${idx}`,
                    name: `Key ${idx + 1}`,
                    key: '',
                    verified: false
                };
                this.plugin.settings.apiKeys.push(newKey);
                if (!this.plugin.settings.selectedApiKeyId) {
                    this.plugin.settings.selectedApiKeyId = newKey.id;
                }
                await this.plugin.saveSettings();
                this.display();
            });
        });

        const keysListEl = containerEl.createDiv('copilot-keys-list');

        const renderKeysList = () => {
            keysListEl.empty();
            const keys = this.plugin.settings.apiKeys || [];
            keys.forEach((k, idx) => {
                const isActive = this.plugin.settings.selectedApiKeyId === k.id;

                const row = new Setting(keysListEl)
                    .setName(k.name || `Key ${idx + 1}`)
                    .setDesc(`${isActive ? 'Active • ' : ''}${k.verified ? 'Verified' : 'Not verified'}`);

                // Make the setting name editable on double click
                const nameEl = row.settingEl.querySelector('.setting-item-name');
                if (nameEl) {
                    nameEl.style.cursor = 'pointer';
                    nameEl.style.userSelect = 'none';
                    nameEl.title = 'Double-click to edit name';
                    
                    nameEl.addEventListener('dblclick', () => {
                        const currentName = k.name || `Key ${idx + 1}`;
                        const input = document.createElement('input');
                        input.type = 'text';
                        input.value = currentName;
                        input.classList.add('copilot-inline-edit-input');
                        
                        // Add styles for the inline input
                        input.style.background = 'var(--background-modifier-form-field)';
                        input.style.border = '1px solid var(--interactive-accent)';
                        input.style.borderRadius = '4px';
                        input.style.padding = '2px 6px';
                        input.style.fontSize = '14px';
                        input.style.fontFamily = 'inherit';
                        input.style.color = 'var(--text-normal)';
                        input.style.width = '180px';
                        
                        // Replace the name element with the input
                        nameEl.replaceWith(input);
                        input.focus();
                        
                        // Save on Enter or blur
                        const saveName = async () => {
                            const newName = input.value.trim() || `Key ${idx + 1}`;
                            k.name = newName;
                            await this.plugin.saveSettings();
                            
                            // Restore the name element
                            const newNameEl = document.createElement('div');
                            newNameEl.classList.add('setting-item-name');
                            newNameEl.textContent = newName;
                            newNameEl.style.cursor = 'pointer';
                            newNameEl.style.userSelect = 'none';
                            newNameEl.title = 'Double-click to edit name';
                            input.replaceWith(newNameEl);
                            
                            // Reattach event listener
                            newNameEl.addEventListener('dblclick', () => {
                                renderKeysList(); // Re-render to enable editing again
                            });
                        };
                        
                        input.addEventListener('keydown', async (e) => {
                            if (e.key === 'Enter') {
                                await saveName();
                            } else if (e.key === 'Escape') {
                                // Restore without saving
                                const newNameEl = document.createElement('div');
                                newNameEl.classList.add('setting-item-name');
                                newNameEl.textContent = k.name || `Key ${idx + 1}`;
                                newNameEl.style.cursor = 'pointer';
                                newNameEl.style.userSelect = 'none';
                                newNameEl.title = 'Double-click to edit name';
                                input.replaceWith(newNameEl);
                                
                                // Reattach event listener
                                newNameEl.addEventListener('dblclick', () => {
                                    renderKeysList(); // Re-render to enable editing again
                                });
                            }
                        });
                        
                        input.addEventListener('blur', saveName);
                    });
                }

                // Key (not hidden)
                row.addText(t => {
                    t.setPlaceholder('API key');
                    t.setValue(k.key || '');
                    t.onChange(async (v) => {
                        k.key = v;
                        k.verified = false; // reset verification if changed
                        await this.plugin.saveSettings();
                        row.setDesc(`${isActive ? 'Active • ' : ''}${k.verified ? 'Verified' : 'Not verified'}`);
                    });
                    t.inputEl.type = 'text'; // visible characters
                    t.inputEl.classList.add('copilot-api-key-input');
                });

                // Compact API actions container
                const actionsContainer = row.controlEl.createDiv('copilot-api-actions');
                actionsContainer.style.display = 'flex';
                actionsContainer.style.gap = '6px';
                actionsContainer.style.alignItems = 'center';

                // Verify button
                const verifyBtn = actionsContainer.createEl('button', { text: 'Verify' });
                verifyBtn.classList.add('mod-muted');
                verifyBtn.style.padding = '4px 8px';
                verifyBtn.style.fontSize = '12px';
                verifyBtn.addEventListener('click', async () => {
                    const status = actionsContainer.querySelector('.copilot-api-status') || actionsContainer.createDiv({ cls: 'copilot-api-status' });
                    status.style.marginLeft = '8px';
                    status.style.fontSize = '12px';
                    status.setText('Verifying...');

                    const ok = await this.plugin.verifyAPIKey(k.key);
                    k.verified = ok;
                    await this.plugin.saveSettings();

                    status.setText(ok ? '✓ Verified' : '✗ Invalid');
                    status.classList.toggle('success', ok);
                    status.classList.toggle('error', !ok);
                    row.setDesc(`${isActive ? 'Active • ' : ''}${k.verified ? 'Verified' : 'Not verified'}`);
                });

                // Activate button
                const activateBtn = actionsContainer.createEl('button', { text: isActive ? 'Active' : 'Set Active' });
                if (isActive) activateBtn.classList.add('mod-cta');
                activateBtn.style.padding = '4px 8px';
                activateBtn.style.fontSize = '12px';
                activateBtn.addEventListener('click', async () => {
                    await this.plugin.setActiveApiKey(k.id);
                    renderKeysList();
                });

                // Delete button
                const deleteBtn = actionsContainer.createEl('button', { text: '✕' });
                deleteBtn.classList.add('mod-warning');
                deleteBtn.style.padding = '4px 8px';
                deleteBtn.style.fontSize = '12px';
                deleteBtn.title = 'Delete';
                deleteBtn.addEventListener('click', async () => {
                    const wasActive = this.plugin.settings.selectedApiKeyId === k.id;
                    this.plugin.settings.apiKeys.splice(idx, 1);
                    if (wasActive) {
                        this.plugin.settings.selectedApiKeyId = this.plugin.settings.apiKeys[0]?.id || null;
                    }
                    await this.plugin.saveSettings();
                    renderKeysList();
                });
            });
        };

        renderKeysList();

        // Model selection
        new Setting(containerEl)
            .setName('Default Model')
            .setDesc('Select the default Gemini model to use')
            .addDropdown(dropdown => {
                GEMINI_MODELS.forEach(model => dropdown.addOption(model, model));
                dropdown
                    .setValue(this.plugin.settings.selectedModel)
                    .onChange(async (value) => {
                        this.plugin.settings.selectedModel = value;
                        await this.plugin.saveSettings();
                    });
            });

        // System Prompt
        new Setting(containerEl)
            .setName('System Prompt')
            .setDesc('Guides the AI’s behavior for all interactions')
            .addTextArea(text => {
                text
                    .setPlaceholder('e.g., You are a helpful assistant that provides concise answers.')
                    .setValue(this.plugin.settings.systemPrompt)
                    .onChange(async (value) => {
                        this.plugin.settings.systemPrompt = value;
                        await this.plugin.saveSettings();
                    });
                text.inputEl.rows = 4;
                text.inputEl.style.width = '100%';
            });

        // Commands
        containerEl.createEl('h3', { text: 'Custom Commands' });

        const commandsContainer = containerEl.createDiv('copilot-commands-list');

        // Add / Import / Export
        new Setting(containerEl)
            .addButton(button => {
                button
                    .setButtonText('Add New Command')
                    .onClick(() => {
                        new CommandEditModal(this.app, this.plugin, null, () => this.display()).open();
                    });
            })
            .addButton(button => {
                button
                    .setButtonText('Export Commands')
                    .onClick(() => {
                        const commands = this.plugin.settings.commands;
                        const json = JSON.stringify(commands, null, 2);
                        const blob = new Blob([json], { type: 'application/json' });
                        const url = URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = 'copilot-commands.json';
                        a.click();
                        URL.revokeObjectURL(url);
                        new Notice('Commands exported successfully');
                    });
            })
            .addButton(button => {
                button
                    .setButtonText('Import Commands')
                    .onClick(() => {
                        const input = document.createElement('input');
                        input.type = 'file';
                        input.accept = '.json';
                        input.onchange = async (e) => {
                            const file = e.target.files[0];
                            if (!file) return;

                            const reader = new FileReader();
                            reader.onload = async (e) => {
                                try {
                                    const importedCommands = JSON.parse(e.target.result);
                                    if (!Array.isArray(importedCommands)) {
                                        new Notice('Invalid file format');
                                        return;
                                    }

                                    const existingNames = new Set(this.plugin.settings.commands.map(c => c.name));
                                    let addedCount = 0;
                                    for (const cmd of importedCommands) {
                                        if (cmd.name && cmd.prompt && !existingNames.has(cmd.name)) {
                                            this.plugin.settings.commands.push({
                                                id: `custom-${Date.now()}-${addedCount}`,
                                                name: cmd.name,
                                                prompt: cmd.prompt,
                                                enabled: cmd.enabled !== undefined ? cmd.enabled : true,
                                                directReplace: cmd.directReplace !== undefined ? cmd.directReplace : false
                                            });
                                            addedCount++;
                                        }
                                    }

                                    await this.plugin.saveSettings();
                                    this.display();
                                    new Notice(`${addedCount} commands imported successfully`);

                                } catch (error) {
                                    new Notice('Error reading or parsing file');
                                }
                            };
                            reader.readAsText(file);
                        };
                        input.click();
                    });
            });

        // List existing commands
        this.plugin.settings.commands.forEach((command, index) => {
            const commandEl = commandsContainer.createDiv('copilot-command-item');

            const header = commandEl.createDiv('copilot-command-header');
            header.createSpan({ text: command.name, cls: 'copilot-command-name' });

            const actions = header.createDiv('copilot-command-actions');

            // Toggle enabled
            const toggleBtn = actions.createEl('button', {
                text: command.enabled ? 'Enabled' : 'Disabled',
                cls: 'copilot-command-button'
            });
            toggleBtn.addEventListener('click', async () => {
                command.enabled = !command.enabled;
                await this.plugin.saveSettings();
                this.display();
            });

            // Direct Replace toggle
            const directReplaceBtn = actions.createEl('button', {
                text: command.directReplace ? 'Direct Replace' : 'Show Output',
                cls: 'copilot-command-button'
            });
            directReplaceBtn.addEventListener('click', async () => {
                command.directReplace = !command.directReplace;
                await this.plugin.saveSettings();
                this.display();
            });

            // Edit
            const editBtn = actions.createEl('button', {
                text: 'Edit',
                cls: 'copilot-command-button'
            });
            editBtn.addEventListener('click', () => {
                new CommandEditModal(this.app, this.plugin, command, () => {
                    this.display();
                }).open();
            });

            // Delete
            const deleteBtn = actions.createEl('button', {
                text: 'Delete',
                cls: 'copilot-command-button'
            });
            deleteBtn.addEventListener('click', async () => {
                this.plugin.settings.commands.splice(index, 1);
                await this.plugin.saveSettings();
                this.display();
            });

            // Prompt preview
            commandEl.createDiv({
                text: command.prompt,
                cls: 'copilot-command-prompt'
            });
        });
    }

}

// ===== COMMAND EDIT MODAL =====
class CommandEditModal extends Modal {
    constructor(app, plugin, command, onSave) {
        super(app);
        this.plugin = plugin;
        this.command = command;
        this.onSave = onSave;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();

        contentEl.createEl('h2', {
            text: this.command ? 'Edit Command' : 'New Command'
        });

        const form = contentEl.createDiv();

        // Name input
        new Setting(form)
            .setName('Command Name')
            .addText(text => {
                this.nameInput = text;
                text
                    .setPlaceholder('e.g., Summarize Text')
                    .setValue(this.command?.name || '');
            });

        // Prompt input
        new Setting(form)
            .setName('Prompt Template')
            .setDesc('Use {} for selected text, {activeNote} for current note')
            .addTextArea(text => {
                this.promptInput = text;
                text
                    .setPlaceholder('Enter your prompt template...')
                    .setValue(this.command?.prompt || '');
                text.inputEl.rows = 5;
                text.inputEl.style.width = '100%';
            });

        // Buttons
        const buttonContainer = contentEl.createDiv('copilot-button-container');

        const saveBtn = buttonContainer.createEl('button', {
            text: 'Save',
            cls: 'mod-cta'
        });

        saveBtn.addEventListener('click', async () => {
            const name = this.nameInput.getValue().trim();
            const prompt = this.promptInput.getValue().trim();

            if (!name || !prompt) {
                new Notice('Please fill in all fields');
                return;
            }

            if (this.command) {
                this.command.name = name;
                this.command.prompt = prompt;
            } else {
                const newCommand = {
                    id: `custom-${Date.now()}`,
                    name: name,
                    prompt: prompt,
                    enabled: true,
                    directReplace: false
                };
                this.plugin.settings.commands.push(newCommand);
            }

            await this.plugin.saveSettings();
            this.close();
            this.onSave();
        });

        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());
    }
}

// ===== EXPORT PLUGIN =====
module.exports = CopilotPlugin;