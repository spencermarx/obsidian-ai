import { MarkdownRenderer, Component, setIcon } from "obsidian";
import { AgentMessage } from "../adapters/types";
import type { AgenticCopilotSettings } from "../constants";

/**
 * Renders agent messages into DOM elements using Obsidian's
 * built-in MarkdownRenderer for consistent styling and theme support.
 */
export class ChatRenderer {
	private component: Component;
	private sourcePath: string;
	private settings: AgenticCopilotSettings;
	/** Per-container generation counters to discard stale async renders. */
	private renderGenerations = new WeakMap<HTMLElement, number>();

	constructor(
		component: Component,
		sourcePath: string,
		settings: AgenticCopilotSettings
	) {
		this.component = component;
		this.sourcePath = sourcePath;
		this.settings = settings;
	}

	/**
	 * Render a single agent message into a container element.
	 */
	async renderMessage(
		message: AgentMessage,
		container: HTMLElement
	): Promise<void> {
		container.empty();
		container.addClass("ac-message", `ac-message-${message.role}`);

		// Role label
		const header = container.createDiv({ cls: "ac-message-header" });
		header.createSpan({
			cls: "ac-message-role",
			text: this.getRoleLabel(message.role),
		});
		header.createSpan({
			cls: "ac-message-time",
			text: this.formatTime(message.timestamp),
		});

		// Message body
		const body = container.createDiv({ cls: "ac-message-body" });

		if (message.fileEdit) {
			this.renderFileEdit(message, body);
		} else if (message.toolUse) {
			this.renderToolUse(message, body);
		}

		if (message.content && message.role !== "tool") {
			await this.renderMarkdown(message.content, body);
		}
	}

	/** Bump and return the generation for a given target element. */
	private nextGeneration(target: HTMLElement): number {
		const gen = (this.renderGenerations.get(target) ?? 0) + 1;
		this.renderGenerations.set(target, gen);
		return gen;
	}

	/**
	 * Render markdown content directly into an arbitrary container.
	 * Uses a per-container generation counter to prevent duplicate
	 * content from concurrent async renders.
	 */
	async renderMarkdownInto(
		content: string,
		container: HTMLElement
	): Promise<void> {
		const gen = this.nextGeneration(container);
		const tmp = createDiv();
		await this.renderMarkdown(content, tmp);
		if (gen === this.renderGenerations.get(container)) {
			container.empty();
			container.append(...Array.from(tmp.childNodes));
		}
	}

	/**
	 * Render streaming assistant text — updates in place.
	 * Uses a per-container generation counter so that stale renders
	 * (superseded while the async markdown render was in flight) are
	 * discarded instead of appending duplicate content.
	 */
	async renderStreamingText(
		content: string,
		container: HTMLElement
	): Promise<void> {
		const body =
			container.querySelector<HTMLElement>(".ac-message-body") ||
			container.createDiv({ cls: "ac-message-body" });
		const gen = this.nextGeneration(body);
		const tmp = createDiv();
		await this.renderMarkdown(content, tmp);
		if (gen === this.renderGenerations.get(body)) {
			body.empty();
			body.append(...Array.from(tmp.childNodes));
		}
	}

	/**
	 * Render a compact tool chip (public — used by ChatView for inline tools).
	 */
	renderToolChip(message: AgentMessage, container: HTMLElement): void {
		if (!message.toolUse) return;

		const chip = container.createDiv({ cls: "ac-tool-chip" });
		const iconEl = chip.createSpan({ cls: "ac-tool-chip-icon" });
		setIcon(iconEl, this.getToolIconName(message.toolUse.name));
		chip.createSpan({
			cls: "ac-tool-chip-name",
			text: message.toolUse.name,
		});

		const summary = this.extractToolSummary(
			message.toolUse.name,
			message.toolUse.input
		);
		if (summary) {
			chip.createSpan({ cls: "ac-tool-chip-summary", text: summary });
		}
	}

	/**
	 * Render a standalone file edit block (public — used by ChatView).
	 */
	renderFileEditBlock(message: AgentMessage, container: HTMLElement): void {
		if (!message.fileEdit) return;
		container.addClass("ac-message", "ac-message-tool");
		const body = container.createDiv({ cls: "ac-message-body" });
		this.renderFileEdit(message, body);
	}

	private getToolIconName(toolName: string): string {
		const icons: Record<string, string> = {
			Read: "file-text",
			Glob: "search",
			Grep: "search",
			LS: "folder",
			WebSearch: "globe",
			WebFetch: "globe",
			Bash: "terminal",
			Write: "pencil",
			Edit: "pencil",
			NotebookEdit: "pencil",
		};
		return icons[toolName] || "wrench";
	}

	private extractToolSummary(toolName: string, input: string): string {
		try {
			const parsed = JSON.parse(input);
			if (toolName === "Read" && parsed.file_path) {
				return parsed.file_path;
			}
			if (toolName === "Glob" && parsed.pattern) {
				return parsed.pattern;
			}
			if (toolName === "Grep" && parsed.pattern) {
				return `"${parsed.pattern}"`;
			}
			if (toolName === "Bash" && parsed.command) {
				return parsed.command.length > 60
					? parsed.command.slice(0, 57) + "..."
					: parsed.command;
			}
			if (toolName === "WebSearch" && parsed.query) {
				return parsed.query;
			}
			if (
				(toolName === "Write" || toolName === "Edit") &&
				parsed.file_path
			) {
				return parsed.file_path;
			}
		} catch {
			// input might not be JSON
		}
		return "";
	}

	/**
	 * Render a tool use block as a collapsible section.
	 */
	private renderToolUse(message: AgentMessage, container: HTMLElement): void {
		if (!message.toolUse) return;

		const details = container.createEl("details", {
			cls: "ac-tool-use",
		});
		const summary = details.createEl("summary", {
			cls: "ac-tool-summary",
		});
		summary.createSpan({ cls: "ac-tool-icon", text: "\u{1F527}" });
		summary.createSpan({
			cls: "ac-tool-name",
			text: message.toolUse.name,
		});

		const content = details.createDiv({ cls: "ac-tool-content" });

		if (message.toolUse.input) {
			const inputSection = content.createDiv({ cls: "ac-tool-section" });
			inputSection.createEl("strong", { text: "Input:" });
			const pre = inputSection.createEl("pre");
			pre.createEl("code", {
				text: this.truncate(message.toolUse.input, 2000),
			});
		}

		if (message.toolUse.output) {
			const outputSection = content.createDiv({ cls: "ac-tool-section" });
			outputSection.createEl("strong", { text: "Output:" });
			const pre = outputSection.createEl("pre");
			pre.createEl("code", {
				text: this.truncate(message.toolUse.output, 2000),
			});
		}
	}

	/**
	 * Render a file edit block with diff and Keep/Revert buttons.
	 *
	 * The CLI always writes files directly (all tools are in --allowedTools).
	 * In "approve" mode, the user can review and revert changes.
	 * In "auto-accept" mode, just show an "Applied" badge.
	 */
	private renderFileEdit(
		message: AgentMessage,
		container: HTMLElement
	): void {
		if (!message.fileEdit) return;

		const editBlock = container.createDiv({ cls: "ac-file-edit" });

		const header = editBlock.createDiv({ cls: "ac-file-edit-header" });
		const editIconEl = header.createSpan({ cls: "ac-file-edit-icon" });
		setIcon(editIconEl, "file-pen-line");
		header.createSpan({
			cls: "ac-file-edit-path",
			text: message.fileEdit.filePath,
		});

		// Diff display
		const diffContainer = editBlock.createDiv({ cls: "ac-file-edit-diff" });
		if (message.fileEdit.oldContent && message.fileEdit.newContent) {
			this.renderSimpleDiff(
				message.fileEdit.oldContent,
				message.fileEdit.newContent,
				diffContainer
			);
		} else if (message.fileEdit.newContent) {
			const pre = diffContainer.createEl("pre", {
				cls: "ac-diff-new",
			});
			pre.createEl("code", {
				text: this.truncate(message.fileEdit.newContent, 3000),
			});
		}

		// Action buttons — depend on approval mode
		const actions = editBlock.createDiv({ cls: "ac-file-edit-actions" });

		if (this.settings.editApprovalMode === "auto-accept") {
			// Auto-accept: just show "Applied" badge
			editBlock.addClass("ac-file-edit-accepted");
			actions.createSpan({
				cls: "ac-file-edit-status",
				text: "Applied",
			});
		} else {
			// Approve mode: file was already written by CLI, show Keep/Revert
			const keepBtn = actions.createEl("button", {
				cls: "ac-btn ac-btn-accept",
				text: "Keep",
			});
			keepBtn.addEventListener("click", () => {
				editBlock.addClass("ac-file-edit-accepted");
				actions.empty();
				actions.createSpan({
					cls: "ac-file-edit-status",
					text: "Kept",
				});
			});

			const revertBtn = actions.createEl("button", {
				cls: "ac-btn ac-btn-reject",
				text: "Revert",
			});
			// Store data for the revert handler (delegated in ChatView)
			revertBtn.dataset.filePath = message.fileEdit.filePath;
			revertBtn.dataset.oldContent = message.fileEdit.oldContent || "";
			revertBtn.dataset.newContent = message.fileEdit.newContent;
		}
	}

	/**
	 * Render a simple line-by-line diff.
	 */
	private renderSimpleDiff(
		oldText: string,
		newText: string,
		container: HTMLElement
	): void {
		const oldLines = oldText.split("\n");
		const newLines = newText.split("\n");

		const pre = container.createEl("pre", { cls: "ac-diff" });

		// Simple diff: show removed lines then added lines
		for (const line of oldLines) {
			const el = pre.createEl("div", { cls: "ac-diff-removed" });
			el.textContent = `- ${line}`;
		}
		for (const line of newLines) {
			const el = pre.createEl("div", { cls: "ac-diff-added" });
			el.textContent = `+ ${line}`;
		}
	}

	private async renderMarkdown(
		content: string,
		container: HTMLElement
	): Promise<void> {
		try {
			await MarkdownRenderer.render(
				// @ts-expect-error — app is passed via the component's owner
				this.component.app || (this.component as { app: unknown }).app,
				content,
				container,
				this.sourcePath,
				this.component
			);
		} catch {
			// Fallback: render as plain text
			container.createEl("p", { text: content });
		}
	}

	private getRoleLabel(role: string): string {
		switch (role) {
			case "user":
				return "You";
			case "assistant":
				return "Agent";
			case "tool":
				return "Tool";
			case "system":
				return "System";
			default:
				return role;
		}
	}

	private formatTime(timestamp: number): string {
		return new Date(timestamp).toLocaleTimeString([], {
			hour: "2-digit",
			minute: "2-digit",
		});
	}

	private truncate(text: string, maxLength: number): string {
		if (text.length <= maxLength) return text;
		return text.slice(0, maxLength) + "\n... (truncated)";
	}
}
