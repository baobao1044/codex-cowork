import { readFile } from "node:fs/promises";
import path from "node:path";

import type { AppConfig, WorkspaceConfig } from "./types.js";

interface RawAppConfig {
  discord?: {
    token?: string;
    guildId?: string;
    allowedChannelIds?: string[];
    ownerUserIds?: string[];
    trustedRoleIds?: string[];
  };
  codex?: {
    path?: string;
    stageTimeoutMs?: number;
  };
  storage?: {
    databasePath?: string;
  };
  responseLanguage?: string;
  workspaces?: Array<{
    key?: string;
    label?: string;
    path?: string;
    allowDangerousExecution?: boolean;
  }>;
}

type RawWorkspace = NonNullable<RawAppConfig["workspaces"]>[number];

function assertString(value: unknown, fieldName: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid config field ${fieldName}: expected non-empty string.`);
  }

  return value.trim();
}

function assertStringArray(value: unknown, fieldName: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error(`Invalid config field ${fieldName}: expected string array.`);
  }

  return value.map((item) => item.trim()).filter(Boolean);
}

function resolveSecretString(value: string): string {
  if (!value.startsWith("env:")) {
    return value;
  }

  const key = value.slice("env:".length);
  const envValue = process.env[key];

  if (!envValue) {
    throw new Error(`Missing environment variable ${key} referenced in config.`);
  }

  return envValue;
}

function assertPositiveNumber(value: unknown, fieldName: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Invalid config field ${fieldName}: expected positive number.`);
  }

  return value;
}

function resolvePath(configDir: string, filePath: string): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  return path.resolve(configDir, filePath);
}

function parseWorkspace(raw: RawWorkspace, configDir: string): WorkspaceConfig {
  return {
    key: assertString(raw?.key, "workspaces[].key"),
    label: assertString(raw?.label, "workspaces[].label"),
    path: resolvePath(configDir, assertString(raw?.path, "workspaces[].path")),
    allowDangerousExecution: raw?.allowDangerousExecution === true,
  };
}

export async function loadConfig(configPath = process.env.BOT_CONFIG_PATH ?? "./config/bot.config.json"): Promise<AppConfig> {
  const absoluteConfigPath = path.resolve(process.cwd(), configPath);
  const configDir = path.dirname(absoluteConfigPath);
  let fileContents: string;

  try {
    fileContents = await readFile(absoluteConfigPath, "utf8");
  } catch (error) {
    const typedError = error as NodeJS.ErrnoException;

    if (typedError.code === "ENOENT") {
      throw new Error(
        `Config file not found at ${absoluteConfigPath}. Check BOT_CONFIG_PATH in .env. Use ./config/bot.config.json on Windows.`,
      );
    }

    throw error;
  }

  const rawConfig = JSON.parse(fileContents) as RawAppConfig;

  if (!rawConfig.workspaces || rawConfig.workspaces.length === 0) {
    throw new Error("Config must define at least one workspace.");
  }

  const codex: AppConfig["codex"] = {
    path: resolvePath(configDir, assertString(rawConfig.codex?.path, "codex.path")),
  };

  if (rawConfig.codex?.stageTimeoutMs !== undefined) {
    codex.stageTimeoutMs = assertPositiveNumber(rawConfig.codex.stageTimeoutMs, "codex.stageTimeoutMs");
  }

  return {
    discord: {
      token: resolveSecretString(assertString(rawConfig.discord?.token, "discord.token")),
      guildId: assertString(rawConfig.discord?.guildId, "discord.guildId"),
      allowedChannelIds: assertStringArray(rawConfig.discord?.allowedChannelIds ?? [], "discord.allowedChannelIds"),
      ownerUserIds: assertStringArray(rawConfig.discord?.ownerUserIds ?? [], "discord.ownerUserIds"),
      trustedRoleIds: assertStringArray(rawConfig.discord?.trustedRoleIds ?? [], "discord.trustedRoleIds"),
    },
    codex,
    storage: {
      databasePath: resolvePath(configDir, assertString(rawConfig.storage?.databasePath, "storage.databasePath")),
    },
    responseLanguage: assertString(rawConfig.responseLanguage ?? "vi", "responseLanguage"),
    workspaces: rawConfig.workspaces.map((workspace) => parseWorkspace(workspace, configDir)),
  };
}

export function resolveWorkspace(workspaces: WorkspaceConfig[], workspaceKey: string): WorkspaceConfig {
  const workspace = workspaces.find((item) => item.key === workspaceKey);

  if (!workspace) {
    throw new Error(`Unknown workspace key: ${workspaceKey}`);
  }

  return workspace;
}
