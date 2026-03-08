import type { AppConfig, ExecutorOutput, StageName, SynthesizerOutput, ThreadSessionRecord, WorkspaceConfig } from "../types.js";
import { resolveWorkspace } from "../config.js";
import { buildCriticPrompt, buildExecutorPrompt, buildFollowupPrompt, buildPlannerPrompt, buildSynthesizerPrompt, normalizeReplanGoal } from "../codex/prompts.js";
import { CodexRunError, CodexRunner, type CodexRunResult, type RunningCodexProcess } from "../codex/runner.js";
import { renderFinalReport, renderFollowupReport } from "../discord/render.js";
import { parseExecutorOutput, parseSynthesizerOutput } from "../schemas.js";
import { ThreadSessionStore } from "../store/threadSessionStore.js";

interface ActiveJob {
  stage: StageName;
  process: RunningCodexProcess;
}

export interface OrchestratorObserver {
  onStageStarted?: (event: { threadId: string; stage: StageName }) => Promise<void> | void;
  onStageCompleted?: (event: { threadId: string; stage: StageName }) => Promise<void> | void;
  onStageFailed?: (event: { threadId: string; stage: StageName; error: Error }) => Promise<void> | void;
  onJobCanceled?: (event: { threadId: string; stage: StageName }) => Promise<void> | void;
  onApprovalNeeded?: (event: { threadId: string; plan: SynthesizerOutput }) => Promise<void> | void;
}

export interface WorkflowResult {
  markdown: string;
  session: ThreadSessionRecord;
}

type StructuredOutputStage = "synthesizer" | "executor";

class StageValidationError extends Error {
  public readonly details: string;

  public constructor(stage: StructuredOutputStage, message: string, rawOutput: string) {
    super(message);
    this.name = "StageValidationError";
    this.details = [
      `${stage} output validation failed.`,
      "",
      message,
      "",
      "Raw output:",
      rawOutput.length > 0 ? rawOutput : "(empty)",
    ].join("\n");
  }
}

export class RevisionRequestedError extends Error {
  public readonly feedback: string;

  public constructor(feedback: string) {
    super("Revision requested.");
    this.name = "RevisionRequestedError";
    this.feedback = feedback;
  }
}

interface PendingApproval {
  plan: SynthesizerOutput;
  resolve: () => void;
  reject: (error: Error) => void;
}

export class OrchestratorService {
  private readonly activeJobs = new Map<string, ActiveJob>();
  private readonly observers = new Set<OrchestratorObserver>();
  private readonly pendingApprovals = new Map<string, PendingApproval>();

  public constructor(
    private readonly config: AppConfig,
    private readonly store: ThreadSessionStore,
    private readonly runner: CodexRunner,
  ) {}

  public getSession(threadId: string): ThreadSessionRecord | null {
    return this.store.get(threadId);
  }

  public getActiveStage(threadId: string): StageName | null {
    return this.activeJobs.get(threadId)?.stage ?? null;
  }

  public addObserver(observer: OrchestratorObserver): void {
    this.observers.add(observer);
  }

  public isAwaitingApproval(threadId: string): boolean {
    return this.pendingApprovals.has(threadId) || this.store.get(threadId)?.status === "awaiting_approval";
  }

  public approve(threadId: string): boolean {
    const pending = this.pendingApprovals.get(threadId);

    if (!pending) {
      return false;
    }

    pending.resolve();
    return true;
  }

  public requestRevision(threadId: string, feedback: string): boolean {
    const pending = this.pendingApprovals.get(threadId);

    if (!pending) {
      return false;
    }

    pending.reject(new RevisionRequestedError(feedback));
    return true;
  }

  public getSessionsAwaitingApproval(): ThreadSessionRecord[] {
    return this.store.findByStatus("awaiting_approval");
  }

  public async resumeAfterApproval(threadId: string): Promise<WorkflowResult> {
    this.ensureNotBusy(threadId);
    const session = this.requireSession(threadId);
    const workspace = resolveWorkspace(this.config.workspaces, session.workspaceKey);

    if (session.status !== "awaiting_approval") {
      throw new Error("This thread is not awaiting approval.");
    }

    if (!session.codexSessionId) {
      throw new Error("This thread does not have a Codex session yet.");
    }

    if (!session.lastExecutorPrompt) {
      throw new Error("No executor prompt is stored for this thread.");
    }

    const synthesizer: SynthesizerOutput = {
      summary: "Recovered a pending plan after restart.",
      planMarkdown: session.lastPlanMarkdown ?? "Plan not available.",
      executorPrompt: session.lastExecutorPrompt,
    };
    const executor = await this.runExecutorStage(threadId, session.codexSessionId, session.lastExecutorPrompt, workspace);
    const markdown = renderFinalReport({
      workspace,
      sessionId: session.codexSessionId,
      synthesizer,
      executor,
    });
    this.store.setLastResult(threadId, markdown);
    this.store.updateStatus(threadId, "completed", "executor");

    return {
      markdown,
      session: this.requireSession(threadId),
    };
  }

  public async resumeAfterRevision(threadId: string, feedback: string): Promise<WorkflowResult> {
    const session = this.requireSession(threadId);

    if (session.status !== "awaiting_approval") {
      throw new Error("This thread is not awaiting approval.");
    }

    return this.rerunPlan(threadId, feedback);
  }

  public async startManagedTask(params: {
    discordThreadId: string;
    discordChannelId: string;
    workspaceKey: string;
    goal: string;
  }): Promise<WorkflowResult> {
    const workspace = resolveWorkspace(this.config.workspaces, params.workspaceKey);
    this.ensureNotBusy(params.discordThreadId);
    const current = this.store.get(params.discordThreadId);

    if (current && current.workspaceKey !== workspace.key) {
      throw new Error("Managed thread is already bound to a different workspace.");
    }

    const existing = this.store.upsertBaseRecord({
      discordThreadId: params.discordThreadId,
      discordChannelId: params.discordChannelId,
      workspaceKey: workspace.key,
      lastGoal: params.goal,
    });

    return this.runPlanAndExecute(existing, workspace, params.goal);
  }

  public async rerunPlan(threadId: string, appendedGoal?: string): Promise<WorkflowResult> {
    const session = this.requireSession(threadId);
    const workspace = resolveWorkspace(this.config.workspaces, session.workspaceKey);
    this.ensureNotBusy(threadId);

    const goal = normalizeReplanGoal(session.lastGoal, appendedGoal ?? "");
    this.store.setLastGoal(threadId, goal);

    return this.runPlanAndExecute(session, workspace, goal);
  }

  public async rerunExecute(threadId: string): Promise<WorkflowResult> {
    const session = this.requireSession(threadId);
    const workspace = resolveWorkspace(this.config.workspaces, session.workspaceKey);
    this.ensureNotBusy(threadId);

    if (!session.codexSessionId) {
      throw new Error("This thread does not have a Codex session yet.");
    }

    if (!session.lastExecutorPrompt) {
      throw new Error("No executor prompt is stored for this thread.");
    }

    const executor = await this.runExecutorStage(threadId, session.codexSessionId, session.lastExecutorPrompt, workspace);
    const refreshed = this.requireSession(threadId);
    const synthesizer: SynthesizerOutput = {
      summary: "Reused the stored plan and executor prompt.",
      planMarkdown: refreshed.lastPlanMarkdown ?? "Plan not available.",
      executorPrompt: refreshed.lastExecutorPrompt ?? session.lastExecutorPrompt,
    };
    const markdown = renderFinalReport({
      workspace,
      sessionId: refreshed.codexSessionId,
      synthesizer,
      executor,
    });
    this.store.setLastResult(threadId, markdown);
    this.store.updateStatus(threadId, "completed", "executor");

    return {
      markdown,
      session: this.requireSession(threadId),
    };
  }

  public async followup(threadId: string, userMessage: string): Promise<WorkflowResult> {
    const session = this.requireSession(threadId);
    const workspace = resolveWorkspace(this.config.workspaces, session.workspaceKey);
    this.ensureNotBusy(threadId);
    this.ensureDangerousExecutionAllowed(workspace, "follow-up");

    if (!session.codexSessionId) {
      throw new Error("This thread does not have a Codex session yet.");
    }

    const result = await this.runStage({
      threadId,
      stage: "followup",
      recordStatus: "executing",
      run: this.runner.startRun({
        kind: "resume",
        sessionId: session.codexSessionId,
        prompt: buildFollowupPrompt(this.config.responseLanguage, userMessage),
        dangerous: true,
        skipGitRepoCheck: true,
      }),
    });

    const markdown = renderFollowupReport({
      workspace,
      sessionId: session.codexSessionId,
      content: result.finalMessage,
    });
    this.store.setLastResult(threadId, markdown);
    this.store.updateStatus(threadId, "completed", "followup");

    return {
      markdown,
      session: this.requireSession(threadId),
    };
  }

  public async cancel(threadId: string): Promise<boolean> {
    const activeJob = this.activeJobs.get(threadId);

    if (activeJob) {
      await activeJob.process.cancel();
      this.store.setActivePid(threadId, null);
      this.store.updateStatus(threadId, "canceled", activeJob.stage);
      this.activeJobs.delete(threadId);
      this.notifyJobCanceled({
        threadId,
        stage: activeJob.stage,
      });
      return true;
    }

    const pending = this.pendingApprovals.get(threadId);

    if (!pending) {
      return false;
    }

    pending.reject(new Error("Approval canceled."));
    this.store.updateStatus(threadId, "canceled", "synthesizer");
    this.notifyJobCanceled({
      threadId,
      stage: "synthesizer",
    });
    return true;
  }

  private async runPlanAndExecute(
    existing: ThreadSessionRecord,
    workspace: WorkspaceConfig,
    goal: string,
  ): Promise<WorkflowResult> {
    try {
      let currentGoal = goal;
      let currentRecord = existing;

      while (true) {
        const plannerResult = await this.runPlannerStage(currentRecord, workspace, currentGoal);
        const codexSessionId = plannerResult.sessionId ?? currentRecord.codexSessionId;

        if (!codexSessionId) {
          throw new Error("Codex planner stage did not return a session id.");
        }

        this.store.setCodexSessionId(currentRecord.discordThreadId, codexSessionId);

        await this.runStage({
          threadId: currentRecord.discordThreadId,
          stage: "critic",
          recordStatus: "planning",
          run: this.runner.startRun({
            kind: "resume",
            sessionId: codexSessionId,
            prompt: buildCriticPrompt(this.config.responseLanguage),
            skipGitRepoCheck: true,
          }),
        });

        const synthesizer = await this.runStage({
          threadId: currentRecord.discordThreadId,
          stage: "synthesizer",
          recordStatus: "planning",
          run: this.runner.startRun({
            kind: "resume",
            sessionId: codexSessionId,
            prompt: buildSynthesizerPrompt(this.config.responseLanguage),
            skipGitRepoCheck: true,
          }),
          finalize: (result) => this.parseStructuredStageOutput("synthesizer", result.finalMessage, parseSynthesizerOutput),
        });
        this.store.setPlanningArtifacts(
          currentRecord.discordThreadId,
          currentGoal,
          synthesizer.planMarkdown,
          synthesizer.executorPrompt,
        );

        try {
          await this.waitForApproval(currentRecord.discordThreadId, synthesizer);
        } catch (error) {
          if (error instanceof RevisionRequestedError) {
            currentGoal = normalizeReplanGoal(currentGoal, error.feedback);
            this.store.setLastGoal(currentRecord.discordThreadId, currentGoal);
            currentRecord = this.requireSession(currentRecord.discordThreadId);
            continue;
          }

          throw error;
        }

        const executor = await this.runExecutorStage(
          currentRecord.discordThreadId,
          codexSessionId,
          synthesizer.executorPrompt,
          workspace,
        );
        const markdown = renderFinalReport({
          workspace,
          sessionId: codexSessionId,
          synthesizer,
          executor,
        });
        this.store.setLastResult(currentRecord.discordThreadId, markdown);
        this.store.updateStatus(currentRecord.discordThreadId, "completed", "executor");

        return {
          markdown,
          session: this.requireSession(currentRecord.discordThreadId),
        };
      }
    } catch (error) {
      const typedError = error instanceof Error ? error : new Error(String(error));
      this.recordWorkflowFailure(existing.discordThreadId, this.store.get(existing.discordThreadId)?.lastStage ?? "planner", typedError);
      throw error;
    }
  }

  private async runPlannerStage(
    record: ThreadSessionRecord,
    workspace: WorkspaceConfig,
    goal: string,
  ) {
    const run =
      record.codexSessionId === null
        ? this.runner.startRun({
            kind: "start",
            cwd: workspace.path,
            prompt: buildPlannerPrompt({
              goal,
              workspace,
              language: this.config.responseLanguage,
              existingSession: false,
            }),
            readOnly: true,
            skipGitRepoCheck: true,
          })
        : this.runner.startRun({
            kind: "resume",
            sessionId: record.codexSessionId,
            prompt: buildPlannerPrompt({
              goal,
              workspace,
              language: this.config.responseLanguage,
              existingSession: true,
            }),
            skipGitRepoCheck: true,
          });

    return this.runStage({
      threadId: record.discordThreadId,
      stage: "planner",
      recordStatus: "planning",
      run,
    });
  }

  private async runExecutorStage(
    threadId: string,
    sessionId: string,
    executorPrompt: string,
    workspace: WorkspaceConfig,
  ): Promise<ExecutorOutput> {
    this.ensureDangerousExecutionAllowed(workspace, "executor");

    return this.runStage({
      threadId,
      stage: "executor",
      recordStatus: "executing",
      run: this.runner.startRun({
        kind: "resume",
        sessionId,
        prompt: buildExecutorPrompt(this.config.responseLanguage, executorPrompt),
        dangerous: true,
        skipGitRepoCheck: true,
      }),
      finalize: (result) => this.parseStructuredStageOutput("executor", result.finalMessage, parseExecutorOutput),
    });
  }

  private async runStage<T = CodexRunResult>(params: {
    threadId: string;
    stage: StageName;
    recordStatus: ThreadSessionRecord["status"];
    run: RunningCodexProcess;
    finalize?: (result: CodexRunResult) => Promise<T> | T;
  }): Promise<T> {
    this.activeJobs.set(params.threadId, {
      stage: params.stage,
      process: params.run,
    });
    this.store.updateStatus(params.threadId, params.recordStatus, params.stage);
    this.store.setActivePid(params.threadId, params.run.pid);
    this.notifyStageStarted({
      threadId: params.threadId,
      stage: params.stage,
    });

    try {
      const result = await params.run.completed;

      if (result.sessionId) {
        this.store.setCodexSessionId(params.threadId, result.sessionId);
      }

      const finalized = params.finalize ? await params.finalize(result) : (result as T);

      this.notifyStageCompleted({
        threadId: params.threadId,
        stage: params.stage,
      });

      return finalized;
    } catch (error) {
      const typedError = error instanceof Error ? error : new Error(String(error));
      const currentStatus = this.store.get(params.threadId)?.status;

      if (currentStatus !== "canceled") {
        this.store.updateStatus(params.threadId, "failed", params.stage);
        const details = error instanceof CodexRunError ? error.result.stderr || error.result.stdoutNoise.join("\n") : undefined;
        if (details) {
          this.store.setLastResult(params.threadId, details);
        }
      }
      this.notifyStageFailed({
        threadId: params.threadId,
        stage: params.stage,
        error: typedError,
      });
      throw error;
    } finally {
      this.store.setActivePid(params.threadId, null);
      this.activeJobs.delete(params.threadId);
    }
  }

  private ensureDangerousExecutionAllowed(workspace: WorkspaceConfig, stageLabel: "executor" | "follow-up"): void {
    if (!workspace.allowDangerousExecution) {
      throw new Error(`Workspace ${workspace.key} does not allow dangerous execution for ${stageLabel} stages.`);
    }
  }

  private parseStructuredStageOutput<T>(
    stage: StructuredOutputStage,
    text: string,
    parser: (text: string) => T,
  ): T {
    try {
      return parser(text);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new StageValidationError(stage, message, text);
    }
  }

  private requireSession(threadId: string): ThreadSessionRecord {
    const session = this.store.get(threadId);

    if (!session) {
      throw new Error("This Discord thread is not managed yet.");
    }

    return session;
  }

  private ensureNotBusy(threadId: string): void {
    if (this.activeJobs.has(threadId) || this.pendingApprovals.has(threadId)) {
      throw new Error("This thread already has an active Codex job.");
    }
  }

  private waitForApproval(threadId: string, plan: SynthesizerOutput): Promise<void> {
    if (this.pendingApprovals.has(threadId)) {
      throw new Error("This thread is already awaiting approval.");
    }

    this.store.updateStatus(threadId, "awaiting_approval", "synthesizer");

    return new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        this.pendingApprovals.delete(threadId);
      };

      this.pendingApprovals.set(threadId, {
        plan,
        resolve: () => {
          cleanup();
          resolve();
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
      });

      this.notifyApprovalNeeded({
        threadId,
        plan,
      });
    });
  }

  private recordWorkflowFailure(threadId: string, stage: StageName, error: Error): void {
    const current = this.store.get(threadId);

    if (current?.status === "canceled") {
      return;
    }

    this.store.updateStatus(threadId, "failed", stage);
    this.store.setLastResult(threadId, this.getFailureDetails(error) ?? error.message);
  }

  private getFailureDetails(error: unknown): string | undefined {
    if (error instanceof StageValidationError) {
      return error.details;
    }

    if (error instanceof CodexRunError) {
      return error.result.stderr || error.result.stdoutNoise.join("\n");
    }

    return error instanceof Error ? error.message : String(error);
  }

  private notifyStageStarted(payload: { threadId: string; stage: StageName }): void {
    for (const observer of this.observers) {
      const handler = observer.onStageStarted;

      if (!handler) {
        continue;
      }

      Promise.resolve(handler(payload)).catch((error) => {
        console.error("Orchestrator observer onStageStarted failed:", error);
      });
    }
  }

  private notifyStageCompleted(payload: { threadId: string; stage: StageName }): void {
    for (const observer of this.observers) {
      const handler = observer.onStageCompleted;

      if (!handler) {
        continue;
      }

      Promise.resolve(handler(payload)).catch((error) => {
        console.error("Orchestrator observer onStageCompleted failed:", error);
      });
    }
  }

  private notifyStageFailed(payload: { threadId: string; stage: StageName; error: Error }): void {
    for (const observer of this.observers) {
      const handler = observer.onStageFailed;

      if (!handler) {
        continue;
      }

      Promise.resolve(handler(payload)).catch((error) => {
        console.error("Orchestrator observer onStageFailed failed:", error);
      });
    }
  }

  private notifyJobCanceled(payload: { threadId: string; stage: StageName }): void {
    for (const observer of this.observers) {
      const handler = observer.onJobCanceled;

      if (!handler) {
        continue;
      }

      Promise.resolve(handler(payload)).catch((error) => {
        console.error("Orchestrator observer onJobCanceled failed:", error);
      });
    }
  }

  private notifyApprovalNeeded(payload: { threadId: string; plan: SynthesizerOutput }): void {
    for (const observer of this.observers) {
      const handler = observer.onApprovalNeeded;

      if (!handler) {
        continue;
      }

      Promise.resolve(handler(payload)).catch((error) => {
        console.error("Orchestrator observer onApprovalNeeded failed:", error);
      });
    }
  }
}
