import {
	Plugin,
	WorkspaceLeaf,
	Notice,
	MarkdownView,
	FuzzySuggestModal,
	App,
	FuzzyMatch,
	TFile,
} from "obsidian";
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
import { getVaultContext } from "./utils/vault-context";

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
					this.applyFileEdit.bind(this)
				);
			} else {
				return new OnboardingView(
					leaf,
					this.detectedAgents,
					(agentId: string) => {
						this.settings.selectedAgent = agentId;
						this.saveSettings();
						this.activeAdapter = this.resolveAdapter();
						this.activateChatView();
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
		this.addRibbonIcon("bot", "Open Agentic Copilot", () => {
			this.activateChatView();
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

	async onunload(): Promise<void> {
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
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}

		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({
				type: CHAT_VIEW_TYPE,
				active: true,
			});
			this.app.workspace.revealLeaf(leaf);
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
			this.app.workspace.revealLeaf(leaf);
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
			callback: () => this.activateChatView(),
		});

		// Open new chat session
		this.addCommand({
			id: "new-chat-session",
			name: "Open new chat session",
			callback: () => this.openNewChatView(),
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
					this.askAboutFile(view.file.path);
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
					this.askAboutSelection(selection);
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
					this.sendToChat(
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
					this.sendToChat(
						`Refactor the following code for better readability and maintainability:\n\n${selection}`
					);
				}
				return true;
			},
		});

		// Run slash command (fuzzy suggest)
		this.addCommand({
			id: "run-slash-command",
			name: "Run agent slash command",
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
					this.sendToChat(cmd.name);
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
						this.saveSettings();
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

		// Register editor context menu
		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor) => {
				const selection = editor.getSelection();
				if (!selection) return;

				menu.addItem((item) => {
					item.setTitle("Ask Agent")
						.setIcon("bot")
						.onClick(() => {
							this.askAboutSelection(selection);
						});
				});

				menu.addItem((item) => {
					item.setTitle("Explain Selection")
						.setIcon("help-circle")
						.onClick(() => {
							this.sendToChat(
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
				leaves[0].view.injectPrompt(prompt);
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
