# Discord Codex Orchestrator

Self-hosted Discord bot that turns a Discord server into a collaborative coding workspace. Each task gets its own managed thread with a full AI planning pipeline — plan, review, approve, execute — powered by a local [Codex CLI](https://github.com/openai/codex) installation.

```
User runs /codex start
         │
         ▼
┌─────────────────────────────────────────────┐
│  planner  →  critic  →  synthesizer         │
│                              │               │
│                   ┌──────────┘               │
│                   ▼                          │
│          Plan posted to thread               │
│          with [Approve] [Revise] buttons     │
│                   │                          │
│          ┌───── Approve ─────┐               │
│          │                   │               │
│          ▼           Revise + feedback        │
│       executor         │                     │
│          │             └──→ planner (loop)    │
│          ▼                                   │
│    Result posted to thread                   │
└─────────────────────────────────────────────┘
```

## Features

### Slash commands

| Command | Where | Description |
|---------|-------|-------------|
| `/codex start workspace:<key> goal:<text>` | Text channel or thread | Creates a managed thread and runs the full pipeline. |
| `/codex status` | Managed thread | Shows session status, active stage, Codex session ID. |
| `/codex cancel` | Managed thread | Kills the active Codex process or cancels a pending approval. |
| `/codex rerun stage:<plan\|execute>` | Managed thread | Reruns the planning chain or only the executor stage. |
| `/codex help` | Anywhere | Shows command reference (ephemeral). |

### In-thread interaction

- **`@Bot <message>`** — Sends a follow-up to the existing Codex session. The bot continues from the same context.
- **`@Bot replan: <feedback>`** — Reruns planner → critic → synthesizer with the feedback appended to the original goal.
- **Approve / Revise buttons** — After the synthesizer produces a plan, the bot posts it with two buttons. Approve starts the executor. Revise asks for feedback, then replans. The loop continues until you approve or cancel.

### Plan approval workflow

The bot never auto-executes. After planner → critic → synthesizer finishes, the pipeline **pauses** and posts the plan to the thread with interactive buttons. This gives the team a chance to review before any code changes happen.

- The approval state persists in SQLite — if the bot restarts while waiting for approval, it re-posts the buttons on startup.
- Only authorized users (owners or trusted roles) can approve or revise.
- Canceling via `/codex cancel` also works during the approval wait.

### Structured output

The synthesizer and executor stages return strict JSON validated locally with [Ajv](https://ajv.js.org/) (JSON Schema 2020-12) against:

- `schemas/synthesizer.output.schema.json` — `{ summary, planMarkdown, executorPrompt }`
- `schemas/executor.output.schema.json` — `{ status, summary, changes[], tests[], nextSteps[] }`

If the LLM wraps JSON in markdown fences (` ```json ... ``` `), the parser strips them automatically before validation. If validation still fails, the thread is marked failed and the raw error is stored for debugging.

### Long output handling

Discord messages are capped at 2000 characters. When a result exceeds 1900 characters, the bot attaches it as a `.md` file with a truncated preview in the message body.

---

## Project layout

```
src/
  index.ts                       Entry point
  types.ts                       SessionStatus, StageName, AppConfig, output types
  config.ts                      Config loader with env: secret resolution
  schemas.ts                     JSON schema validation + markdown fence stripping

  codex/
    runner.ts                    Spawn and monitor codex CLI (JSONL streaming)
    jsonl.ts                     Parse Codex JSONL events
    prompts.ts                   Stage prompt builders (planner, critic, etc.)

  orchestrator/
    service.ts                   Pipeline state machine, approval flow, observer pattern

  discord/
    bot.ts                       Discord client, slash commands, button handlers
    permissions.ts               Owner/role authorization, channel allowlisting
    render.ts                    Markdown report rendering

  store/
    threadSessionStore.ts        SQLite-backed session persistence (node:sqlite)

  utils/
    text.ts                      Thread name sanitization, mention stripping
    files.ts                     Directory creation
    process.ts                   Process tree cleanup (taskkill on Windows)

schemas/
  synthesizer.output.schema.json
  executor.output.schema.json

tests/
  helpers.ts                     Test config builder, temp dirs, waitFor
  schemas.test.ts                JSON fence stripping + validation
  jsonl.test.ts                  JSONL parser
  permissions.test.ts            Authorization + channel gating
  runner.integration.test.ts     CodexRunner with fake binary
  orchestrator.integration.test.ts  Full pipeline + approval + revision + restart
  fixtures/fake-codex.mjs        Mock codex CLI for tests

config/
  bot.config.example.json        Config template

scripts/
  build.ps1  dev.ps1  start.ps1  test.ps1  test-watch.ps1  shared.ps1
```

---

## Requirements

- **Node.js 24+** (uses the built-in `node:sqlite` module)
- A working local [Codex CLI](https://github.com/openai/codex) installation
- A Discord bot token with guild access
- **Message Content intent** enabled in the Discord developer portal (for mention-based follow-ups)

---

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Create environment file

Copy `.env.example` to `.env` and set your Discord token:

```env
DISCORD_TOKEN=your-bot-token-here
BOT_CONFIG_PATH=./config/bot.config.json
```

### 3. Create bot config

Copy `config/bot.config.example.json` to `config/bot.config.json` and fill in:

```jsonc
{
  "discord": {
    "token": "env:DISCORD_TOKEN",       // reads from .env
    "guildId": "123456789012345678",     // your server ID
    "allowedChannelIds": ["..."],        // channels where /codex works
    "ownerUserIds": ["..."],             // Discord user IDs that can use the bot
    "trustedRoleIds": ["..."]            // role IDs that can use the bot
  },
  "codex": {
    "path": "C:\\path\\to\\codex.cmd",   // local codex CLI path
    "stageTimeoutMs": 600000             // 10 min per stage (optional)
  },
  "storage": {
    "databasePath": "./data/bot.sqlite"  // SQLite file path
  },
  "responseLanguage": "vi",              // language for AI prose fields
  "workspaces": [
    {
      "key": "my-project",
      "label": "My Project",
      "path": "C:\\path\\to\\project",
      "allowDangerousExecution": true     // required for executor + follow-up
    }
  ]
}
```

### 4. Start the bot

Development (TypeScript directly via tsx):

```bash
npm run dev
```

Production (compile first):

```bash
npm run build
npm start
```

Slash commands are registered to the configured guild on startup.

---

## Configuration reference

| Field | Type | Description |
|-------|------|-------------|
| `discord.token` | string | Bot token. Supports `env:VAR_NAME` to read from environment. |
| `discord.guildId` | string | The Discord server ID to register commands in. |
| `discord.allowedChannelIds` | string[] | Channels (or parent channels of threads) where the bot responds. Empty = allow all. |
| `discord.ownerUserIds` | string[] | User IDs with full bot access. |
| `discord.trustedRoleIds` | string[] | Role IDs with bot access. |
| `codex.path` | string | Absolute path to the `codex` binary. On Windows, use `.cmd` wrapper. |
| `codex.stageTimeoutMs` | number? | Max milliseconds per Codex stage. Default: 600000 (10 min). |
| `storage.databasePath` | string | Path to SQLite database file. Relative to config directory. |
| `responseLanguage` | string | Language code for AI prose. Default: `"vi"`. |
| `workspaces` | array | List of workspace definitions. At least one required. |
| `workspaces[].key` | string | Unique key used in slash command choices. |
| `workspaces[].label` | string | Display name shown in Discord. |
| `workspaces[].path` | string | Absolute filesystem path to the workspace. |
| `workspaces[].allowDangerousExecution` | boolean | Must be `true` for executor and follow-up stages to run. |

### Config notes

- A managed thread stays **bound to its original workspace**. Starting a new task in the same thread with a different workspace is rejected.
- The `env:` prefix in string fields resolves environment variables at config load time.
- On startup, the store clears stale `active_pid` entries and marks abandoned `planning`/`executing` sessions as `failed`. Sessions in `awaiting_approval` are preserved and re-posted with buttons.

---

## Pipeline stages

| Stage | Mode | Description |
|-------|------|-------------|
| **planner** | read-only | Reads the workspace, drafts an implementation plan. |
| **critic** | read-only | Reviews the draft plan for gaps, risks, and simpler alternatives. |
| **synthesizer** | read-only | Produces the final plan as structured JSON (`SynthesizerOutput`). |
| *(approval pause)* | — | Bot posts plan + Approve/Revise buttons. Pipeline waits. |
| **executor** | dangerous | Executes the approved plan. Modifies files, runs commands. Returns `ExecutorOutput`. |
| **followup** | dangerous | Continues from the same session context when user mentions the bot. |

---

## Session lifecycle

```
idle
  │  /codex start
  ▼
planning  (planner → critic → synthesizer)
  │
  ▼
awaiting_approval  (buttons posted, waiting for user)
  │
  ├── Approve → executing (executor runs) → completed
  ├── Revise  → planning (loop back with feedback)
  ├── /codex cancel → canceled
  └── stage error → failed
```

---

## Development

### Build

```bash
npm run build
```

### Test

```bash
npm test
```

### Test in watch mode

```bash
npm run test:watch
```

The integration tests use `tests/fixtures/fake-codex.mjs` to emulate `codex exec` and `codex exec resume`. Environment variables control test behavior:

| Variable | Effect |
|----------|--------|
| `FAKE_CODEX_FAIL_STAGE` | Force a nonzero exit for the named stage. |
| `FAKE_CODEX_FAIL_CODE` | Exit code to use (default: 9). |
| `FAKE_CODEX_DELAY_STAGE` | Add a delay before the named stage completes. |
| `FAKE_CODEX_DELAY_MS` | Delay duration in milliseconds. |
| `FAKE_CODEX_BAD_JSON_STAGE` | Return unparseable JSON for the named stage. |
| `FAKE_CODEX_INVALID_SCHEMA_STAGE` | Return valid JSON that fails schema validation. |

### Test coverage summary

- **29 tests** across 5 test files
- Unit tests: JSONL parsing, permissions, schema validation with fence stripping
- Integration tests: full pipeline, follow-up, replan, approval flow, revision loop, restart recovery, timeout, cancellation, workspace binding, error handling

---

## Architecture

```
Discord User
    │
    │  slash command / mention / button click
    ▼
DiscordCodexBot  (src/discord/bot.ts)
    │
    │  startManagedTask / approve / requestRevision / cancel
    ▼
OrchestratorService  (src/orchestrator/service.ts)
    │
    │  observer pattern (onStageStarted, onApprovalNeeded, ...)
    │
    ├──→ CodexRunner  (src/codex/runner.ts)
    │       │
    │       │  spawn codex exec [--json]
    │       ▼
    │    codex CLI  (local installation)
    │
    └──→ ThreadSessionStore  (src/store/threadSessionStore.ts)
            │
            ▼
         SQLite  (node:sqlite)
```

The orchestrator uses an **observer pattern** to decouple stage events from Discord message delivery. The bot registers as an observer and receives notifications for stage transitions, errors, and approval requests.

---

## License

MIT
