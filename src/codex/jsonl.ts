export interface CodexCliEvent {
  type: string;
  [key: string]: unknown;
}

export type JsonlParseResult =
  | { kind: "event"; event: CodexCliEvent }
  | { kind: "noise"; line: string }
  | { kind: "invalid"; line: string; error: Error };

export function parseCodexJsonlLine(line: string): JsonlParseResult {
  const trimmed = line.trim();

  if (trimmed.length === 0) {
    return { kind: "noise", line };
  }

  if (!trimmed.startsWith("{")) {
    return { kind: "noise", line };
  }

  try {
    const parsed = JSON.parse(trimmed) as CodexCliEvent;

    if (!parsed || typeof parsed.type !== "string") {
      return {
        kind: "invalid",
        line,
        error: new Error("Parsed JSON line was missing a string type field."),
      };
    }

    return { kind: "event", event: parsed };
  } catch (error) {
    return {
      kind: "invalid",
      line,
      error: error as Error,
    };
  }
}

export function extractAgentMessageText(event: CodexCliEvent): string | null {
  if (event.type !== "item.completed") {
    return null;
  }

  const item = event.item;

  if (!item || typeof item !== "object") {
    return null;
  }

  const typedItem = item as { type?: unknown; text?: unknown };

  if (typedItem.type === "agent_message" && typeof typedItem.text === "string") {
    return typedItem.text;
  }

  return null;
}

export function extractThreadId(event: CodexCliEvent): string | null {
  if (event.type !== "thread.started") {
    return null;
  }

  return typeof event.thread_id === "string" ? event.thread_id : null;
}
