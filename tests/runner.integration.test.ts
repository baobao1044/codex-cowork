import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CodexRunner } from "../src/codex/runner.js";
import { createTempDir, removeTempDir } from "./helpers.js";

const fixturePath = path.resolve(process.cwd(), "tests/fixtures/fake-codex.mjs");

describe("CodexRunner on Windows", () => {
  let tempDir = "";
  let statePath = "";

  beforeEach(async () => {
    tempDir = await createTempDir("codex-runner-cmd-");
    statePath = path.join(tempDir, "fake-state.json");
    process.env.FAKE_CODEX_STATE = statePath;
  });

  afterEach(async () => {
    delete process.env.FAKE_CODEX_STATE;
    await removeTempDir(tempDir);
  });

  it("runs a .cmd codex path on Windows", async () => {
    if (process.platform !== "win32") {
      return;
    }

    const wrapperPath = path.join(tempDir, "fake-codex.cmd");
    const wrapperContents = [
      "@echo off",
      `"${process.execPath}" "${fixturePath}" %*`,
      "",
    ].join("\r\n");
    await writeFile(wrapperPath, wrapperContents, "utf8");

    const runner = new CodexRunner({
      codexPath: wrapperPath,
    });

    const result = await runner.startRun({
      kind: "start",
      cwd: tempDir,
      prompt: "Stage: planner\nReturn a plan.",
      readOnly: true,
      skipGitRepoCheck: true,
    }).completed;

    expect(result.sessionId).toBe("fake-session-1");
    expect(result.finalMessage).toContain("## Draft Plan");

    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      invocations: Array<{ stage: string }>;
    };
    expect(state.invocations).toHaveLength(1);
    expect(state.invocations[0]?.stage).toBe("planner");
  }, 15000);
});
