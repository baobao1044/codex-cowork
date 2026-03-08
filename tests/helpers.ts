import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { AppConfig } from "../src/types.js";

export async function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function removeTempDir(dirPath: string): Promise<void> {
  await rm(dirPath, { recursive: true, force: true });
}

export function buildTestConfig(workspacePath: string, databasePath = ":memory:"): AppConfig {
  return {
    discord: {
      token: "token",
      guildId: "guild",
      allowedChannelIds: ["channel-1"],
      ownerUserIds: ["owner-1"],
      trustedRoleIds: ["role-1"],
    },
    codex: {
      path: "unused-in-tests",
    },
    storage: {
      databasePath,
    },
    responseLanguage: "vi",
    workspaces: [
      {
        key: "main",
        label: "Main",
        path: workspacePath,
        allowDangerousExecution: true,
      },
    ],
  };
}

export async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const startedAt = Date.now();

  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out while waiting for condition.");
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
