import { readFile, writeFile } from "node:fs/promises";

function parseArgs(argv) {
  const args = argv.slice(2);
  const isResume = args[0] === "exec" && args[1] === "resume";
  const prompt = args.at(-1) ?? "";
  const sessionIdArg = isResume ? args.at(-2) ?? null : null;
  const stageMatch = /Stage:\s*([a-zA-Z0-9_-]+)/.exec(prompt);
  const stage = stageMatch?.[1] ?? "unknown";

  return {
    args,
    isResume,
    prompt,
    sessionIdArg,
    stage,
    dangerous: args.includes("--dangerously-bypass-approvals-and-sandbox"),
    readOnly: args.includes("read-only"),
    cwd: args.includes("-C") ? args[args.indexOf("-C") + 1] ?? null : null,
  };
}

async function readState(statePath) {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    return {
      invocationCount: 0,
      sessionId: process.env.FAKE_CODEX_SESSION_ID ?? "fake-session-1",
      invocations: [],
    };
  }
}

function buildOutput(stage) {
  if (process.env.FAKE_CODEX_INVALID_JSON_STAGE === stage) {
    return '{"invalid": ';
  }

  if (process.env.FAKE_CODEX_INVALID_SCHEMA_STAGE === stage) {
    if (stage === "synthesizer") {
      return JSON.stringify({
        summary: "Missing executor prompt on purpose.",
        planMarkdown: "## Plan\n- Broken output",
      });
    }

    if (stage === "executor") {
      return JSON.stringify({
        status: "completed",
        summary: "Broken executor output.",
        changes: "not-an-array",
        tests: [],
        nextSteps: [],
      });
    }
  }

  if (stage === "planner") {
    return "## Draft Plan\n- Inspect workspace\n- Implement bot\n- Validate behavior";
  }

  if (stage === "critic") {
    return "- Check dangerous execution boundaries.\n- Verify resume and cancellation paths.";
  }

  if (stage === "synthesizer") {
    return JSON.stringify({
      summary: "Final approved plan for the Discord Codex bot.",
      planMarkdown: "## Plan\n- Build the bot\n- Add tests\n- Verify the workflow",
      executorPrompt: "Implement the approved plan in the current workspace and run the tests.",
    });
  }

  if (stage === "executor") {
    return JSON.stringify({
      status: "completed",
      summary: "Implementation finished successfully.",
      changes: ["Added runtime modules.", "Added integration tests."],
      tests: [
        {
          name: "npm test",
          status: "passed",
          details: "Fake codex reported the test suite passed.",
        },
      ],
      nextSteps: ["Manual Discord smoke test."],
    });
  }

  if (stage === "followup") {
    return "Follow-up processed successfully.";
  }

  return `Unhandled stage: ${stage}`;
}

process.on("SIGTERM", () => {
  process.exit(130);
});

const statePath = process.env.FAKE_CODEX_STATE;

if (!statePath) {
  console.error("FAKE_CODEX_STATE was not set.");
  process.exit(2);
}

const parsed = parseArgs(process.argv);
const state = await readState(statePath);
state.invocationCount += 1;
state.invocations.push({
  stage: parsed.stage,
  isResume: parsed.isResume,
  dangerous: parsed.dangerous,
  readOnly: parsed.readOnly,
  cwd: parsed.cwd,
  sessionIdArg: parsed.sessionIdArg,
});
await writeFile(statePath, JSON.stringify(state, null, 2));

if (process.env.FAKE_CODEX_FAIL_STAGE === parsed.stage) {
  console.error(`forced failure for stage ${parsed.stage}`);
  process.exit(Number(process.env.FAKE_CODEX_FAIL_CODE ?? "9"));
}

if (process.env.FAKE_CODEX_BAD_JSON_STAGE === parsed.stage) {
  console.log(JSON.stringify({ type: "turn.started" }));
  console.log(
    JSON.stringify({
      type: "item.completed",
      item: {
        id: `item_${state.invocationCount}`,
        type: "agent_message",
        text: "{bad-json",
      },
    }),
  );
  console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
  process.exit(0);
}

if (process.env.FAKE_CODEX_DELAY_STAGE === parsed.stage) {
  const delayMs = Number(process.env.FAKE_CODEX_DELAY_MS ?? "5000");
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

if (!parsed.isResume) {
  console.log(JSON.stringify({ type: "thread.started", thread_id: state.sessionId }));
}

console.log(JSON.stringify({ type: "turn.started" }));
console.log(
  JSON.stringify({
    type: "item.completed",
    item: {
      id: `item_${state.invocationCount}`,
      type: "agent_message",
      text: buildOutput(parsed.stage),
    },
  }),
);
console.log(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } }));
