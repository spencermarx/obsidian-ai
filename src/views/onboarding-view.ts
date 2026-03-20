import { ItemView, WorkspaceLeaf } from "obsidian";
import { CHAT_VIEW_TYPE } from "../constants";
import { DetectedAgent } from "../adapters/detector";

/**
 * Shown when no agentic CLI tools are detected.
 * Provides installation links and setup instructions.
 */
export class OnboardingView extends ItemView {
	private detectedAgents: DetectedAgent[];
	private onSelectAgent: (agentId: string) => void;

	constructor(
		leaf: WorkspaceLeaf,
		detectedAgents: DetectedAgent[],
		onSelectAgent: (agentId: string) => void
	) {
		super(leaf);
		this.detectedAgents = detectedAgents;
		this.onSelectAgent = onSelectAgent;
	}

	getViewType(): string {
		return CHAT_VIEW_TYPE;
	}

	getDisplayText(): string {
		return "Setup";
	}

	getIcon(): string {
		return "bot";
	}

	onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("ac-onboarding");

		if (this.detectedAgents.length > 0) {
			this.renderAgentSelection(container);
		} else {
			this.renderNoAgents(container);
		}
		return Promise.resolve();
	}

	onClose(): Promise<void> {
		// No cleanup needed
		return Promise.resolve();
	}

	private renderAgentSelection(container: HTMLElement): void {
		container.createEl("h2", { text: "Choose your agent" });
		container.createEl("p", {
			text: "The following agentic CLI tools were detected on your system:",
		});

		const list = container.createDiv({ cls: "ac-agent-list" });

		for (const agent of this.detectedAgents) {
			const card = list.createDiv({ cls: "ac-agent-card" });
			const info = card.createDiv({ cls: "ac-agent-info" });
			info.createEl("h3", { text: agent.adapter.displayName });
			if (agent.version) {
				info.createEl("p", {
					cls: "ac-agent-version",
					text: `v${agent.version}`,
				});
			}
			if (agent.path) {
				info.createEl("code", {
					cls: "ac-agent-path",
					text: agent.path,
				});
			}

			const selectBtn = card.createEl("button", {
				cls: "ac-btn ac-btn-primary",
				text: "Use this agent",
			});
			selectBtn.addEventListener("click", () => {
				this.onSelectAgent(agent.adapter.id);
			});
		}
	}

	private renderNoAgents(container: HTMLElement): void {
		container.createEl("h2", { text: "No agentic CLI tools found" });
		container.createEl("p", {
			text: "Agentic copilot needs a CLI agent installed on your system. Install one of the following:",
		});

		const tools = container.createDiv({ cls: "ac-install-list" });

		// Claude Code
		const claude = tools.createDiv({ cls: "ac-install-item" });
		claude.createEl("h3", { text: "Claude code" });
		claude.createEl("p", {
			text: "Anthropic's agentic coding tool.",
		});
		const claudeInstall = ["npm install -g", "@anthropic-ai/claude-code"].join(" ");
		claude.createEl("pre").createEl("code").textContent = claudeInstall;

		// Opencode
		const opencode = tools.createDiv({ cls: "ac-install-item" });
		opencode.createEl("h3", { text: "Opencode" });
		opencode.createEl("p", {
			text: "Open-source agentic coding tool.",
		});
		const opencodeCmd = opencode.createEl("pre");
		opencodeCmd.createEl("code", {
			text: "curl -fsSL https://opencode.ai/install | bash",
		});

		container.createEl("p", {
			cls: "ac-install-note",
			text: "After installing, restart Obsidian or re-open this panel to auto-detect the agent.",
		});

		// Manual path option
		container.createEl("p", {
			text: 'You can also configure a custom binary path in the plugin settings.',
		});
	}
}
