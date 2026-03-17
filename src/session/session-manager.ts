import { spawn, ChildProcess } from "child_process";
import { AgentAdapter, AgentMessage, VaultContext } from "../adapters/types";
import { MessageQueue } from "./message-queue";
import { getShell, isWindows, getExpandedPath } from "../utils/platform";

export type SessionStatus = "idle" | "running" | "error" | "terminated";

export interface Session {
	id: string;
	adapter: AgentAdapter;
	status: SessionStatus;
	process: ChildProcess | null;
	messageQueue: MessageQueue;
	userMessages: AgentMessage[];
	error?: string;
}

type SessionEventType = "message" | "status" | "error" | "complete";

interface SessionEvent {
	sessionId: string;
	type: SessionEventType;
	message?: AgentMessage;
	status?: SessionStatus;
	error?: string;
}

/**
 * Manages multiple concurrent agent sessions.
 *
 * Each session owns a child process and a message queue. The manager
 * handles spawning, streaming, lifecycle, and cleanup.
 */
export class SessionManager {
	private sessions = new Map<string, Session>();
	private listeners: Array<(event: SessionEvent) => void> = [];
	private nextId = 1;

	/** Listen for session events (messages, status changes, errors). */
	onEvent(callback: (event: SessionEvent) => void): void {
		this.listeners.push(callback);
	}

	/** Remove all event listeners. */
	removeAllListeners(): void {
		this.listeners = [];
	}

	/** Create a new session with the given adapter. */
	createSession(adapter: AgentAdapter): string {
		const id = `session-${this.nextId++}`;
		const session: Session = {
			id,
			adapter,
			status: "idle",
			process: null,
			messageQueue: new MessageQueue(),
			userMessages: [],
		};

		session.messageQueue.onMessage((msg) => {
			this.emit({ sessionId: id, type: "message", message: msg });
		});

		this.sessions.set(id, session);
		return id;
	}

	/** Get a session by ID. */
	getSession(id: string): Session | undefined {
		return this.sessions.get(id);
	}

	/** Get all active sessions. */
	getActiveSessions(): Session[] {
		return Array.from(this.sessions.values()).filter(
			(s) => s.status !== "terminated"
		);
	}

	/**
	 * Send a prompt to a session, spawning a new agent process.
	 *
	 * Each prompt creates a new child_process invocation (one-shot mode).
	 * The process streams its output back through the message queue.
	 */
	async sendPrompt(
		sessionId: string,
		prompt: string,
		context: VaultContext
	): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) throw new Error(`Session ${sessionId} not found`);

		// Kill any existing process for this session
		this.killProcess(session);

		// Record user message
		const userMessage: AgentMessage = {
			role: "user",
			content: prompt,
			timestamp: Date.now(),
		};
		session.userMessages.push(userMessage);
		this.emit({
			sessionId,
			type: "message",
			message: userMessage,
		});

		// Build spawn args
		const spawnArgs = session.adapter.buildSpawnArgs({
			prompt,
			context,
			cwd: context.vaultPath,
		});

		// Spawn the process
		try {
			this.setStatus(session, "running");

			const shell = getShell();
			const expandedEnv = {
				...process.env,
				PATH: getExpandedPath(),
				...spawnArgs.env,
			};
			const proc = spawn(spawnArgs.command, spawnArgs.args, {
				cwd: context.vaultPath,
				env: expandedEnv,
				shell: isWindows() ? shell : true,
				stdio: ["pipe", "pipe", "pipe"],
			});

			session.process = proc;

			// Parse stdout through the adapter
			if (proc.stdout) {
				this.consumeStream(session, proc);
			}

			// Capture stderr for error reporting
			let stderrBuffer = "";
			if (proc.stderr) {
				proc.stderr.on("data", (chunk) => {
					stderrBuffer += chunk.toString();
				});
			}

			proc.on("error", (err) => {
				session.error = err.message;
				this.setStatus(session, "error");
				this.emit({
					sessionId,
					type: "error",
					error: err.message,
				});
			});

			proc.on("close", (code) => {
				session.messageQueue.flush();
				session.process = null;

				if (code !== 0 && code !== null) {
					const errMsg =
						stderrBuffer.trim() ||
						`Process exited with code ${code}`;
					session.error = errMsg;
					this.setStatus(session, "error");
					this.emit({
						sessionId,
						type: "error",
						error: errMsg,
					});
				} else {
					this.setStatus(session, "idle");
				}

				this.emit({ sessionId, type: "complete" });
			});
		} catch (err) {
			const message =
				err instanceof Error ? err.message : "Failed to spawn process";
			session.error = message;
			this.setStatus(session, "error");
			this.emit({ sessionId, type: "error", error: message });
		}
	}

	/** Stop the running process for a session. */
	stopSession(sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (session) {
			this.killProcess(session);
			this.setStatus(session, "idle");
		}
	}

	/** Terminate and remove a session entirely. */
	destroySession(sessionId: string): void {
		const session = this.sessions.get(sessionId);
		if (session) {
			this.killProcess(session);
			session.messageQueue.removeAllListeners();
			this.setStatus(session, "terminated");
			this.sessions.delete(sessionId);
		}
	}

	/** Kill all sessions. Called on plugin unload. */
	destroyAll(): void {
		for (const [id] of this.sessions) {
			this.destroySession(id);
		}
		this.removeAllListeners();
	}

	private async consumeStream(
		session: Session,
		proc: ChildProcess
	): Promise<void> {
		if (!proc.stdout) return;

		try {
			for await (const message of session.adapter.parseOutputStream(
				proc.stdout
			)) {
				if (session.process !== proc) break; // Session was restarted
				session.messageQueue.push(message);
			}
		} catch (err) {
			// Stream ended or errored — handled by 'close' event
		}
	}

	private killProcess(session: Session): void {
		if (session.process) {
			try {
				session.process.kill("SIGTERM");
				// Force kill after 3 seconds if still running
				const proc = session.process;
				setTimeout(() => {
					try {
						proc.kill("SIGKILL");
					} catch {
						// Already dead
					}
				}, 3000);
			} catch {
				// Already dead
			}
			session.process = null;
		}
	}

	private setStatus(session: Session, status: SessionStatus): void {
		session.status = status;
		this.emit({
			sessionId: session.id,
			type: "status",
			status,
		});
	}

	private emit(event: SessionEvent): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}
}
