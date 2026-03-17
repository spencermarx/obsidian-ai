# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Agentic Copilot** is an Obsidian plugin that bridges agentic CLI tools (Claude Code, Opencode, Gemini CLI) into Obsidian as a workspace copilot. It provides a chat panel, vault-aware context, slash commands, and file edit diffs with confirmation workflows. Desktop only (requires Node.js `child_process`).

## Build & Development Commands

```bash
npm run dev        # Watch mode (esbuild)
npm run build      # TypeScript check + production esbuild bundle
npm run version    # Bump version in manifest.json & versions.json
```

No test framework is configured. No linter is configured.

**Local development:** Symlink the repo into `<vault>/.obsidian/plugins/agentic-copilot`, run `npm run dev`, and reload Obsidian (`Cmd+R`).

**Release:** Tag a bare version (e.g., `1.0.1`) and push. GitHub Actions builds and creates a release with `main.js`, `manifest.json`, `styles.css`.

## Architecture

The plugin follows a layered architecture:

**Entry point** (`src/main.ts`): Extends Obsidian's `Plugin` class. Registers the chat view, settings tab, ribbon icon, and all commands. Orchestrates agent detection, adapter resolution, and session lifecycle.

**Adapter layer** (`src/adapters/`): Pluggable interface (`AgentAdapter`) for different CLI tools. Each adapter knows how to detect its binary, build spawn args, and parse its output format. Implementations:
- `claude-code.ts` — Parses `--output-format stream-json` structured output with content block tracking
- `opencode.ts` — Parses plain text / JSON lines from `-p` headless mode
- `generic-cli.ts` — Fallback for custom CLI tools; reads all stdout as plain text
- `detector.ts` — Scans system PATH for known binaries, returns prioritized list

**Session layer** (`src/session/`): `SessionManager` spawns child processes via `child_process.spawn()`, pipes stdout through the adapter's parser, and emits events (`message`, `status`, `error`, `complete`). `MessageQueue` buffers streaming text deltas into complete messages, flushing on role/thinking-state transitions.

**View layer** (`src/views/`): `ChatView` is an Obsidian `ItemView` sidebar panel with real-time streaming rendering, slash command autocomplete (`/`), file mention autocomplete (`@`), edit diff rendering with Accept/Reject buttons, and multi-session support. `ChatRenderer` converts agent messages to DOM using Obsidian's `MarkdownRenderer`. `OnboardingView` shows setup instructions when no CLI tools are detected.

**Utilities** (`src/utils/`): `vault-context.ts` gathers active file path/content, text selection, and cursor position. `platform.ts` handles cross-platform shell detection and PATH expansion (prepends `~/.local/bin`, `~/.cargo/bin`, `/opt/homebrew/bin`, etc. to work around Obsidian's minimal GUI-launched PATH).

## Key Design Decisions

- **No TTY emulation**: Uses piped stdio with structured output modes (stream-json) instead of `node-pty` to avoid native compilation requirements.
- **Session persistence**: CLI session IDs are passed to agents for multi-turn conversation and resumption.
- **Multi-session**: Each chat panel leaf owns an independent session with its own process.
- **Edit approval workflow**: Configurable approve vs auto-accept mode for file edits surfaced by the agent.

## Key Interfaces

`AgentAdapter` (`src/adapters/types.ts`): Core interface all adapters implement — `detect()`, `buildSpawnArgs()`, `parseOutputStream()`, `getSlashCommands()`.

`AgentMessage` (`src/adapters/types.ts`): Unified message type with `role`, `content`, `isThinking`, `toolUse`, `fileEdit`, `cliSessionId`, `timestamp`.

`AgenticCopilotSettings` (`src/constants.ts`): Plugin settings — `selectedAgent`, `customBinaryPath`, `workingDirectory`, `maxSessions`, `editApprovalMode`, context toggles.

## Build Configuration

- **esbuild** bundles `src/main.ts` → `main.js` (ESNext modules, ES2018 target)
- `obsidian` is marked external (provided by the host app)
- TypeScript strict mode enabled, isolated modules
- Output: `main.js`, `manifest.json`, `styles.css` are the release artifacts
