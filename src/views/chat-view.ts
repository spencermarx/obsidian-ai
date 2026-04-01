import { ItemView, WorkspaceLeaf, Notice, setIcon } from "obsidian";
import { CHAT_VIEW_TYPE } from "../constants";
import { AgentAdapter, AgentMessage, SlashCommand } from "../adapters/types";
import { SessionManager, SessionStatus } from "../session/session-manager";
import { ChatRenderer } from "./chat-renderer";
import { getVaultContext } from "../utils/vault-context";
import type { AgenticCopilotSettings } from "../constants";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

/** A pending image awaiting send. */
interface PendingImage {
	/** Absolute path to the temp file. */
	tempPath: string;
	/** Original file name for display. */
	name: string;
	/** Object URL for the thumbnail preview. */
	objectUrl: string;
}

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
	private onRevertEdit: (
		filePath: string,
		oldContent: string,
		newContent: string
	) => Promise<void>;
	private onSaveSettings: () => Promise<void>;

	// DOM elements
	private messagesContainer!: HTMLElement;
	private inputEl!: HTMLTextAreaElement;
	private sendBtn!: HTMLButtonElement;
	private stopBtn!: HTMLButtonElement;
	private statusEl!: HTMLElement;
	private slashPopup!: HTMLElement;
	private mentionPopup!: HTMLElement;
	private sessionChip!: HTMLElement;
	private sessionChipId!: HTMLElement;
	private sessionChipIcon!: HTMLElement;
	private permToggle!: HTMLButtonElement;
	private activityBar: HTMLElement | null = null;
	private activityText: HTMLElement | null = null;

	// Image input
	private imagePreviewArea!: HTMLElement;
	private inputArea!: HTMLElement;

	// State
	private isGenerating = false;
	private streamingThinkingEl: HTMLElement | null = null;
	private streamingMessageEl: HTMLElement | null = null;
	private slashCommands: SlashCommand[] = [];
	private pendingImages: PendingImage[] = [];
	private dragEnterCount = 0;

	constructor(
		leaf: WorkspaceLeaf,
		sessionManager: SessionManager,
		settings: AgenticCopilotSettings,
		adapter: AgentAdapter,
		onApplyEdit: (
			filePath: string,
			oldContent: string,
			newContent: string
		) => Promise<void>,
		onRevertEdit: (
			filePath: string,
			oldContent: string,
			newContent: string
		) => Promise<void>,
		onSaveSettings: () => Promise<void>
	) {
		super(leaf);
		this.sessionManager = sessionManager;
		this.settings = settings;
		this.adapter = adapter;
		this.onApplyEdit = onApplyEdit;
		this.onRevertEdit = onRevertEdit;
		this.onSaveSettings = onSaveSettings;
		this.renderer = new ChatRenderer(this, "", this.settings);
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

	onOpen(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass("ac-chat-container");

		this.buildUI(container);
		this.setupSession();
		this.setupEventListeners();
		return Promise.resolve();
	}

	onClose(): Promise<void> {
		this.clearPendingImages();
		if (this.sessionId) {
			this.sessionManager.destroySession(this.sessionId);
		}
		return Promise.resolve();
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
		(this.leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
	}

	private buildUI(container: HTMLElement): void {
		// ── Header bar ──
		const header = container.createDiv({ cls: "ac-chat-header" });

		// Left: status
		this.statusEl = header.createDiv({ cls: "ac-status" });
		this.statusEl.createSpan({ cls: "ac-status-dot ac-status-idle" });
		this.statusEl.createSpan({
			cls: "ac-status-text",
			text: this.adapter.displayName,
		});

		// Right: session chip (clickable — copies resume command)
		this.sessionChip = header.createDiv({
			cls: "ac-session-chip",
			attr: {
				"aria-label":
					"Click to copy terminal command to continue this session",
				role: "button",
				tabindex: "0",
			},
		});
		this.sessionChip.addClass("ac-hidden"); // hidden until real CLI ID arrives
		const chipTermIcon = this.sessionChip.createSpan({
			cls: "ac-session-chip-terminal",
		});
		setIcon(chipTermIcon, "terminal");
		this.sessionChipId = this.sessionChip.createSpan({
			cls: "ac-session-chip-id",
		});
		this.sessionChipIcon = this.sessionChip.createSpan({
			cls: "ac-session-chip-copy",
		});
		setIcon(this.sessionChipIcon, "copy");
		this.sessionChip.addEventListener("click", () =>
			this.copySessionId()
		);

		// ── Messages area ──
		this.messagesContainer = container.createDiv({ cls: "ac-messages" });
		this.renderWelcome();

		// ── Autocomplete popups (hidden by default) ──
		this.slashPopup = container.createDiv({ cls: "ac-slash-popup" });
		this.slashPopup.addClass("ac-hidden");
		this.mentionPopup = container.createDiv({ cls: "ac-mention-popup" });
		this.mentionPopup.addClass("ac-hidden");

		// ── Input area ──
		this.inputArea = container.createDiv({ cls: "ac-input-area" });

		// Image preview strip (hidden until images are attached)
		this.imagePreviewArea = this.inputArea.createDiv({
			cls: "ac-image-previews ac-hidden",
		});

		const inputWrap = this.inputArea.createDiv({ cls: "ac-input-wrap" });

		this.inputEl = inputWrap.createEl("textarea", {
			cls: "ac-input",
			attr: {
				placeholder: `Message ${this.adapter.displayName}…`,
				rows: "1",
			},
		});

		const btnGroup = inputWrap.createDiv({ cls: "ac-btn-group" });
		this.sendBtn = btnGroup.createEl("button", {
			cls: "ac-btn ac-btn-send clickable-icon",
			attr: { "aria-label": "Send" },
		});
		setIcon(this.sendBtn, "arrow-up");

		this.stopBtn = btnGroup.createEl("button", {
			cls: "ac-btn ac-btn-stop clickable-icon",
			attr: { "aria-label": "Stop" },
		});
		setIcon(this.stopBtn, "square");
		this.stopBtn.addClass("ac-hidden");

		// ── Toolbar below input ──
		const toolbar = this.inputArea.createDiv({ cls: "ac-toolbar" });

		// Permission mode toggle
		const permWrap = toolbar.createDiv({ cls: "ac-toolbar-item" });
		const permIcon = permWrap.createSpan({ cls: "ac-toolbar-icon" });
		setIcon(permIcon, "shield");
		this.permToggle = permWrap.createEl("button", {
			cls: "ac-toolbar-toggle",
			text:
				this.settings.editApprovalMode === "approve"
					? "Review edits"
					: "Auto-accept",
		});
		if (this.settings.editApprovalMode === "auto-accept") {
			this.permToggle.addClass("ac-toolbar-toggle-auto");
		}
		this.permToggle.addEventListener("click", () => {
			const newMode =
				this.settings.editApprovalMode === "approve"
					? "auto-accept"
					: "approve";
			this.settings.editApprovalMode = newMode;
			this.permToggle.textContent =
				newMode === "approve" ? "Review edits" : "Auto-accept";
			this.permToggle.toggleClass(
				"ac-toolbar-toggle-auto",
				newMode === "auto-accept"
			);
			void this.onSaveSettings();
			new Notice(
				newMode === "auto-accept"
					? "Edits will be applied silently"
					: "Edits will show review controls"
			);
		});

		// Hint text for shortcuts
		const hints = toolbar.createDiv({ cls: "ac-toolbar-hints" });
		hints.createSpan({ cls: "ac-toolbar-hint", text: "/ commands" });
		hints.createSpan({ cls: "ac-toolbar-hint", text: "@ files" });
		hints.createSpan({ cls: "ac-toolbar-hint", text: "# tags" });
	}

	private renderWelcome(): void {
		const welcome = this.messagesContainer.createDiv({
			cls: "ac-welcome",
		});

		const header = welcome.createDiv({ cls: "ac-welcome-header" });
		header.createEl("h3", { text: "Agentic copilot" });
		header.createEl("p", {
			text: `Connected to ${this.adapter.displayName}. Ask anything about your vault.`,
		});

		if (this.slashCommands.length > 0) {
			const cmdSection = welcome.createDiv({
				cls: "ac-welcome-commands",
			});
			cmdSection.createEl("p", {
				cls: "ac-welcome-commands-label",
				text: "Commands",
			});
			const cmdList = cmdSection.createDiv({
				cls: "ac-welcome-cmd-list",
			});
			for (const cmd of this.slashCommands) {
				const item = cmdList.createDiv({ cls: "ac-welcome-cmd" });
				item.createSpan({
					cls: "ac-welcome-cmd-name",
					text: cmd.name,
				});
				item.createSpan({
					cls: "ac-welcome-cmd-desc",
					text: cmd.description,
				});
				item.addEventListener("click", () => {
					this.inputEl.value = cmd.name + " ";
					this.inputEl.focus();
					this.autoResizeInput();
				});
			}
		}

		// Resume session link
		const resumeSection = welcome.createDiv({ cls: "ac-resume-section" });
		this.buildResumeLink(resumeSection);
	}

	private buildResumeLink(container: HTMLElement): void {
		container.empty();
		const link = container.createEl("button", {
			cls: "ac-resume-link",
			text: "Resume a previous session",
		});
		link.addEventListener("click", () => {
			this.showResumeForm(container);
		});
	}

	private showResumeForm(container: HTMLElement): void {
		container.empty();
		const form = container.createDiv({ cls: "ac-resume-form" });
		const input = form.createEl("input", {
			cls: "ac-resume-input",
			attr: {
				type: "text",
				placeholder: "Paste session ID…",
				spellcheck: "false",
			},
		});
		const btn = form.createEl("button", {
			cls: "ac-resume-btn",
			text: "Resume",
		});

		const doResume = () => {
			let sessionId = input.value.trim();
			if (!sessionId) return;
			// Support pasting full command: "claude --resume <id>" or "claude -r <id>"
			const cmdMatch = sessionId.match(
				/claude\s+(?:--resume|-r)\s+(\S+)/
			);
			if (cmdMatch) sessionId = cmdMatch[1];
			this.resumeSession(sessionId);
		};

		btn.addEventListener("click", doResume);
		input.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				doResume();
			}
			if (e.key === "Escape") {
				this.buildResumeLink(container);
			}
		});
		input.focus();
	}

	private resumeSession(cliSessionId: string): void {
		// Destroy current session and create a new one with the given CLI session ID
		if (this.sessionId) {
			this.sessionManager.destroySession(this.sessionId);
		}
		this.clearMessages();
		this.setupSession(cliSessionId);
		this.updateStatus("idle");
		new Notice(`Resuming session ${cliSessionId.slice(0, 8)}…`);
	}

	private setupSession(resumeSessionId?: string): void {
		this.sessionId = this.sessionManager.createSession(
			this.adapter,
			resumeSessionId
		);
		// Don't show the chip yet — wait for the real CLI session ID
		// to arrive via the system init event (updateSessionIdDisplay).
		// If resuming, show immediately since the ID is already known.
		if (resumeSessionId) {
			this.updateSessionIdDisplay(resumeSessionId);
		}
	}

	private copySessionId(): void {
		if (!this.sessionId) return;
		const session = this.sessionManager.getSession(this.sessionId);
		if (!session) return;
		const cmd = `claude --resume ${session.cliSessionId}`;
		void navigator.clipboard.writeText(cmd).then(() => {
			// Show checkmark feedback
			this.sessionChipIcon.empty();
			setIcon(this.sessionChipIcon, "check");
			this.sessionChip.addClass("ac-session-chip-copied");
			new Notice("Resume command copied to clipboard");
			setTimeout(() => {
				this.sessionChipIcon.empty();
				setIcon(this.sessionChipIcon, "copy");
				this.sessionChip.removeClass("ac-session-chip-copied");
			}, 1500);
		});
	}

	/** Update the session ID display when the real CLI session ID arrives. */
	private updateSessionIdDisplay(cliSessionId: string): void {
		if (this.sessionChip) {
			const shortId = cliSessionId.slice(0, 8);
			this.sessionChipId.textContent = shortId;
			this.sessionChip.removeClass("ac-hidden");
			this.sessionChip.setAttribute(
				"aria-label",
				`Session ${cliSessionId} — click to copy resume command`
			);
		}
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
		this.sendBtn.addEventListener("click", () => { void this.sendMessage(); });

		// Stop button
		this.stopBtn.addEventListener("click", () => this.stopGeneration());

		// Input: Enter to send, Shift+Enter for newline
		this.inputEl.addEventListener("keydown", (e) => {
			// Handle autocomplete selection
			if (
				e.key === "Tab" ||
				(e.key === "Enter" && this.isPopupVisible())
			) {
				const selected =
					this.slashPopup.querySelector(".ac-popup-item-active") ||
					this.mentionPopup.querySelector(".ac-popup-item-active");
				if (selected) {
					e.preventDefault();
					(selected as HTMLElement).click();
					return;
				}
			}

			// Navigate autocomplete with arrow keys
			if (
				(e.key === "ArrowDown" || e.key === "ArrowUp") &&
				this.isPopupVisible()
			) {
				e.preventDefault();
				this.navigatePopup(e.key === "ArrowDown" ? 1 : -1);
				return;
			}

			if (e.key === "Escape" && this.isPopupVisible()) {
				e.preventDefault();
				this.hideAllPopups();
				return;
			}

			if (e.key === "Enter" && !e.shiftKey) {
				e.preventDefault();
				void this.sendMessage();
			}
		});

		// Input: auto-resize + autocomplete + send button state
		this.inputEl.addEventListener("input", () => {
			this.autoResizeInput();
			this.handleAutocomplete();
			this.updateSendButtonState();
		});

		// Image paste handler
		this.inputEl.addEventListener("paste", (e) => {
			const items = e.clipboardData?.items;
			if (!items) return;
			for (let i = 0; i < items.length; i++) {
				const item = items[i];
				if (item.type.startsWith("image/")) {
					e.preventDefault();
					const file = item.getAsFile();
					if (file) void this.addImageFile(file);
					return;
				}
			}
		});

		// Image drag-and-drop on the chat view.
		// Obsidian intercepts drag events at the workspace level for its own
		// pane/file drag-drop handling, so events never reach .ac-input-area.
		// We attach to this.contentEl with capture phase and stopPropagation
		// to intercept before Obsidian does.
		const dropTarget = this.contentEl;

		dropTarget.addEventListener(
			"dragover",
			(e) => {
				if (e.dataTransfer?.types.includes("Files")) {
					e.preventDefault();
					e.stopPropagation();
					e.dataTransfer.dropEffect = "copy";
				}
			},
			{ capture: true }
		);
		dropTarget.addEventListener(
			"dragenter",
			(e) => {
				if (e.dataTransfer?.types.includes("Files")) {
					e.preventDefault();
					e.stopPropagation();
					this.dragEnterCount++;
					if (this.dragEnterCount === 1) {
						this.inputArea.addClass("ac-drop-active");
					}
				}
			},
			{ capture: true }
		);
		dropTarget.addEventListener(
			"dragleave",
			(e) => {
				if (!e.dataTransfer?.types.includes("Files")) return;
				this.dragEnterCount--;
				if (this.dragEnterCount <= 0) {
					this.dragEnterCount = 0;
					this.inputArea.removeClass("ac-drop-active");
				}
			},
			{ capture: true }
		);
		dropTarget.addEventListener(
			"drop",
			(e) => {
				if (!e.dataTransfer?.types.includes("Files")) return;
				e.preventDefault();
				e.stopPropagation();
				this.dragEnterCount = 0;
				this.inputArea.removeClass("ac-drop-active");
				const files = e.dataTransfer?.files;
				if (!files) return;
				for (let i = 0; i < files.length; i++) {
					if (files[i].type.startsWith("image/")) {
						void this.addImageFile(files[i]);
					}
				}
			},
			{ capture: true }
		);

		// File edit revert buttons (delegated)
		this.messagesContainer.addEventListener("click", (e) => {
			const target = e.target as HTMLElement;
			if (target.classList.contains("ac-btn-reject")) {
				void this.handleRevertEdit(target);
			}
		});
	}

	private isPopupVisible(): boolean {
		return (
			!this.slashPopup.hasClass("ac-hidden") ||
			!this.mentionPopup.hasClass("ac-hidden")
		);
	}

	private navigatePopup(direction: number): void {
		const popup = !this.slashPopup.hasClass("ac-hidden")
			? this.slashPopup
			: this.mentionPopup;
		const items = Array.from(popup.querySelectorAll(".ac-popup-item"));
		if (items.length === 0) return;

		const active = popup.querySelector(".ac-popup-item-active");
		let idx = active ? items.indexOf(active) : -1;
		if (active) active.removeClass("ac-popup-item-active");

		idx += direction;
		if (idx < 0) idx = items.length - 1;
		if (idx >= items.length) idx = 0;

		items[idx].addClass("ac-popup-item-active");
		(items[idx] as HTMLElement).scrollIntoView({ block: "nearest" });
	}

	private async sendMessage(): Promise<void> {
		const text = this.inputEl.value.trim();
		if ((!text && this.pendingImages.length === 0) || this.isGenerating) return;
		if (!this.sessionId) return;

		// Snapshot pending image paths before clearing
		const imagePaths = this.pendingImages.map((img) => img.tempPath);

		// Clear input and image UI (keep temp files for the CLI to read)
		this.inputEl.value = "";
		this.autoResizeInput();
		this.updateSendButtonState();
		this.hideAllPopups();
		this.resetPendingImagesUI();

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
		this.sendBtn.addClass("ac-hidden");
		this.stopBtn.removeClass("ac-hidden");
		this.streamingThinkingEl = null;
		this.streamingMessageEl = null;

		try {
			await this.sessionManager.sendPrompt(
				this.sessionId,
				text,
				context,
				{
					editApprovalMode: this.settings.editApprovalMode,
					imagePaths: imagePaths.length > 0 ? imagePaths : undefined,
				}
			);
			this.setActivity("Starting…");
		} catch (err) {
			const msg =
				err instanceof Error ? err.message : "Failed to send message";
			this.showError(msg);
			this.onGenerationComplete();
		}
	}

	private setActivity(text: string): void {
		this.clearActivity();
		this.activityBar = this.messagesContainer.createDiv({
			cls: "ac-activity-inline",
		});
		this.activityBar.createSpan({ cls: "ac-activity-spinner" });
		this.activityText = this.activityBar.createSpan({
			cls: "ac-activity-text",
			text,
		});
		this.scrollToBottom();
	}

	private clearActivity(): void {
		if (this.activityBar && this.activityBar.parentElement) {
			this.activityBar.remove();
		}
	}

	private handleMsgCount = 0;

	private handleMessage(message: AgentMessage): void {
		this.handleMsgCount++;
		if (this.handleMsgCount <= 10 || this.handleMsgCount % 20 === 0) {
			console.debug(
				`[agentic-copilot][PIPE-8] ChatView.handleMessage #${this.handleMsgCount}: role=${message.role} thinking=${!!message.isThinking} tool=${!!message.toolUse} len=${message.content.length}`
			);
		}

		// System messages carry metadata (e.g. CLI session ID) — not displayed
		if (message.role === "system") {
			if (message.cliSessionId) {
				this.updateSessionIdDisplay(message.cliSessionId);
			}
			return;
		}

		if (message.role === "user") {
			this.renderUserMessage(message);
			return;
		}

		if (message.role === "tool") {
			this.setActivity(this.extractActivityText(message));

			if (message.fileEdit) {
				// File edits get their own block with Keep/Revert controls.
				// The CLI already wrote the file — the renderer handles the
				// button labels based on editApprovalMode.
				this.streamingMessageEl = null;
				const el = this.messagesContainer.createDiv();
				this.renderer.renderFileEditBlock(message, el);
			} else {
				// Non-edit tools: render as compact chip inline
				if (!this.streamingMessageEl) {
					this.streamingMessageEl =
						this.messagesContainer.createDiv({
							cls: "ac-message ac-message-assistant",
						});
					this.streamingMessageEl.createDiv({
						cls: "ac-message-body",
					});
				}
				const body =
					this.streamingMessageEl.querySelector(".ac-message-body");
				if (body) {
					this.renderer.renderToolChip(
						message,
						body as HTMLElement
					);
				}
			}
			this.scrollToBottom();
			return;
		}

		// Assistant thinking — collapsible reasoning block
		if (message.role === "assistant" && message.isThinking) {
			this.setActivity("Thinking…");
			this.streamingMessageEl = null;

			if (!this.streamingThinkingEl) {
				this.streamingThinkingEl = this.messagesContainer.createDiv({
					cls: "ac-message ac-message-thinking",
				});
				const details = this.streamingThinkingEl.createEl("details", {
					cls: "ac-thinking",
				});
				details.setAttribute("open", "");
				const summary = details.createEl("summary", {
					cls: "ac-thinking-summary",
				});
				summary.createSpan({
					cls: "ac-thinking-icon",
					text: "Thinking",
				});
				summary.createSpan({ cls: "ac-thinking-label" });
				details.createDiv({ cls: "ac-thinking-content" });
			}

			const contentEl =
				this.streamingThinkingEl.querySelector<HTMLElement>(
					".ac-thinking-content"
				);
			if (contentEl) {
				void this.renderer.renderMarkdownInto(message.content, contentEl);
			}
			this.scrollToBottom();
			return;
		}

		// Assistant text — streaming accumulation
		if (message.role === "assistant") {
			this.setActivity("Responding…");
			if (this.streamingThinkingEl) {
				const details =
					this.streamingThinkingEl.querySelector("details");
				if (details) details.removeAttribute("open");
				this.streamingThinkingEl = null;
			}

			if (!this.streamingMessageEl) {
				this.streamingMessageEl = this.messagesContainer.createDiv({
					cls: "ac-message ac-message-assistant",
				});
				this.streamingMessageEl.createDiv({ cls: "ac-message-body" });
			}

			void this.renderer.renderStreamingText(
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

		// Show image thumbnails if the message had images attached
		if (message.imagePaths?.length) {
			const grid = el.createDiv({ cls: "ac-user-image-grid" });
			for (const imgPath of message.imagePaths) {
				const thumb = grid.createDiv({ cls: "ac-user-image-thumb" });
				const img = thumb.createEl("img", {
					attr: {
						src: `file://${imgPath}`,
						alt: imgPath.split("/").pop() || "image",
					},
				});
				img.addEventListener("error", () => {
					thumb.empty();
					thumb.addClass("ac-user-image-thumb-error");
					thumb.createSpan({ text: imgPath.split("/").pop() || "image" });
				});
			}
		}

		const body = el.createDiv({ cls: "ac-message-body" });
		body.createEl("p", { text: message.content });
		this.addCopyButton(el, message.content);
		this.scrollToBottom();
	}

	private extractActivityText(message: AgentMessage): string {
		if (!message.toolUse) return "Working…";
		const name = message.toolUse.name;
		try {
			const parsed = JSON.parse(message.toolUse.input);
			if (name === "Read" && parsed.file_path) {
				return `Reading ${this.shortenPath(parsed.file_path)}…`;
			}
			if ((name === "Write" || name === "Edit") && parsed.file_path) {
				return `Editing ${this.shortenPath(parsed.file_path)}…`;
			}
			if (name === "Grep" && parsed.pattern) {
				return `Searching for "${parsed.pattern}"…`;
			}
			if (name === "Glob" && parsed.pattern) {
				return `Finding ${parsed.pattern}…`;
			}
			if (name === "Bash" && parsed.command) {
				const cmd = parsed.command.split(" ")[0];
				return `Running ${cmd}…`;
			}
			if (name === "WebSearch" && parsed.query) {
				return "Searching web…";
			}
		} catch {
			/* ignore parse errors */
		}
		return `Using ${name}…`;
	}

	private shortenPath(filePath: string): string {
		const parts = filePath.split("/");
		if (parts.length <= 2) return filePath;
		return parts.slice(-2).join("/");
	}

	private onGenerationComplete(): void {
		this.isGenerating = false;
		this.clearActivity();
		if (this.streamingThinkingEl) {
			const details =
				this.streamingThinkingEl.querySelector("details");
			if (details) details.removeAttribute("open");
			this.streamingThinkingEl = null;
		}
		// Add copy button to the completed assistant message
		if (this.streamingMessageEl) {
			const body = this.streamingMessageEl.querySelector<HTMLElement>(
				".ac-message-body"
			);
			if (body) {
				this.addCopyButton(
					this.streamingMessageEl,
					body.textContent || ""
				);
			}
		}
		this.streamingMessageEl = null;
		this.sendBtn.removeClass("ac-hidden");
		this.stopBtn.addClass("ac-hidden");
	}

	private stopGeneration(): void {
		if (this.sessionId) {
			this.sessionManager.stopSession(this.sessionId);
		}
		this.onGenerationComplete();
	}

	private updateStatus(status: SessionStatus): void {
		const dot = this.statusEl.querySelector(".ac-status-dot");
		if (dot) dot.className = `ac-status-dot ac-status-${status}`;
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

	private addCopyButton(messageEl: HTMLElement, text: string): void {
		const btn = messageEl.createDiv({
			cls: "ac-copy-btn clickable-icon",
			attr: { "aria-label": "Copy" },
		});
		setIcon(btn, "copy");
		btn.addEventListener("click", (e) => {
			e.stopPropagation();
			void navigator.clipboard.writeText(text).then(() => {
				btn.empty();
				setIcon(btn, "check");
				btn.addClass("ac-copy-btn-done");
				setTimeout(() => {
					btn.empty();
					setIcon(btn, "copy");
					btn.removeClass("ac-copy-btn-done");
				}, 1500);
			});
		});
	}

	private autoResizeInput(): void {
		// Reset to auto so scrollHeight reflects the actual content size
		this.inputEl.setCssProps({ "--ac-input-height": "auto" });
		// Force a layout reflow so scrollHeight updates
		const scrollH = this.inputEl.scrollHeight;
		const h = Math.min(scrollH, 200) + "px";
		this.inputEl.setCssProps({ "--ac-input-height": h });
	}

	private updateSendButtonState(): void {
		if (this.inputEl.value.trim() || this.pendingImages.length > 0) {
			this.sendBtn.addClass("ac-btn-send-active");
		} else {
			this.sendBtn.removeClass("ac-btn-send-active");
		}
	}

	// ── Image handling ──

	/**
	 * Save a File (from clipboard or drop) to a temp directory and add it
	 * to the pending images list with a thumbnail preview.
	 */
	private async addImageFile(file: File): Promise<void> {
		try {
			const buffer = Buffer.from(await file.arrayBuffer());
			const ext = this.imageExtFromMime(file.type);
			const tempDir = path.join(os.tmpdir(), "agentic-copilot-images");
			fs.mkdirSync(tempDir, { recursive: true });
			const tempPath = path.join(
				tempDir,
				`img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`
			);
			fs.writeFileSync(tempPath, buffer);

			const objectUrl = URL.createObjectURL(file);
			const pending: PendingImage = {
				tempPath,
				name: file.name || path.basename(tempPath),
				objectUrl,
			};
			this.pendingImages.push(pending);
			this.renderImagePreviews();
			this.updateSendButtonState();
		} catch (err) {
			const msg = err instanceof Error ? err.message : "Failed to save image";
			new Notice(`Image error: ${msg}`);
		}
	}

	/** Map MIME type to file extension. */
	private imageExtFromMime(mime: string): string {
		switch (mime) {
			case "image/png": return ".png";
			case "image/jpeg": return ".jpg";
			case "image/gif": return ".gif";
			case "image/webp": return ".webp";
			case "image/svg+xml": return ".svg";
			case "image/bmp": return ".bmp";
			default: return ".png";
		}
	}

	/** Render the image preview strip from current pendingImages state. */
	private renderImagePreviews(): void {
		this.imagePreviewArea.empty();
		if (this.pendingImages.length === 0) {
			this.imagePreviewArea.addClass("ac-hidden");
			return;
		}
		this.imagePreviewArea.removeClass("ac-hidden");

		for (let i = 0; i < this.pendingImages.length; i++) {
			const img = this.pendingImages[i];
			const thumb = this.imagePreviewArea.createDiv({ cls: "ac-image-thumb" });
			const imgEl = thumb.createEl("img", {
				attr: { src: img.objectUrl, alt: img.name },
			});
			imgEl.addClass("ac-image-thumb-img");

			const removeBtn = thumb.createDiv({
				cls: "ac-image-thumb-remove clickable-icon",
				attr: { "aria-label": "Remove image" },
			});
			setIcon(removeBtn, "x");
			const idx = i;
			removeBtn.addEventListener("click", () => this.removePendingImage(idx));
		}
	}

	/** Remove a pending image by index, revoke its object URL, and re-render. */
	private removePendingImage(index: number): void {
		const removed = this.pendingImages.splice(index, 1);
		for (const img of removed) {
			URL.revokeObjectURL(img.objectUrl);
			// Best-effort temp file cleanup
			try { fs.unlinkSync(img.tempPath); } catch { /* ignore */ }
		}
		this.renderImagePreviews();
		this.updateSendButtonState();
	}

	/** Reset UI state for pending images without deleting temp files (used when sending). */
	private resetPendingImagesUI(): void {
		for (const img of this.pendingImages) {
			URL.revokeObjectURL(img.objectUrl);
		}
		this.pendingImages = [];
		this.imagePreviewArea.empty();
		this.imagePreviewArea.addClass("ac-hidden");
	}

	/** Clear all pending images, revoke object URLs, delete temp files, and hide the preview strip. */
	private clearPendingImages(): void {
		for (const img of this.pendingImages) {
			URL.revokeObjectURL(img.objectUrl);
			try { fs.unlinkSync(img.tempPath); } catch { /* ignore */ }
		}
		this.pendingImages = [];
		this.imagePreviewArea.empty();
		this.imagePreviewArea.addClass("ac-hidden");
	}

	// ── Autocomplete ──

	private handleAutocomplete(): void {
		const text = this.inputEl.value;
		const cursor = this.inputEl.selectionStart;
		const beforeCursor = text.slice(0, cursor);

		// Check for @ mention (files)
		const atMatch = beforeCursor.match(/@([\w./-]*)$/);
		if (atMatch) {
			this.showFileMentions(atMatch[1]);
			return;
		}

		// Check for # mention (tags)
		const hashMatch = beforeCursor.match(/#([\w/-]*)$/);
		if (hashMatch && !beforeCursor.endsWith("##")) {
			this.showTagMentions(hashMatch[1]);
			return;
		}

		// Check for / commands (only at start)
		if (text.startsWith("/") && !text.includes(" ")) {
			const filter = text.toLowerCase();
			const matches = this.slashCommands.filter((cmd) =>
				cmd.name.toLowerCase().startsWith(filter)
			);
			if (matches.length > 0) {
				this.showSlashPopup(matches);
				return;
			}
		}

		this.hideAllPopups();
	}

	private showFileMentions(query: string): void {
		this.hideAllPopups();
		const files = this.app.vault.getMarkdownFiles();
		const q = query.toLowerCase();
		const matches = files
			.filter((f) => f.path.toLowerCase().includes(q))
			.sort((a, b) => b.stat.mtime - a.stat.mtime)
			.slice(0, 8);

		if (matches.length === 0) {
			this.mentionPopup.addClass("ac-hidden");
			return;
		}

		this.mentionPopup.empty();
		this.mentionPopup.removeClass("ac-hidden");

		for (const file of matches) {
			const item = this.mentionPopup.createDiv({
				cls: "ac-popup-item",
			});
			const iconEl = item.createSpan({ cls: "ac-popup-item-icon" });
			setIcon(iconEl, "file-text");
			item.createSpan({
				cls: "ac-popup-item-text",
				text: file.name,
			});
			const dirPath = file.path.slice(
				0,
				file.path.length - file.name.length - 1
			);
			if (dirPath) {
				item.createSpan({
					cls: "ac-popup-item-desc",
					text: dirPath,
				});
			}

			item.addEventListener("click", () => {
				this.insertMention("@", query, file.path);
			});
		}
		// Activate first item
		const first = this.mentionPopup.querySelector(".ac-popup-item");
		if (first) first.addClass("ac-popup-item-active");
	}

	private showTagMentions(query: string): void {
		this.hideAllPopups();
		let tags: string[] = [];
		try {
			const tagMap = (
				this.app.metadataCache as unknown as {
					getTags: () => Record<string, number>;
				}
			).getTags();
			if (tagMap) {
				tags = Object.keys(tagMap);
			}
		} catch {
			/* getTags may not be available */
		}

		const q = query.toLowerCase();
		const matches = tags
			.filter((t) => t.toLowerCase().includes(q))
			.slice(0, 8);

		if (matches.length === 0) {
			this.mentionPopup.addClass("ac-hidden");
			return;
		}

		this.mentionPopup.empty();
		this.mentionPopup.removeClass("ac-hidden");

		for (const tag of matches) {
			const item = this.mentionPopup.createDiv({
				cls: "ac-popup-item",
			});
			const iconEl = item.createSpan({ cls: "ac-popup-item-icon" });
			setIcon(iconEl, "hash");
			item.createSpan({
				cls: "ac-popup-item-text",
				text: tag,
			});

			item.addEventListener("click", () => {
				// Tags from metadataCache include the # prefix
				const tagName = tag.startsWith("#") ? tag.slice(1) : tag;
				this.insertMention("#", query, tagName);
			});
		}
		const first = this.mentionPopup.querySelector(".ac-popup-item");
		if (first) first.addClass("ac-popup-item-active");
	}

	private insertMention(
		trigger: string,
		query: string,
		replacement: string
	): void {
		const cursor = this.inputEl.selectionStart;
		const text = this.inputEl.value;
		// Find the trigger position
		const start = cursor - query.length - trigger.length;
		const before = text.slice(0, start);
		const after = text.slice(cursor);
		this.inputEl.value = `${before}${trigger}${replacement} ${after}`;
		const newCursor = start + trigger.length + replacement.length + 1;
		this.inputEl.selectionStart = newCursor;
		this.inputEl.selectionEnd = newCursor;
		this.inputEl.focus();
		this.hideAllPopups();
		this.autoResizeInput();
	}

	private showSlashPopup(commands: SlashCommand[]): void {
		this.hideAllPopups();
		this.slashPopup.empty();
		this.slashPopup.removeClass("ac-hidden");

		for (const cmd of commands) {
			const item = this.slashPopup.createDiv({
				cls: "ac-popup-item",
			});
			item.createSpan({ cls: "ac-popup-item-text", text: cmd.name });
			item.createSpan({
				cls: "ac-popup-item-desc",
				text: cmd.description,
			});

			item.addEventListener("click", () => {
				this.inputEl.value = cmd.name + " ";
				this.inputEl.focus();
				this.hideAllPopups();
			});
		}
		const first = this.slashPopup.querySelector(".ac-popup-item");
		if (first) first.addClass("ac-popup-item-active");
	}

	private hideAllPopups(): void {
		this.slashPopup.addClass("ac-hidden");
		this.mentionPopup.addClass("ac-hidden");
	}

	private async handleRevertEdit(button: HTMLElement): Promise<void> {
		const filePath = button.dataset.filePath;
		const oldContent = button.dataset.oldContent;
		const newContent = button.dataset.newContent;

		if (!filePath) return;

		try {
			await this.onRevertEdit(filePath, oldContent || "", newContent || "");
			const editBlock = button.closest(".ac-file-edit");
			if (editBlock) {
				editBlock.addClass("ac-file-edit-rejected");
				const actions = editBlock.querySelector(
					".ac-file-edit-actions"
				);
				if (actions) {
					actions.empty();
					actions.createSpan({
						cls: "ac-file-edit-status",
						text: "Reverted",
					});
				}
			}
			new Notice(`Reverted edit to ${filePath}`);
		} catch (err) {
			const msg =
				err instanceof Error ? err.message : "Failed to revert edit";
			new Notice(`Failed to revert: ${msg}`);
		}
	}

	/**
	 * Public method to inject a prompt from an external command.
	 */
	async injectPrompt(prompt: string): Promise<void> {
		this.inputEl.value = prompt;
		await this.sendMessage();
	}
}
