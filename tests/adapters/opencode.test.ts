import { describe, it, expect } from "vitest";
import { OpencodeAdapter } from "../../src/adapters/opencode";
import type { VaultContext } from "../../src/adapters/types";
import { Readable } from "stream";

const vault: VaultContext = { vaultPath: "/vault" };

describe("OpencodeAdapter", () => {
  const adapter = new OpencodeAdapter();

  describe("spawning", () => {
    it("invokes the opencode binary in quiet pipe mode", () => {
      const { command, args } = adapter.buildSpawnArgs({
        prompt: "hello",
        context: vault,
        cwd: "/vault",
      });

      expect(command).toBe("opencode");
      expect(args).toContain("-q");
      expect(args.some((a) => a.includes("hello"))).toBe(true);
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

    it("parses JSON structured output when available", async () => {
      const stream = new Readable({
        read() {
          this.push(
            JSON.stringify({ type: "text", content: "structured" }) + "\n",
          );
          this.push(null);
        },
      });

      const msgs = [];
      for await (const msg of adapter.parseOutputStream(stream)) {
        msgs.push(msg);
      }

      expect(msgs[0].content).toBe("structured");
    });
  });
});
