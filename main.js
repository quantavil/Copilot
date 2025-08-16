// ===== IMPORTS AND CONSTANTS =====
const { Plugin, PluginSettingTab, Setting, Modal, Notice, ItemView, WorkspaceLeaf, Menu, Editor, MarkdownView, requestUrl, EditorSuggest, TFile } = require('obsidian');
const COPILOT_VIEW_TYPE = 'copilot-chat-view';
const GEMINI_MODELS = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];

// ===== MAIN PLUGIN CLASS =====
class CopilotPlugin extends Plugin {
    async onload() {
        await this.loadSettings();

        // Register the sidebar view
        this.registerView(
            COPILOT_VIEW_TYPE,
            (leaf) => new CopilotChatView(leaf, this)
        );

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
        // Register slash commands in editor
        this.registerEditorSuggest(new SlashCommandSuggestor(this.app, this));

        // Add settings tab
        this.addSettingTab(new CopilotSettingTab(this.app, this));

        // Initialize chat history
        if (!this.settings.chatHistory) {
            this.settings.chatHistory = [];
        }
    }

    async loadSettings() {
        // Load saved data
        const savedData = await this.loadData() || {};

        // Define default settings
        const defaultSettings = {
            apiKey: '',
            selectedModel: 'gemini-2.5-flash',
            systemPrompt: '',
            commands: [],
            directReplace: false, // Keep this as global default for new commands
            apiVerified: false,
            chatHistory: []
        };

        // Merge saved data with defaults
        this.settings = Object.assign({}, defaultSettings, savedData);

        // Ensure commands is an array (safety check)
        if (!Array.isArray(this.settings.commands)) {
            this.settings.commands = [];
        }

        // Migrate existing commands to include directReplace property
        this.settings.commands = this.settings.commands.map(cmd => {
            // Preserve all existing command properties and add directReplace if missing
            return {
                id: cmd.id,
                name: cmd.name,
                prompt: cmd.prompt,
                enabled: cmd.enabled !== undefined ? cmd.enabled : true,
                directReplace: cmd.directReplace !== undefined
                    ? cmd.directReplace
                    : this.settings.directReplace
            };
        });

        // Initialize chat history if not present
        if (!Array.isArray(this.settings.chatHistory)) {
            this.settings.chatHistory = [];
        }

        // Save the migrated settings back
        await this.saveSettings();
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }

    registerCommands() {
        // Command to open chat view
        this.addCommand({
            id: 'open-copilot-chat',
            name: 'Open Copilot Chat',
            callback: () => this.activateChatView()
        });

        // Command for bulk actions
        this.addCommand({
            id: 'copilot-bulk-action',
            name: 'Bulk AI Action',
            callback: () => new BulkActionModal(this.app, this).open()
        });

        // Register custom commands as Obsidian commands
        this.settings.commands.forEach(cmd => {
            if (cmd.enabled) {
                this.addCommand({
                    id: `copilot-cmd-${cmd.id}`,
                    name: cmd.name,
                    editorCallback: (editor, view) => {
                        this.executeCommand(cmd, editor, view);
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

        const submenu = menu.addItem((item) => {
            item.setTitle('Copilot Actions')
                .setIcon('bot');
            const subMenu = item.setSubmenu();

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

            // Use command-specific directReplace setting
            if (command.directReplace && selection) {
                editor.replaceSelection(response);
            } else {
                // Show output modal
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
            const activeFile = view.file;
            if (activeFile) {
                const content = await this.app.vault.read(activeFile);
                processed = processed.replace(/\{activeNote\}/g, content);
            }
        }

        // Replace {[[Note Title]]} with linked note content
        const linkMatches = processed.match(/\{\[\[(.+?)\]\]\}/g);
        if (linkMatches) {
            for (const match of linkMatches) {
                const noteName = match.slice(3, -3);
                const file = this.app.metadataCache.getFirstLinkpathDest(noteName, '');
                if (file) {
                    const content = await this.app.vault.read(file);
                    processed = processed.replace(match, content);
                }
            }
        }

        // Replace {#tag1, #tag2} with notes containing tags
        const tagMatches = processed.match(/\{(#[^}]+)\}/g);
        if (tagMatches) {
            for (const match of tagMatches) {
                const tags = match.slice(1, -1).split(',').map(t => t.trim());
                const files = this.app.vault.getMarkdownFiles().filter(file => {
                    const cache = this.app.metadataCache.getFileCache(file);
                    if (!cache || !cache.tags) return false;
                    return tags.some(tag => cache.tags.some(t => t.tag === tag));
                });

                let content = '';
                for (const file of files) {
                    content += `\n\n--- ${file.basename} ---\n`;
                    content += await this.app.vault.read(file);
                }
                processed = processed.replace(match, content);
            }
        }

        return processed;
    }

    async callGeminiAPI(prompt) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.settings.selectedModel}:generateContent?key=${this.settings.apiKey}`;

        const requestBody = {
            contents: [{
                parts: [{
                    text: prompt
                }]
            }]
        };

        if (this.settings.systemPrompt) {
            requestBody.system_instruction = {
                parts: [{
                    text: this.settings.systemPrompt
                }]
            };
        }

        try {
            const response = await requestUrl({
                url: url,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(requestBody)
            });

            if (response.json.candidates && response.json.candidates[0]) {
                return response.json.candidates[0].content.parts[0].text;
            } else {
                throw new Error('Invalid response from API');
            }
        } catch (error) {
            console.error('Gemini API error:', error);
            throw error;
        }
    }

    async verifyAPIKey(apiKey) {
        const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;

        try {
            const response = await requestUrl({
                url: url,
                method: 'GET'
            });

            return response.status === 200;
        } catch (error) {
            return false;
        }
    }
}

// ===== CHAT VIEW CLASS =====

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

// ===== CHAT VIEW CLASS =====

/* ===== CHAT VIEW CLASS ===== */
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

        // Create header with new chat button and history
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

        historyBtn.addEventListener('click', () => {
            this.showHistoryMenu(historyBtn);
        });

        // Add new chat button
        const newChatBtn = headerRight.createEl('button', {
            cls: 'copilot-header-button',
            attr: { 'aria-label': 'New chat' }
        });
        newChatBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>`;

        newChatBtn.addEventListener('click', async () => {
            // Save current session only if it has messages
            if (this.messages.length > 0) {
                await this.saveCurrentSession();
            }
            this.messages = [];
            this.currentSessionId = Date.now().toString();
            this.chatContainer.empty();
            this.addWelcomeMessage();
            new Notice('Started new chat');
        });

        // Chat container (takes most space)
        this.chatContainer = container.createDiv('copilot-chat-container');

        // Bottom section container
        const bottomSection = container.createDiv('copilot-bottom-section');

        // Input container with suggestions
        const inputWrapper = bottomSection.createDiv('copilot-input-wrapper');

        // Suggestions container (hidden by default)
        this.suggestionsEl = inputWrapper.createDiv('copilot-suggestions');
        this.suggestionsEl.style.display = 'none';

        const inputContainer = inputWrapper.createDiv('copilot-input-container');

        this.inputEl = inputContainer.createEl('textarea', {
            cls: 'copilot-input',
            attr: {
                placeholder: 'Ask anything. [[ for notes. / for custom prompts.',
                rows: '1'
            }
        });

        const sendButton = inputContainer.createEl('button', {
            cls: 'copilot-send-button',
            attr: { 'aria-label': 'Send message' }
        });
        sendButton.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;

        // Model selector (minimal design)
        const modelContainer = bottomSection.createDiv('copilot-model-container');

        // Create model pills
        GEMINI_MODELS.forEach(model => {
            const modelPill = modelContainer.createDiv({
                cls: 'copilot-model-pill',
                text: model.split('-').pop() // Show only last part (flash/pro)
            });

            if (model === this.plugin.settings.selectedModel) {
                modelPill.addClass('active');
            }

            modelPill.addEventListener('click', async () => {
                // Remove active class from all pills
                modelContainer.querySelectorAll('.copilot-model-pill').forEach(pill => {
                    pill.removeClass('active');
                });

                // Add active class to clicked pill
                modelPill.addClass('active');

                // Update settings
                this.plugin.settings.selectedModel = model;
                await this.plugin.saveSettings();

                // Show subtle feedback
                new Notice(`Switched to ${model}`, 2000);
            });
        });

        // Event listeners
        sendButton.addEventListener('click', () => this.sendMessage());

        this.inputEl.addEventListener('keydown', (e) => {
            // Handle suggestions navigation
            if (this.suggestionsEl.style.display !== 'none') {
                if (e.key === 'ArrowDown') {
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

            // Handle prompt history navigation
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

            // Normal enter to send
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.sendMessage();
            }
        });

        this.inputEl.addEventListener('input', () => {
            // Auto-resize textarea
            this.inputEl.style.height = 'auto';
            this.inputEl.style.height = Math.min(this.inputEl.scrollHeight, 120) + 'px';

            // Check for suggestions
            this.checkForSuggestions();
        });

        // Add welcome message if no messages
        if (this.messages.length === 0) {
            this.addWelcomeMessage();
        }
    }

    async onClose() {
        // Save current session when closing the view
        if (this.messages.length > 0) {
            await this.saveCurrentSession();
        }
    }

        checkForSuggestions() {
        const value = this.inputEl.value;
        const cursorPos = this.inputEl.selectionStart;
        const textBeforeCursor = value.substring(0, cursorPos);

        // Check for slash commands
        const slashMatch = textBeforeCursor.match(/\/(\w*)$/);
        if (slashMatch) {
            this.showCommandSuggestions(slashMatch[1]);
            return;
        }

        // Check for note links like [[Note Name... (partial)]]
        // Match an opening [[ and capture anything after it up to the cursor (no closing brackets required)
        const linkMatch = textBeforeCursor.match(/\[\[([^\]]*)$/);
        if (linkMatch) {
            this.showNoteSuggestions(linkMatch[1]);
            return;
        }

        // Check for tags
        const tagMatch = textBeforeCursor.match(/#(\w*)$/);
        if (tagMatch) {
            this.showTagSuggestions(tagMatch[1]);
            return;
        }

        this.hideSuggestions();
    }

    showCommandSuggestions(query) {
        const commands = this.plugin.settings.commands
            .filter(cmd => cmd.enabled && cmd.name.toLowerCase().includes(query.toLowerCase()));

        if (commands.length === 0) {
            this.hideSuggestions();
            return;
        }

        this.currentSuggestions = commands.map(cmd => ({
            type: 'command',
            value: cmd.name,
            data: cmd
        }));

        this.displaySuggestions();
    }

    showNoteSuggestions(query) {
        const files = this.app.vault.getMarkdownFiles();
        const matches = files
            .filter(file => file.basename.toLowerCase().includes(query.toLowerCase()))
            .slice(0, 10); // Limit to 10 suggestions

        if (matches.length === 0) {
            this.hideSuggestions();
            return;
        }

        this.currentSuggestions = matches.map(file => ({
            type: 'note',
            value: file.basename,
            data: file
        }));

        this.displaySuggestions();
    }

    showTagSuggestions(query) {
        const tags = new Set();

        // Collect all tags from metadata cache
        this.app.vault.getMarkdownFiles().forEach(file => {
            const cache = this.app.metadataCache.getFileCache(file);
            if (cache && cache.tags) {
                cache.tags.forEach(tag => {
                    tags.add(tag.tag.substring(1)); // Remove # prefix
                });
            }
        });

        const matches = Array.from(tags)
            .filter(tag => tag.toLowerCase().includes(query.toLowerCase()))
            .slice(0, 10);

        if (matches.length === 0) {
            this.hideSuggestions();
            return;
        }

        this.currentSuggestions = matches.map(tag => ({
            type: 'tag',
            value: tag,
            data: tag
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
            } else if (suggestion.type === 'note') {
                item.createSpan({ text: '[[', cls: 'copilot-suggestion-prefix' });
                item.createSpan({ text: suggestion.value });
                item.createSpan({ text: ']]', cls: 'copilot-suggestion-prefix' });
            } else if (suggestion.type === 'tag') {
                item.createSpan({ text: '#', cls: 'copilot-suggestion-prefix' });
                item.createSpan({ text: suggestion.value });
            }

            item.addEventListener('click', () => {
                this.selectSuggestion(index);
            });
        });
    }

    navigateSuggestions(direction) {
        const items = this.suggestionsEl.querySelectorAll('.copilot-suggestion-item');

        // Remove previous selection
        if (this.selectedSuggestionIndex >= 0) {
            const prev = items[this.selectedSuggestionIndex];
            if (prev && prev.classList) prev.classList.remove('selected');
        }

        // Update index
        this.selectedSuggestionIndex += direction;

        // Wrap around
        if (this.selectedSuggestionIndex < 0) {
            this.selectedSuggestionIndex = items.length - 1;
        } else if (this.selectedSuggestionIndex >= items.length) {
            this.selectedSuggestionIndex = 0;
        }

        // Add new selection
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
        } else if (suggestion.type === 'note') {
            // Match the opening [[ and whatever the user typed after it (no closing required)
            const match = textBeforeCursor.match(/\[\[([^\]]*)$/);
            replaceLength = match ? match[0].length : 0;
            newText = '[[' + suggestion.value + ']]';
        } else if (suggestion.type === 'tag') {
            const match = textBeforeCursor.match(/#(\w*)$/);
            replaceLength = match ? match[0].length : 0;
            newText = '#' + suggestion.value + ' ';
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

    async sendMessage() {
        const message = this.inputEl.value.trim();
        if (!message) return;

        // Add to prompt history
        this.promptHistory.push(message);
        this.promptHistoryIndex = this.promptHistory.length;

        if (!this.plugin.settings.apiKey || !this.plugin.settings.apiVerified) {
            new Notice('Please configure your Gemini API key in settings');
            return;
        }

        // Remove welcome message if exists
        const welcomeEl = this.chatContainer.querySelector('.copilot-welcome');
        if (welcomeEl) welcomeEl.remove();

        // Add user message
        this.addMessage('user', message);
        this.inputEl.value = '';
        this.inputEl.style.height = 'auto';

        // Show loading
        const loadingEl = this.addMessage('assistant', '', true);

        try {
            let prompt = message;

            // Check for slash commands
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
                        return;
                    }

                    prompt = await this.plugin.processPrompt(command.prompt, textToProcess, activeView);
                }
            } else {
                // Process any [[Note]] or #tag references in the message
                prompt = await this.processChatPrompt(message);
            }

            const response = await this.plugin.callGeminiAPI(prompt);

            // Remove loading and add response
            loadingEl.remove();
            this.addMessage('assistant', response);

            // Auto-save session after each exchange
            await this.saveCurrentSession();

        } catch (error) {
            loadingEl.remove();
            this.addMessage('assistant', `Error: ${error.message}`);

        }
    }

    async processChatPrompt(message) {
        let processed = message;

        // Process [[Note]] links - find all complete [[Note Name]] occurrences
        const linkMatches = [...processed.matchAll(/\[\[([^\]]+)\]\]/g)];
        if (linkMatches.length > 0) {
            for (const m of linkMatches) {
                const match = m[0];
                const noteName = m[1];
                const file = this.app.metadataCache.getFirstLinkpathDest(noteName, '');
                if (file) {
                    const content = await this.app.vault.read(file);
                    processed = processed.replace(match, `

--- Content of ${noteName} ---
${content}
--- End of ${noteName} ---
`);
                }
            }
        }

        // Process #tag references
        const tagMatches = processed.match(/#(\w+)/g);
        if (tagMatches) {
            for (const match of tagMatches) {
                const tag = match;
                const files = this.app.vault.getMarkdownFiles().filter(file => {
                    const cache = this.app.metadataCache.getFileCache(file);
                    return cache && cache.tags && cache.tags.some(t => t.tag === tag);
                });

                if (files.length > 0) {
                    let tagContent = `

--- Notes with tag ${tag} ---
`;
                    for (const file of files) {
                        const content = await this.app.vault.read(file);
                        tagContent += `
### ${file.basename}
${content}
`;
                    }
                    tagContent += `--- End of ${tag} notes ---
`;
                    processed = processed.replace(match, tagContent);
                }
            }
        }

        return processed;
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
            const codeBlockRegex = /```(\w*)\n([\s\S]*?)\n```/g;
            let lastIndex = 0;
            let match;

            while ((match = codeBlockRegex.exec(content)) !== null) {
                // Add text before the code block
                if (match.index > lastIndex) {
                    messageContentEl.createDiv({
                        text: content.substring(lastIndex, match.index)
                    });
                }

                const lang = match[1] || 'code';
                const code = match[2];

                const codeBlockWrapper = messageContentEl.createDiv({ cls: 'copilot-code-block-wrapper' });

                const header = codeBlockWrapper.createDiv({ cls: 'copilot-code-block-header' });
                header.createSpan({ text: lang, cls: 'copilot-code-block-lang' });

                const copyButton = header.createEl('button', { cls: 'copilot-copy-button' });
                copyButton.innerHTML = "                <svg class=\"copilot-copy-icon\" xmlns=\"http://www.w3.org/2000/svg\" width=\"14\" height=\"14\" viewBox=\"0 0 24 24\" fill=\"none\" stroke=\"currentColor\" stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\"><rect x=\"9\" y=\"9\" width=\"13\" height=\"13\" rx=\"2\" ry=\"2\"></rect><path d=\"M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1\"></path></svg>                    <span class=\"copilot-copy-text\">Copy</span>                ";

                copyButton.addEventListener('click', () => {
                    navigator.clipboard.writeText(code);
                    new Notice('Copied to clipboard');
                });

                const pre = codeBlockWrapper.createEl('pre');
                const codeEl = pre.createEl('code', { text: code });

                lastIndex = codeBlockRegex.lastIndex;
            }

            // Add remaining text after the last code block
            if (lastIndex < content.length) {
                messageContentEl.createDiv({
                    text: content.substring(lastIndex)
                });
            }
        } else {
            messageContentEl.setText(content);
        }


        // Add timestamp
        const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        messageEl.createDiv({
            cls: 'copilot-message-time',
            text: time
        });

        // Scroll to bottom
        this.chatContainer.scrollTop = this.chatContainer.scrollHeight;

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

        // Check if this session already exists in history
        const existingIndex = this.plugin.settings.chatHistory.findIndex(
            s => s.id === this.currentSessionId
        );

        const session = {
            id: this.currentSessionId,
            timestamp: Date.now(),
            messages: [...this.messages],
            title: this.generateSessionTitle()
        };

        if (existingIndex !== -1) {
            // Update existing session
            this.plugin.settings.chatHistory[existingIndex] = session;
        } else {
            // Add new session
            this.plugin.settings.chatHistory.unshift(session);

            // Keep only last 10 sessions
            if (this.plugin.settings.chatHistory.length > 10) {
                this.plugin.settings.chatHistory = this.plugin.settings.chatHistory.slice(0, 10);
            }
        }

        await this.plugin.saveSettings();
    }

    generateSessionTitle() {
        // Generate title from first user message
        const firstUserMsg = this.messages.find(m => m.type === 'user');
        if (firstUserMsg) {
            return firstUserMsg.content.substring(0, 50) + (firstUserMsg.content.length > 50 ? '...' : '');
        }
        return 'New Chat';
    }

    async loadSession(sessionId) {
        const session = this.plugin.settings.chatHistory.find(s => s.id === sessionId);
        if (session) {
            this.messages = [...session.messages];
            this.currentSessionId = sessionId;
            this.renderAllMessages();
        }
    }

    renderAllMessages() {
        this.chatContainer.empty();
        this.messages.forEach(msg => {
            this.addMessage(msg.type, msg.content, false, false);
        });
    }

    showHistoryMenu(button) {
        const menu = new Menu();

        if (this.plugin.settings.chatHistory.length === 0) {
            menu.addItem((item) => {
                item.setTitle('No chat history')
                    .setDisabled(true);
            });
        } else {
            this.plugin.settings.chatHistory.forEach((session, index) => {
                menu.addItem((item) => {
                    const date = new Date(session.timestamp);
                    const timeStr = date.toLocaleString([], {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit'
                    });

                    item.setTitle(session.title)
                        .setSection(`${timeStr} • ${session.messages.length} messages`)
                        .onClick(async () => {
                            // Save current session before switching
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

// ===== SLASH COMMAND SUGGESTOR =====
class SlashCommandSuggestor extends require('obsidian').EditorSuggest {
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

        if (editor) {
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

// ===== BULK ACTION MODAL =====
class BulkActionModal extends Modal {
    constructor(app, plugin) {
        super(app);
        this.plugin = plugin;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('copilot-bulk-modal');

        contentEl.createEl('h2', { text: 'Bulk AI Action' });

        // Command selection
        const commandSection = contentEl.createDiv('copilot-bulk-section');
        commandSection.createEl('h3', { text: 'Select Command', cls: 'copilot-bulk-title' });

        const commandSelect = commandSection.createEl('select', { cls: 'copilot-bulk-input' });
        this.plugin.settings.commands.forEach(cmd => {
            if (cmd.enabled) {
                commandSelect.createEl('option', { text: cmd.name, value: cmd.id });
            }
        });

        // Target selection
        const targetSection = contentEl.createDiv('copilot-bulk-section');
        targetSection.createEl('h3', { text: 'Select Target', cls: 'copilot-bulk-title' });

        const targetTypeSelect = targetSection.createEl('select', { cls: 'copilot-bulk-input' });
        targetTypeSelect.createEl('option', { text: 'By Tags', value: 'tags' });
        targetTypeSelect.createEl('option', { text: 'By Folder', value: 'folder' });
        targetTypeSelect.createEl('option', { text: 'By Links', value: 'links' });

        const targetInput = targetSection.createEl('input', {
            cls: 'copilot-bulk-input',
            attr: { placeholder: 'Enter tags, folder path, or note name...' }
        });

        // Preview section
        const previewSection = contentEl.createDiv('copilot-bulk-section');
        previewSection.createEl('h3', { text: 'Preview', cls: 'copilot-bulk-title' });
        const previewContainer = previewSection.createDiv('copilot-bulk-preview');

        // Update preview on input change
        const updatePreview = async () => {
            previewContainer.empty();
            const targetType = targetTypeSelect.value;
            const targetValue = targetInput.value.trim();

            if (!targetValue) {
                previewContainer.createDiv({
                    text: 'Enter target criteria above',
                    cls: 'copilot-bulk-preview-item'
                });
                return;
            }

            const files = await this.getTargetFiles(targetType, targetValue);

            if (files.length === 0) {
                previewContainer.createDiv({
                    text: 'No files found matching criteria',
                    cls: 'copilot-bulk-preview-item'
                });
            } else {
                previewContainer.createDiv({
                    text: `Found ${files.length} files:`,
                    cls: 'copilot-bulk-preview-item'
                });

                files.slice(0, 10).forEach(file => {
                    previewContainer.createDiv({
                        text: `• ${file.path}`,
                        cls: 'copilot-bulk-preview-item'
                    });
                });

                if (files.length > 10) {
                    previewContainer.createDiv({
                        text: `... and ${files.length - 10} more`,
                        cls: 'copilot-bulk-preview-item'
                    });
                }
            }
        };

        targetTypeSelect.addEventListener('change', updatePreview);
        targetInput.addEventListener('input', updatePreview);

        // Action buttons
        const buttonContainer = contentEl.createDiv('copilot-button-container');

        const executeBtn = buttonContainer.createEl('button', {
            text: 'Execute',
            cls: 'mod-cta'
        });

        executeBtn.addEventListener('click', async () => {
            const commandId = commandSelect.value;
            const command = this.plugin.settings.commands.find(c => c.id === commandId);
            const targetType = targetTypeSelect.value;
            const targetValue = targetInput.value.trim();

            if (!command || !targetValue) {
                new Notice('Please select a command and specify target');
                return;
            }

            const files = await this.getTargetFiles(targetType, targetValue);

            if (files.length === 0) {
                new Notice('No files found matching criteria');
                return;
            }

            this.close();

            // Execute bulk action
            new Notice(`Processing ${files.length} files...`);

            for (let i = 0; i < files.length; i++) {
                try {
                    const content = await this.app.vault.read(files[i]);
                    const prompt = await this.plugin.processPrompt(command.prompt.replace('{}', content), '', null);
                    const response = await this.plugin.callGeminiAPI(prompt);

                    // Create new file with AI output
                    const newPath = files[i].path.replace('.md', '_ai.md');
                    await this.app.vault.create(newPath, response);

                } catch (error) {
                    console.error(`Error processing ${files[i].path}:`, error);
                }
            }

            new Notice(`Bulk action completed for ${files.length} files`);
        });

        const cancelBtn = buttonContainer.createEl('button', { text: 'Cancel' });
        cancelBtn.addEventListener('click', () => this.close());

        // Initial preview
        updatePreview();
    }

    async getTargetFiles(type, value) {
        const { TFile } = require('obsidian');
        const files = [];

        switch (type) {
            case 'tags':
                const tags = value.split(',').map(t => t.trim());
                this.app.vault.getMarkdownFiles().forEach(file => {
                    const cache = this.app.metadataCache.getFileCache(file);
                    if (cache && cache.tags) {
                        const fileTags = cache.tags.map(t => t.tag);
                        if (tags.some(tag => fileTags.includes(tag))) {
                            files.push(file);
                        }
                    }
                });
                break;

            case 'folder':
                this.app.vault.getMarkdownFiles().forEach(file => {
                    if (file.path.startsWith(value)) {
                        files.push(file);
                    }
                });
                break;

            case 'links':
                const targetFile = this.app.metadataCache.getFirstLinkpathDest(value, '');
                if (targetFile) {
                    const backlinks = this.app.metadataCache.getBacklinksForFile(targetFile);
                    backlinks.data.forEach((links, path) => {
                        const file = this.app.vault.getAbstractFileByPath(path);
                        if (file && file instanceof TFile) {
                            files.push(file);
                        }
                    });
                }
                break;
        }

        return files;
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

        // API Key Setting
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
                        // Remove any existing status
                        const existingStatus = containerEl.querySelector('.copilot-api-status');
                        if (existingStatus) existingStatus.remove();

                        // Create status element after the setting item
                        const settingItem = button.buttonEl.closest('.setting-item');
                        const status = settingItem.createDiv('copilot-api-status');
                        status.setText('Verifying...');

                        const isValid = await this.plugin.verifyAPIKey(this.plugin.settings.apiKey);

                        if (isValid) {
                            this.plugin.settings.apiVerified = true;
                            await this.plugin.saveSettings();
                            status.addClass('success');
                            status.setText('✓ API key verified successfully');
                        } else {
                            this.plugin.settings.apiVerified = false;
                            await this.plugin.saveSettings();
                            status.addClass('error');
                            status.setText('✗ Invalid API key');
                        }
                    });
            });

        // Model Selection
        new Setting(containerEl)
            .setName('Default Model')
            .setDesc('Select the default Gemini model to use')
            .addDropdown(dropdown => {
                GEMINI_MODELS.forEach(model => {
                    dropdown.addOption(model, model);
                });
                dropdown
                    .setValue(this.plugin.settings.selectedModel)
                    .onChange(async (value) => {
                        this.plugin.settings.selectedModel = value;
                        await this.plugin.saveSettings();
                    });
            });

        // System Prompt Setting
        new Setting(containerEl)
            .setName('System Prompt')
            .setDesc('Enter a system-level prompt to guide the AI\'s behavior for all interactions.')
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

        // Commands Section
        containerEl.createEl('h3', { text: 'Custom Commands' });

        const commandsContainer = containerEl.createDiv('copilot-commands-list');

        // Add new command button
        new Setting(containerEl)
            .addButton(button => {
                button
                    .setButtonText('Add New Command')
                    .onClick(() => {
                        new CommandEditModal(this.app, this.plugin, null, () => {
                            this.display();
                        }).open();
                    });
            });

        // Display existing commands
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

            // Direct Replace button
            const directReplaceBtn = actions.createEl('button', {
                text: command.directReplace ? 'Direct Replace' : 'Show Output',
                cls: 'copilot-command-button'
            });
            directReplaceBtn.addEventListener('click', async () => {
                command.directReplace = !command.directReplace;
                await this.plugin.saveSettings();
                this.display();
            });

            // Edit button
            const editBtn = actions.createEl('button', {
                text: 'Edit',
                cls: 'copilot-command-button'
            });
            editBtn.addEventListener('click', () => {
                new CommandEditModal(this.app, this.plugin, command, () => {
                    this.display();
                }).open();
            });

            // Delete button
            if (command.id !== 'fix-grammar') { // Don't allow deleting default command
                const deleteBtn = actions.createEl('button', {
                    text: 'Delete',
                    cls: 'copilot-command-button'
                });
                deleteBtn.addEventListener('click', async () => {
                    this.plugin.settings.commands.splice(index, 1);
                    await this.plugin.saveSettings();
                    this.display();
                });
            }

            // Show prompt preview
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
            .setDesc('Use {} for selected text, {activeNote} for current note, {[[Note]]} for linked notes, {#tag} for tagged notes')
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
                // Edit existing
                this.command.name = name;
                this.command.prompt = prompt;
            } else {
                // Create new
                const newCommand = {
                    id: `custom-${Date.now()}`,
                    name: name,
                    prompt: prompt,
                    enabled: true,
                    directReplace: false // Default to false
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