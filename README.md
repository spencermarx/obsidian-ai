# Agentic Copilot

An Obsidian plugin that integrates agentic CLI tools — [Claude Code](https://docs.anthropic.com/en/docs/claude-code), [Opencode](https://opencode.ai), Gemini CLI, and more — directly into your Obsidian workspace as a copilot.

## Features

- **Auto-detection**: Automatically detects installed agentic CLI tools on your system
- **Multi-agent support**: Switch between Claude Code, Opencode, or any custom CLI agent
- **Chat panel**: Conversational side panel with streaming responses
- **Vault-aware context**: Automatically passes your active file, selection, and vault path to the agent
- **Slash commands**: Access all agent slash commands (`/commit`, `/compact`, `/review-pr`, etc.) from within Obsidian
- **File edit integration**: Agent-suggested file edits display as diffs with Accept/Reject buttons
- **Multi-session**: Run multiple agent sessions simultaneously in separate panels
- **Editor integration**: Right-click context menu for "Ask Agent", "Explain Selection"
- **Theme-aware**: Automatically matches your Obsidian light/dark theme

## Requirements

- **Desktop only** — requires Node.js access (Electron)
- At least one agentic CLI tool installed:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code): `npm install -g @anthropic-ai/claude-code`
  - [Opencode](https://opencode.ai): `curl -fsSL https://opencode.ai/install | bash`
  - Or any custom CLI tool that accepts prompts and produces text output

## Installation

### From Obsidian Community Plugins

1. Open **Settings > Community Plugins > Browse**
2. Search for "Agentic Copilot"
3. Click **Install**, then **Enable**

### Manual Installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/spencermarx/obsidian-ai/releases)
2. Create a folder: `<your-vault>/.obsidian/plugins/agentic-copilot/`
3. Copy the three files into that folder
4. Restart Obsidian and enable the plugin in **Settings > Community Plugins**

## Usage

### Opening the Chat Panel

- Click the **bot icon** in the left ribbon, or
- Use the command palette: `Agentic Copilot: Open chat panel`

### Sending Messages

Type your message in the input area and press **Enter** to send. Use **Shift+Enter** for a newline.

The plugin automatically includes context about your active file and text selection (configurable in settings).

### Slash Commands

Type `/` in the chat input to see available agent commands. These come directly from the connected CLI tool:

- `/commit` — Commit staged changes
- `/compact` — Compact conversation context
- `/review-pr` — Review a pull request
- `/help` — Show available commands

### Editor Integration

Select text in any markdown file, then:

- **Right-click > Ask Agent** to send the selection to the agent
- **Right-click > Explain Selection** to get an explanation
- Use the command palette for more actions: Explain, Refactor, Ask about file

### File Edits

When the agent suggests file changes, they appear as diff blocks in the chat with **Accept** and **Reject** buttons. Click Accept to apply the edit to your vault.

### Multi-Session

Open additional chat panels with `Agentic Copilot: Open new chat session`. Each panel runs its own independent agent session. Configure the max concurrent sessions in settings.

## Configuration

Open **Settings > Agentic Copilot** to configure:

| Setting | Description | Default |
|---------|-------------|---------|
| Agent | Which CLI tool to use (auto-detect, specific, or custom) | Auto-detect |
| Custom binary path | Path to a custom CLI agent binary | - |
| Extra CLI arguments | Arguments appended to every invocation | - |
| Working directory | Vault root or active file's directory | Vault root |
| Include active file | Send active file content as context | On |
| Include selection | Send current selection as context | On |
| Max concurrent sessions | Maximum simultaneous agent sessions | 5 |
| Auto-apply file edits | Skip confirmation for agent file edits | Off |

## Architecture

The plugin is a thin orchestration layer — all heavy lifting is done by the CLI agent:

```
Obsidian Plugin (UI + orchestration)
    | child_process.spawn + pipes
CLI Agent (Claude Code / Opencode / custom)
    | API calls
LLM Provider (Anthropic / OpenAI / etc.)
```

### Adapter Pattern

Each CLI tool is wrapped in an `AgentAdapter` that handles:
- Binary detection and version checking
- Building spawn arguments with vault context
- Parsing the agent's streaming output into structured messages
- Exposing slash commands

Adding support for a new CLI tool is as simple as implementing the `AgentAdapter` interface.

## Development

```bash
# Clone the repository
git clone https://github.com/spencermarx/obsidian-ai.git
cd obsidian-ai

# Install dependencies
npm install

# Start development mode (watches for changes)
npm run dev

# Build for production
npm run build
```

To test in Obsidian, symlink or copy the built files to your vault:

```bash
ln -s /path/to/obsidian-ai /path/to/vault/.obsidian/plugins/agentic-copilot
```

## License

MIT
