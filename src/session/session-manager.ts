import { spawn, type ChildProcess } from "child_process";
import { promises as fs } from "fs";
import * as nodePath from "path";
import {
  type AgentAdapter,
  type AgentMessage,
  type VaultContext,
} from "../adapters/types";
import { MessageQueue } from "./message-queue";
import {
  getShell,
  isWindows,
  getExpandedPath,
  whichBinary,
} from "../utils/platform";

export type SessionStatus = "idle" | "running" | "error" | "terminated";

export interface Session {
  id: string;
  adapter: AgentAdapter;
  status: SessionStatus;
  process: ChildProcess | null;
  messageQueue: MessageQueue;
  userMessages: AgentMessage[];
  error?: string;
  /** Handle for the force-kill timer so we can cancel it. */
  killTimer?: ReturnType<typeof setTimeout>;
  /** CLI-level session UUID for conversation persistence and resumption. */
  cliSessionId: string;
  /** True after the first prompt has been sent and the CLI has initialized the session. */
  sessionInitialized: boolean;
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
  private beforeUnloadHandler: (() => void) | null = null;

  constructor() {
    // Register a beforeunload handler so we kill child processes
    // when Obsidian is closed or the window is refreshed.
    this.beforeUnloadHandler = () => this.destroyAll();
    window.addEventListener("beforeunload", this.beforeUnloadHandler);
  }

  /** Listen for session events. Returns an unsubscribe function. */
  onEvent(callback: (event: SessionEvent) => void): () => void {
    this.listeners.push(callback);
    return () => {
      const idx = this.listeners.indexOf(callback);
      if (idx !== -1) this.listeners.splice(idx, 1);
    };
  }

  /** Remove all event listeners. */
  removeAllListeners(): void {
    this.listeners = [];
  }

  /** Create a new session with the given adapter, optionally resuming an existing CLI session. */
  createSession(adapter: AgentAdapter, resumeCliSessionId?: string): string {
    const id = `session-${this.nextId++}`;
    const session: Session = {
      id,
      adapter,
      status: "idle",
      process: null,
      messageQueue: new MessageQueue(),
      userMessages: [],
      cliSessionId: resumeCliSessionId || crypto.randomUUID(),
      sessionInitialized: !!resumeCliSessionId,
    };

    session.messageQueue.onMessage((msg) => {
      // Update CLI session ID when the adapter reports it from the stream
      if (msg.cliSessionId) {
        session.cliSessionId = msg.cliSessionId;
      }
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
      (s) => s.status !== "terminated",
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
    context: VaultContext,
    opts?: {
      editApprovalMode?: "approve" | "auto-accept";
      imagePaths?: string[];
    },
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    // Kill any existing process for this session and wait for it to exit,
    // so the CLI releases its session lock before we spawn a new process.
    await this.killProcess(session);

    // Record user message
    const userMessage: AgentMessage = {
      role: "user",
      content: prompt,
      imagePaths: opts?.imagePaths,
      timestamp: Date.now(),
    };
    session.userMessages.push(userMessage);
    this.emit({
      sessionId,
      type: "message",
      message: userMessage,
    });

    // Read and base64-encode images asynchronously (avoids blocking the
    // main thread with readFileSync in the adapter).
    let imageData: Array<{ base64: string; mimeType: string }> | undefined;
    if (opts?.imagePaths?.length) {
      imageData = await Promise.all(
        opts.imagePaths.map(async (imgPath) => {
          const buf = await fs.readFile(imgPath);
          return {
            base64: buf.toString("base64"),
            mimeType: mimeFromExtension(imgPath),
          };
        }),
      );
      // Temp files are now encoded in memory — clean them up.
      for (const imgPath of opts.imagePaths) {
        fs.unlink(imgPath).catch(() => {});
      }
    }

    // Build spawn args — use --resume for subsequent prompts
    const spawnArgs = session.adapter.buildSpawnArgs({
      prompt,
      context,
      cwd: context.vaultPath,
      editApprovalMode: opts?.editApprovalMode,
      cliSessionId: session.cliSessionId,
      resumeSession: session.sessionInitialized,
      imagePaths: opts?.imagePaths,
      imageData,
    });

    // Resolve the full binary path before spawning.
    // We must NOT use shell: true because the shell performs word-splitting
    // on the prompt argument, breaking multi-word prompts.
    const resolvedBinary =
      (await whichBinary(spawnArgs.command)) || spawnArgs.command;

    console.debug(
      "[agentic-copilot][PIPE-1] spawning:",
      resolvedBinary,
      spawnArgs.args.map((a) => (a.length > 80 ? a.slice(0, 80) + "…" : a)),
    );

    // Spawn the process
    try {
      this.setStatus(session, "running");

      const expandedEnv = {
        ...process.env,
        PATH: getExpandedPath(),
        ...spawnArgs.env,
      };
      const useDetached = !isWindows();
      const proc = spawn(resolvedBinary, spawnArgs.args, {
        cwd: context.vaultPath,
        env: expandedEnv,
        // NO shell: true — it word-splits the prompt, breaking everything.
        // We resolve the full binary path above via whichBinary() instead.
        shell: isWindows() ? getShell() : false,
        stdio: ["pipe", "pipe", "pipe"],
        // Detach on Unix so we get a process group we can kill
        // as a unit (prevents orphaned agent processes).
        detached: useDetached,
      });

      // Prevent the detached child from keeping Obsidian alive
      if (useDetached) {
        proc.unref();
      }

      session.process = proc;
      session.sessionInitialized = true;

      // Write any stdin data (e.g. stream-json multimodal messages)
      // then close stdin so the CLI doesn't wait for more input.
      // Use the write callback to avoid truncation from back-pressure.
      if (proc.stdin) {
        if (spawnArgs.stdinData) {
          proc.stdin.write(spawnArgs.stdinData, () => proc.stdin.end());
        } else {
          proc.stdin.end();
        }
      }

      console.debug(
        "[agentic-copilot] process spawned, pid:",
        proc.pid,
        "stdin closed:",
        proc.stdin?.destroyed ?? "no stdin",
        "stdout readable:",
        !!proc.stdout,
        "stderr readable:",
        !!proc.stderr,
      );

      // Parse stdout through the adapter.
      // Catch errors so a crash in the stream parser is visible.
      if (proc.stdout) {
        this.consumeStream(session, proc).catch((err) => {
          const msg =
            err instanceof Error ? err.message : "Stream parsing failed";
          console.error("[agentic-copilot] consumeStream error:", err);
          this.emit({
            sessionId,
            type: "error",
            error: msg,
          });
        });
      }

      // Capture stderr for error reporting and debugging
      let stderrBuffer = "";
      if (proc.stderr) {
        proc.stderr.on("data", (chunk) => {
          const text = chunk.toString();
          stderrBuffer += text;
          console.debug("[agentic-copilot] stderr:", text.trim());
        });
      }

      proc.on("error", (err) => {
        console.error("[agentic-copilot] process error:", err);
        session.error = err.message;
        this.setStatus(session, "error");
        this.emit({
          sessionId,
          type: "error",
          error: err.message,
        });
      });

      proc.on("close", (code) => {
        console.debug("[agentic-copilot] process closed, code:", code);
        session.messageQueue.flush();
        session.process = null;

        // 128+signal codes: 143=SIGTERM, 130=SIGINT — these are
        // normal user-initiated stops, not errors.
        const isSignalExit = code === 143 || code === 130;

        if (code !== 0 && code !== null && !isSignalExit) {
          const errMsg =
            stderrBuffer.trim() || `Process exited with code ${code}`;
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
      console.error("[agentic-copilot] spawn error:", err);
      session.error = message;
      this.setStatus(session, "error");
      this.emit({ sessionId, type: "error", error: message });
    }
  }

  /** Stop the running process for a session. */
  stopSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      void this.killProcess(session);
      this.setStatus(session, "idle");
    }
  }

  /** Terminate and remove a session entirely. */
  destroySession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    void this.killProcess(session);
    if (session.killTimer) {
      clearTimeout(session.killTimer);
      session.killTimer = undefined;
    }
    session.messageQueue.removeAllListeners();
    this.setStatus(session, "terminated");
    this.sessions.delete(sessionId);
  }

  /**
   * Kill all sessions and remove global handlers.
   * Called on plugin unload or window close.
   */
  destroyAll(): void {
    for (const [id] of this.sessions) {
      this.destroySession(id);
    }
    this.removeAllListeners();

    if (this.beforeUnloadHandler) {
      window.removeEventListener("beforeunload", this.beforeUnloadHandler);
      this.beforeUnloadHandler = null;
    }
  }

  private async consumeStream(
    session: Session,
    proc: ChildProcess,
  ): Promise<void> {
    if (!proc.stdout) return;

    let messageCount = 0;
    try {
      for await (const message of session.adapter.parseOutputStream(
        proc.stdout,
      )) {
        if (session.process !== proc) break; // Session was restarted
        messageCount++;
        try {
          session.messageQueue.push(message);
        } catch (pushErr) {
          // A listener error must not kill the stream loop
          console.error("[agentic-copilot] messageQueue.push error:", pushErr);
        }
      }
    } catch (err) {
      console.error(
        "[agentic-copilot] stream consumption error after",
        messageCount,
        "messages:",
        err,
      );
    }

    console.debug(
      "[agentic-copilot] stream ended, total messages:",
      messageCount,
    );
  }

  /**
   * Kill a session's child process and its entire process group.
   *
   * We spawn with `detached: true` on Unix so the child gets its own
   * process group. Killing the negative PID terminates the entire group,
   * preventing orphaned agent processes.
   */
  private killProcess(session: Session): Promise<void> {
    // Clear any pending force-kill timer from a previous kill attempt
    if (session.killTimer) {
      clearTimeout(session.killTimer);
      session.killTimer = undefined;
    }

    if (!session.process) return Promise.resolve();

    const proc = session.process;
    const pid = proc.pid;
    session.process = null;

    // Try graceful shutdown first
    try {
      if (pid && !isWindows()) {
        // Kill the entire process group so shell children die too
        process.kill(-pid, "SIGTERM");
      } else {
        proc.kill("SIGTERM");
      }
    } catch {
      // Already dead
      return Promise.resolve();
    }

    // Force kill after 3 seconds if still running
    session.killTimer = setTimeout(() => {
      session.killTimer = undefined;
      try {
        if (pid && !isWindows()) {
          process.kill(-pid, "SIGKILL");
        } else {
          proc.kill("SIGKILL");
        }
      } catch {
        // Already dead
      }
    }, 3000);

    // Return a promise that resolves when the process actually exits
    return new Promise<void>((resolve) => {
      proc.once("close", () => {
        if (session.killTimer) {
          clearTimeout(session.killTimer);
          session.killTimer = undefined;
        }
        resolve();
      });
    });
  }

  private setStatus(session: Session, status: SessionStatus): void {
    session.status = status;
    this.emit({
      sessionId: session.id,
      type: "status",
      status,
    });
  }

  private emitCount = 0;

  private emit(event: SessionEvent): void {
    this.emitCount++;
    // [PIPE-7] Log session manager emit
    if (
      event.type === "message" &&
      (this.emitCount <= 5 || this.emitCount % 20 === 0)
    ) {
      const msg = event.message;
      console.debug(
        `[agentic-copilot][PIPE-7] SM.emit #${this.emitCount}: type=${event.type} role=${msg?.role} thinking=${!!msg?.isThinking} listeners=${this.listeners.length}`,
      );
    }
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

/** Map a file extension to its MIME type for image uploads. */
function mimeFromExtension(filePath: string): string {
  const ext = nodePath.extname(filePath).toLowerCase();
  switch (ext) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".bmp":
      return "image/bmp";
    case ".svg":
      return "image/svg+xml";
    default:
      return "image/png";
  }
}
