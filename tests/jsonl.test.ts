import { describe, expect, it } from "vitest";

import { extractAgentMessageText, extractThreadId, parseCodexJsonlLine } from "../src/codex/jsonl.js";

describe("parseCodexJsonlLine", () => {
  it("parses valid event lines", () => {
    const result = parseCodexJsonlLine('{"type":"thread.started","thread_id":"abc"}');

    expect(result.kind).toBe("event");
    if (result.kind === "event") {
      expect(result.event.type).toBe("thread.started");
      expect(extractThreadId(result.event)).toBe("abc");
    }
  });

  it("treats plain text as noise", () => {
    const result = parseCodexJsonlLine("plain-text warning");

    expect(result).toEqual({
      kind: "noise",
      line: "plain-text warning",
    });
  });

  it("marks malformed json as invalid", () => {
    const result = parseCodexJsonlLine('{"type":');

    expect(result.kind).toBe("invalid");
  });

  it("extracts final agent message text", () => {
    const parsed = parseCodexJsonlLine(
      '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"hello"}}',
    );

    expect(parsed.kind).toBe("event");
    if (parsed.kind === "event") {
      expect(extractAgentMessageText(parsed.event)).toBe("hello");
    }
  });
});
