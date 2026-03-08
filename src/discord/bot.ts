import {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type GuildMember,
  type Message,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";

import type { AppConfig, SynthesizerOutput, ThreadSessionRecord, WorkspaceConfig } from "../types.js";
import { resolveWorkspace } from "../config.js";
import { renderErrorReport, renderStatusMessage } from "./render.js";
import { isChannelAllowed, isUserAuthorized } from "./permissions.js";
import { OrchestratorService, type OrchestratorObserver } from "../orchestrator/service.js";
import { sanitizeThreadName, stripBotMention } from "../utils/text.js";

const APPROVE_PREFIX = "codex-approve-";
const REVISE_PREFIX = "codex-revise-";

function buildCodexCommand(workspaces: WorkspaceConfig[]) {
  const builder = new SlashCommandBuilder()
    .setName("codex")
    .setDescription("Manage Codex Discord orchestration.")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("start")
        .setDescription("Create or reuse a managed thread and start planner -> critic -> synthesizer -> executor.")
        .addStringOption((option) =>
          option
            .setName("workspace")
            .setDescription("Workspace key from the allowlist.")
            .setRequired(true)
            .addChoices(
              ...workspaces.map((workspace) => ({
                name: workspace.label,
                value: workspace.key,
              })),
            ),
        )
        .addStringOption((option) =>
          option
            .setName("goal")
            .setDescription("Task goal to send into Codex.")
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("status").setDescription("Show the current managed-thread status."),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("cancel").setDescription("Cancel the active Codex job for this managed thread."),
    )
    .addSubcommand((subcommand) =>
      subcommand.setName("help").setDescription("Show command usage and thread behavior."),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("rerun")
        .setDescription("Rerun either the plan chain or the executor.")
        .addStringOption((option) =>
          option
            .setName("stage")
            .setDescription("Which stage group to rerun.")
            .setRequired(true)
            .addChoices(
              { name: "plan", value: "plan" },
              { name: "execute", value: "execute" },
            ),
        ),
    );

  return builder.toJSON();
}

async function collectRoleIds(member: GuildMember | null): Promise<string[]> {
  if (!member) {
    return [];
  }

  return [...member.roles.cache.keys()];
}

function getChannelContext(channel: ChatInputCommandInteraction["channel"] | Message["channel"]) {
  if (!channel) {
    return {
      channelId: null,
      parentChannelId: null,
    };
  }

  if (channel.isThread()) {
    return {
      channelId: channel.id,
      parentChannelId: channel.parentId,
    };
  }

  return {
    channelId: channel.id,
    parentChannelId: null,
  };
}

function canCreateThread(channel: ChatInputCommandInteraction["channel"]): channel is TextChannel {
  return channel?.type === ChannelType.GuildText;
}

export class DiscordCodexBot {
  private readonly client: Client;
  private readonly orchestratorObserver: OrchestratorObserver;
  private readonly pendingRevisions = new Map<string, string>();

  public constructor(
    private readonly config: AppConfig,
    private readonly orchestrator: OrchestratorService,
  ) {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers,
      ],
      partials: [Partials.Channel],
    });
    this.orchestratorObserver = {
      onStageStarted: async ({ threadId, stage }) => {
        await this.sendThreadUpdate(threadId, this.renderStageStarted(stage));
      },
      onStageFailed: async ({ threadId, stage, error }) => {
        await this.sendThreadUpdate(threadId, `Stage \`${stage}\` failed.\n\n${error.message}`);
      },
      onJobCanceled: async ({ threadId, stage }) => {
        await this.sendThreadUpdate(threadId, `Canceled active stage \`${stage}\`.`);
      },
      onApprovalNeeded: async ({ threadId, plan }) => {
        await this.sendApprovalMessage(threadId, plan);
      },
    };
    this.orchestrator.addObserver(this.orchestratorObserver);
  }

  public async start(): Promise<void> {
    this.client.once("clientReady", async () => {
      await this.registerCommands();
      await this.recoverPendingApprovals();
      console.log(`Discord bot ready as ${this.client.user?.tag ?? "unknown-user"}.`);
    });

    this.client.on("interactionCreate", (interaction) => {
      if (interaction.isButton()) {
        void this.handleButtonInteraction(interaction);
        return;
      }

      if (!interaction.isChatInputCommand() || interaction.commandName !== "codex") {
        return;
      }

      void this.handleCommand(interaction);
    });

    this.client.on("messageCreate", (message) => {
      void this.handleMessage(message);
    });

    await this.client.login(this.config.discord.token);
  }

  private async registerCommands(): Promise<void> {
    const guild = await this.client.guilds.fetch(this.config.discord.guildId);
    await guild.commands.set([buildCodexCommand(this.config.workspaces)]);
  }

  private async handleCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    try {
      await interaction.deferReply({
        flags: MessageFlags.Ephemeral,
      });

      await this.ensureAuthorizedInteraction(interaction);

      const subcommand = interaction.options.getSubcommand(true);

      if (subcommand === "start") {
        await this.handleStartCommand(interaction);
        return;
      }

      if (subcommand === "status") {
        await this.handleStatusCommand(interaction);
        return;
      }

      if (subcommand === "cancel") {
        await this.handleCancelCommand(interaction);
        return;
      }

      if (subcommand === "help") {
        await this.handleHelpCommand(interaction);
        return;
      }

      if (subcommand === "rerun") {
        await this.handleRerunCommand(interaction);
        return;
      }

      await interaction.editReply({
        content: "Unknown subcommand.",
      });
    } catch (error) {
      const content = renderErrorReport((error as Error).message);
      await this.respondToInteraction(interaction, content);
    }
  }

  private async handleStartCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const workspaceKey = interaction.options.getString("workspace", true);
    const goal = interaction.options.getString("goal", true);
    const workspace = resolveWorkspace(this.config.workspaces, workspaceKey);
    const thread = await this.ensureManagedThread(interaction, goal);

    await interaction.editReply({
      content: `Started Codex job in thread <#${thread.id}> for workspace ${workspace.label}.`,
    });

    void this.runInBackground(thread, async () =>
      this.orchestrator.startManagedTask({
        discordThreadId: thread.id,
        discordChannelId: thread.parentId ?? thread.id,
        workspaceKey,
        goal,
      }),
    );
  }

  private async handleStatusCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const thread = this.requireThreadChannel(interaction.channel);
    const session = this.orchestrator.getSession(thread.id);

    if (!session) {
      await interaction.editReply({
        content: "This thread is not managed yet.",
      });
      return;
    }

    const workspace = resolveWorkspace(this.config.workspaces, session.workspaceKey);
    const activeStage = this.orchestrator.getActiveStage(thread.id);

    await interaction.editReply({
      content: renderStatusMessage(session, activeStage, workspace),
    });
  }

  private async handleCancelCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const thread = this.requireThreadChannel(interaction.channel);
    const canceled = await this.orchestrator.cancel(thread.id);

    await interaction.editReply({
      content: canceled ? "Canceled the active Codex job." : "No active Codex job was running.",
    });
  }

  private async handleRerunCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const thread = this.requireThreadChannel(interaction.channel);
    const stage = interaction.options.getString("stage", true);

    await interaction.editReply({
      content: `Queued rerun for ${stage} in thread <#${thread.id}>.`,
    });

    void this.runInBackground(thread, async () => {
      if (stage === "plan") {
        return this.orchestrator.rerunPlan(thread.id);
      }

      return this.orchestrator.rerunExecute(thread.id);
    });
  }

  private async handleHelpCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.editReply({
      content: [
        "**Codex Bot Commands**",
        "",
        "`/codex start workspace:<key> goal:<text>` - Tao thread moi va bat dau task.",
        "`/codex status` - Xem trang thai session (chay trong managed thread).",
        "`/codex cancel` - Huy job dang chay hoac dang cho approve.",
        "`/codex rerun stage:<plan|execute>` - Chay lai plan hoac executor.",
        "`/codex help` - Hien thi huong dan nay.",
        "",
        "**Trong managed thread:**",
        "`@Bot <message>` - Gui follow-up cho Codex session.",
        "`@Bot replan: <feedback>` - Chay lai planner voi feedback moi.",
        "Buttons `Approve` / `Revise` xuat hien sau khi bot tao xong plan.",
      ].join("\n"),
    });
  }

  private async handleButtonInteraction(interaction: ButtonInteraction): Promise<void> {
    if (!(interaction.customId.startsWith(APPROVE_PREFIX) || interaction.customId.startsWith(REVISE_PREFIX))) {
      return;
    }

    try {
      await this.ensureAuthorizedButtonInteraction(interaction);

      if (interaction.customId.startsWith(APPROVE_PREFIX)) {
        const threadId = interaction.customId.slice(APPROVE_PREFIX.length);
        const resolvedInMemory = this.orchestrator.approve(threadId);
        await interaction.update({ components: [] });

        if (!resolvedInMemory) {
          const channel = await this.fetchManagedThread(threadId);
          void this.runInBackground(channel, async () => this.orchestrator.resumeAfterApproval(threadId));
        }
        return;
      }

      const threadId = interaction.customId.slice(REVISE_PREFIX.length);
      this.pendingRevisions.set(threadId, interaction.user.id);
      await interaction.update({ components: [] });
      await interaction.followUp({
        content: "Gui feedback revision ngay trong thread nay. Chi tin nhan tiep theo cua ban se duoc dung de replan.",
        flags: MessageFlags.Ephemeral,
      });
    } catch (error) {
      await this.respondToButtonInteraction(interaction, renderErrorReport((error as Error).message));
    }
  }

  private async handleMessage(message: Message): Promise<void> {
    if (message.author.bot || !message.inGuild() || !this.client.user) {
      return;
    }

    const revisionOwnerId = this.pendingRevisions.get(message.channel.id);

    if (revisionOwnerId) {
      if (!message.channel.isThread()) {
        this.pendingRevisions.delete(message.channel.id);
      } else if (message.author.id === revisionOwnerId) {
        this.pendingRevisions.delete(message.channel.id);
        const feedback = message.content.trim();

        if (feedback.length === 0) {
          await message.reply("Feedback revision khong duoc de trong.");
          return;
        }

        await message.channel.sendTyping();
        if (this.orchestrator.requestRevision(message.channel.id, feedback)) {
          await message.reply("Da nhan feedback revision. Bot dang lap plan lai.");
          return;
        }

        void this.runInBackground(message.channel, async () => this.orchestrator.resumeAfterRevision(message.channel.id, feedback));
        return;
      }
    }

    if (!message.mentions.users.has(this.client.user.id)) {
      return;
    }

    const member = message.member ?? (await message.guild.members.fetch(message.author.id));
    const roleIds = await collectRoleIds(member);

    if (!isUserAuthorized(message.author.id, roleIds, this.config.discord)) {
      await message.reply("You are not allowed to use this bot.");
      return;
    }

    const context = getChannelContext(message.channel);

    if (!context.channelId || !isChannelAllowed(context.channelId, context.parentChannelId, this.config.discord.allowedChannelIds)) {
      await message.reply("This channel is not allowed for Codex jobs.");
      return;
    }

    if (!message.channel.isThread()) {
      await message.reply("Use /codex start in an allowed channel, then continue inside the managed thread.");
      return;
    }

    const session = this.orchestrator.getSession(message.channel.id);

    if (!session) {
      await message.reply("This thread is not managed yet. Start it with /codex start first.");
      return;
    }

    const content = stripBotMention(message.content, this.client.user.id);
    const replanPrefix = "replan:";

    try {
      await message.channel.sendTyping();
      void this.runInBackground(message.channel, async () => {
        if (content.toLowerCase().startsWith(replanPrefix)) {
          return this.orchestrator.rerunPlan(message.channel.id, content.slice(replanPrefix.length));
        }

        return this.orchestrator.followup(message.channel.id, content);
      });
    } catch (error) {
      await message.reply(renderErrorReport((error as Error).message));
    }
  }

  private async runInBackground(
    thread: ThreadChannel,
    run: () => Promise<{ markdown: string }>,
  ): Promise<void> {
    try {
      const result = await run();
      if (!result.markdown) {
        return;
      }
      await this.sendFinalResult(thread, result.markdown);
    } catch (error) {
      await thread.send(renderErrorReport((error as Error).message));
    }
  }

  private async sendFinalResult(thread: ThreadChannel, markdown: string): Promise<void> {
    if (markdown.length <= 1900) {
      await thread.send(markdown);
      return;
    }

    const file = new AttachmentBuilder(Buffer.from(markdown, "utf8"), {
      name: `codex-result-${thread.id}.md`,
    });
    const summary = `${markdown.slice(0, 800)}\n\nFull result attached.`;

    await thread.send({
      content: summary,
      files: [file],
    });
  }

  private async respondToInteraction(interaction: ChatInputCommandInteraction, content: string): Promise<void> {
    if (interaction.deferred) {
      await interaction.editReply({ content });
      return;
    }

    if (interaction.replied) {
      await interaction.followUp({
        content,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      content,
      flags: MessageFlags.Ephemeral,
    });
  }

  private async respondToButtonInteraction(interaction: ButtonInteraction, content: string): Promise<void> {
    if (interaction.deferred || interaction.replied) {
      await interaction.followUp({
        content,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    await interaction.reply({
      content,
      flags: MessageFlags.Ephemeral,
    });
  }

  private renderStageStarted(stage: string): string {
    if (stage === "planner") {
      return "Starting `planner`: drafting the implementation plan.";
    }

    if (stage === "critic") {
      return "Starting `critic`: reviewing the draft plan for gaps and risks.";
    }

    if (stage === "synthesizer") {
      return "Starting `synthesizer`: producing the final plan and executor prompt.";
    }

    if (stage === "executor") {
      return "Starting `executor`: running the approved plan in the workspace.";
    }

    if (stage === "followup") {
      return "Starting `followup`: continuing the same Codex session.";
    }

    return `Starting stage \`${stage}\`.`;
  }

  private async sendThreadUpdate(threadId: string, content: string): Promise<void> {
    try {
      const channel = await this.client.channels.fetch(threadId);

      if (!channel?.isThread()) {
        return;
      }

      await channel.send(content);
    } catch (error) {
      console.error(`Failed to send thread update for ${threadId}:`, error);
    }
  }

  private async sendApprovalMessage(threadId: string, plan: SynthesizerOutput): Promise<void> {
    const channel = await this.fetchManagedThread(threadId);
    const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${APPROVE_PREFIX}${threadId}`)
        .setLabel("Approve")
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${REVISE_PREFIX}${threadId}`)
        .setLabel("Revise")
        .setStyle(ButtonStyle.Secondary),
    );
    const content = [
      "# Plan Awaiting Approval",
      "",
      plan.summary,
      "",
      plan.planMarkdown,
    ].join("\n");

    if (content.length <= 1800) {
      await channel.send({
        content,
        components: [buttons],
      });
      return;
    }

    const file = new AttachmentBuilder(Buffer.from(plan.planMarkdown, "utf8"), {
      name: `codex-plan-${threadId}.md`,
    });

    await channel.send({
      content: `# Plan Awaiting Approval\n\n${plan.summary}\n\nPlan qua dai nen duoc dinh kem file. Chon Approve hoac Revise ben duoi.`,
      files: [file],
      components: [buttons],
    });
  }

  private async recoverPendingApprovals(): Promise<void> {
    const sessions = this.orchestrator.getSessionsAwaitingApproval();

    for (const session of sessions) {
      const plan = this.buildRecoveryPlan(session);
      await this.sendApprovalMessage(session.discordThreadId, plan);
    }
  }

  private buildRecoveryPlan(session: ThreadSessionRecord): SynthesizerOutput {
    return {
      summary: "Recovered pending approval after restart.",
      planMarkdown: session.lastPlanMarkdown ?? "Plan not available.",
      executorPrompt: session.lastExecutorPrompt ?? "Executor prompt not available.",
    };
  }

  private async fetchManagedThread(threadId: string): Promise<ThreadChannel> {
    const channel = await this.client.channels.fetch(threadId);

    if (!channel?.isThread()) {
      throw new Error("Managed thread was not found.");
    }

    return channel;
  }

  private async ensureManagedThread(interaction: ChatInputCommandInteraction, goal: string): Promise<ThreadChannel> {
    if (interaction.channel?.isThread()) {
      return interaction.channel;
    }

    if (!canCreateThread(interaction.channel)) {
      throw new Error("Run /codex start inside a text channel or an existing thread.");
    }

    return interaction.channel.threads.create({
      name: sanitizeThreadName(goal),
      autoArchiveDuration: 1440,
      reason: `Codex job requested by ${interaction.user.tag}`,
    });
  }

  private requireThreadChannel(channel: ChatInputCommandInteraction["channel"]): ThreadChannel {
    if (!channel?.isThread()) {
      throw new Error("Run this command inside a managed thread.");
    }

    return channel;
  }

  private async ensureAuthorizedInteraction(interaction: ChatInputCommandInteraction): Promise<void> {
    if (!interaction.inGuild()) {
      throw new Error("This bot only works inside a guild.");
    }

    const guild = interaction.guild;

    if (!guild) {
      throw new Error("Guild context was not available.");
    }

    const member = await guild.members.fetch(interaction.user.id);
    const roleIds = await collectRoleIds(member);
    const context = getChannelContext(interaction.channel);

    if (!context.channelId || !isChannelAllowed(context.channelId, context.parentChannelId, this.config.discord.allowedChannelIds)) {
      throw new Error("This channel is not allowed for Codex jobs.");
    }

    if (!isUserAuthorized(interaction.user.id, roleIds, this.config.discord)) {
      throw new Error("You are not allowed to use this bot.");
    }
  }

  private async ensureAuthorizedButtonInteraction(interaction: ButtonInteraction): Promise<void> {
    if (!interaction.inGuild()) {
      throw new Error("This bot only works inside a guild.");
    }

    const member = interaction.member;
    const roleIds = member && "roles" in member && "cache" in member.roles ? [...member.roles.cache.keys()] : [];
    const context = getChannelContext(interaction.channel);

    if (!context.channelId || !isChannelAllowed(context.channelId, context.parentChannelId, this.config.discord.allowedChannelIds)) {
      throw new Error("This channel is not allowed for Codex jobs.");
    }

    if (!isUserAuthorized(interaction.user.id, roleIds, this.config.discord)) {
      throw new Error("You are not allowed to use this bot.");
    }
  }
}
