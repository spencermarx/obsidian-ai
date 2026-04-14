import { describe, it, expect } from "vitest";
import { MessageQueue } from "../../src/session/message-queue";
import type { AgentMessage } from "../../src/adapters/types";

function msg(content: string, opts?: Partial<AgentMessage>): AgentMessage {
  return { role: "assistant", content, timestamp: Date.now(), ...opts };
}

describe("MessageQueue", () => {
  it("delivers messages to registered listeners", () => {
    const queue = new MessageQueue();
    const received: AgentMessage[] = [];
    queue.onMessage((m) => received.push(m));

    queue.push(msg("hello"));
    queue.flush();

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received.some((m) => m.content.includes("hello"))).toBe(true);
  });

  it("accumulates consecutive assistant text into a growing message", () => {
    const queue = new MessageQueue();
    const received: AgentMessage[] = [];
    queue.onMessage((m) => received.push(m));

    queue.push(msg("Hello "));
    queue.push(msg("world"));
    queue.flush();

    // The queue emits updates as content grows — the last emitted
    // message should contain the full accumulated text.
    const lastMsg = received[received.length - 1];
    expect(lastMsg.content).toBe("Hello world");
  });

  it("flushes buffer when switching from thinking to text", () => {
    const queue = new MessageQueue();
    const received: AgentMessage[] = [];
    queue.onMessage((m) => received.push(m));

    queue.push(msg("thinking...", { isThinking: true }));
    queue.push(msg("answer"));
    queue.flush();

    const thinking = received.filter((m) => m.isThinking);
    const text = received.filter((m) => !m.isThinking);
    expect(thinking.length).toBeGreaterThanOrEqual(1);
    expect(text.length).toBeGreaterThanOrEqual(1);
  });

  it("emits user messages immediately without buffering", () => {
    const queue = new MessageQueue();
    const received: AgentMessage[] = [];
    queue.onMessage((m) => received.push(m));

    queue.push(msg("user input", { role: "user" }));

    expect(received).toHaveLength(1);
    expect(received[0].role).toBe("user");
  });

  it("emits tool messages immediately without buffering", () => {
    const queue = new MessageQueue();
    const received: AgentMessage[] = [];
    queue.onMessage((m) => received.push(m));

    queue.push(
      msg("Tool: Bash", {
        role: "tool",
        toolUse: { name: "Bash", input: "ls" },
      }),
    );

    expect(received).toHaveLength(1);
    expect(received[0].toolUse?.name).toBe("Bash");
  });

  it("stops delivering after removeAllListeners", () => {
    const queue = new MessageQueue();
    const received: AgentMessage[] = [];
    queue.onMessage((m) => received.push(m));
    queue.removeAllListeners();

    queue.push(msg("hello"));
    queue.flush();

    expect(received).toHaveLength(0);
  });

  it("tracks full message history via getMessages", () => {
    const queue = new MessageQueue();
    queue.push(msg("first"));
    queue.push(msg("ignored", { role: "user" }));
    queue.flush();

    const history = queue.getMessages();
    expect(history.length).toBeGreaterThanOrEqual(2);
  });
});
