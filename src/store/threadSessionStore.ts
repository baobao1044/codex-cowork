import { DatabaseSync } from "node:sqlite";

import type { SessionStatus, StageName, ThreadSessionRecord } from "../types.js";
import { ensureParentDirectory } from "../utils/files.js";

function mapRecord(row: Record<string, unknown>): ThreadSessionRecord {
  return {
    discordThreadId: String(row.discord_thread_id),
    discordChannelId: String(row.discord_channel_id),
    workspaceKey: String(row.workspace_key),
    codexSessionId: row.codex_session_id === null ? null : String(row.codex_session_id),
    status: String(row.status) as SessionStatus,
    lastStage: row.last_stage === null ? null : (String(row.last_stage) as StageName),
    activePid: row.active_pid === null ? null : Number(row.active_pid),
    lastGoal: row.last_goal === null ? null : String(row.last_goal),
    lastPlanMarkdown: row.last_plan_markdown === null ? null : String(row.last_plan_markdown),
    lastExecutorPrompt: row.last_executor_prompt === null ? null : String(row.last_executor_prompt),
    lastResultMarkdown: row.last_result_markdown === null ? null : String(row.last_result_markdown),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class ThreadSessionStore {
  private readonly db: DatabaseSync;

  public static async create(databasePath: string): Promise<ThreadSessionStore> {
    if (databasePath !== ":memory:") {
      await ensureParentDirectory(databasePath);
    }

    return new ThreadSessionStore(databasePath);
  }

  private constructor(databasePath: string) {
    this.db = new DatabaseSync(databasePath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS thread_sessions (
        discord_thread_id TEXT PRIMARY KEY,
        discord_channel_id TEXT NOT NULL,
        workspace_key TEXT NOT NULL,
        codex_session_id TEXT,
        status TEXT NOT NULL,
        last_stage TEXT,
        active_pid INTEGER,
        last_goal TEXT,
        last_plan_markdown TEXT,
        last_executor_prompt TEXT,
        last_result_markdown TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  public get(threadId: string): ThreadSessionRecord | null {
    const statement = this.db.prepare(`
      SELECT *
      FROM thread_sessions
      WHERE discord_thread_id = ?
    `);
    const row = statement.get(threadId) as Record<string, unknown> | undefined;
    return row ? mapRecord(row) : null;
  }

  public findByStatus(status: SessionStatus): ThreadSessionRecord[] {
    const statement = this.db.prepare(`
      SELECT *
      FROM thread_sessions
      WHERE status = ?
      ORDER BY updated_at DESC
    `);

    return (statement.all(status) as Array<Record<string, unknown>>).map((row) => mapRecord(row));
  }

  public upsertBaseRecord(params: {
    discordThreadId: string;
    discordChannelId: string;
    workspaceKey: string;
    lastGoal?: string | null;
  }): ThreadSessionRecord {
    const statement = this.db.prepare(`
      INSERT INTO thread_sessions (
        discord_thread_id,
        discord_channel_id,
        workspace_key,
        status,
        last_goal,
        updated_at
      ) VALUES (?, ?, ?, 'idle', ?, CURRENT_TIMESTAMP)
      ON CONFLICT(discord_thread_id) DO UPDATE SET
        discord_channel_id = excluded.discord_channel_id,
        last_goal = COALESCE(excluded.last_goal, thread_sessions.last_goal),
        updated_at = CURRENT_TIMESTAMP
    `);

    statement.run(
      params.discordThreadId,
      params.discordChannelId,
      params.workspaceKey,
      params.lastGoal ?? null,
    );

    const record = this.get(params.discordThreadId);

    if (!record) {
      throw new Error("Failed to read thread session after upsert.");
    }

    return record;
  }

  public updateStatus(threadId: string, status: SessionStatus, lastStage: StageName | null): void {
    const statement = this.db.prepare(`
      UPDATE thread_sessions
      SET status = ?, last_stage = ?, updated_at = CURRENT_TIMESTAMP
      WHERE discord_thread_id = ?
    `);
    statement.run(status, lastStage, threadId);
  }

  public setActivePid(threadId: string, pid: number | null): void {
    const statement = this.db.prepare(`
      UPDATE thread_sessions
      SET active_pid = ?, updated_at = CURRENT_TIMESTAMP
      WHERE discord_thread_id = ?
    `);
    statement.run(pid, threadId);
  }

  public setCodexSessionId(threadId: string, codexSessionId: string): void {
    const statement = this.db.prepare(`
      UPDATE thread_sessions
      SET codex_session_id = ?, updated_at = CURRENT_TIMESTAMP
      WHERE discord_thread_id = ?
    `);
    statement.run(codexSessionId, threadId);
  }

  public setPlanningArtifacts(threadId: string, lastGoal: string, planMarkdown: string, executorPrompt: string): void {
    const statement = this.db.prepare(`
      UPDATE thread_sessions
      SET
        last_goal = ?,
        last_plan_markdown = ?,
        last_executor_prompt = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE discord_thread_id = ?
    `);
    statement.run(lastGoal, planMarkdown, executorPrompt, threadId);
  }

  public setLastGoal(threadId: string, lastGoal: string): void {
    const statement = this.db.prepare(`
      UPDATE thread_sessions
      SET last_goal = ?, updated_at = CURRENT_TIMESTAMP
      WHERE discord_thread_id = ?
    `);
    statement.run(lastGoal, threadId);
  }

  public setLastResult(threadId: string, markdown: string): void {
    const statement = this.db.prepare(`
      UPDATE thread_sessions
      SET last_result_markdown = ?, updated_at = CURRENT_TIMESTAMP
      WHERE discord_thread_id = ?
    `);
    statement.run(markdown, threadId);
  }

  public clearDanglingActivity(): void {
    const statement = this.db.prepare(`
      UPDATE thread_sessions
      SET
        active_pid = NULL,
        status = CASE
          WHEN status IN ('planning', 'executing') THEN 'failed'
          ELSE status
        END,
        updated_at = CURRENT_TIMESTAMP
      WHERE active_pid IS NOT NULL
    `);
    statement.run();
  }
}
