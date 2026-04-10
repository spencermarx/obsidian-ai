# Contributing to Agentic Copilot

Thanks for your interest in contributing! This document covers everything you need to get started.

## Getting started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Obsidian](https://obsidian.md/) desktop app
- At least one supported CLI tool installed: [Claude Code](https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/overview), [Opencode](https://opencode.ai), or [Gemini CLI](https://github.com/google-gemini/gemini-cli)

### Local development setup

1. **Clone the repo** into your vault's plugin directory:

   ```bash
   cd /path/to/your/vault/.obsidian/plugins
   git clone https://github.com/spencermarx/obsidian-ai.git agentic-copilot
   cd agentic-copilot
   npm install
   ```

   Or clone elsewhere and symlink:

   ```bash
   git clone https://github.com/spencermarx/obsidian-ai.git
   cd obsidian-ai
   npm install
   ln -s "$(pwd)" /path/to/your/vault/.obsidian/plugins/agentic-copilot
   ```

2. **Start dev mode:**

   ```bash
   npm run dev
   ```

   This runs esbuild in watch mode -- changes rebuild automatically.

3. **Reload Obsidian** (`Cmd+R` / `Ctrl+R`) to pick up changes. Enable the plugin under Settings > Community plugins if this is the first time.

### Build commands

| Command            | Purpose                                      |
|--------------------|----------------------------------------------|
| `npm run dev`      | Watch mode (esbuild, incremental)            |
| `npm run build`    | TypeScript check + production esbuild bundle |
| `npm run version`  | Bump version in manifest.json & versions.json|

## Architecture overview

See the [CLAUDE.md](./CLAUDE.md) file for a detailed architecture guide covering the adapter layer, session management, view layer, and key design decisions.

**Key directories:**

```
src/
  adapters/     # CLI tool adapters (Claude Code, Opencode, Generic)
  session/      # Process spawning and message queue
  views/        # Obsidian ItemView chat panel and renderer
  utils/        # Vault context, platform helpers
```

## Making changes

### Branching

- Create a feature branch from `main`: `git checkout -b feat/my-feature`
- Use [conventional commits](https://www.conventionalcommits.org/) for commit messages:
  - `feat(scope): description` -- new features
  - `fix(scope): description` -- bug fixes
  - `refact(scope): description` -- refactors
  - `chore: description` -- maintenance, deps, tooling

### Code style

- TypeScript strict mode is enabled
- No linter is configured yet -- follow the existing patterns in the codebase
- Keep adapter implementations self-contained: each adapter file should encapsulate all CLI-specific logic
- Prefer the Obsidian API (`createDiv`, `createEl`, `setIcon`, etc.) over raw DOM manipulation

### Adding a new CLI adapter

1. Create `src/adapters/your-cli.ts` implementing the `AgentAdapter` interface from `src/adapters/types.ts`
2. Register it in `src/adapters/detector.ts`
3. Add the binary name to the PATH expansion in `src/utils/platform.ts` if needed

### Testing

No test framework is configured yet. Verify changes by:

1. Running `npm run build` (TypeScript must compile cleanly)
2. Manual testing in Obsidian with the relevant CLI tool(s)
3. Checking the developer console (`Cmd+Option+I`) for errors

## Submitting a pull request

1. Ensure `npm run build` passes with no errors
2. Keep PRs focused -- one logical change per PR
3. Write a clear description of what changed and why
4. If your PR addresses an open issue, reference it (e.g., `Fixes #123`)

## Reporting bugs

Use the [Bug Report](https://github.com/spencermarx/obsidian-ai/issues/new?template=bug_report.yml) issue template. Include:

- Plugin version and CLI agent/version
- Steps to reproduce
- Console logs or screenshots if available

## Releases

Releases are automated. When a bare version tag (e.g., `1.3.1`) is pushed, GitHub Actions builds and publishes `main.js`, `manifest.json`, and `styles.css` as a release.

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](./LICENSE).
