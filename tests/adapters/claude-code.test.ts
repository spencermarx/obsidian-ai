import { describe, it, expect } from "vitest";
import { ClaudeCodeAdapter } from "../../src/adapters/claude-code";
import type { VaultContext } from "../../src/adapters/types";
import { Readable } from "stream";

const vault: VaultContext = { vaultPath: "/vault" };

describe("ClaudeCodeAdapter", () => {
  const adapter = new ClaudeCodeAdapter();

  // ── Spawn configuration ──

  describe("text-only prompts", () => {
    it("produces a non-interactive CLI invocation with the prompt", () => {
      const { command, args, stdinData } = adapter.buildSpawnArgs({
        prompt: "explain this code",
        context: vault,
        cwd: "/vault",
      });

      expect(command).toBe("claude");
      expect(args.join(" ")).toContain("-p");
      expect(args.join(" ")).toContain("--output-format stream-json");
      expect(stdinData).toBeUndefined();
      // The prompt text appears somewhere in the args
      expect(args.some((a) => a.includes("explain this code"))).toBe(true);
    });

    it("includes vault context when active file is provided", () => {
      const { args } = adapter.buildSpawnArgs({
        prompt: "refactor",
        context: {
          vaultPath: "/vault",
          activeFilePath: "src/main.ts",
          activeFileContent: "const x = 1;",
        },
        cwd: "/vault",
      });

      const fullPrompt = args.find((a) => a.includes("refactor"))!;
      expect(fullPrompt).toContain("src/main.ts");
    });
  });

  describe("session persistence", () => {
    it("creates a new session on first invocation", () => {
      const { args } = adapter.buildSpawnArgs({
        prompt: "hi",
        context: vault,
        cwd: "/vault",
        cliSessionId: "session-abc",
        resumeSession: false,
      });

      expect(args.join(" ")).toContain("--session-id session-abc");
      expect(args.join(" ")).not.toContain("--resume");
    });

    it("resumes an existing session on subsequent invocations", () => {
      const { args } = adapter.buildSpawnArgs({
        prompt: "hi",
        context: vault,
        cwd: "/vault",
        cliSessionId: "session-abc",
        resumeSession: true,
      });

      expect(args.join(" ")).toContain("--resume session-abc");
      expect(args.join(" ")).not.toContain("--session-id");
    });
  });

  describe("multimodal image support", () => {
    it("sends images as base64 via stdin when imageData is provided", () => {
      const { args, stdinData } = adapter.buildSpawnArgs({
        prompt: "describe this screenshot",
        context: vault,
        cwd: "/vault",
        imageData: [{ base64: "iVBORw0KGgo=", mimeType: "image/png" }],
      });

      expect(args.join(" ")).toContain("--input-format stream-json");
      expect(stdinData).toBeDefined();

      const envelope = JSON.parse(stdinData!);
      expect(envelope.message.content).toHaveLength(2);

      const [textBlock, imageBlock] = envelope.message.content;
      expect(textBlock.type).toBe("text");
      expect(textBlock.text).toContain("describe this screenshot");
      expect(imageBlock.type).toBe("image");
      expect(imageBlock.source.media_type).toBe("image/png");
      expect(imageBlock.source.data).toBe("iVBORw0KGgo=");
    });

    it("uses standard -p mode when no images are attached", () => {
      const { stdinData } = adapter.buildSpawnArgs({
        prompt: "no images here",
        context: vault,
        cwd: "/vault",
        imageData: [],
      });

      expect(stdinData).toBeUndefined();
    });
  });

  // ── Stream parsing ──

  describe("output stream parsing", () => {
    function streamFromLines(lines: string[]): Readable {
      return new Readable({
        read() {
          this.push(lines.join("\n") + "\n");
          this.push(null);
        },
      });
    }

    async function collectMessages(lines: string[]) {
      const msgs = [];
      for await (const msg of adapter.parseOutputStream(
        streamFromLines(lines),
      )) {
        msgs.push(msg);
      }
      return msgs;
    }

    it("extracts session ID from system init events", async () => {
      const msgs = await collectMessages([
        JSON.stringify({
          type: "system",
          session_id: "new-session-id",
          slash_commands: ["compact"],
        }),
      ]);

      expect(msgs).toHaveLength(1);
      expect(msgs[0].cliSessionId).toBe("new-session-id");
    });

    it("yields text content from streaming delta events", async () => {
      const msgs = await collectMessages([
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            content_block: { type: "text" },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "Hello world" },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_stop" },
        }),
      ]);

      const textMsgs = msgs.filter(
        (m) => m.role === "assistant" && !m.isThinking,
      );
      expect(textMsgs).toHaveLength(1);
      expect(textMsgs[0].content).toBe("Hello world");
    });

    it("marks thinking blocks as isThinking", async () => {
      const msgs = await collectMessages([
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            content_block: { type: "thinking" },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "thinking_delta", thinking: "reasoning..." },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_stop" },
        }),
      ]);

      expect(
        msgs.some((m) => m.isThinking && m.content === "reasoning..."),
      ).toBe(true);
    });

    it("emits file edits from Edit tool_use blocks", async () => {
      const editInput = JSON.stringify({
        file_path: "/src/app.ts",
        new_string: "const y = 2;",
        old_string: "const x = 1;",
      });

      const msgs = await collectMessages([
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_start",
            content_block: { type: "tool_use", name: "Edit" },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "input_json_delta", partial_json: editInput },
          },
        }),
        JSON.stringify({
          type: "stream_event",
          event: { type: "content_block_stop" },
        }),
      ]);

      const toolMsg = msgs.find((m) => m.role === "tool");
      expect(toolMsg).toBeDefined();
      expect(toolMsg!.fileEdit?.filePath).toBe("/src/app.ts");
      expect(toolMsg!.fileEdit?.newContent).toBe("const y = 2;");
    });

    it("ignores redundant top-level assistant summary events", async () => {
      const msgs = await collectMessages([
        JSON.stringify({ type: "assistant", content: "summary" }),
      ]);

      expect(msgs).toHaveLength(0);
    });
  });

  // ── Slash commands ──

  describe("slash command handling", () => {
    it("handles /clear as a UI action", async () => {
      const result = await adapter.executeSlashCommand("/clear", "");
      expect(result.handled).toBe(true);
      expect(result.action).toBe("clear");
    });

    it("translates /compact into a summarization prompt", async () => {
      const result = await adapter.executeSlashCommand("/compact", "");
      expect(result.handled).toBe(true);
      expect(result.prompt).toBeDefined();
    });

    it("passes through unknown commands as unhandled", async () => {
      const result = await adapter.executeSlashCommand("/nonexistent", "args");
      expect(result.handled).toBe(false);
    });
  });
});
