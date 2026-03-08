import { spawn, type ChildProcessByStdio } from "node:child_process";
import readline from "node:readline";
import type { Readable } from "node:stream";

import { extractAgentMessageText, extractThreadId, parseCodexJsonlLine, type CodexCliEvent } from "./jsonl.js";
import { killProcessTree } from "../utils/process.js";

export interface CodexRunnerOptions {
  codexPath: string;
  commandArgs?: string[];
  defaultTimeoutMs?: number;
}

export interface CodexRunOptions {
  kind: "start" | "resume";
  prompt: string;
  cwd?: string;
  sessionId?: string;
  dangerous?: boolean;
  readOnly?: boolean;
  skipGitRepoCheck?: boolean;
  timeoutMs?: number;
}

export interface CodexRunResult {
  sessionId: string | null;
  finalMessage: string;
  events: CodexCliEvent[];
  stdoutNoise: string[];
  stderr: string;
  exitCode: number;
}

export class CodexRunError extends Error {
  public readonly result: CodexRunResult;

  public constructor(message: string, result: CodexRunResult) {
    super(message);
    this.name = "CodexRunError";
    this.result = result;
  }
}

export class CodexTimeoutError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CodexTimeoutError";
  }
}

export interface RunningCodexProcess {
  pid: number | null;
  completed: Promise<CodexRunResult>;
  cancel: () => Promise<void>;
}

interface SpawnInvocation {
  command: string;
  args: string[];
}

function buildArgs(options: CodexRunOptions, baseArgs: string[] = []): string[] {
  const args = [...baseArgs, "exec"];

  if (options.kind === "resume") {
    args.push("resume");
  }

  args.push("--json");

  if (options.dangerous) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else if (options.readOnly && options.kind === "start") {
    args.push("-s", "read-only");
  }

  if (options.skipGitRepoCheck) {
    args.push("--skip-git-repo-check");
  }

  if (options.kind === "start") {
    if (!options.cwd) {
      throw new Error("Codex start run requires a cwd.");
    }

    args.push("-C", options.cwd);
    args.push(options.prompt);
    return args;
  }

  if (!options.sessionId) {
    throw new Error("Codex resume run requires a sessionId.");
  }

  args.push(options.sessionId, options.prompt);
  return args;
}

function attachLineReader(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  const reader = readline.createInterface({ input: stream });
  reader.on("line", onLine);
}

function buildSpawnInvocation(command: string, args: string[]): SpawnInvocation {
  if (process.platform === "win32" && /\.(cmd|bat)$/i.test(command)) {
    return {
      command: process.env.ComSpec || "cmd.exe",
      args: ["/d", "/s", "/c", command, ...args],
    };
  }

  return { command, args };
}

export class CodexRunner {
  private readonly codexPath: string;
  private readonly commandArgs: string[];
  private readonly defaultTimeoutMs: number | undefined;

  public constructor(options: CodexRunnerOptions) {
    this.codexPath = options.codexPath;
    this.commandArgs = options.commandArgs ?? [];
    this.defaultTimeoutMs = options.defaultTimeoutMs;
  }

  public startRun(options: CodexRunOptions): RunningCodexProcess {
    const args = buildArgs(options, this.commandArgs);
    const invocation = buildSpawnInvocation(this.codexPath, args);
    const child = spawn(invocation.command, invocation.args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    return {
      pid: child.pid ?? null,
      completed: this.collectResultWithTimeout(child, options.timeoutMs ?? this.defaultTimeoutMs),
      cancel: async () => {
        if (!child.pid) {
          return;
        }

        await killProcessTree(child.pid);
      },
    };
  }

  private collectResultWithTimeout(
    child: ChildProcessByStdio<null, Readable, Readable>,
    timeoutMs: number | undefined,
  ): Promise<CodexRunResult> {
    const resultPromise = this.collectResult(child);

    if (!timeoutMs) {
      return resultPromise;
    }

    return new Promise<CodexRunResult>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        reject(new CodexTimeoutError(`Codex process timed out after ${timeoutMs} ms.`));

        void (async () => {
          try {
            if (child.pid) {
              await killProcessTree(child.pid);
            }
          } catch {
            // Ignore kill failures and surface the timeout as the primary error.
          }
        })();
      }, timeoutMs);

      resultPromise.then(
        (value) => {
          clearTimeout(timer);
          if (settled) {
            return;
          }
          settled = true;
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          if (settled) {
            return;
          }
          settled = true;
          reject(error);
        },
      );
    });
  }

  private async collectResult(child: ChildProcessByStdio<null, Readable, Readable>): Promise<CodexRunResult> {
    const events: CodexCliEvent[] = [];
    const stdoutNoise: string[] = [];
    const stderrChunks: string[] = [];
    let sessionId: string | null = null;
    let finalMessage = "";

    attachLineReader(child.stdout, (line) => {
      const parsed = parseCodexJsonlLine(line);

      if (parsed.kind === "event") {
        events.push(parsed.event);
        sessionId = extractThreadId(parsed.event) ?? sessionId;
        finalMessage = extractAgentMessageText(parsed.event) ?? finalMessage;
        return;
      }

      if (parsed.line.trim().length > 0) {
        stdoutNoise.push(parsed.line);
      }
    });

    attachLineReader(child.stderr, (line) => {
      stderrChunks.push(line);
    });

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve(code ?? 0));
    });

    const result: CodexRunResult = {
      sessionId,
      finalMessage,
      events,
      stdoutNoise,
      stderr: stderrChunks.join("\n"),
      exitCode,
    };

    if (exitCode !== 0) {
      throw new CodexRunError(`Codex process exited with code ${exitCode}.`, result);
    }

    return result;
  }
}
