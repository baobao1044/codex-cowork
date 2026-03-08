import { describe, expect, it } from "vitest";

import { parseExecutorOutput, parseSynthesizerOutput } from "../src/schemas.js";

describe("structured output parsing", () => {
  it("parses clean synthesizer json", () => {
    const result = parseSynthesizerOutput(
      JSON.stringify({
        summary: "ok",
        planMarkdown: "## Plan",
        executorPrompt: "Run it",
      }),
    );

    expect(result.executorPrompt).toBe("Run it");
  });

  it("parses synthesizer json wrapped in json fences", () => {
    const result = parseSynthesizerOutput([
      "```json",
      JSON.stringify({
        summary: "ok",
        planMarkdown: "## Plan",
        executorPrompt: "Run it",
      }),
      "```",
    ].join("\n"));

    expect(result.planMarkdown).toBe("## Plan");
  });

  it("parses executor json wrapped in plain fences", () => {
    const result = parseExecutorOutput([
      "```",
      JSON.stringify({
        status: "completed",
        summary: "done",
        changes: ["a"],
        tests: [],
        nextSteps: [],
      }),
      "```",
    ].join("\n"));

    expect(result.status).toBe("completed");
  });

  it("still throws on invalid json", () => {
    expect(() => parseExecutorOutput("```json\n{bad\n```")).toThrow("not valid JSON");
  });
});
