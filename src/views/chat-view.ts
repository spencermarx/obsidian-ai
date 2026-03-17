import { ItemView, WorkspaceLeaf, Notice, App } from "obsidian";
import { CHAT_VIEW_TYPE } from "../constants";
import { AgentAdapter, AgentMessage, SlashCommand } from "../adapters/types";
import { SessionManager, SessionStatus } from "../session/session-manager";
import { ChatRenderer } from "./chat-renderer";
import { getVaultContext } from "../utils/vault-context";
import type { AgenticCopilotSettings } from "../constants";

/**
 * The main chat panel view — an Obsidian ItemView that provides
 * a conversational interface to the active agentic CLI tool.
 *
 * Supports multi-session: each view leaf owns its own session.
 */
export class ChatView extends ItemView {
	private sessionManager: SessionManager;
	private settings: AgenticCopilotSettings;
	private adapter: AgentAdapter;
	private sessionId: string | null = null;
	private renderer: ChatRenderer;
	private onApplyEdit: (
		filePath: string,
		oldContent: string,
		newContent: string
	) => Promise<void>;

	// DOM elements
	private messagesContainer!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private stopBtn!: HTMLButtonElement;
	private statusEl!: HTMLElement;
	private slashPopup!: HTMLElement;

	// State
	private isGenerating = false;
	private streamingMessageEl: HTMLElement | null = null;
	private slashCommands: SlashCommand[] = [];

	constructor(
		leaf: WorkspaceLeaf,
		sessionManager: SessionManager,
		settings: AgenticCopilotSettings,
		adapter: AgentAdapter,
		onApplyEdit: (
			filePath: string,
			oldContent: string,
			newContent: string
		) => Promise<void>
	) {
		super(leaf);
		this.sessionManager = sessionManager;
		this.settings = settings;
		this.adapter = adapter;
		this.onApplyEdit = onApplyEdit;
		this.renderer = new ChatRenderer(this, "");
		this.slashCommands = adapter.getSlashCommands();
	}

	getViewType(): string {
		return CHAT_VIEW_TYPE;
	}

	getDisplayText(): string {
		return `Copilot — ${this.adapter.displayName}`;
	}

	getIcon(): string {
		return "bot";
	}

	async onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("ac-chat-container");

		this.buildUI(container);
		this.setupSession();
		this.setupEventListeners();
	}

	async onClose(): Promise<void> {
		if (this.sessionId) {
			this.sessionManager.destroySession(this.sessionId);
		}
	}

	/** Update the adapter (when user switches agents). */
	setAdapter(adapter: AgentAdapter): void {
		this.adapter = adapter;
		this.slashCommands = adapter.getSlashCommands();
		if (this.sessionId) {
			this.sessionManager.destroySession(this.sessionId);
		}
		this.setupSession();
		this.clearMessages();
		this.updateStatus("idle");
		// Trigger header update by toggling the view state
		(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
	}

	private buildUI(container: HTMLElement): void {
		// Header bar
		const header = container.createDiv({ cls: "ac-chat-header" });
		this.statusEl = header.createDiv({ cls: "ac-status" });
		this.statusEl.createSpan({
			cls: "ac-status-dot ac-status-idle",
		});
		this.statusEl.createSpan({
			cls: "ac-status-text",
			text: this.adapter.displayName,
		});

		// Messages area
		this.messagesContainer = container.createDiv({
			cls: "ac-messages",
		});

		// Welcome message
		this.renderWelcome();

		// Slash command popup (hidden by default)
		this.slashPopup = container.createDiv({ cls: "ac-slash-popup" });
		this.slashPopup.style.display = "none";

		// Input area
		const inputArea = container.createDiv({ cls: "ac-input-area" });

		this.inputEl = inputArea.createEl("textarea", {
			cls: "ac-input",
			attr: {
				placeholder: `Message ${this.adapter.displayName}... (/ for commands)`,
				rows: "1",
			},
		});

		const btnGroup = inputArea.createDiv({ cls: "ac-btn-group" });

		this.sendBtn = btnGroup.createEl("button", {
			cls: "ac-btn ac-btn-send",
			text: "Send",
		});

		this.stopBtn = btnGroup.createEl("button", {
			cls: "ac-btn ac-btn-stop",
			text: "Stop",
		});
		this.stopBtn.style.display = "none";
	}

	private renderWelcome(): void {
		const welcome = this.messagesContainer.createDiv({
			cls: "ac-welcome",
		});
		welcome.createEl("h3", {
			text: `Agentic Copilot`,
		});
		welcome.createEl("p", {
			text: `Connected to ${this.adapter.displayName}. Ask anything about your vault, or use / to see available commands.`,
		});

		if (this.slashCommands.length > 0) {
			const cmdList = welcome.createDiv({ cls: "ac-welcome-commands" });
			cmdList.createEl("p", {
				cls: "ac-welcome-commands-label",
				text: "Available commands:",
			});
			for (const cmd of this.slashCommands.slice(0, 5)) {
				const item = cmdList.createDiv({ cls: "ac-welcome-cmd" });
				item.createSpan({
					cls: "ac-welcome-cmd-name",
					text: cmd.name,
				});
				item.createSpan({
					cls: "ac-welcome-cmd-desc",
					text: cmd.description,
				});
			}
		}
	}

	private setupSession(): void {
		this.sessionId = this.sessionManager.createSession(this.adapter);
	}

	private setupEventListeners(): void {
		// Session events
		this.sessionManager.onEvent((event) => {
			if (event.sessionId !== this.sessionId) return;

			switch (event.type) {
				case "message":
					if (event.message) {
						this.handleMessage(event.message);
					}
					break;
				case "status":
					if (event.status) {
						this.updateStatus(event.status);
					}
					break;
				case "error":
					if (event.error) {
						this.showError(event.error);
					}
					break;
				case "complete":
					this.onGenerationComplete();
					break;
			}
		});

		// Send button
		this.sendBtn.addEventListener("click", () => this.sendMessage());

		// Stop button
		this.stopBtn.addEventListener("click", () => this.stopGeneration());

		// Input: Enter to send, Shift+Enter for newline
		this.inputEl.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				this.sendMessage();
			}
		});

		// Input: auto-resize
		this.inputEl.addEventListener("input", () => {
			this.autoResizeInput();
			this.handleSlashAutocomplete();
		});

		// File edit accept buttons (delegated)
		this.messagesContainer.addEventListener("click", (e) => {
			const target = e.target as HTMLElement;
			if (target.classList.contains("ac-btn-accept")) {
				this.handleAcceptEdit(target);
			}
		});
	}

	private async sendMessage(): Promise<void> {
		const text = this.inputEl.value.trim();
		if (!text || this.isGenerating) return;
		if (!this.sessionId) return;

		// Clear input
		this.inputEl.value = "";
		this.autoResizeInput();
		this.hideSlashPopup();

		// Gather vault context
		const context = getVaultContext(this.app);

		// Apply settings-based context filtering
		if (!this.settings.includeActiveFile) {
			delete context.activeFileContent;
			delete context.activeFilePath;
		}
		if (!this.settings.includeSelection) {
			delete context.selection;
		}

		// Set working directory
		if (
			this.settings.workingDirectory === "file" &&
			context.activeFilePath
		) {
			const parts = context.activeFilePath.split("/");
			parts.pop();
			const fileDir = parts.join("/");
			if (fileDir) {
				context.vaultPath = context.vaultPath + "/" + fileDir;
			}
		}

		this.isGenerating = true;
		this.sendBtn.style.display = "none";
		this.stopBtn.style.display = "";
		this.streamingMessageEl = null;

		try {
			await this.sessionManager.sendPrompt(
				this.sessionId,
				text,
				context
			);
		} catch (err) {
			const msg =
				err instanceof Error ? err.message : "Failed to send message";
			this.showError(msg);
			this.onGenerationComplete();
		}
	}

	private handleMessage(message: AgentMessage): void {
		if (message.role === "user") {
			this.renderUserMessage(message);
			return;
		}

		if (message.role === "tool") {
			this.renderToolMessage(message);
			return;
		}

		// Assistant message — streaming accumulation
		if (message.role === "assistant") {
			if (!this.streamingMessageEl) {
				// Create a new message bubble
				this.streamingMessageEl = this.messagesContainer.createDiv({
					cls: "ac-message ac-message-assistant",
				});
				const header = this.streamingMessageEl.createDiv({
					cls: "ac-message-header",
				});
				header.createSpan({
					cls: "ac-message-role",
					text: "Agent",
				});
				header.createSpan({
					cls: "ac-message-time",
					text: new Date().toLocaleTimeString([], {
						hour: "2-digit",
						minute: "2-digit",
					}),
				});
				this.streamingMessageEl.createDiv({
					cls: "ac-message-body",
				});
			}

			// Update the streaming content
			this.renderer.renderStreamingText(
				message.content,
				this.streamingMessageEl
			);
			this.scrollToBottom();
		}
	}

	private renderUserMessage(message: AgentMessage): void {
		const el = this.messagesContainer.createDiv({
			cls: "ac-message ac-message-user",
		});
		const header = el.createDiv({ cls: "ac-message-header" });
		header.createSpan({ cls: "ac-message-role", text: "You" });
		header.createSpan({
			cls: "ac-message-time",
			text: new Date(message.timestamp).toLocaleTimeString([], {
				hour: "2-digit",
				minute: "2-digit",
			}),
		});
		const body = el.createDiv({ cls: "ac-message-body" });
		body.createEl("p", { text: message.content });
		this.scrollToBottom();
	}

	private async renderToolMessage(message: AgentMessage): Promise<void> {
		// Finalize any streaming assistant message first
		this.streamingMessageEl = null;

		const el = this.messagesContainer.createDiv();
		await this.renderer.renderMessage(message, el);
		this.scrollToBottom();
	}

	private onGenerationComplete(): void {
		this.isGenerating = false;
		this.streamingMessageEl = null;
		this.sendBtn.style.display = "";
		this.stopBtn.style.display = "none";
	}

	private stopGeneration(): void {
		if (this.sessionId) {
			this.sessionManager.stopSession(this.sessionId);
		}
		this.onGenerationComplete();
	}

	private updateStatus(status: SessionStatus): void {
		const dot = this.statusEl.querySelector(".ac-status-dot");
		if (dot) {
			dot.className = `ac-status-dot ac-status-${status}`;
		}
	}

	private showError(error: string): void {
		const el = this.messagesContainer.createDiv({
			cls: "ac-message ac-message-error",
		});
		el.createDiv({ cls: "ac-message-header" }).createSpan({
			cls: "ac-message-role",
			text: "Error",
		});
		const body = el.createDiv({ cls: "ac-message-body" });
		body.createEl("p", { text: error });
		this.scrollToBottom();
		new Notice(`Agentic Copilot: ${error}`);
	}

	private clearMessages(): void {
		this.messagesContainer.empty();
		this.renderWelcome();
	}

	private scrollToBottom(): void {
		this.messagesContainer.scrollTop =
			this.messagesContainer.scrollHeight;
	}

	private autoResizeInput(): void {
		this.inputEl.style.height = "auto";
		this.inputEl.style.height =
			Math.min(this.inputEl.scrollHeight, 200) + "px";
	}

	private handleSlashAutocomplete(): void {
		const text = this.inputEl.value;
		if (text.startsWith("/") && !text.includes(" ")) {
			const filter = text.toLowerCase();
			const matches = this.slashCommands.filter((cmd) =>
				cmd.name.toLowerCase().startsWith(filter)
			);

			if (matches.length > 0) {
				this.showSlashPopup(matches);
			} else {
				this.hideSlashPopup();
			}
		} else {
			this.hideSlashPopup();
		}
	}

	private showSlashPopup(commands: SlashCommand[]): void {
		this.slashPopup.empty();
		this.slashPopup.style.display = "";

		for (const cmd of commands) {
			const item = this.slashPopup.createDiv({
				cls: "ac-slash-item",
			});
			item.createSpan({ cls: "ac-slash-name", text: cmd.name });
			item.createSpan({ cls: "ac-slash-desc", text: cmd.description });

			item.addEventListener("click", () => {
				this.inputEl.value = cmd.name + " ";
				this.inputEl.focus();
				this.hideSlashPopup();
			});
		}
	}

	private hideSlashPopup(): void {
		this.slashPopup.style.display = "none";
	}

	private async handleAcceptEdit(button: HTMLElement): Promise<void> {
		const filePath = button.dataset.filePath;
		const newContent = button.dataset.newContent;
		const oldContent = button.dataset.oldContent;

		if (!filePath || !newContent) return;

		try {
			await this.onApplyEdit(filePath, oldContent || "", newContent);
			const editBlock = button.closest(".ac-file-edit");
			if (editBlock) {
				editBlock.addClass("ac-file-edit-accepted");
				const actions = editBlock.querySelector(
					".ac-file-edit-actions"
				);
				if (actions) {
					actions.innerHTML = "";
					actions.createSpan({
						cls: "ac-file-edit-status",
						text: "Applied",
					});
				}
			}
			new Notice(`Applied edit to ${filePath}`);
		} catch (err) {
			const msg =
				err instanceof Error ? err.message : "Failed to apply edit";
			new Notice(`Failed to apply edit: ${msg}`);
		}
	}

	/**
	 * Public method to inject a prompt from an external command
	 * (e.g., "explain selection" from context menu).
	 */
	async injectPrompt(prompt: string): Promise<void> {
		this.inputEl.value = prompt;
		await this.sendMessage();
	}
}
