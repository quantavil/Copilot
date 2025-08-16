# Obsidian Copilot

Bring AI into your notes with custom commands powered by Gemini API.

This is an Obsidian plugin that allows you to use Google's Gemini AI to interact with your notes. It provides a chat interface and allows you to define custom commands to process text selections or entire notes.

## Features

*   **AI Chat View**: A sidebar chat view to talk with Gemini AI.
*   **Custom Commands**: Create and customize your own commands to process text.
*   **Context-Aware**: Use content from your current note, linked notes, or notes with specific tags in your prompts.
*   **Slash Commands**: Access your custom commands directly in the editor using `/`.
*   **Bulk Actions**: Perform AI actions on multiple notes at once, based on tags, folders, or links.
*   **Flexible Output**: Choose to replace selected text directly or view the AI output in a modal to copy or append.

## How to Use

1.  **Install the plugin**: Download the files from the latest release and place them in your Obsidian vault's `.obsidian/plugins` directory.
2.  **Enable the plugin**: Go to `Settings` -> `Community plugins` and enable "Copilot".
3.  **Configure the API Key**:
    *   Go to the plugin settings for "Copilot".
    *   Enter your Google Gemini API key. You can get one from [Google AI Studio](https://aistudio.google.com/app/apikey).
    *   Click "Verify" to make sure your API key is working.
4.  **Start a Chat**:
    *   Click the "Copilot Chat" icon in the ribbon (left sidebar) to open the chat view.
    *   Type your questions and press Enter to chat with the AI.
5.  **Use Commands**:
    *   Select some text in the editor.
    *   Right-click and choose a command from the "Copilot Actions" submenu.
    *   Alternatively, type `/` in the editor to see a list of available commands.

## Settings

*   **Gemini API Key**: Your API key for the Gemini API.
*   **Default Model**: Choose the Gemini model to use (e.g., `gemini-1.5-flash`).
*   **System Prompt**: A custom instruction to guide the AI's behavior for all interactions.
*   **Custom Commands**:
    *   **Add New Command**: Create a new custom command.
    *   **Command Name**: The name of the command that will appear in the menu.
    *   **Prompt Template**: The prompt to send to the AI. Use the following placeholders:
        *   `{}`: The currently selected text.
        *   `{activeNote}`: The content of the current note.
        *   `{[[Note Title]]}`: The content of a linked note.
        *   `{#tag}`: The content of all notes with a specific tag.
    *   **Enabled/Disabled**: Toggle commands on or off.
    *   **Direct Replace/Show Output**: Choose whether the command replaces the selection directly or shows the output in a modal.

## License

This plugin is licensed under the [MIT License](LICENSE).
