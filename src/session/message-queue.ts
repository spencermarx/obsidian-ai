import { AgentMessage } from "../adapters/types";

/**
 * Buffers streaming message chunks and emits complete messages.
 *
 * For streaming adapters that emit partial text deltas, this accumulates
 * them into a single assistant message until a new message role appears
 * or the stream ends.
 */
export class MessageQueue {
	private messages: AgentMessage[] = [];
	private currentBuffer: string = "";
	private currentRole: AgentMessage["role"] | null = null;
	private listeners: Array<(msg: AgentMessage) => void> = [];

	/** Register a callback for each complete message. */
	onMessage(callback: (msg: AgentMessage) => void): void {
		this.listeners.push(callback);
	}

	/** Remove all listeners. */
	removeAllListeners(): void {
		this.listeners = [];
	}

	/** Push a parsed message from the adapter's stream parser. */
	push(message: AgentMessage): void {
		// If this is a text delta for the same role, accumulate
		if (
			message.role === "assistant" &&
			this.currentRole === "assistant" &&
			!message.toolUse &&
			!message.fileEdit
		) {
			this.currentBuffer += message.content;
			// Emit an update for the accumulated message
			const accumulated: AgentMessage = {
				role: "assistant",
				content: this.currentBuffer,
				timestamp: message.timestamp,
			};
			this.emit(accumulated);
			return;
		}

		// Flush any buffered text before switching roles
		this.flush();

		// Tool use and file edit messages are emitted immediately
		if (message.toolUse || message.fileEdit || message.role !== "assistant") {
			this.messages.push(message);
			this.emit(message);
			return;
		}

		// Start a new assistant buffer
		this.currentRole = "assistant";
		this.currentBuffer = message.content;
		this.emit(message);
	}

	/** Flush any remaining buffered content. */
	flush(): void {
		if (this.currentBuffer && this.currentRole) {
			const msg: AgentMessage = {
				role: this.currentRole,
				content: this.currentBuffer,
				timestamp: Date.now(),
			};
			this.messages.push(msg);
			this.currentBuffer = "";
			this.currentRole = null;
		}
	}

	/** Get the full message history. */
	getMessages(): AgentMessage[] {
		const result = [...this.messages];
		if (this.currentBuffer && this.currentRole) {
			result.push({
				role: this.currentRole,
				content: this.currentBuffer,
				timestamp: Date.now(),
			});
		}
		return result;
	}

	/** Clear all messages. */
	clear(): void {
		this.messages = [];
		this.currentBuffer = "";
		this.currentRole = null;
	}

	private emit(message: AgentMessage): void {
		for (const listener of this.listeners) {
			listener(message);
		}
	}
}
