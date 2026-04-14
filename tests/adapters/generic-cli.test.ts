import { describe, it, expect } from "vitest";
import { GenericCliAdapter } from "../../src/adapters/generic-cli";
import type { VaultContext } from "../../src/adapters/types";

const vault: VaultContext = { vaultPath: "/vault" };

describe("GenericCliAdapter", () => {
  const adapter = new GenericCliAdapter("my-tool");

  it("uses the custom binary name in display and command", () => {
    expect(adapter.binaryName).toBe("my-tool");
    expect(adapter.displayName).toContain("my-tool");
  });

  describe("spawning", () => {
    it("passes the full prompt as the command argument", () => {
      const { command, args } = adapter.buildSpawnArgs({
        prompt: "hello",
        context: vault,
        cwd: "/vault",
      });

      expect(command).toBe("my-tool");
      expect(args).toHaveLength(1);
      expect(args[0]).toContain("hello");
    });

    it("embeds image paths in prompt as a fallback", () => {
      const { args } = adapter.buildSpawnArgs({
        prompt: "look at this",
        context: vault,
        cwd: "/vault",
        imagePaths: ["/tmp/img.png"],
      });

      expect(args[0]).toContain("/tmp/img.png");
    });
  });

  it("has no built-in slash commands", () => {
    expect(adapter.getBuiltinSlashCommands()).toHaveLength(0);
  });

  it("returns unhandled for any slash command", async () => {
    const result = await adapter.executeSlashCommand("/anything", "");
    expect(result.handled).toBe(false);
  });
});
