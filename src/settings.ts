import { App, PluginSettingTab, Setting } from "obsidian";
import type AgenticCopilotPlugin from "./main";
import { getAllAdapters } from "./adapters/detector";
import type { DetectedAgent } from "./adapters/detector";

export class AgenticCopilotSettingTab extends PluginSettingTab {
	plugin: AgenticCopilotPlugin;
	detectedAgents: DetectedAgent[];

	constructor(
		app: App,
		plugin: AgenticCopilotPlugin,
		detectedAgents: DetectedAgent[]
	) {
		super(app, plugin);
		this.plugin = plugin;
		this.detectedAgents = detectedAgents;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h1", { text: "Agentic Copilot" });

		// Agent selection
		const agentOptions: Record<string, string> = {
			auto: "Auto-detect (first available)",
		};

		for (const agent of this.detectedAgents) {
			const label = agent.version
				? `${agent.adapter.displayName} (v${agent.version})`
				: agent.adapter.displayName;
			agentOptions[agent.adapter.id] = label;
		}

		// Add all known adapters as options even if not detected
		for (const adapter of getAllAdapters()) {
			if (!agentOptions[adapter.id]) {
				agentOptions[adapter.id] = `${adapter.displayName} (not detected)`;
			}
		}

		agentOptions["custom"] = "Custom CLI binary";

		new Setting(containerEl)
			.setName("Agent")
			.setDesc(
				"Which agentic CLI tool to use. 'Auto-detect' picks the first one found on your system."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOptions(agentOptions)
					.setValue(this.plugin.settings.selectedAgent)
					.onChange(async (value) => {
						this.plugin.settings.selectedAgent = value;
						await this.plugin.saveSettings();
						// Show/hide custom binary path
						this.display();
					})
			);

		// Custom binary path (shown when 'custom' is selected)
		if (
			this.plugin.settings.selectedAgent === "custom" ||
			this.plugin.settings.customBinaryPath
		) {
			new Setting(containerEl)
				.setName("Custom binary path")
				.setDesc(
					"Full path or command name of the CLI tool to use (e.g., /usr/local/bin/my-agent or gemini)."
				)
				.addText((text) =>
					text
						.setPlaceholder("/usr/local/bin/my-agent")
						.setValue(this.plugin.settings.customBinaryPath)
						.onChange(async (value) => {
							this.plugin.settings.customBinaryPath = value;
							await this.plugin.saveSettings();
						})
				);
		}

		// Custom arguments
		new Setting(containerEl)
			.setName("Extra CLI arguments")
			.setDesc(
				"Additional arguments appended to every agent invocation (space-separated)."
			)
			.addText((text) =>
				text
					.setPlaceholder("--model opus")
					.setValue(this.plugin.settings.customArgs)
					.onChange(async (value) => {
						this.plugin.settings.customArgs = value;
						await this.plugin.saveSettings();
					})
			);

		// Working directory
		containerEl.createEl("h2", { text: "Context" });

		new Setting(containerEl)
			.setName("Working directory")
			.setDesc(
				"Set the agent's working directory to the vault root or the active file's directory."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						vault: "Vault root",
						file: "Active file directory",
					})
					.setValue(this.plugin.settings.workingDirectory)
					.onChange(async (value: "vault" | "file") => {
						this.plugin.settings.workingDirectory = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Include active file")
			.setDesc(
				"Automatically include the content of the active file in the agent's context."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.includeActiveFile)
					.onChange(async (value) => {
						this.plugin.settings.includeActiveFile = value;
						await this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Include selection")
			.setDesc(
				"Automatically include the current text selection in the agent's context."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.includeSelection)
					.onChange(async (value) => {
						this.plugin.settings.includeSelection = value;
						await this.plugin.saveSettings();
					})
			);

		// Sessions
		containerEl.createEl("h2", { text: "Sessions" });

		new Setting(containerEl)
			.setName("Max concurrent sessions")
			.setDesc(
				"Maximum number of agent sessions that can run simultaneously."
			)
			.addSlider((slider) =>
				slider
					.setLimits(1, 10, 1)
					.setValue(this.plugin.settings.maxSessions)
					.setDynamicTooltip()
					.onChange(async (value) => {
						this.plugin.settings.maxSessions = value;
						await this.plugin.saveSettings();
					})
			);

		// Permissions
		containerEl.createEl("h2", { text: "Permissions" });

		new Setting(containerEl)
			.setName("Edit approval")
			.setDesc(
				"Control how file edits are reviewed. 'Review edits' shows Keep/Revert buttons after the agent writes; 'Auto-accept' hides review controls."
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOptions({
						approve: "Review edits (Keep/Revert)",
						"auto-accept": "Auto-accept edits",
					})
					.setValue(this.plugin.settings.editApprovalMode)
					.onChange(async (value: "approve" | "auto-accept") => {
						this.plugin.settings.editApprovalMode = value;
						await this.plugin.saveSettings();
					})
			);

		// Status section
		containerEl.createEl("h2", { text: "Detected Agents" });

		if (this.detectedAgents.length === 0) {
			containerEl.createEl("p", {
				text: "No agentic CLI tools were detected on your system. Install Claude Code, Opencode, or configure a custom binary above.",
				cls: "setting-item-description",
			});
		} else {
			for (const agent of this.detectedAgents) {
				const item = containerEl.createDiv({
					cls: "ac-detected-agent",
				});
				item.createSpan({
					text: `${agent.adapter.displayName}`,
					cls: "ac-detected-name",
				});
				if (agent.version) {
					item.createSpan({
						text: ` v${agent.version}`,
						cls: "ac-detected-version",
					});
				}
				if (agent.path) {
					item.createEl("code", {
						text: agent.path,
						cls: "ac-detected-path",
					});
				}
			}
		}
	}
}
