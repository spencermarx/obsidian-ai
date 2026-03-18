import {
	Plugin,
	Notice,
	MarkdownView,
	FuzzySuggestModal,
	App,
	TFile,
	Platform,
} from "obsidian";
import { exec } from "child_process";
import {
	CHAT_VIEW_TYPE,
	DEFAULT_SETTINGS,
	AgenticCopilotSettings,
} from "./constants";
import { AgentAdapter, SlashCommand } from "./adapters/types";
import {
	detectAgents,
	getAdapterById,
	DetectedAgent,
} from "./adapters/detector";
import { GenericCliAdapter } from "./adapters/generic-cli";
import { SessionManager } from "./session/session-manager";
import { ChatView } from "./views/chat-view";
import { OnboardingView } from "./views/onboarding-view";
import { AgenticCopilotSettingTab } from "./settings";
import { getExpandedPath } from "./utils/platform";

/**
 * Agentic Copilot — Obsidian Plugin
 *
 * Bridges agentic CLI tools (Claude Code, Opencode, Gemini CLI, etc.)
 * directly into Obsidian as a workspace copilot. Auto-detects installed
 * agents, provides a chat panel, and integrates with the editor.
 */
export default class AgenticCopilotPlugin extends Plugin {
	settings: AgenticCopilotSettings = DEFAULT_SETTINGS;
	private sessionManager: SessionManager = new SessionManager();
	private detectedAgents: DetectedAgent[] = [];
	private activeAdapter: AgentAdapter | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		// Detect available agents
		this.detectedAgents = await detectAgents();

		// Resolve which adapter to use
		this.activeAdapter = this.resolveAdapter();

		// Register the chat view
		this.registerView(CHAT_VIEW_TYPE, (leaf) => {
			if (this.activeAdapter) {
				return new ChatView(
					leaf,
					this.sessionManager,
					this.settings,
					this.activeAdapter,
					this.applyFileEdit.bind(this),
					this.revertFileEdit.bind(this),
					this.saveSettings.bind(this)
				);
			} else {
				return new OnboardingView(
					leaf,
					this.detectedAgents,
					(agentId: string) => {
						this.settings.selectedAgent = agentId;
						void this.saveSettings();
						this.activeAdapter = this.resolveAdapter();
						void this.activateChatView();
					}
				);
			}
		});

		// Register settings tab
		this.addSettingTab(
			new AgenticCopilotSettingTab(
				this.app,
				this,
				this.detectedAgents
			)
		);

		// Register commands
		this.registerCommands();

		// Ribbon icon
		this.addRibbonIcon("bot", "Open agentic copilot", () => {
			void this.activateChatView();
		});

		// Notify user
		if (this.activeAdapter) {
			new Notice(
				`Agentic Copilot: ${this.activeAdapter.displayName} detected`
			);
		} else if (this.detectedAgents.length === 0) {
			// Don't spam on every load — only show if explicitly opened
		}
	}

	onunload(): void {
		this.sessionManager.destroyAll();
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	/**
	 * Resolve which adapter to use based on settings and detected agents.
	 */
	private resolveAdapter(): AgentAdapter | null {
		const { selectedAgent, customBinaryPath } = this.settings;

		// Custom binary
		if (selectedAgent === "custom" && customBinaryPath) {
			return new GenericCliAdapter(customBinaryPath);
		}

		// Auto-detect: use first available
		if (selectedAgent === "auto") {
			if (this.detectedAgents.length > 0) {
				return this.detectedAgents[0].adapter;
			}
			// No agents found
			return null;
		}

		// Specific agent selected
		const detected = this.detectedAgents.find(
			(a) => a.adapter.id === selectedAgent
		);
		if (detected) {
			return detected.adapter;
		}

		// Agent selected but not detected — try anyway
		return getAdapterById(selectedAgent, customBinaryPath);
	}

	/**
	 * Open or focus the chat view in the right sidebar.
	 */
	private async activateChatView(): Promise<void> {
		const existing =
			this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);

		if (existing.length > 0) {
			void this.app.workspace.revealLeaf(existing[0]);
			return;
		}

		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({
				type: CHAT_VIEW_TYPE,
				active: true,
			});
			void this.app.workspace.revealLeaf(leaf);
		}
	}

	/**
	 * Open a NEW chat view (for multi-session support).
	 */
	private async openNewChatView(): Promise<void> {
		const activeSessions =
			this.sessionManager.getActiveSessions().length;
		if (activeSessions >= this.settings.maxSessions) {
			new Notice(
				`Maximum ${this.settings.maxSessions} concurrent sessions reached.`
			);
			return;
		}

		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({
				type: CHAT_VIEW_TYPE,
				active: true,
			});
			void this.app.workspace.revealLeaf(leaf);
		}
	}

	/**
	 * Register all plugin commands.
	 */
	private registerCommands(): void {
		// Open chat panel
		this.addCommand({
			id: "open-chat",
			name: "Open chat panel",
			callback: () => { void this.activateChatView(); },
		});

		// Open new chat session
		this.addCommand({
			id: "new-chat-session",
			name: "Open new chat session",
			callback: () => { void this.openNewChatView(); },
		});

		// Ask about current file
		this.addCommand({
			id: "ask-about-file",
			name: "Ask agent about current file",
			checkCallback: (checking) => {
				const view =
					this.app.workspace.getActiveViewOfType(MarkdownView);
				if (!view?.file) return false;
				if (!checking) {
					void this.askAboutFile(view.file.path);
				}
				return true;
			},
		});

		// Ask about selection
		this.addCommand({
			id: "ask-about-selection",
			name: "Ask agent about selection",
			editorCheckCallback: (checking, editor) => {
				const selection = editor.getSelection();
				if (!selection) return false;
				if (!checking) {
					void this.askAboutSelection(selection);
				}
				return true;
			},
		});

		// Explain selection
		this.addCommand({
			id: "explain-selection",
			name: "Explain selection",
			editorCheckCallback: (checking, editor) => {
				const selection = editor.getSelection();
				if (!selection) return false;
				if (!checking) {
					void this.sendToChat(
						`Explain the following:\n\n${selection}`
					);
				}
				return true;
			},
		});

		// Refactor selection
		this.addCommand({
			id: "refactor-selection",
			name: "Refactor selection",
			editorCheckCallback: (checking, editor) => {
				const selection = editor.getSelection();
				if (!selection) return false;
				if (!checking) {
					void this.sendToChat(
						`Refactor the following code for better readability and maintainability:\n\n${selection}`
					);
				}
				return true;
			},
		});

		// Run slash command (fuzzy suggest)
		this.addCommand({
			id: "run-slash",
			name: "Run agent slash",
			callback: () => {
				if (!this.activeAdapter) {
					new Notice("No agent configured");
					return;
				}
				const commands = this.activeAdapter.getSlashCommands();
				if (commands.length === 0) {
					new Notice("No slash commands available for this agent");
					return;
				}
				new SlashCommandModal(this.app, commands, (cmd) => {
					void this.sendToChat(cmd.name);
				}).open();
			},
		});

		// Restart session
		this.addCommand({
			id: "restart-session",
			name: "Restart agent session",
			callback: () => {
				const leaves =
					this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
				if (leaves.length > 0) {
					const view = leaves[0].view;
					if (view instanceof ChatView && this.activeAdapter) {
						view.setAdapter(this.activeAdapter);
						new Notice("Agent session restarted");
					}
				}
			},
		});

		// Switch agent
		this.addCommand({
			id: "switch-agent",
			name: "Switch agent",
			callback: () => {
				if (this.detectedAgents.length === 0) {
					new Notice("No agents detected");
					return;
				}
				new AgentSwitchModal(
					this.app,
					this.detectedAgents,
					(agent) => {
						this.settings.selectedAgent = agent.adapter.id;
						void this.saveSettings();
						this.activeAdapter = agent.adapter;

						// Update all open chat views
						const leaves =
							this.app.workspace.getLeavesOfType(
								CHAT_VIEW_TYPE
							);
						for (const leaf of leaves) {
							if (leaf.view instanceof ChatView) {
								leaf.view.setAdapter(agent.adapter);
							}
						}

						new Notice(
							`Switched to ${agent.adapter.displayName}`
						);
					}
				).open();
			},
		});

		// Open agent in system terminal (interactive shell)
		this.addCommand({
			id: "open-in-terminal",
			name: "Open agent in terminal (interactive)",
			callback: () => {
				if (!this.activeAdapter) {
					new Notice("No agent configured");
					return;
				}
				this.openAgentInTerminal();
			},
		});

		// Register editor context menu
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor) => {
				const selection = editor.getSelection();
				if (!selection) return;

				menu.addItem((item) => {
					item.setTitle("Ask agent")
						.setIcon("bot")
						.onClick(() => {
							void this.askAboutSelection(selection);
						});
				});

				menu.addItem((item) => {
					item.setTitle("Explain selection")
						.setIcon("help-circle")
						.onClick(() => {
							void this.sendToChat(
								`Explain the following:\n\n${selection}`
							);
						});
				});
			})
		);
	}

	/**
	 * Send a prompt to the active chat view, opening it if needed.
	 */
	private async sendToChat(prompt: string): Promise<void> {
		await this.activateChatView();

		// Small delay to ensure view is ready
		setTimeout(() => {
			const leaves =
				this.app.workspace.getLeavesOfType(CHAT_VIEW_TYPE);
			if (leaves.length > 0 && leaves[0].view instanceof ChatView) {
				void leaves[0].view.injectPrompt(prompt);
			}
		}, 100);
	}

	private async askAboutFile(filePath: string): Promise<void> {
		await this.sendToChat(
			`Tell me about this file: ${filePath}`
		);
	}

	private async askAboutSelection(selection: string): Promise<void> {
		await this.sendToChat(selection);
	}

	/**
	 * Launch the active agent's CLI in the system terminal for a fully
	 * interactive session. Uses the vault root as the working directory.
	 */
	private openAgentInTerminal(): void {
		if (!this.activeAdapter) return;

		const adapter = this.app.vault.adapter as {
			getBasePath?: () => string;
		};
		const vaultPath =
			typeof adapter.getBasePath === "function"
				? adapter.getBasePath()
				: "";

		const binary = this.activeAdapter.binaryName;
		const expandedPath = getExpandedPath();

		if (Platform.isMacOS) {
			// macOS: open Terminal.app with the command
			const script = `tell application "Terminal"
				activate
				do script "export PATH='${expandedPath}'; cd '${vaultPath}' && ${binary}"
			end tell`;
			exec(`osascript -e '${script.replace(/'/g, "'\\''")}'`, (err) => {
				if (err) {
					new Notice(
						`Failed to open terminal: ${err.message}`
					);
				}
			});
		} else if (Platform.isLinux) {
			// Linux: try common terminal emulators
			const terminals = [
				"gnome-terminal",
				"konsole",
				"xfce4-terminal",
				"xterm",
			];
			const tryTerminal = (idx: number) => {
				if (idx >= terminals.length) {
					new Notice(
						"Could not find a terminal emulator. Please open a terminal manually."
					);
					return;
				}
				const term = terminals[idx];
				const cmd =
					term === "gnome-terminal"
						? `${term} -- bash -c "export PATH='${expandedPath}'; cd '${vaultPath}' && ${binary}; exec bash"`
						: `${term} -e "bash -c \\"export PATH='${expandedPath}'; cd '${vaultPath}' && ${binary}; exec bash\\""`;
				exec(cmd, (err) => {
					if (err) tryTerminal(idx + 1);
				});
			};
			tryTerminal(0);
		} else if (Platform.isWin) {
			// Windows: open cmd.exe
			exec(
				`start cmd.exe /k "cd /d "${vaultPath}" && ${binary}"`,
				(err) => {
					if (err) {
						new Notice(
							`Failed to open terminal: ${err.message}`
						);
					}
				}
			);
		} else {
			new Notice(
				"Terminal launch is not supported on this platform. Please open a terminal manually."
			);
		}

		new Notice(
			`Opening ${this.activeAdapter.displayName} in terminal…`
		);
	}

	/**
	 * Revert a file edit that the CLI already applied.
	 * For Edit tool: replaces newContent back with oldContent in the file.
	 * For Write tool (no oldContent): warns that full revert isn't possible.
	 */
	private async revertFileEdit(
		filePath: string,
		oldContent: string,
		newContent: string
	): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(filePath);
		if (!(file instanceof TFile)) {
			throw new Error(`File not found: ${filePath}`);
		}

		const currentContent = await this.app.vault.read(file);

		if (oldContent) {
			// Edit tool: swap newContent back to oldContent
			if (currentContent.includes(newContent)) {
				const restored = currentContent.replace(
					newContent,
					oldContent
				);
				await this.app.vault.modify(file, restored);
			} else {
				throw new Error(
					"File has been modified since the edit — cannot auto-revert"
				);
			}
		} else if (newContent) {
			// Write tool (full file replacement) — we don't have the original
			// content, so we can't perfectly revert. Warn the user.
			throw new Error(
				"Cannot revert a full file write — original content not available. Use Ctrl+Z in the editor."
			);
		}
	}

	/**
	 * Apply a file edit suggested by the agent.
	 * Handles both new files and modifications to existing files.
	 */
	private async applyFileEdit(
		filePath: string,
		oldContent: string,
		newContent: string
	): Promise<void> {
		const file = this.app.vault.getAbstractFileByPath(filePath);

		if (file instanceof TFile) {
			// Existing file — modify it
			if (oldContent) {
				// Partial edit: replace old content with new
				const currentContent = await this.app.vault.read(file);
				const updated = currentContent.replace(
					oldContent,
					newContent
				);
				await this.app.vault.modify(file, updated);
			} else {
				// Full file replacement
				await this.app.vault.modify(file, newContent);
			}
		} else {
			// New file — create it
			const dir = filePath.split("/").slice(0, -1).join("/");
			if (dir) {
				await this.app.vault.createFolder(dir).catch(() => {
					// Folder may already exist
				});
			}
			await this.app.vault.create(filePath, newContent);
		}
	}
}

/**
 * Fuzzy suggest modal for selecting agent slash commands.
 */
class SlashCommandModal extends FuzzySuggestModal<SlashCommand> {
	private commands: SlashCommand[];
	private onSelect: (cmd: SlashCommand) => void;

	constructor(
		app: App,
		commands: SlashCommand[],
		onSelect: (cmd: SlashCommand) => void
	) {
		super(app);
		this.commands = commands;
		this.onSelect = onSelect;
		this.setPlaceholder("Select a slash command...");
	}

	getItems(): SlashCommand[] {
		return this.commands;
	}

	getItemText(item: SlashCommand): string {
		return `${item.name} — ${item.description}`;
	}

	onChooseItem(item: SlashCommand): void {
		this.onSelect(item);
	}
}

/**
 * Fuzzy suggest modal for switching between detected agents.
 */
class AgentSwitchModal extends FuzzySuggestModal<DetectedAgent> {
	private agents: DetectedAgent[];
	private onSelect: (agent: DetectedAgent) => void;

	constructor(
		app: App,
		agents: DetectedAgent[],
		onSelect: (agent: DetectedAgent) => void
	) {
		super(app);
		this.agents = agents;
		this.onSelect = onSelect;
		this.setPlaceholder("Select an agent...");
	}

	getItems(): DetectedAgent[] {
		return this.agents;
	}

	getItemText(item: DetectedAgent): string {
		return item.version
			? `${item.adapter.displayName} (v${item.version})`
			: item.adapter.displayName;
	}

	onChooseItem(item: DetectedAgent): void {
		this.onSelect(item);
	}
}
