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
    SuggestModal
} = require('obsidian');

const COPILOT_VIEW_TYPE = 'copilot-chat-view';
const GEMINI_MODELS = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];

// ===== MAIN PLUGIN CLASS =====
class CopilotPlugin extends Plugin {
    async onload() {
        await this.loadSettings();
        await this.initializeUsageTracking();

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

        if (!this.settings.chatHistory) {
            this.settings.chatHistory = [];
        }
    }

    async loadSettings() {
        const savedData = await this.loadData() || {};
        const defaultSettings = {
            apiKey: '',
            selectedModel: 'gemini-2.5-flash',
            systemPrompt: '',
            commands: [],
            directReplace: false,
            apiVerified: false,
            chatHistory: [],
            usageData: {}
        };

        this.settings = { ...defaultSettings, ...savedData };

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

        if (!Array.isArray(this.settings.chatHistory)) {
            this.settings.chatHistory = [];
        }

        await this.saveSettings();
    }

    async saveSettings() {
        await this.saveData(this.settings);
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
        if (!this.settings.apiKey || !this.settings.apiVerified) {
            new Notice('Please configure your Gemini API key in settings');
            return;
        }

        const selection = editor.getSelection();
        if (!selection && command.prompt.includes('{}')) {
            new Notice('Please select some text first');
            return;
        }

        try {
            const prompt = await this.processPrompt(command.prompt, selection, view);
            const response = await this.callGeminiAPI(prompt);

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

        // Replace {} with selection
        if (selection) {
            processed = processed.replace(/\{\}/g, selection);
        }

        // Replace {activeNote} with current note content
        if (processed.includes('{activeNote}')) {
            const activeFile = view?.file;
            if (activeFile) {
                const content = await this.app.vault.read(activeFile);
                processed = processed.replace(/\{activeNote\}/g, content);
            }
        }

        // Removed [[Note]] content expansion entirely.

        return processed;
    }

    async callGeminiAPI(input, abortSignal) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.settings.selectedModel}:generateContent?key=${this.settings.apiKey}`;

        const contents = Array.isArray(input)
            ? input
            : [{
                role: 'user',
                parts: [{ text: input }]
            }];

        const requestBody = {
            contents,
            ...(this.settings.systemPrompt
                ? { system_instruction: { parts: [{ text: this.settings.systemPrompt }] } }
                : {})
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
                this.settings.apiVerified = false;
                await this.saveSettings();
                const msg = json?.error?.message || `API key invalid or unauthorized (status ${res.status})`;
                throw new Error(msg);
            }

            if (!res.ok) {
                const msg = json?.error?.message || `HTTP ${res.status}`;
                throw new Error(msg);
            }

            const parts = json?.candidates?.[0]?.content?.parts || [];
            const text = parts.map(p => p.text || '').join('').trim();

            // Track usage - rough token estimate
            const estimatedTokens = Math.ceil((JSON.stringify(requestBody).length + text.length) / 4);
            await this.trackUsage(this.settings.selectedModel, estimatedTokens);

            if (text) return text;

            throw new Error('Invalid response from API');
        } catch (error) {
            if (error.name === 'AbortError') {
                throw new Error('Generation stopped by user');
            }
            console.error('Gemini API network error:', error);
            throw error;
        }
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
        this.messages = [];
        this.currentSuggestions = [];
        this.selectedSuggestionIndex = -1;
        this.currentSessionId = Date.now().toString();
        this.promptHistory = [];
        this.promptHistoryIndex = -1;

        // /paper logging
        this.paperFile = null;
        this.paperAiOnly = false;

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
            // Reset paper logging for new chat
            this.paperFile = null;
            this.paperAiOnly = false;
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
            attr: {
                placeholder: '/ for commands',
                rows: '1'
            }
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

            if (model === this.plugin.settings.selectedModel) {
                modelPill.addClass('active');
            }

            modelPill.addEventListener('click', async () => {
                modelContainer.querySelectorAll('.copilot-model-pill').forEach(pill => pill.removeClass('active'));
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
            if (this.isLoading) {
                this.stopGeneration();
            } else {
                this.sendMessage();
            }
        });

        this.inputEl.addEventListener('keydown', (e) => {
            // Suggestions navigation
            if (this.suggestionsEl.style.display !== 'none') {
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

            // Prompt history
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (this.promptHistoryIndex > 0) {
                    this.promptHistoryIndex--;
                    this.inputEl.value = this.promptHistory[this.promptHistoryIndex];
                    this.inputEl.selectionStart = this.inputEl.selectionEnd = this.inputEl.value.length;
                }
                return;
            } else if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (this.promptHistoryIndex < this.promptHistory.length - 1) {
                    this.promptHistoryIndex++;
                    this.inputEl.value = this.promptHistory[this.promptHistoryIndex];
                    this.inputEl.selectionStart = this.inputEl.selectionEnd = this.inputEl.value.length;
                } else if (this.promptHistoryIndex === this.promptHistory.length - 1) {
                    this.promptHistoryIndex++;
                    this.inputEl.value = '';
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
        if (this.messages.length === 0) {
            this.addWelcomeMessage();
        }
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
        if (tokens < 1000000) return (tokens / 1000).toFixed(1) + 'K';
        return (tokens / 1000000).toFixed(1) + 'M';
    }

    async onClose() {
        if (this.messages.length > 0) {
            await this.saveCurrentSession();
        }
        this.paperFile = null;
        this.paperAiOnly = false;
    }

    checkForSuggestions() {
        const value = this.inputEl.value;
        const cursorPos = this.inputEl.selectionStart;
        const textBeforeCursor = value.substring(0, cursorPos);

        // Only slash commands
        const slashMatch = textBeforeCursor.match(/\/(\w*)$/);
        if (slashMatch) {
            this.showCommandSuggestions(slashMatch[1]);
            return;
        }

        this.hideSuggestions();
    }

    showCommandSuggestions(query) {
        const commands = this.plugin.settings.commands
            .filter(cmd => cmd.enabled && cmd.name.toLowerCase().includes((query || '').toLowerCase()));

        const allSuggestions = [
            ...commands.map(cmd => ({ type: 'command', value: cmd.name, data: cmd }))
        ];

        // Add /paper helper
        if ('paper'.includes((query || '').toLowerCase())) {
            allSuggestions.unshift({
                type: 'command',
                value: 'paper',
                data: { name: 'paper', prompt: 'Start/Configure paper logging' }
            });
        }

        if (allSuggestions.length === 0) {
            this.hideSuggestions();
            return;
        }

        this.currentSuggestions = allSuggestions;
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
            }
            item.addEventListener('click', () => this.selectSuggestion(index));
        });

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

        if (this.selectedSuggestionIndex < 0) {
            this.selectedSuggestionIndex = items.length - 1;
        } else if (this.selectedSuggestionIndex >= items.length) {
            this.selectedSuggestionIndex = 0;
        }

        const curr = items[this.selectedSuggestionIndex];
        if (curr && curr.classList) curr.classList.add('selected');
    }

    selectSuggestion(index) {
        const suggestion = this.currentSuggestions[index];
        const value = this.inputEl.value;
        const cursorPos = this.inputEl.selectionStart;
        const textBeforeCursor = value.substring(0, cursorPos);
        const textAfterCursor = value.substring(cursorPos);

        let newText = '';
        let replaceLength = 0;

        if (suggestion.type === 'command') {
            const match = textBeforeCursor.match(/\/(\w*)$/);
            replaceLength = match ? match[0].length : 0;
            newText = '/' + suggestion.value + ' ';
        }

        const newValue = textBeforeCursor.substring(0, cursorPos - replaceLength) + newText + textAfterCursor;
        this.inputEl.value = newValue;
        this.inputEl.selectionStart = this.inputEl.selectionEnd = cursorPos - replaceLength + newText.length;

        this.hideSuggestions();
        this.inputEl.focus();
    }

    hideSuggestions() {
        this.suggestionsEl.style.display = 'none';
        this.currentSuggestions = [];
        this.selectedSuggestionIndex = -1;
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

    async sendMessage() {
        const message = this.inputEl.value.trim();
        if (!message) return;

        // Handle /paper configuration (no chat message for this)
        if (message.startsWith('/paper')) {
            const args = message.split(/\s+/).slice(1).map(a => a.toLowerCase());
            const sub = args[0] || '';

            if (sub === 'off') {
                this.paperFile = null;
                this.paperAiOnly = false;
                new Notice('Paper logging disabled');
            } else if (sub === 'new') {
                await this.createPaperFile();
                if (!this.paperFile) return;
                new Notice('Paper logging enabled (user + AI)');
                this.paperAiOnly = false;
            } else if (sub === 'ai') {
                if (!this.paperFile) await this.createPaperFile();
                this.paperAiOnly = true;
                new Notice('Paper logging: AI replies only');
            } else if (sub === 'both') {
                if (!this.paperFile) await this.createPaperFile();
                this.paperAiOnly = false;
                new Notice('Paper logging: user + AI');
            } else {
                // Default /paper: enable if off, or show status
                if (!this.paperFile) {
                    await this.createPaperFile();
                    if (!this.paperFile) return;
                    this.paperAiOnly = false;
                    new Notice('Paper logging enabled (user + AI)');
                } else {
                    new Notice(`Paper active → Mode: ${this.paperAiOnly ? 'AI-only' : 'user + AI'} | Try "/paper ai", "/paper both", "/paper new", "/paper off"`);
                }
            }

            this.inputEl.value = '';
            this.inputEl.style.height = 'auto';
            return;
        }

        // Add to prompt history
        this.promptHistory.push(message);
        this.promptHistoryIndex = this.promptHistory.length;

        if (!this.plugin.settings.apiKey || !this.plugin.settings.apiVerified) {
            new Notice('Please configure your Gemini API key in settings');
            return;
        }

        // Remove welcome message if exists
        this.chatContainer.querySelector('.copilot-welcome')?.remove();

        // Add user message to chat
        this.addMessage('user', message);
        this.inputEl.value = '';
        this.inputEl.style.height = 'auto';

        // Show loading spinner message
        const loadingEl = this.addMessage('assistant', '', true);

        // Abort controller
        this.abortController = new AbortController();
        this.updateSendButton(true);

        try {
            let prompt = message;

            // Custom /commands (not /paper)
            if (message.startsWith('/')) {
                const commandName = message.slice(1).split(' ')[0];
                const command = this.plugin.settings.commands.find(c =>
                    c.name.toLowerCase() === commandName.toLowerCase()
                );

                if (command) {
                    const activeView = this.app.workspace.getActiveViewOfType(MarkdownView);
                    const selection = activeView ? activeView.editor.getSelection() : '';
                    const commandArgs = message.substring(commandName.length + 2).trim();
                    const textToProcess = commandArgs || selection;

                    if (!textToProcess && command.prompt.includes('{}')) {
                        new Notice(`Please select text or provide arguments for the ${command.name} command.`);
                        loadingEl.remove();
                        this.updateSendButton(false);
                        return;
                    }

                    prompt = await this.plugin.processPrompt(command.prompt, textToProcess, activeView);

                    // One-shot command: no multi-turn history for /commands
                    const response = await this.plugin.callGeminiAPI(prompt, this.abortController.signal);

                    loadingEl.remove();
                    this.addMessage('assistant', response);
                    this.updateUsageDisplay();
                    await this.saveCurrentSession();
                    return;
                }
            }

            // Build multi-turn chat contents from recent history.
            // Replace the most recent user message with the processed prompt (no wiki expansion).
            const history = this.messages.slice();
            if (history.length && history[history.length - 1].type === 'user') {
                history[history.length - 1] = {
                    ...history[history.length - 1],
                    content: prompt
                };
            }

            // Limit to the last N messages
            const maxMessages = 12;
            const recent = history.slice(-maxMessages);

            const contents = recent.map(m => ({
                role: m.type === 'user' ? 'user' : 'model',
                parts: [{ text: m.content }]
            }));

            const response = await this.plugin.callGeminiAPI(contents, this.abortController.signal);

            // Remove loading and add response
            loadingEl.remove();
            this.addMessage('assistant', response);

            // Update usage
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

    addMessage(type, content, isLoading = false, saveToMessages = true) {
        const messageEl = this.chatContainer.createDiv(`copilot-message ${type}`);

        if (saveToMessages && !isLoading) {
            this.messages.push({
                type: type,
                content: content,
                timestamp: Date.now()
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

        const messageContentEl = messageEl.createDiv({
            cls: 'copilot-message-content'
        });

        if (type === 'assistant') {
            const modelName = this.plugin.settings.selectedModel.split('-').pop();
            const modelEl = messageEl.createDiv({
                cls: 'copilot-message-model',
                text: modelName
            });
            modelEl.addEventListener('click', () => {
                navigator.clipboard.writeText(content);
                new Notice('Copied to clipboard');
            });
        }

        if (type === 'assistant') {
            MarkdownRenderer.render(this.app, content, messageContentEl, '', this);
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

        const existingIndex = this.plugin.settings.chatHistory.findIndex(s => s.id === this.currentSessionId);

        const session = {
            id: this.currentSessionId,
            timestamp: Date.now(),
            messages: [...this.messages],
            title: this.generateSessionTitle()
        };

        if (existingIndex !== -1) {
            this.plugin.settings.chatHistory[existingIndex] = session;
        } else {
            this.plugin.settings.chatHistory.unshift(session);
            if (this.plugin.settings.chatHistory.length > 10) {
                this.plugin.settings.chatHistory = this.plugin.settings.chatHistory.slice(0, 10);
            }
        }

        await this.plugin.saveSettings();
    }

    generateSessionTitle() {
        const firstUserMsg = this.messages.find(m => m.type === 'user');
        return firstUserMsg ? firstUserMsg.content.substring(0, 50) + (firstUserMsg.content.length > 50 ? '...' : '') : 'New Chat';
    }

    async loadSession(sessionId) {
        const session = this.plugin.settings.chatHistory.find(s => s.id === sessionId);
        if (!session) return;

        this.messages = [...session.messages];
        this.currentSessionId = sessionId;
        this.renderAllMessages();
    }

    renderAllMessages() {
        this.chatContainer.empty();
        for (const msg of this.messages) {
            this.addMessage(msg.type, msg.content, false, false);
        }
    }

    showHistoryMenu(button) {
        const menu = new Menu();
        menu.dom.addClass('copilot-history-menu');

        if (this.plugin.settings.chatHistory.length === 0) {
            menu.addItem((item) => {
                item.setTitle('No chat history')
                    .setDisabled(true);
            });
        } else {
            this.plugin.settings.chatHistory.forEach((session) => {
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
                            this.plugin.settings.chatHistory = [];
                            await this.plugin.saveSettings();
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

        // API Key
        new Setting(containerEl)
            .setName('Gemini API Key')
            .setDesc('Enter your Google Gemini API key')
            .addText(text => {
                text
                    .setPlaceholder('Enter your API key')
                    .setValue(this.plugin.settings.apiKey)
                    .onChange(async (value) => {
                        this.plugin.settings.apiKey = value;
                        await this.plugin.saveSettings();
                    });
                text.inputEl.type = 'password';
                text.inputEl.addClass('copilot-api-input');
            })
            .addButton(button => {
                button
                    .setButtonText('Verify')
                    .onClick(async () => {
                        containerEl.querySelector('.copilot-api-status')?.remove();
                        const settingItem = button.buttonEl.closest('.setting-item');
                        const status = settingItem.createDiv('copilot-api-status');
                        status.setText('Verifying...');

                        const isValid = await this.plugin.verifyAPIKey(this.plugin.settings.apiKey);
                        this.plugin.settings.apiVerified = isValid;
                        await this.plugin.saveSettings();

                        status.addClass(isValid ? 'success' : 'error');
                        status.setText(isValid ? '✓ API key verified successfully' : '✗ Invalid API key');
                    });
            });

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