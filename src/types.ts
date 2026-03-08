export type SessionStatus =
  | "idle"
  | "planning"
  | "awaiting_approval"
  | "executing"
  | "completed"
  | "failed"
  | "canceled";

export type StageName =
  | "planner"
  | "critic"
  | "synthesizer"
  | "executor"
  | "followup";

export interface WorkspaceConfig {
  key: string;
  label: string;
  path: string;
  allowDangerousExecution: boolean;
}

export interface AppConfig {
  discord: {
    token: string;
    guildId: string;
    allowedChannelIds: string[];
    ownerUserIds: string[];
    trustedRoleIds: string[];
  };
  codex: {
    path: string;
    stageTimeoutMs?: number;
  };
  storage: {
    databasePath: string;
  };
  responseLanguage: string;
  workspaces: WorkspaceConfig[];
}

export interface ThreadSessionRecord {
  discordThreadId: string;
  discordChannelId: string;
  workspaceKey: string;
  codexSessionId: string | null;
  status: SessionStatus;
  lastStage: StageName | null;
  activePid: number | null;
  lastGoal: string | null;
  lastPlanMarkdown: string | null;
  lastExecutorPrompt: string | null;
  lastResultMarkdown: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SynthesizerOutput {
  summary: string;
  planMarkdown: string;
  executorPrompt: string;
}

export interface ExecutorTestResult {
  name: string;
  status: "passed" | "failed" | "not_run";
  details: string;
}

export interface ExecutorOutput {
  status: "completed" | "partial" | "failed";
  summary: string;
  changes: string[];
  tests: ExecutorTestResult[];
  nextSteps: string[];
}
