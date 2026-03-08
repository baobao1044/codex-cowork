import type { ExecutorOutput, StageName, SynthesizerOutput, WorkspaceConfig } from "../types.js";

function asJsonContractExample(value: object): string {
  return JSON.stringify(value, null, 2);
}

function getLanguageInstruction(language: string): string {
  if (language.toLowerCase().startsWith("vi")) {
    return "Use Vietnamese for prose fields.";
  }

  return `Use ${language} for prose fields.`;
}

export function buildPlannerPrompt(params: {
  goal: string;
  workspace: WorkspaceConfig;
  language: string;
  existingSession: boolean;
}): string {
  const preface = params.existingSession
    ? "You are revisiting the same task thread with existing context."
    : "You are starting a new task thread.";

  return [
    "Stage: planner",
    preface,
    `Workspace label: ${params.workspace.label}`,
    `Workspace path: ${params.workspace.path}`,
    getLanguageInstruction(params.language),
    "Produce a draft implementation plan in Markdown.",
    "Focus on architecture, data flow, interfaces, failure modes, and concrete next steps.",
    "Do not execute changes. Read-only planning only.",
    "Task goal:",
    params.goal,
  ].join("\n");
}

export function buildCriticPrompt(language: string): string {
  return [
    "Stage: critic",
    getLanguageInstruction(language),
    "Critique the latest draft plan from this session.",
    "Identify missing risks, questionable assumptions, edge cases, and simpler alternatives.",
    "Do not execute changes. Keep the critique concise but concrete.",
  ].join("\n");
}

export function buildSynthesizerPrompt(language: string): string {
  const example: SynthesizerOutput = {
    summary: "One short summary paragraph.",
    planMarkdown: "## Plan\n- Step one\n- Step two",
    executorPrompt: "Implement the approved plan in the workspace and then report the outcome.",
  };

  return [
    "Stage: synthesizer",
    getLanguageInstruction(language),
    "Use the whole session context, including the latest plan and critique, to produce the final approved plan.",
    "Return only valid JSON matching this contract exactly. Do not wrap it in Markdown fences.",
    asJsonContractExample(example),
  ].join("\n");
}

export function buildExecutorPrompt(language: string, synthesizedPrompt: string): string {
  const example: ExecutorOutput = {
    status: "completed",
    summary: "Brief execution summary.",
    changes: ["Implemented the required code path."],
    tests: [
      {
        name: "npm test",
        status: "passed",
        details: "All targeted tests passed.",
      },
    ],
    nextSteps: ["Deploy after manual review."],
  };

  return [
    "Stage: executor",
    getLanguageInstruction(language),
    "Continue in the same Codex session and execute the plan in the current workspace.",
    "You may modify files and run commands as needed.",
    "After execution, return only valid JSON matching this contract exactly. Do not wrap it in Markdown fences.",
    asJsonContractExample(example),
    "Approved executor instructions:",
    synthesizedPrompt,
  ].join("\n");
}

export function buildFollowupPrompt(language: string, userMessage: string): string {
  return [
    "Stage: followup",
    getLanguageInstruction(language),
    "Continue from the existing task context in this Codex session.",
    "Handle the user message directly. Execute changes only if needed.",
    "Reply normally in plain text or Markdown.",
    "User message:",
    userMessage,
  ].join("\n");
}

export function normalizeReplanGoal(previousGoal: string | null, delta: string): string {
  const trimmedDelta = delta.trim();

  if (trimmedDelta.length === 0) {
    return previousGoal ?? "Replan the current task using the existing conversation context.";
  }

  if (!previousGoal) {
    return trimmedDelta;
  }

  return [`Original goal: ${previousGoal}`, `New instruction: ${trimmedDelta}`].join("\n");
}

export function isPlanningStage(stage: StageName): boolean {
  return stage === "planner" || stage === "critic" || stage === "synthesizer";
}
