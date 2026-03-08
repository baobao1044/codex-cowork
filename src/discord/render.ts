import type { ExecutorOutput, StageName, SynthesizerOutput, ThreadSessionRecord, WorkspaceConfig } from "../types.js";
import { renderBulletList } from "../utils/text.js";

export function renderStatusMessage(record: ThreadSessionRecord, activeStage: StageName | null, workspace: WorkspaceConfig): string {
  return [
    `Thread: ${record.discordThreadId}`,
    `Workspace: ${workspace.label} (${workspace.key})`,
    `Status: ${record.status}`,
    `Stage: ${activeStage ?? record.lastStage ?? "n/a"}`,
    `Codex session: ${record.codexSessionId ?? "not created yet"}`,
    `Active PID: ${record.activePid ?? "none"}`,
  ].join("\n");
}

export function renderFinalReport(params: {
  workspace: WorkspaceConfig;
  sessionId: string | null;
  synthesizer: SynthesizerOutput;
  executor: ExecutorOutput;
}): string {
  return [
    `# Codex Result`,
    ``,
    `- Workspace: ${params.workspace.label} (${params.workspace.key})`,
    `- Codex session: ${params.sessionId ?? "unknown"}`,
    `- Execution status: ${params.executor.status}`,
    ``,
    `## Summary`,
    params.synthesizer.summary,
    ``,
    `## Plan`,
    params.synthesizer.planMarkdown,
    ``,
    `## Executor Prompt`,
    "```text",
    params.synthesizer.executorPrompt,
    "```",
    ``,
    `## Execution Summary`,
    params.executor.summary,
    ``,
    `## Changes`,
    params.executor.changes.length > 0 ? renderBulletList(params.executor.changes) : "- None reported",
    ``,
    `## Tests`,
    params.executor.tests.length > 0
      ? renderBulletList(params.executor.tests.map((item) => `${item.name}: ${item.status} - ${item.details}`))
      : "- None reported",
    ``,
    `## Next Steps`,
    params.executor.nextSteps.length > 0 ? renderBulletList(params.executor.nextSteps) : "- None reported",
  ].join("\n");
}

export function renderFollowupReport(params: {
  workspace: WorkspaceConfig;
  sessionId: string | null;
  content: string;
}): string {
  return [
    `# Codex Follow-up`,
    ``,
    `- Workspace: ${params.workspace.label} (${params.workspace.key})`,
    `- Codex session: ${params.sessionId ?? "unknown"}`,
    ``,
    params.content,
  ].join("\n");
}

export function renderErrorReport(message: string, details?: string): string {
  if (!details) {
    return `Codex job failed.\n\n${message}`;
  }

  return `Codex job failed.\n\n${message}\n\n${details}`;
}
