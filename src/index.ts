import "dotenv/config";

import { loadConfig } from "./config.js";
import { CodexRunner } from "./codex/runner.js";
import { DiscordCodexBot } from "./discord/bot.js";
import { OrchestratorService } from "./orchestrator/service.js";
import { ThreadSessionStore } from "./store/threadSessionStore.js";

async function main(): Promise<void> {
  const config = await loadConfig();
  const store = await ThreadSessionStore.create(config.storage.databasePath);
  store.clearDanglingActivity();
  const defaultStageTimeoutMs = config.codex.stageTimeoutMs ?? 600_000;
  const runner = new CodexRunner({
    codexPath: config.codex.path,
    defaultTimeoutMs: defaultStageTimeoutMs,
  });
  const orchestrator = new OrchestratorService(config, store, runner);
  const bot = new DiscordCodexBot(config, orchestrator);

  await bot.start();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
