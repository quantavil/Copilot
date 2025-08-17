# Obsidian Copilot: Your AI-Powered Second Brain

Obsidian Copilot brings the power of Google's Gemini API directly into your Obsidian vault. It's more than just a chatbot; it's a powerful tool for thought, designed to help you write, refactor, and think better.

## Features

- **🤖 AI Chat Assistant:** A dedicated sidebar for conversational AI. Ask questions, brainstorm ideas, and get instant feedback without leaving Obsidian.
- **✨ Custom AI Commands:** Create your own commands to process and transform your notes. Summarize, translate, refactor, or analyze text with a single click.
- **🧠 Context-Aware Prompts:** Enhance your prompts with the content of your current note, linked notes, or notes with specific tags.
- **⚡️ Slash Commands:** Access your custom commands instantly from the editor by typing `/`.
- **✍️ Flexible Output:** Choose to have AI-generated content replace your selected text or view it in a modal to copy and paste.
- **📄 Canvas Integration:** Save your conversations to a new "canvas" file using `/canvas`. You can also work on a specific file by setting it as a "context file" with `/canvas -f [[Note Title]]`.
- **MODEL SELECTION:** Choose between different Gemini models (`gemini-2.5-pro`, `gemini-2.5-flash`, `gemini-2.5-flash-lite`) directly from the chat interface.
- **CHAT HISTORY:** Your chat history is saved and can be accessed from the chat view.

## Getting Started

1.  **Installation:**
    - **Recommended:** Install directly from the Obsidian Community Plugins browser.
    - **Manual:** Download the latest release from the [releases page](https://github.com/quantavil/obsidian-copilot/releases) and extract the files into your vault's `.obsidian/plugins` directory.
2.  **Enable the Plugin:** Go to `Settings` -> `Community Plugins` and enable "Copilot".
3.  **Add Your API Key:**
    - Open the Copilot settings in Obsidian.
    - Paste your Google Gemini API key. You can get one from [Google AI Studio](https://aistudio.google.com/app/apikey).
    - Click "Verify" to confirm your key is working.

## How to Use

- **Chat:** Click the "Copilot Chat" icon in the ribbon to open the chat view.
- **Commands:**
    - Select text in the editor.
    - Right-click and choose a command from the "Copilot Actions" menu.
    - Or, type `/` in the editor to see a list of your custom commands.

## Customization

Create powerful, personalized workflows with custom commands:

- **Command Name:** A descriptive name for your command.
- **Prompt Template:** The instruction for the AI. Use these placeholders to make your prompts dynamic:
    - `{}`: The currently selected text.
    - `{activeNote}`: The content of the current note.
    - `{[[Note Title]]}`: The content of a linked note.
    - `{#tag}`: The content of all notes with a specific tag.
- **Output:** Choose to either replace the selected text or show the output in a modal.

## Contributing

This plugin is an open-source project. We welcome contributions of all kinds. Please feel free to open an issue or submit a pull request on our [GitHub repository](https://github.com/quantavil/obsidian-copilot).

## Disclaimer

This plugin uses the Google Gemini API, which is a third-party service. Your use of the API is subject to Google's terms of service and privacy policy. Please be mindful of the data you send to the API.

## License

This plugin is licensed under the MIT License.
