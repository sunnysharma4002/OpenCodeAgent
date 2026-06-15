# OpenCode Agent 🧠⚡

**OpenCode Agent** is a VS Code extension that brings an AI-powered coding agent directly into your editor sidebar. Powered by the [OpenCode Zen API](https://opencode.ai), it can autonomously inspect, edit, and write code in your workspace using a set of built-in tools.

## Features

- **🤖 AI Chat Panel** – A webview-based chat interface in the VS Code activity bar.
- **🛠️ Tool-Use Capabilities** – The agent can autonomously:
  - **Read files** – View any file in your workspace.
  - **Write files** – Create or overwrite files (creates directories automatically).
  - **List directories** – Explore your project structure.
  - **Run shell commands** – Execute commands in the workspace root.
  - **Grep search** – Search for regex patterns across your project.
- **🧠 Multiple Models** – Switch between several AI models on the fly.
- **💬 Conversational History** – Conversations persist across VS Code sessions.
- **🔧 Configurable API Key** – Set your OpenCode API key in VS Code settings.

## Installation

### From VSIX

1. Download the `.vsix` file from the [releases page](https://github.com/your-org/opencode-agent/releases).
2. In VS Code, open the Extensions view (`Ctrl+Shift+X`), click the `...` menu → **Install from VSIX...**
3. Select the downloaded `.vsix` file.
4. Reload VS Code.

### From VS Code Marketplace

*(Coming soon)*

## Usage

1. Click the **OpenCode Agent** icon in the activity bar (left sidebar).
2. The chat panel opens. Type your request in the text box and press `Enter` or click **Send**.
3. Watch the agent think, call tools, and respond with results!

### Example prompts

- *"Read the contents of src/extension.ts"*
- *"List all files in the src directory"*
- *"Search for 'fetch' in all .ts files"*
- *"Create a new file called hello.txt with 'Hello, World!'"*
- *"Run npm test"*
- *"Explain the architecture of this project"*

### Switching models

Click the model name dropdown at the top of the chat panel to switch between available AI models.

### Starting a new session

Click the **+ New** button to clear the conversation history and start fresh.

## Configuration

Open VS Code settings (`Ctrl+,`) and search for `opencodeAgent`:

| Setting | Default | Description |
|---------|---------|-------------|
| `opencodeAgent.apiKey` | *(pre-configured)* | Your OpenCode API key. |

## Tool Reference

The agent can use these tools to interact with your workspace:

| Tool | Description |
|------|-------------|
| `read_file` | Read a file's contents (path relative to workspace root). |
| `write_file` | Write content to a file (creates parent directories). |
| `list_files` | List files and directories in a folder. |
| `run_command` | Execute a shell command in the workspace directory (30s timeout). |
| `grep_search` | Search for a regex pattern in workspace files. |

## Building from source

### Prerequisites

- [Node.js](https://nodejs.org/) (v18 or newer)
- npm

### Setup

```bash
git clone <repository-url>
cd opencode-agent
npm install
```

### Build the extension

Compile the TypeScript source and bundle the extension:

```bash
npm run build
```

### Package a VSIX

To create a `.vsix` file that can be installed directly in VS Code:

```bash
npm run package
```

This runs the build first, then packages the extension into `opencode-agent-<version>.vsix` using `vsce`. You can install the resulting `.vsix` file via the Extensions view → `...` → **Install from VSIX...**

If you need to package without publishing, use:

```bash
npx vsce package
```

### Watch mode

During development, you can run the build in watch mode for automatic recompilation:

```bash
npm run watch
```

## Security

- All tool operations are **sandboxed to the workspace root** – path traversal attacks are blocked.
- Shell commands run with the same privileges as VS Code.
- The API key can be changed at any time in settings.

## Requirements

- **VS Code** `^1.90.0`

## License

[MIT](./LICENSE)

## Support

If you encounter any issues or have feature requests, please open an issue on the [GitHub repository](https://github.com/your-org/opencode-agent/issues).

---

*OpenCode Agent is not officially affiliated with VS Code or Microsoft. It is an open-source project powered by the OpenCode Zen API.*
