import { readFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CodexRunner } from "../src/codex/runner.js";
import { OrchestratorService } from "../src/orchestrator/service.js";
import { ThreadSessionStore } from "../src/store/threadSessionStore.js";
import type { SynthesizerOutput } from "../src/types.js";
import { buildTestConfig, createTempDir, removeTempDir, waitFor } from "./helpers.js";

const fixturePath = path.resolve(process.cwd(), "tests/fixtures/fake-codex.mjs");

describe("OrchestratorService integration", () => {
  let tempDir = "";
  let statePath = "";

  beforeEach(async () => {
    tempDir = await createTempDir("codex-discord-bot-");
    statePath = path.join(tempDir, "fake-state.json");
    process.env.FAKE_CODEX_STATE = statePath;
    delete process.env.FAKE_CODEX_FAIL_STAGE;
    delete process.env.FAKE_CODEX_FAIL_CODE;
    delete process.env.FAKE_CODEX_DELAY_STAGE;
    delete process.env.FAKE_CODEX_DELAY_MS;
    delete process.env.FAKE_CODEX_BAD_JSON_STAGE;
    delete process.env.FAKE_CODEX_INVALID_JSON_STAGE;
    delete process.env.FAKE_CODEX_INVALID_SCHEMA_STAGE;
  });

  afterEach(async () => {
    delete process.env.FAKE_CODEX_STATE;
    delete process.env.FAKE_CODEX_FAIL_STAGE;
    delete process.env.FAKE_CODEX_FAIL_CODE;
    delete process.env.FAKE_CODEX_DELAY_STAGE;
    delete process.env.FAKE_CODEX_DELAY_MS;
    delete process.env.FAKE_CODEX_BAD_JSON_STAGE;
    delete process.env.FAKE_CODEX_INVALID_JSON_STAGE;
    delete process.env.FAKE_CODEX_INVALID_SCHEMA_STAGE;
    await removeTempDir(tempDir);
  });

  async function makeHarness(stageTimeoutMs?: number) {
    const config = buildTestConfig(tempDir);
    if (stageTimeoutMs) {
      config.codex.stageTimeoutMs = stageTimeoutMs;
    }
    const store = await ThreadSessionStore.create(":memory:");
    const runner = new CodexRunner({
      codexPath: process.execPath,
      commandArgs: [fixturePath],
      defaultTimeoutMs: config.codex.stageTimeoutMs,
    });
    const orchestrator = new OrchestratorService(config, store, runner);

    return { config, store, runner, orchestrator };
  }

  function installAutoApproval(orchestrator: OrchestratorService): void {
    orchestrator.addObserver({
      onApprovalNeeded: ({ threadId }) => {
        orchestrator.approve(threadId);
      },
    });
  }

  it("runs planner -> critic -> synthesizer -> executor successfully", async () => {
    const { orchestrator, store } = await makeHarness();
    installAutoApproval(orchestrator);

    const result = await orchestrator.startManagedTask({
      discordThreadId: "thread-1",
      discordChannelId: "channel-1",
      workspaceKey: "main",
      goal: "Build the Discord Codex bot",
    });

    expect(result.markdown).toContain("# Codex Result");
    expect(result.markdown).toContain("Execution status: completed");

    const session = store.get("thread-1");
    expect(session?.status).toBe("completed");
    expect(session?.codexSessionId).toBe("fake-session-1");
    expect(session?.lastPlanMarkdown).toContain("## Plan");
    expect(session?.lastExecutorPrompt).toContain("Implement the approved plan");

    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      invocations: Array<{ stage: string; isResume: boolean; dangerous: boolean }>;
    };
    expect(state.invocations.map((item) => item.stage)).toEqual([
      "planner",
      "critic",
      "synthesizer",
      "executor",
    ]);
    expect(state.invocations[0]?.isResume).toBe(false);
    expect(state.invocations[3]?.dangerous).toBe(true);
  });

  it("resumes an existing Codex session for follow-up and replan", async () => {
    const { orchestrator } = await makeHarness();
    installAutoApproval(orchestrator);

    await orchestrator.startManagedTask({
      discordThreadId: "thread-1",
      discordChannelId: "channel-1",
      workspaceKey: "main",
      goal: "Build the Discord Codex bot",
    });

    const followup = await orchestrator.followup("thread-1", "Add another validation layer.");
    expect(followup.markdown).toContain("Follow-up processed successfully.");

    const replan = await orchestrator.rerunPlan("thread-1", "Update the plan after the follow-up.");
    expect(replan.markdown).toContain("# Codex Result");

    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      invocations: Array<{ stage: string; isResume: boolean; sessionIdArg: string | null }>;
    };
    expect(state.invocations[4]).toMatchObject({
      stage: "followup",
      isResume: true,
      sessionIdArg: "fake-session-1",
    });
    expect(state.invocations[5]).toMatchObject({
      stage: "planner",
      isResume: true,
      sessionIdArg: "fake-session-1",
    });
  }, 15000);

  it("blocks follow-up when dangerous execution is disabled for the workspace", async () => {
    const { config, orchestrator, store } = await makeHarness();
    installAutoApproval(orchestrator);

    await orchestrator.startManagedTask({
      discordThreadId: "thread-1",
      discordChannelId: "channel-1",
      workspaceKey: "main",
      goal: "Build the Discord Codex bot",
    });

    config.workspaces[0]!.allowDangerousExecution = false;

    await expect(
      orchestrator.followup("thread-1", "Add another validation layer."),
    ).rejects.toThrow("does not allow dangerous execution for follow-up stages");

    const session = store.get("thread-1");
    expect(session?.status).toBe("completed");

    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      invocations: Array<{ stage: string }>;
    };
    expect(state.invocations).toHaveLength(4);
  });

  it("keeps a managed thread bound to its original workspace", async () => {
    const { store } = await makeHarness();
    const config = buildTestConfig(tempDir);
    config.workspaces.push({
      key: "other",
      label: "Other",
      path: path.join(tempDir, "other"),
      allowDangerousExecution: true,
    });
    const runner = new CodexRunner({
      codexPath: process.execPath,
      commandArgs: [fixturePath],
    });
    const orchestrator = new OrchestratorService(config, store, runner);
    installAutoApproval(orchestrator);

    await orchestrator.startManagedTask({
      discordThreadId: "thread-1",
      discordChannelId: "channel-1",
      workspaceKey: "main",
      goal: "Build the Discord Codex bot",
    });

    await expect(
      orchestrator.startManagedTask({
        discordThreadId: "thread-1",
        discordChannelId: "channel-1",
        workspaceKey: "other",
        goal: "Try to switch workspace",
      }),
    ).rejects.toThrow("different workspace");
  });

  it.each(["planner", "critic", "synthesizer", "executor"])(
    "marks the thread failed when %s exits nonzero",
    async (stage) => {
      const { orchestrator, store } = await makeHarness();
      process.env.FAKE_CODEX_FAIL_STAGE = stage;
      if (stage === "executor") {
        installAutoApproval(orchestrator);
      }

      await expect(
        orchestrator.startManagedTask({
          discordThreadId: "thread-1",
          discordChannelId: "channel-1",
          workspaceKey: "main",
          goal: "Build the Discord Codex bot",
        }),
      ).rejects.toThrow();

      const session = store.get("thread-1");
      expect(session?.status).toBe("failed");
      expect(session?.lastStage).toBe(stage);
    },
  );

  it("marks the thread failed when synthesizer output is invalid", async () => {
    const { orchestrator, store } = await makeHarness();
    process.env.FAKE_CODEX_BAD_JSON_STAGE = "synthesizer";

    await expect(
      orchestrator.startManagedTask({
        discordThreadId: "thread-1",
        discordChannelId: "channel-1",
        workspaceKey: "main",
        goal: "Build the Discord Codex bot",
      }),
    ).rejects.toThrow("synthesizer output was not valid JSON");

    const session = store.get("thread-1");
    expect(session?.status).toBe("failed");
    expect(session?.lastStage).toBe("synthesizer");
    expect(session?.lastResultMarkdown).toContain("synthesizer output validation failed.");
    expect(session?.lastResultMarkdown).toContain("not valid JSON");
    expect(session?.lastResultMarkdown).toContain("{bad-json");
  });

  it("marks the thread failed when executor output fails schema validation", async () => {
    const { orchestrator, store } = await makeHarness();
    process.env.FAKE_CODEX_INVALID_SCHEMA_STAGE = "executor";
    installAutoApproval(orchestrator);

    await expect(
      orchestrator.startManagedTask({
        discordThreadId: "thread-1",
        discordChannelId: "channel-1",
        workspaceKey: "main",
        goal: "Build the Discord Codex bot",
      }),
    ).rejects.toThrow("executor output failed schema validation");

    const session = store.get("thread-1");
    expect(session?.status).toBe("failed");
    expect(session?.lastStage).toBe("executor");
    expect(session?.lastResultMarkdown).toContain("executor output validation failed.");
    expect(session?.lastResultMarkdown).toContain('"changes":"not-an-array"');
  });

  it("times out a slow stage and marks the thread failed", async () => {
    const { orchestrator, store } = await makeHarness(250);
    process.env.FAKE_CODEX_DELAY_STAGE = "critic";
    process.env.FAKE_CODEX_DELAY_MS = "2000";

    await expect(
      orchestrator.startManagedTask({
        discordThreadId: "thread-1",
        discordChannelId: "channel-1",
        workspaceKey: "main",
        goal: "Build the Discord Codex bot",
      }),
    ).rejects.toThrow("timed out");

    const session = store.get("thread-1");
    expect(session?.status).toBe("failed");
    expect(session?.lastStage).toBe("critic");
    expect(session?.lastResultMarkdown).toContain("timed out");
  }, 15000);

  it("cancels a delayed executor and allows rerun afterward", async () => {
    const { orchestrator, store } = await makeHarness();
    process.env.FAKE_CODEX_DELAY_STAGE = "executor";
    process.env.FAKE_CODEX_DELAY_MS = "5000";
    installAutoApproval(orchestrator);

    const runPromise = orchestrator.startManagedTask({
      discordThreadId: "thread-1",
      discordChannelId: "channel-1",
      workspaceKey: "main",
      goal: "Build the Discord Codex bot",
    });

    await waitFor(() => orchestrator.getActiveStage("thread-1") === "executor");
    await expect(orchestrator.cancel("thread-1")).resolves.toBe(true);
    await expect(runPromise).rejects.toThrow();
    await waitFor(() => store.get("thread-1")?.status === "canceled");

    delete process.env.FAKE_CODEX_DELAY_STAGE;
    delete process.env.FAKE_CODEX_DELAY_MS;

    const rerun = await orchestrator.rerunExecute("thread-1");
    expect(rerun.markdown).toContain("Execution status: completed");
  }, 15000);

  it("waits for approval before running executor", async () => {
    const { orchestrator, store } = await makeHarness();
    const approvalEvents: SynthesizerOutput[] = [];
    orchestrator.addObserver({
      onApprovalNeeded: ({ plan }) => {
        approvalEvents.push(plan);
      },
    });

    const runPromise = orchestrator.startManagedTask({
      discordThreadId: "thread-1",
      discordChannelId: "channel-1",
      workspaceKey: "main",
      goal: "Build the Discord Codex bot",
    });

    await waitFor(() => store.get("thread-1")?.status === "awaiting_approval");

    const stateBeforeApproval = JSON.parse(await readFile(statePath, "utf8")) as {
      invocations: Array<{ stage: string }>;
    };
    expect(stateBeforeApproval.invocations.map((item) => item.stage)).toEqual([
      "planner",
      "critic",
      "synthesizer",
    ]);
    expect(approvalEvents).toHaveLength(1);
    expect(approvalEvents[0]?.planMarkdown).toContain("## Plan");

    expect(orchestrator.approve("thread-1")).toBe(true);
    const result = await runPromise;
    expect(result.markdown).toContain("Execution status: completed");
  });

  it("loops back through planning when revision is requested", async () => {
    const { orchestrator, store } = await makeHarness();
    let approvalCount = 0;
    orchestrator.addObserver({
      onApprovalNeeded: ({ threadId }) => {
        approvalCount += 1;
        if (approvalCount === 1) {
          orchestrator.requestRevision(threadId, "Add more validation detail.");
          return;
        }

        orchestrator.approve(threadId);
      },
    });

    const result = await orchestrator.startManagedTask({
      discordThreadId: "thread-1",
      discordChannelId: "channel-1",
      workspaceKey: "main",
      goal: "Build the Discord Codex bot",
    });

    expect(result.markdown).toContain("Execution status: completed");
    expect(approvalCount).toBe(2);
    expect(store.get("thread-1")?.status).toBe("completed");

    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      invocations: Array<{ stage: string }>;
    };
    expect(state.invocations.map((item) => item.stage)).toEqual([
      "planner",
      "critic",
      "synthesizer",
      "planner",
      "critic",
      "synthesizer",
      "executor",
    ]);
  });

  it("resumes executor from stored awaiting_approval state", async () => {
    const { orchestrator, store } = await makeHarness();

    store.upsertBaseRecord({
      discordThreadId: "thread-1",
      discordChannelId: "channel-1",
      workspaceKey: "main",
      lastGoal: "Build the Discord Codex bot",
    });
    store.setCodexSessionId("thread-1", "fake-session-1");
    store.setPlanningArtifacts(
      "thread-1",
      "Build the Discord Codex bot",
      "## Plan\n- Stored",
      "Implement the approved plan in the current workspace and run the tests.",
    );
    store.updateStatus("thread-1", "awaiting_approval", "synthesizer");

    const result = await orchestrator.resumeAfterApproval("thread-1");
    expect(result.markdown).toContain("Execution status: completed");
    expect(store.get("thread-1")?.status).toBe("completed");
  });
});
