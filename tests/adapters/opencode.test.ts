import { describe, it, expect } from "vitest";
import { OpencodeAdapter } from "../../src/adapters/opencode";
import type { VaultContext } from "../../src/adapters/types";
import { Readable } from "stream";

const vault: VaultContext = { vaultPath: "/vault" };

describe("OpencodeAdapter", () => {
  const adapter = new OpencodeAdapter();

  describe("spawning", () => {
    it("invokes opencode run with JSON output", () => {
      const { command, args } = adapter.buildSpawnArgs({
        prompt: "hello",
        context: vault,
        cwd: "/vault",
      });

      expect(command).toBe("opencode");
      expect(args.slice(0, 3)).toEqual(["run", "--format", "json"]);
      expect(args.some((a) => a.includes("hello"))).toBe(true);
    });

    it("resumes an initialized OpenCode session", () => {
      const { args } = adapter.buildSpawnArgs({
        prompt: "continue",
        context: vault,
        cwd: "/vault",
        cliSessionId: "ses_example",
        resumeSession: true,
      });

      expect(args).toContain("--session");
      expect(args).toContain("ses_example");
    });

    it("embeds image paths in prompt when images are attached", () => {
      const { args } = adapter.buildSpawnArgs({
        prompt: "describe this",
        context: vault,
        cwd: "/vault",
        imagePaths: ["/tmp/screenshot.png"],
      });

      const prompt = args.find((a) => a.includes("describe this"))!;
      expect(prompt).toContain("/tmp/screenshot.png");
    });
  });

  describe("output parsing", () => {
    it("yields plain text lines as assistant messages", async () => {
      const stream = new Readable({
        read() {
          this.push("First line\nSecond line\n");
          this.push(null);
        },
      });

      const msgs = [];
      for await (const msg of adapter.parseOutputStream(stream)) {
        msgs.push(msg);
      }

      expect(msgs.every((m) => m.role === "assistant")).toBe(true);
      expect(msgs.some((m) => m.content === "First line")).toBe(true);
    });

    it("parses text from OpenCode JSON events", async () => {
      const stream = new Readable({
        read() {
          this.push(
            JSON.stringify({
              type: "text",
              sessionID: "ses_example",
              part: { type: "text", text: "structured" },
            }) + "\n",
          );
          this.push(null);
        },
      });

      const msgs = [];
      for await (const msg of adapter.parseOutputStream(stream)) {
        msgs.push(msg);
      }

      expect(msgs[0].content).toBe("structured");
      expect(msgs[0].cliSessionId).toBe("ses_example");
    });

    it("ignores OpenCode lifecycle events", async () => {
      const stream = Readable.from(
        [
          { type: "step_start", sessionID: "ses_example" },
          {
            type: "text",
            sessionID: "ses_example",
            part: { type: "text", text: "answer" },
          },
          { type: "step_finish", sessionID: "ses_example" },
        ]
          .map((event) => JSON.stringify(event))
          .join("\n") + "\n",
      );

      const msgs = [];
      for await (const msg of adapter.parseOutputStream(stream)) {
        msgs.push(msg);
      }

      expect(msgs).toHaveLength(1);
      expect(msgs[0].content).toBe("answer");
    });

    it("parses current OpenCode tool events", async () => {
      const stream = Readable.from(
        JSON.stringify({
          type: "tool_use",
          sessionID: "ses_example",
          part: {
            tool: "read",
            state: {
              input: { filePath: "/vault/note.md" },
              output: "note contents",
            },
          },
        }) + "\n",
      );

      const msgs = [];
      for await (const msg of adapter.parseOutputStream(stream)) {
        msgs.push(msg);
      }

      expect(msgs[0].role).toBe("tool");
      expect(msgs[0].toolUse?.name).toBe("read");
      expect(msgs[0].toolUse?.input).toContain("note.md");
      expect(msgs[0].cliSessionId).toBe("ses_example");
    });
  });
});
