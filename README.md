<p align="center">
  <img src="https://img.shields.io/github/v/release/spencermarx/obsidian-ai?style=flat-square&color=blue" alt="Latest Release" />
  <img src="https://img.shields.io/badge/obsidian-%3E%3D1.5.0-blueviolet?style=flat-square" alt="Obsidian" />
  <img src="https://img.shields.io/github/license/spencermarx/obsidian-ai?style=flat-square" alt="License" />
  <img src="https://img.shields.io/badge/platform-desktop%20only-orange?style=flat-square" alt="Desktop Only" />
</p>

# Agentic Copilot

> Bring your agentic CLI tools — Claude Code, Opencode, Gemini CLI, and more — directly into Obsidian as a workspace copilot. Auto-detects your environment. Zero configuration required.

**Agentic Copilot** is a thin orchestration layer that connects Obsidian to whatever agentic coding tool you already use. It doesn't reinvent the wheel — it gives the wheel a steering column inside your knowledge base.

```
You (Obsidian) <-> Agentic Copilot <-> CLI Agent <-> LLM Provider
                   ~~~~~~~~~~~~~~~
                   (this plugin)
```

---

## Quickstart

**1. Install a CLI agent** (if you don't have one already):

```bash
# Claude Code
npm install -g @anthropic-ai/claude-code

# — or —

# Opencode
curl -fsSL https://opencode.ai/install | bash
```

**2. Install the plugin** (pick one method):

| Method | Steps |
|--------|-------|
| **Community Plugins** | Settings > Community Plugins > Browse > search "Agentic Copilot" > Install > Enable |
| **BRAT** (beta/pre-release) | Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) > Add beta plugin > enter `spencermarx/obsidian-ai` |
| **Manual** | Download `main.js`, `manifest.json`, `styles.css` from the [latest release](https://github.com/spencermarx/obsidian-ai/releases) into `<vault>/.obsidian/plugins/agentic-copilot/` > restart Obsidian > enable |

**3. Open the chat panel**: Click the bot icon in the ribbon, or `Ctrl/Cmd+P` > "Agentic Copilot: Open chat panel".

That's it. The plugin auto-detects your agent and you're ready to go.

---

## Features

### Chat Panel
A conversational side panel that streams agent responses in real-time, rendered with Obsidian's native markdown engine (so links, code blocks, and themes all just work).

### Vault-Aware Context
Every prompt automatically includes your active file, text selection, and vault path — so the agent knows what you're looking at. Fully configurable in settings.

### Slash Commands
Type `/` in the chat input to autocomplete agent-native commands. These come directly from the connected CLI tool — `/commit`, `/compact`, `/review-pr`, `/help`, etc.

### File Edit Diffs
When the agent suggests file changes, they appear as inline diffs with **Accept** / **Reject** buttons. No changes are applied without your confirmation (unless you enable auto-apply).

### Multi-Session
Open multiple independent chat panels, each with its own agent session. Use different agents in different panels, or run parallel conversations with the same one.

### Editor Integration
Select text in any file, then:
- **Right-click > Ask Agent** — send the selection as a prompt
- **Right-click > Explain Selection** — get an explanation
- **Command palette** — Explain, Refactor, Ask about file, Run slash command

### Multi-Agent Auto-Detection
On load, the plugin scans your PATH for known CLI tools and presents the first one found. Switch agents anytime via the command palette (`Agentic Copilot: Switch agent`) or in settings.

| Agent | Binary | Output Mode |
|-------|--------|-------------|
| Claude Code | `claude` | `--output-format stream-json` (structured streaming) |
| Opencode | `opencode` | `run` mode (text/JSON) |
| Custom | any | stdin/stdout pipes |

---

## All Commands

Open with `Ctrl/Cmd+P` (command palette):

| Command | Description |
|---------|-------------|
| `Agentic Copilot: Open chat panel` | Open or focus the chat sidebar |
| `Agentic Copilot: Open new chat session` | Open an additional chat panel (multi-session) |
| `Agentic Copilot: Ask agent about current file` | Send the active file to the agent |
| `Agentic Copilot: Ask agent about selection` | Send selected text to the agent |
| `Agentic Copilot: Explain selection` | Ask the agent to explain selected text |
| `Agentic Copilot: Refactor selection` | Ask the agent to refactor selected code |
| `Agentic Copilot: Run agent slash command` | Fuzzy-search and execute an agent slash command |
| `Agentic Copilot: Restart agent session` | Kill and restart the current session |
| `Agentic Copilot: Switch agent` | Switch between detected CLI agents |

---

## Configuration

Open **Settings > Agentic Copilot**:

### Agent

| Setting | Description | Default |
|---------|-------------|---------|
| Agent | Which CLI tool to use (`Auto-detect`, specific agent, or `Custom`) | Auto-detect |
| Custom binary path | Full path or command name for a custom CLI agent | — |
| Extra CLI arguments | Additional args appended to every invocation (e.g., `--model opus`) | — |

### Context

| Setting | Description | Default |
|---------|-------------|---------|
| Working directory | Agent's cwd: vault root or active file's parent directory | Vault root |
| Include active file | Auto-include the active file's content in every prompt | On |
| Include selection | Auto-include the current text selection in every prompt | On |

### Sessions

| Setting | Description | Default |
|---------|-------------|---------|
| Max concurrent sessions | Maximum simultaneous agent sessions | 5 |

### Advanced

| Setting | Description | Default |
|---------|-------------|---------|
| Auto-apply file edits | Apply agent-suggested edits without confirmation. **Use with caution.** | Off |

---

## Troubleshooting

### "No agentic CLI tools found"

The plugin couldn't find any known CLI binaries on your PATH.

1. **Verify installation**: Open a terminal and run `claude --version` or `opencode version`
2. **Check PATH**: Obsidian inherits the system PATH. If you installed a tool via a version manager (nvm, fnm, mise), ensure the binary is on the default PATH — not just your shell profile
3. **Use a custom binary path**: Go to Settings > Agentic Copilot > set Agent to "Custom" and enter the full path (e.g., `/Users/you/.nvm/versions/node/v20/bin/claude`)
4. **Restart Obsidian**: Detection runs on plugin load. Restart after installing a new CLI tool

### Agent hangs or produces no output

- Click the **Stop** button to kill the process
- Use `Agentic Copilot: Restart agent session` from the command palette
- Check that your CLI tool works standalone: `claude -p "hello"` should produce output
- If using custom args, temporarily clear them in settings to rule out conflicts

### "Process exited with code 1"

The CLI tool crashed. Common causes:
- **Missing API key**: Most agents need an API key set as an environment variable (e.g., `ANTHROPIC_API_KEY`). Set it in your shell profile so Obsidian inherits it
- **Rate limiting**: You've exceeded the provider's rate limit. Wait and retry
- **Network error**: Check your internet connection

### Plugin doesn't load on mobile

This plugin is **desktop only**. It requires Node.js's `child_process` module to spawn CLI tools, which is only available in Obsidian's Electron (desktop) environment.

### Theme doesn't look right

The plugin uses Obsidian's CSS variables for all styling. If something looks off:
- Try switching themes to confirm it's not a theme-specific issue
- File an issue with your theme name and a screenshot

---

## How It Works

### Architecture

```
┌────────────────────────────────────────┐
│            Obsidian Plugin             │
│                                        │
│  ┌──────────┐    ┌──────────────────┐  │
│  │Chat View │    │ Editor Actions   │  │
│  │(ItemView)│    │ (context menu,   │  │
│  │          │    │  command palette) │  │
│  └────┬─────┘    └───────┬──────────┘  │
│       │                  │             │
│  ┌────▼──────────────────▼──────────┐  │
│  │       Session Manager            │  │
│  │  (spawn, lifecycle, streaming)   │  │
│  └──────────────┬───────────────────┘  │
│                 │                      │
│  ┌──────────────▼───────────────────┐  │
│  │       Adapter Layer              │  │
│  │  ┌──────────┐ ┌────────┐        │  │
│  │  │Claude    │ │Opencode│ ┌────┐ │  │
│  │  │Code      │ │        │ │Any │ │  │
│  │  │(stream-  │ │(run    │ │CLI │ │  │
│  │  │ json)    │ │ mode)  │ │    │ │  │
│  │  └──────────┘ └────────┘ └────┘ │  │
│  └──────────────────────────────────┘  │
└────────────────┬───────────────────────┘
                 │ child_process.spawn()
                 ▼
          ┌─────────────┐
          │  CLI Agent   │
          │  (your tool) │
          └──────┬──────┘
                 │ API calls
                 ▼
          ┌─────────────┐
          │ LLM Provider │
          └─────────────┘
```

### Why `child_process.spawn` (not node-pty)?

`node-pty` requires native compilation per platform — impractical for an Obsidian plugin that must install without a build step. Instead, we use Node.js `child_process.spawn` with piped stdio, and rely on structured output modes (e.g., Claude Code's `--output-format stream-json`) for rich, parseable data. Trade-off: no full TTY emulation. Benefit: zero native dependencies, instant cross-platform install.

### Adding a New Agent

Implement the `AgentAdapter` interface in `src/adapters/`:

```typescript
interface AgentAdapter {
  readonly id: string;            // unique identifier
  readonly displayName: string;   // shown in UI
  readonly binaryName: string;    // CLI binary name

  detect(): Promise<boolean>;     // is it installed?
  getVersion(): Promise<string | null>;

  buildSpawnArgs(opts: {
    prompt: string;
    context: VaultContext;
    cwd: string;
  }): SpawnArgs;

  parseOutputStream(stdout: Readable): AsyncIterable<AgentMessage>;

  getSlashCommands(): SlashCommand[];
  formatSlashCommand(command: string, args?: string): string;
}
```

Then register it in `src/adapters/detector.ts`:

```typescript
const ADAPTER_CONSTRUCTORS: Array<() => AgentAdapter> = [
  () => new ClaudeCodeAdapter(),
  () => new OpencodeAdapter(),
  () => new YourNewAdapter(),  // <-- add here
];
```

That's it. The detection, settings UI, and chat panel all pick it up automatically.

---

## Development

### Setup

```bash
git clone https://github.com/spencermarx/obsidian-ai.git
cd obsidian-ai
npm install
```

### Dev Mode

```bash
npm run dev
```

This watches `src/` and rebuilds `main.js` on every change. Symlink into a test vault:

```bash
# macOS/Linux
ln -s "$(pwd)" "/path/to/vault/.obsidian/plugins/agentic-copilot"

# Windows (PowerShell, as admin)
New-Item -ItemType SymbolicLink -Path "C:\path\to\vault\.obsidian\plugins\agentic-copilot" -Target "$(Get-Location)"
```

Then reload Obsidian (`Ctrl/Cmd+R`) to pick up changes.

### Production Build

```bash
npm run build
```

Outputs: `main.js` (single bundled file, ~56KB).

### Project Structure

```
src/
├── main.ts                 # Plugin entry: onload, commands, views
├── constants.ts            # Settings interface, view type IDs
├── settings.ts             # PluginSettingTab implementation
├── adapters/
│   ├── types.ts            # AgentAdapter interface
│   ├── claude-code.ts      # Claude Code adapter
│   ├── opencode.ts         # Opencode adapter
│   ├── generic-cli.ts      # Generic fallback adapter
│   └── detector.ts         # Auto-detection logic
├── session/
│   ├── session-manager.ts  # Process lifecycle management
│   └── message-queue.ts    # Stream buffering
├── views/
│   ├── chat-view.ts        # Main chat panel (ItemView)
│   ├── chat-renderer.ts    # Markdown + tool-use rendering
│   └── onboarding-view.ts  # First-run setup
└── utils/
    ├── vault-context.ts    # Vault/file/selection context
    └── platform.ts         # Cross-platform utilities
```

---

## FAQ

**Q: Does this send my vault data to a third party?**
A: The plugin itself sends nothing externally. It passes context to your locally-installed CLI agent, which then communicates with its configured LLM provider. Your data flows through the same path it would if you ran the CLI tool directly in a terminal.

**Q: Can I use this on mobile?**
A: No. The plugin requires Node.js `child_process` to spawn CLI tools, which is only available on desktop (Electron).

**Q: What if I have both Claude Code and Opencode installed?**
A: The plugin auto-detects both. By default it uses the first one found (Claude Code takes priority). You can switch anytime via Settings or the `Switch agent` command.

**Q: Can I use my own custom AI tool?**
A: Yes. Set Agent to "Custom" in settings and enter the binary name or full path. The plugin will pipe your prompt as a CLI argument and read stdout as the response.

**Q: Does the agent have access to my entire vault?**
A: The plugin passes the vault path as the working directory, and optionally the active file's content and your text selection. The CLI agent can then read files within that directory as it normally would. This is the same access the agent has when you run it from a terminal in your vault folder.

**Q: How do I update the plugin?**
A: If installed via Community Plugins or BRAT, updates are automatic. For manual installs, download the latest release files and replace the old ones.

---

## Contributing

Contributions are welcome! The most impactful way to contribute is **adding a new adapter** for a CLI tool you use. See [Adding a New Agent](#adding-a-new-agent) above.

For bug reports and feature requests, please [open an issue](https://github.com/spencermarx/obsidian-ai/issues).

## License

[MIT](LICENSE)
