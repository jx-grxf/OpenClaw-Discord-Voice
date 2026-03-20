import fs from 'node:fs';
import path from 'node:path';
import prism from 'prism-media';
import { EndBehaviorType, VoiceConnection, getVoiceConnection } from '@discordjs/voice';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  Guild,
  MessageFlags,
  TextChannel,
  ThreadChannel,
} from 'discord.js';
import {
  convertPcmToWav,
  createRequestTempDir,
  getTtsOutputExtension,
  playAudioFile,
  removeRequestTempDir,
  synthesizeSpeech,
  transcribeWav,
} from '../audio.js';
import { collectBridgeHealth, summarizeHealthIssues } from '../diagnostics.js';
import {
  askOpenClaw,
  createOpenClawSession,
  deleteOpenClawSession,
  deleteOpenClawSessionWithRetry,
  getOpenClawChatHistory,
  type OpenClawChatHistoryMessage,
  type OpenClawVerboseEvent,
} from '../openclaw.js';
import {
  beginGuildJoin,
  beginGuildListen,
  buildVoiceSessionKey,
  clearVoiceSession,
  createVoiceSession,
  endGuildJoin,
  getActiveGuildJoinUser,
  endGuildListen,
  getActiveGuildListenUser,
  getVoiceSession,
  markVoiceSessionUsed,
  setVoiceSessionVerbose,
  setVoiceSessionBotSpeaking,
  setVoiceSessionListenMode,
} from '../state.js';
import { formatAge, truncate } from '../utils.js';
import { getOrCreateConnectionFromMember } from '../voice.js';

function formatPipelineError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    const message = error.message.trim();
    const firstLine = message.split('\n').find((line) => line.trim())?.trim() ?? message;

    if (message.includes('missing scope: operator.write')) {
      return 'OpenClaw denied live verbose streaming for this session because the local gateway token does not have write scope.';
    }

    return firstLine;
  }
  return 'Unknown voice bridge error.';
}

function formatCleanupError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    const message = error.message.trim();

    if (message.includes('ETIMEDOUT') || message.includes('timed out')) {
      return 'OpenClaw cleanup timed out before it could confirm the session deletion.';
    }

    if (message.includes('gateway closed') || message.includes('gateway connect failed')) {
      return 'OpenClaw closed the cleanup connection before it could confirm the session deletion.';
    }

    if (message.includes('missing scope: operator.admin')) {
      return 'OpenClaw denied the cleanup request because this local gateway token does not have the needed admin scope.';
    }

    const firstLine = message.split('\n').find((line) => line.trim())?.trim();
    if (firstLine) return firstLine;
  }

  return 'OpenClaw cleanup failed for an unknown reason.';
}

function fitEmbedFieldValue(value: string, maxLength = 1024): string {
  const trimmed = value.trim();
  if (!trimmed) return '—';
  return truncate(trimmed, maxLength);
}

function summarizeSessionKey(sessionKey: string): string {
  return `\`${truncate(sessionKey, 72)}\``;
}

function summarizeSessionId(sessionId: string | null): string {
  return sessionId ? `\`${truncate(sessionId, 48)}\`` : 'Not reported yet';
}

function statusLabel(ok: boolean): string {
  return ok ? 'OK' : 'MISSING';
}

function formatLatency(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const VOICE_MODE_SLASH = 'voice-mode:slash';
const VOICE_MODE_AUTO = 'voice-mode:auto';
const VOICE_VERBOSE_ENABLE = 'voice-verbose:enable';
const VOICE_VERBOSE_DISABLE = 'voice-verbose:disable';

type ListenExecutionContext = {
  guildId: string;
  guild: Guild;
  requestUserId: string;
  connection: VoiceConnection;
  session: NonNullable<ReturnType<typeof getVoiceSession>>;
  startNotice?: () => Promise<void>;
  finishReply: (payload: { embed?: EmbedBuilder; content?: string }) => Promise<void>;
};

const autoListenControllers = new Map<string, { dispose: () => void; triggerActive: boolean }>();

function buildVoiceVerboseButtons(active: boolean) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(VOICE_VERBOSE_ENABLE)
        .setLabel('Yes')
        .setStyle(active ? ButtonStyle.Secondary : ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(VOICE_VERBOSE_DISABLE)
        .setLabel('No')
        .setStyle(active ? ButtonStyle.Danger : ButtonStyle.Secondary),
    ),
  ];
}

function buildVoiceVerbosePromptEmbed(session: NonNullable<ReturnType<typeof getVoiceSession>>) {
  const embed = new EmbedBuilder()
    .setTitle('Voice verbose mode')
    .setColor(session.verboseEnabled ? 0x5865f2 : 0xfee75c)
    .setDescription('Do you want to activate verbose mode for this voice session?')
    .addFields(
      {
        name: 'Session',
        value: summarizeSessionKey(session.sessionKey),
        inline: false,
      },
      {
        name: 'Current status',
        value: session.verboseEnabled
          ? `Active${session.verboseThreadId ? ` in <#${session.verboseThreadId}>` : ''}`
          : 'Inactive',
        inline: false,
      },
      {
        name: 'What it does',
        value: 'Tool calls, verbose updates, and background execution details go into a separate Discord thread. Final voice replies still stay in the normal chat.',
        inline: false,
      },
    );

  return embed;
}

function buildVerboseValue(value: unknown): string {
  if (typeof value === 'string' && value.trim()) {
    return value.trim();
  }
  if (Array.isArray(value)) {
    const nested = value
      .map((entry) => buildVerboseValue(entry))
      .filter((entry) => entry.length > 0);
    if (nested.length > 0) {
      return nested.join('\n');
    }
  }
  if (value && typeof value === 'object') {
    const content = (value as { content?: unknown }).content;
    if (Array.isArray(content)) {
      const textParts = content
        .flatMap((entry) => {
          if (!entry || typeof entry !== 'object') return [];
          const record = entry as { type?: unknown; text?: unknown };
          return record.type === 'text' && typeof record.text === 'string' ? [record.text.trim()] : [];
        })
        .filter((entry) => entry.length > 0);
      if (textParts.length > 0) {
        return textParts.join('\n');
      }
    }

    try {
      return JSON.stringify(value, null, 2);
    } catch {
      return String(value);
    }
  }

  return '';
}

function trimVerboseMessage(text: string, maxLength = 1_800): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function parseTextSignaturePhase(block: Record<string, unknown>): string | null {
  const raw = typeof block.textSignature === 'string' ? block.textSignature.trim() : '';
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { phase?: unknown };
    return typeof parsed.phase === 'string' ? parsed.phase : null;
  } catch {
    return null;
  }
}

function buildVerboseHistoryMessages(message: OpenClawChatHistoryMessage): string[] {
  const content = Array.isArray(message.content) ? message.content : [];
  const results: string[] = [];

  if (message.role === 'assistant') {
    for (const block of content) {
      const type = typeof block.type === 'string' ? block.type : '';

      if (type === 'text') {
        const text = typeof block.text === 'string' ? block.text.trim() : '';
        const phase = parseTextSignaturePhase(block);
        if (!text || phase === 'final_answer') continue;
        results.push(trimVerboseMessage(`**Assistant note**\n${text}`));
        continue;
      }

      if (type === 'toolCall') {
        const toolName = typeof block.name === 'string' && block.name.trim() ? block.name.trim() : 'tool';
        const args = buildVerboseValue(block.arguments ?? block.partialJson);
        results.push(
          trimVerboseMessage(
            args
              ? `**Tool call:** \`${toolName}\`\n\`\`\`json\n${args}\n\`\`\``
              : `**Tool call:** \`${toolName}\``,
          ),
        );
      }
    }
  }

  if (message.role === 'toolResult') {
    const toolName = message.toolName?.trim() || 'tool';
    const text = content
      .flatMap((block) => (block?.type === 'text' && typeof block.text === 'string' ? [block.text.trim()] : []))
      .filter((entry) => entry.length > 0)
      .join('\n\n')
      .trim();

    results.push(
      trimVerboseMessage(
        text
          ? `**Tool output:** \`${toolName}\`\n\`\`\`\n${text}\n\`\`\``
          : `**Tool output:** \`${toolName}\``,
      ),
    );
  }

  return results.filter((entry) => entry.trim().length > 0);
}

function buildVerboseHistoryMessageKey(message: OpenClawChatHistoryMessage): string {
  return JSON.stringify({
    role: message.role ?? '',
    toolCallId: message.toolCallId ?? '',
    toolName: message.toolName ?? '',
    timestamp: message.timestamp ?? null,
    content: message.content ?? [],
  });
}

function formatVerboseEventMessage(event: OpenClawVerboseEvent): string | null {
  const data = event.data ?? {};
  const phase = typeof data.phase === 'string' ? data.phase : '';

  if (event.stream === 'tool') {
    const name = typeof data.name === 'string' && data.name.trim() ? data.name.trim() : 'tool';
    if (phase === 'start') {
      const args = buildVerboseValue(data.args);
      return trimVerboseMessage(
        args
          ? `**Tool start:** \`${name}\`\n\`\`\`json\n${args}\n\`\`\``
          : `**Tool start:** \`${name}\``,
      );
    }

    if (phase === 'update') {
      const partial = buildVerboseValue(data.partialResult);
      return trimVerboseMessage(
        partial
          ? `**Tool update:** \`${name}\`\n\`\`\`\n${partial}\n\`\`\``
          : `**Tool update:** \`${name}\``,
      );
    }

    if (phase === 'result') {
      const result = buildVerboseValue(data.result);
      const prefix = data.isError ? '**Tool error:**' : '**Tool result:**';
      return trimVerboseMessage(
        result
          ? `${prefix} \`${name}\`\n\`\`\`\n${result}\n\`\`\``
          : `${prefix} \`${name}\``,
      );
    }

    return trimVerboseMessage(`**Tool event:** \`${name}\`${phase ? ` (${phase})` : ''}`);
  }

  if (event.stream === 'error') {
    const detail = buildVerboseValue(data.error ?? data);
    return trimVerboseMessage(detail ? `**Agent error**\n\`\`\`\n${detail}\n\`\`\`` : '**Agent error**');
  }

  if (event.stream === 'lifecycle' && (phase === 'fallback' || phase === 'error')) {
    const detail = buildVerboseValue(data);
    return trimVerboseMessage(`**Lifecycle:** \`${phase}\`\n\`\`\`json\n${detail}\n\`\`\``);
  }

  return null;
}

async function resolveVerboseThread(guild: Guild, threadId: string): Promise<ThreadChannel | null> {
  const channel = guild.channels.cache.get(threadId) ?? await guild.channels.fetch(threadId).catch(() => null);
  return channel instanceof ThreadChannel ? channel : null;
}

async function sendVerboseEventToThread(guild: Guild, threadId: string, event: OpenClawVerboseEvent): Promise<void> {
  const content = formatVerboseEventMessage(event);
  if (!content) return;

  const thread = await resolveVerboseThread(guild, threadId);
  if (!thread) return;

  if (thread.archived && !thread.locked) {
    await thread.setArchived(false).catch(() => {});
  }

  await thread.send({ content });
}

async function sendVerboseNoticeToThread(guild: Guild, threadId: string, message: string): Promise<void> {
  const thread = await resolveVerboseThread(guild, threadId);
  if (!thread) return;

  if (thread.archived && !thread.locked) {
    await thread.setArchived(false).catch(() => {});
  }

  await thread.send({ content: trimVerboseMessage(message) });
}

async function mirrorVerboseHistoryToThread(
  guild: Guild,
  threadId: string,
  sessionKey: string,
  state: { seen: Set<string> },
): Promise<void> {
  const messages = await getOpenClawChatHistory(sessionKey, { limit: 200, timeoutMs: 15_000 });

  for (const message of messages) {
    const key = buildVerboseHistoryMessageKey(message);
    if (state.seen.has(key)) continue;
    state.seen.add(key);

    for (const content of buildVerboseHistoryMessages(message)) {
      await sendVerboseNoticeToThread(guild, threadId, content);
    }
  }
}

function getVerboseHostChannel(channel: ChatInputCommandInteraction['channel'] | ButtonInteraction['channel']): TextChannel | null {
  if (!channel) return null;
  if (channel instanceof TextChannel) return channel;
  if (channel instanceof ThreadChannel && channel.parent instanceof TextChannel) return channel.parent;
  return null;
}

async function ensureVerboseThread(
  guild: Guild,
  channel: ChatInputCommandInteraction['channel'] | ButtonInteraction['channel'],
  session: NonNullable<ReturnType<typeof getVoiceSession>>,
): Promise<ThreadChannel> {
  if (session.verboseThreadId) {
    const existing = await resolveVerboseThread(guild, session.verboseThreadId);
    if (existing) {
      if (existing.archived && !existing.locked) {
        await existing.setArchived(false).catch(() => {});
      }
      return existing;
    }
  }

  const hostChannel = getVerboseHostChannel(channel);
  if (!hostChannel) {
    throw new Error('Verbose mode needs a normal text channel so I can create a thread there.');
  }

  const starter = await hostChannel.send({
    content: `Verbose mode stream for ${summarizeSessionKey(session.sessionKey)}`,
  });
  const thread = await starter.startThread({
    name: `voice-verbose-${new Date().toISOString().slice(11, 16).replace(':', '-')}`,
    autoArchiveDuration: 60,
    reason: 'OpenClaw voice verbose stream',
  });
  await thread.send({
    embeds: [
      new EmbedBuilder()
        .setTitle('Verbose mode active')
        .setColor(0x5865f2)
        .setDescription('Tool calls and background execution details for this voice session will appear here.'),
    ],
  });
  return thread;
}

function buildJoinModeButtons(activeMode: 'slash' | 'auto') {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(VOICE_MODE_SLASH)
        .setLabel('Slash-to-talk')
        .setStyle(activeMode === 'slash' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(VOICE_MODE_AUTO)
        .setLabel('Auto-listen (Beta)')
        .setStyle(activeMode === 'auto' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    ),
  ];
}

function buildJoinEmbed(session: NonNullable<ReturnType<typeof getVoiceSession>>, options: {
  channelId: string | null;
  created: boolean;
  issues: string[];
}) {
  const modeText = session.listenMode === 'auto'
    ? 'Auto-listen Beta is active. Speak naturally while the bot is idle, but expect rough edges.'
    : 'Slash-to-talk is active. Run `/listen` whenever you want to speak.';

  const embed = new EmbedBuilder()
    .setTitle('Voice bridge ready')
    .setColor(options.issues.length ? 0xfee75c : 0x57f287)
    .setDescription(`Connected to your voice channel. ${options.created ? 'Created' : 'Reusing'} the active OpenClaw voice session.`)
    .addFields(
      {
        name: 'Voice',
        value: options.channelId ? `<#${options.channelId}>` : 'Connected',
        inline: true,
      },
      {
        name: 'Mode',
        value: session.listenMode === 'auto' ? 'Auto-listen (Beta)' : 'Slash-to-talk',
        inline: true,
      },
      {
        name: 'Verbose',
        value: session.verboseEnabled
          ? session.verboseThreadId ? `On in <#${session.verboseThreadId}>` : 'On'
          : 'Off',
        inline: true,
      },
      {
        name: 'Session key',
        value: summarizeSessionKey(session.sessionKey),
        inline: false,
      },
      {
        name: 'Session id',
        value: summarizeSessionId(session.openClawSessionId),
        inline: false,
      },
      {
        name: 'Next',
        value: `${modeText}\nUse the buttons below to switch modes at any time.`,
        inline: false,
      },
    )
    .setFooter({ text: options.created ? 'Fresh OpenClaw session prepared' : 'Existing OpenClaw session reused' });

  if (options.issues.length) {
    embed.addFields({
      name: 'Warnings',
      value: options.issues.map((issue) => `- ${issue}`).join('\n').slice(0, 1024),
    });
  }

  return embed;
}

function disposeAutoListen(guildId: string) {
  const controller = autoListenControllers.get(guildId);
  if (!controller) return;
  controller.dispose();
  autoListenControllers.delete(guildId);
}

function getNoAudioTimeoutMs(): number {
  const raw = Number(process.env.VOICE_NO_AUDIO_TIMEOUT_MS ?? '');
  return Number.isFinite(raw) && raw >= 3_000 ? raw : 12_000;
}

function getNoSpeechTimeoutMs(): number {
  const raw = Number(process.env.VOICE_NO_SPEECH_TIMEOUT_MS ?? '');
  return Number.isFinite(raw) && raw >= 2_000 ? raw : 5_000;
}

function getMaxCaptureMs(): number {
  const raw = Number(process.env.VOICE_MAX_CAPTURE_MS ?? '');
  return Number.isFinite(raw) && raw >= 4_000 ? raw : 9_000;
}

export function getListenTimingConfig() {
  return {
    noAudioTimeoutMs: getNoAudioTimeoutMs(),
    noSpeechTimeoutMs: getNoSpeechTimeoutMs(),
    maxCaptureMs: getMaxCaptureMs(),
  };
}

export function redactSessionKey(sessionKey: string): string {
  return truncate(sessionKey, 24);
}

export function buildListenLogDetails(details: {
  guildId: string;
  channelId: string | null;
  speakingStarted: boolean;
  ssrcMapped: boolean;
  opusPackets?: number;
  opusBytes?: number;
  pcmBytes?: number;
  transcriptLength?: number;
  hasOpenClawSessionId?: boolean;
  sessionKey: string;
}) {
  return {
    guildId: details.guildId,
    channelId: details.channelId,
    speakingStarted: details.speakingStarted,
    ssrcMapped: details.ssrcMapped,
    opusPackets: details.opusPackets,
    opusBytes: details.opusBytes,
    pcmBytes: details.pcmBytes,
    transcriptLength: details.transcriptLength,
    hasOpenClawSessionId: details.hasOpenClawSessionId ?? false,
    sessionKeyPreview: redactSessionKey(details.sessionKey),
  };
}

function formatSessionStatus(guildId: string | null, userId: string): string {
  if (!guildId) return 'No voice session has been prepared for you yet.';
  const joinUserId = getActiveGuildJoinUser(guildId);
  if (joinUserId) {
    return `A voice session is currently being prepared by Discord user: \`${joinUserId}\``;
  }
  const session = getVoiceSession(guildId);
  if (!session) return 'No voice session has been prepared for you yet.';

  const details = [`OpenClaw key: \`${session.sessionKey}\``];
  if (session.openClawSessionId) {
    details.push(`OpenClaw session id: \`${session.openClawSessionId}\``);
  }
  details.push(`Created by Discord user: \`${session.createdByUserId}\``);
  details.push(`Created: ${formatAge(Date.now() - session.createdAt)}`);
  if (session.lastUsedAt) {
    details.push(`Last used: ${formatAge(Date.now() - session.lastUsedAt)}`);
  }
  return details.join('\n');
}

export async function handleJoin(interaction: ChatInputCommandInteraction) {
  const guildId = interaction.guildId;
  const guild = interaction.guild;
  if (!guildId || !guild) {
    await interaction.reply({ content: 'This command only works inside a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const hadVoiceConnectionBeforeJoin = Boolean(getVoiceConnection(guildId));

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const connection = await getOrCreateConnectionFromMember(interaction);
  if (!connection) return;

  const health = collectBridgeHealth();
  const issues = summarizeHealthIssues(health);
  let session = getVoiceSession(guildId);
  let created = false;

  const channelId = connection.joinConfig.channelId;
  if (session && !hadVoiceConnectionBeforeJoin) {
    console.warn('Discarding stale voice session after reconnect', {
      guildId,
      previousChannelId: session.channelId,
      requestedChannelId: channelId,
    });
    disposeAutoListen(guildId);
    clearVoiceSession(guildId);
    try {
      await deleteOpenClawSessionWithRetry(session.sessionKey, {
        attempts: 2,
        timeoutMs: 10_000,
        backoffMs: 500,
      });
    } catch (error) {
      console.warn('Failed to clean up stale OpenClaw session after reconnect', {
        guildId,
        previousChannelId: session.channelId,
        error: formatPipelineError(error),
      });
    }
    session = null;
  }

  if (session && channelId && session.channelId !== channelId) {
    console.warn('Discarding stale voice session for different channel', {
      guildId,
      previousChannelId: session.channelId,
      requestedChannelId: channelId,
    });
    disposeAutoListen(guildId);
    clearVoiceSession(guildId);
    try {
      await deleteOpenClawSession(session.sessionKey);
    } catch (error) {
      console.warn('Failed to clean up stale OpenClaw session before recreating', {
        guildId,
        previousChannelId: session.channelId,
        error: formatPipelineError(error),
      });
    }
    session = null;
  }

  if (!session) {
    const joinLock = beginGuildJoin(guildId, interaction.user.id);
    if (!joinLock.ok) {
      await interaction.editReply({
        content: 'A voice session is already being prepared in this server. Wait a moment, then try again.',
      });
      return;
    }
    try {
      if (!channelId) {
        connection.destroy();
        await interaction.editReply({
          content: 'The voice connection has no channel id yet. Please try `/join` again.',
        });
        return;
      }
      const requestedKey = buildVoiceSessionKey(guildId, channelId);
      const openClawSession = await createOpenClawSession(requestedKey);
      session = createVoiceSession(guildId, channelId, interaction.user.id, {
        sessionKey: openClawSession.sessionKey,
        openClawSessionId: openClawSession.sessionId,
      });
      created = true;
    } catch (error) {
      connection.destroy();
      await interaction.editReply({
        content: `Joining voice worked, but creating the OpenClaw session failed: ${formatPipelineError(error)}`,
      });
      return;
    } finally {
      endGuildJoin(guildId, interaction.user.id);
    }
  }

  const embed = buildJoinEmbed(session, {
    channelId: connection.joinConfig.channelId,
    created,
    issues,
  });

  if (session.listenMode === 'auto') {
    enableAutoListen(guildId, guild, connection);
  } else {
    disposeAutoListen(guildId);
  }

  await interaction.editReply({
    embeds: [embed],
    components: buildJoinModeButtons(session.listenMode),
  });
}

async function runListenTurn(context: ListenExecutionContext) {
  const { guildId, guild, requestUserId, connection, session, startNotice, finishReply } = context;

  const listenLock = beginGuildListen(guildId, requestUserId);
  if (!listenLock.ok) {
    await finishReply({
      content: 'Another voice turn is already running in this server. Wait for it to finish, then try again.',
    });
    return;
  }

  const releaseListenLock = () => {
    endGuildListen(guildId, requestUserId);
  };
  let tmpDir: string | null = null;
  const listenStartedAt = Date.now();

  try {
    if (startNotice) {
      await startNotice();
    }

    const botMember = await guild.members.fetchMe();
    const receiveMember = await guild.members.fetch(requestUserId).catch(() => null);

    const receiver = connection.receiver;
    tmpDir = createRequestTempDir();
    const requestTmpDir = tmpDir;
    const requestId = path.basename(requestTmpDir);
    const logPrefix = `[listen:${requestId}]`;
    const log = (message: string, details?: Record<string, unknown>) => {
      console.log(logPrefix, message, details ?? {});
    };
    const timing = getListenTimingConfig();

    const opusStream = receiver.subscribe(requestUserId, {
      end: {
        behavior: EndBehaviorType.AfterSilence,
        duration: 1200,
      },
    });

    let decoder: prism.opus.Decoder;
    try {
      decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });
    } catch (error) {
      console.error(logPrefix, 'Opus decoder init failed', error);
      releaseListenLock();
      await finishReply({
        content: 'Opus decoding is unavailable. Install `opusscript` or `@discordjs/opus`, then restart the bot.',
      });
      await removeRequestTempDir(requestTmpDir);
      return;
    }

    const pcmPath = path.join(requestTmpDir, 'input.pcm');
    const wavPath = path.join(requestTmpDir, 'input.wav');
    const transcriptBasePath = path.join(requestTmpDir, 'transcript');
    const ttsPath = path.join(requestTmpDir, `reply.${getTtsOutputExtension()}`);
    const out = fs.createWriteStream(pcmPath);

    let completed = false;
    let receivedOpusPackets = 0;
    let receivedOpusBytes = 0;
    let receivedPcmBytes = 0;
    let speakingStarted = false;
    let ssrcMapped = false;
    let captureFinalized = false;

    const onSpeakingStart = (userId: string) => {
      if (userId !== requestUserId) return;
      speakingStarted = true;
      log('Speaking started', { userId });
    };

    const onSpeakingEnd = (userId: string) => {
      if (userId !== requestUserId) return;
      log('Speaking ended', { userId, opusPackets: receivedOpusPackets, pcmBytes: receivedPcmBytes });
    };

    const onSsrcCreate = (data: { userId: string; audioSSRC: number }) => {
      if (data.userId !== requestUserId) return;
      ssrcMapped = true;
      log('SSRC mapped', { userId: data.userId, audioSSRC: data.audioSSRC });
    };

    receiver.speaking.on('start', onSpeakingStart);
    receiver.speaking.on('end', onSpeakingEnd);
    receiver.ssrcMap.on('create', onSsrcCreate);

    const cleanupListeners = () => {
      receiver.speaking.off('start', onSpeakingStart);
      receiver.speaking.off('end', onSpeakingEnd);
      receiver.ssrcMap.off('create', onSsrcCreate);
    };

    const stopCapture = (reason: string) => {
      if (captureFinalized) return;
      captureFinalized = true;
      log('Stopping capture', {
        reason,
        ...buildListenLogDetails({
          guildId,
          channelId: connection.joinConfig.channelId,
          speakingStarted,
          ssrcMapped,
          opusPackets: receivedOpusPackets,
          opusBytes: receivedOpusBytes,
          pcmBytes: receivedPcmBytes,
          hasOpenClawSessionId: Boolean(session.openClawSessionId),
          sessionKey: session.sessionKey,
        }),
      });
      try {
        opusStream.unpipe(decoder);
      } catch {}
      try {
        decoder.unpipe(out);
      } catch {}
      try {
        opusStream.destroy();
      } catch {}
      try {
        decoder.end();
      } catch {}
      if (!out.destroyed && !out.writableEnded) {
        out.end();
      }
    };

    const finishWithError = async (message: string) => {
      if (completed) return;
      completed = true;
      clearTimeout(noAudioTimer);
      clearTimeout(noSpeechTimer);
      clearTimeout(maxCaptureTimer);
      cleanupListeners();
      releaseListenLock();
      stopCapture('error');
      if (!out.destroyed) {
        out.destroy();
      }
      await finishReply({ content: message });
      await removeRequestTempDir(requestTmpDir);
    };

    const noAudioTimer = setTimeout(async () => {
      if (completed || receivedOpusPackets > 0) return;
      console.warn(logPrefix, 'No audio received before timeout', {
        guildId: guild.id,
        channelId: connection.joinConfig.channelId,
        speakingStarted,
        ssrcMapped,
        sessionKeyPreview: redactSessionKey(session.sessionKey),
      });
      await finishWithError(
        'I did not receive any voice signal from you. Check that Discord voice activity or push-to-talk is actually sending audio, then try again.',
      );
    }, timing.noAudioTimeoutMs);

    const noSpeechTimer = setTimeout(async () => {
      if (completed || speakingStarted) return;
      console.warn(logPrefix, 'No speech detected before timeout', {
        guildId,
        channelId: connection.joinConfig.channelId,
        opusPackets: receivedOpusPackets,
        sessionKeyPreview: redactSessionKey(session.sessionKey),
      });
      await finishWithError(
        'I only received background audio or unclear noise, not clear speech. Try again and speak more directly into the mic.',
      );
    }, timing.noSpeechTimeoutMs);

    const maxCaptureTimer = setTimeout(() => {
      if (completed) return;
      stopCapture('max-capture-timeout');
    }, timing.maxCaptureMs);

    log('Receive pipeline started', {
      ...buildListenLogDetails({
        guildId: guild.id,
        channelId: connection.joinConfig.channelId,
        speakingStarted,
        ssrcMapped,
        hasOpenClawSessionId: Boolean(session.openClawSessionId),
        sessionKey: session.sessionKey,
      }),
      botReadyForReceive: Boolean(botMember.voice?.channelId) && botMember.voice?.selfDeaf === false,
      speakerChannelMatches: receiveMember?.voice?.channelId === connection.joinConfig.channelId,
      timing,
    });

    opusStream.on('data', (chunk) => {
      receivedOpusPackets += 1;
      receivedOpusBytes += chunk.length;
      if (receivedOpusPackets === 1) {
        clearTimeout(noAudioTimer);
        log('First opus packet received', {
          ...buildListenLogDetails({
            guildId,
            channelId: connection.joinConfig.channelId,
            speakingStarted,
            ssrcMapped,
            opusPackets: receivedOpusPackets,
            opusBytes: receivedOpusBytes,
            sessionKey: session.sessionKey,
          }),
          bytes: chunk.length,
        });
      } else if (receivedOpusPackets % 50 === 0) {
        log('Still receiving opus packets', {
          ...buildListenLogDetails({
            guildId,
            channelId: connection.joinConfig.channelId,
            speakingStarted,
            ssrcMapped,
            opusPackets: receivedOpusPackets,
            opusBytes: receivedOpusBytes,
            sessionKey: session.sessionKey,
          }),
        });
      }
    });

    decoder.on('data', (chunk: Buffer) => {
      receivedPcmBytes += chunk.length;
    });

    opusStream.on('end', () => {
      log('Opus stream ended', {
        ...buildListenLogDetails({
          guildId,
          channelId: connection.joinConfig.channelId,
          speakingStarted,
          ssrcMapped,
          opusPackets: receivedOpusPackets,
          opusBytes: receivedOpusBytes,
          pcmBytes: receivedPcmBytes,
          sessionKey: session.sessionKey,
        }),
      });
    });

    opusStream.on('close', () => {
      log('Opus stream closed');
    });

    opusStream.on('error', async (error) => {
      console.error(logPrefix, 'Opus stream error', error);
      await finishWithError('The Discord receive stream failed while listening.');
    });

    decoder.on('error', async (error) => {
      console.error(logPrefix, 'Decoder error', error);
      await finishWithError('The audio decoder failed while processing your speech.');
    });

    out.on('error', async (error) => {
      console.error(logPrefix, 'Write stream error', error);
      if (!receivedOpusPackets) {
        await finishWithError('I could not capture usable audio. Check your mic and Discord voice settings, then try again.');
        return;
      }
      await finishWithError('Saving the captured audio failed.');
    });

    out.on('finish', async () => {
      if (completed) return;

      clearTimeout(maxCaptureTimer);
      clearTimeout(noSpeechTimer);

      log('PCM file complete', {
        ...buildListenLogDetails({
          guildId,
          channelId: connection.joinConfig.channelId,
          speakingStarted,
          ssrcMapped,
          opusPackets: receivedOpusPackets,
          opusBytes: receivedOpusBytes,
          pcmBytes: receivedPcmBytes,
          sessionKey: session.sessionKey,
        }),
        pcmPath,
      });

      if (!receivedOpusPackets || receivedPcmBytes === 0) {
        await finishWithError(
          'I still did not receive decodable speech audio. Check Discord voice activity, your input device, and whether you spoke after `/listen` started.',
        );
        return;
      }

      try {
        await convertPcmToWav(pcmPath, wavPath);
        log('Converted PCM to WAV', { wavPath });

        const transcript = await transcribeWav(wavPath, transcriptBasePath);
        log('Transcription finished', buildListenLogDetails({
          guildId,
          channelId: connection.joinConfig.channelId,
          speakingStarted,
          ssrcMapped,
          transcriptLength: transcript.length,
          hasOpenClawSessionId: Boolean(session.openClawSessionId),
          sessionKey: session.sessionKey,
        }));
        if (!transcript.trim()) {
          throw new Error('Audio arrived, but Whisper could not recognize any speech. Try speaking more clearly or a little louder.');
        }

        let openClawResult;
        if (session.verboseEnabled && session.verboseThreadId) {
          const historyState = { seen: new Set<string>() };
          try {
            await mirrorVerboseHistoryToThread(guild, session.verboseThreadId, session.sessionKey, historyState);
          } catch (error) {
            console.warn(logPrefix, 'Initial verbose history sync failed', {
              error: formatPipelineError(error),
            });
          }

          let stopVerbosePolling = false;
          const verbosePolling = (async () => {
            while (!stopVerbosePolling) {
              await sleep(1200);
              if (stopVerbosePolling) break;
              try {
                await mirrorVerboseHistoryToThread(guild, session.verboseThreadId!, session.sessionKey, historyState);
              } catch (error) {
                console.warn(logPrefix, 'Verbose history poll failed', {
                  error: formatPipelineError(error),
                });
              }
            }
          })();

          try {
            openClawResult = await askOpenClaw(transcript, {
              sessionKey: session.sessionKey,
              sessionId: session.openClawSessionId,
            });
          } finally {
            stopVerbosePolling = true;
            await verbosePolling.catch(() => {});
            await mirrorVerboseHistoryToThread(guild, session.verboseThreadId, session.sessionKey, historyState).catch(() => {});
          }
        } else {
          openClawResult = await askOpenClaw(transcript, {
            sessionKey: session.sessionKey,
            sessionId: session.openClawSessionId,
          });
        }
        log('OpenClaw turn finished', {
          sessionKeyPreview: redactSessionKey(openClawResult.sessionKey),
          hasOpenClawSessionId: Boolean(openClawResult.sessionId),
        });

        await synthesizeSpeech(openClawResult.reply, ttsPath);
        log('TTS synthesis finished', { ttsPath });
        setVoiceSessionBotSpeaking(guildId, true);
        await playAudioFile(connection, ttsPath);
        setVoiceSessionBotSpeaking(guildId, false);
        log('Reply playback finished');
        markVoiceSessionUsed(guildId, {
          initialized: true,
          sessionKey: openClawResult.sessionKey,
          openClawSessionId: openClawResult.sessionId,
        });

        completed = true;
        clearTimeout(noAudioTimer);
        clearTimeout(noSpeechTimer);
        clearTimeout(maxCaptureTimer);
        cleanupListeners();
        releaseListenLock();
        const replyEmbed = new EmbedBuilder()
          .setTitle('Turn complete')
          .setColor(0x57f287)
          .addFields(
            {
              name: 'You said',
              value: fitEmbedFieldValue(transcript),
              inline: false,
            },
            {
              name: 'OpenClaw replied',
              value: fitEmbedFieldValue(openClawResult.reply),
              inline: false,
            },
            {
              name: 'Session key',
              value: summarizeSessionKey(openClawResult.sessionKey),
              inline: false,
            },
            {
              name: 'Session id',
              value: summarizeSessionId(openClawResult.sessionId),
              inline: false,
            },
            {
              name: 'Latency',
              value: formatLatency(Date.now() - listenStartedAt),
              inline: false,
            },
          )
          .setFooter({ text: 'Use /info if you need the full bridge state' });
        await finishReply({ embed: replyEmbed });
      } catch (error) {
        console.error(logPrefix, 'Listen pipeline failed', error);
        completed = true;
        clearTimeout(noAudioTimer);
        clearTimeout(noSpeechTimer);
        clearTimeout(maxCaptureTimer);
        cleanupListeners();
        releaseListenLock();
        setVoiceSessionBotSpeaking(guildId, false);
        await finishReply({ content: `Processing failed: ${formatPipelineError(error)}` });
      } finally {
        await removeRequestTempDir(requestTmpDir);
      }
    });

    opusStream.pipe(decoder).pipe(out);
  } catch (error) {
    releaseListenLock();
    if (tmpDir) {
      await removeRequestTempDir(tmpDir).catch(() => {});
    }
    throw error;
  }
}

export async function handleListen(interaction: ChatInputCommandInteraction) {
  const guildId = interaction.guildId;
  if (!guildId || !interaction.guild) {
    await interaction.editReply({ content: 'This command only works inside a server.' });
    return;
  }

  const session = getVoiceSession(guildId);
  if (!session) {
    if (getActiveGuildJoinUser(guildId)) {
      await interaction.editReply('The OpenClaw voice session is still being prepared. Wait a moment, then run `/listen` again.');
      return;
    }
    await interaction.editReply('No OpenClaw voice session is active yet. Run `/join` first.');
    return;
  }

  if (session.listenMode === 'auto') {
    await interaction.editReply('Auto-listen Beta is active in this server. Just speak while the bot is idle, or switch back to Slash-to-talk in `/join`.');
    return;
  }

  const connection = await getOrCreateConnectionFromMember(interaction);
  if (!connection) return;

  await runListenTurn({
    guildId,
    guild: interaction.guild,
    requestUserId: interaction.user.id,
    connection,
    session,
    startNotice: async () => {
      const listeningEmbed = new EmbedBuilder()
        .setTitle('Listening now')
        .setColor(0x5865f2)
        .setDescription('Speak a short sentence. Capture stops after about 1.2 seconds of silence.')
        .addFields(
          {
            name: 'Voice session',
            value: summarizeSessionKey(session.sessionKey),
            inline: false,
          },
          {
            name: 'Tip',
            value: 'Speak after this message appears and avoid push-to-talk gaps at the start.',
            inline: false,
          },
        );
      await interaction.editReply({ embeds: [listeningEmbed] });
    },
    finishReply: async ({ embed, content }) => {
      if (embed) {
        await interaction.followUp({ embeds: [embed] });
        return;
      }
      if (content) {
        await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      }
    },
  });
}

export async function handleVoiceVerbose(interaction: ChatInputCommandInteraction) {
  if (!interaction.deferred && !interaction.replied) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }

  const guildId = interaction.guildId;
  if (!guildId || !interaction.guild) {
    await interaction.editReply({ content: 'This command only works inside a server.' });
    return;
  }

  const session = getVoiceSession(guildId);
  if (!session) {
    await interaction.editReply({ content: 'No OpenClaw voice session is active yet. Run `/join` first.' });
    return;
  }

  await interaction.editReply({
    embeds: [buildVoiceVerbosePromptEmbed(session)],
    components: buildVoiceVerboseButtons(session.verboseEnabled),
  });
}

async function sendAutoModeMessage(guild: NonNullable<ListenExecutionContext['guild']>, textChannelId: string | null, payload: {
  embed?: EmbedBuilder;
  content?: string;
}) {
  if (!textChannelId) return;

  const channel = guild.channels.cache.get(textChannelId) ?? await guild.channels.fetch(textChannelId).catch(() => null);
  if (!channel?.isTextBased()) return;

  if (payload.embed) {
    await channel.send({ embeds: [payload.embed] });
    return;
  }

  if (payload.content) {
    await channel.send({ content: payload.content });
  }
}

function enableAutoListen(guildId: string, guild: NonNullable<ListenExecutionContext['guild']>, connection: VoiceConnection) {
  disposeAutoListen(guildId);

  const receiver = connection.receiver;
  const controller = { dispose: () => {}, triggerActive: false };

  const onSpeakingStart = (userId: string) => {
    const session = getVoiceSession(guildId);
    if (!session || session.listenMode !== 'auto') return;
    if (userId !== session.createdByUserId) return;
    if (session.botSpeaking || controller.triggerActive || getActiveGuildListenUser(guildId)) return;

    controller.triggerActive = true;
    void runListenTurn({
      guildId,
      guild,
      requestUserId: userId,
      connection,
      session,
      finishReply: async (payload) => {
        const activeSession = getVoiceSession(guildId);
        await sendAutoModeMessage(guild, activeSession?.autoListenTextChannelId ?? null, payload);
      },
    }).finally(() => {
      controller.triggerActive = false;
    });
  };

  receiver.speaking.on('start', onSpeakingStart);

  controller.dispose = () => {
    receiver.speaking.off('start', onSpeakingStart);
  };

  autoListenControllers.set(guildId, controller);
}

export async function handleVoiceVerboseButton(interaction: ButtonInteraction) {
  if (!interaction.customId.startsWith('voice-verbose:')) return;

  await interaction.deferUpdate();

  const guildId = interaction.guildId;
  if (!guildId || !interaction.guild) return;

  const session = getVoiceSession(guildId);
  if (!session) {
    await interaction.editReply({
      content: 'The voice session is no longer active. Run `/join` again first.',
      embeds: [],
      components: [],
    });
    return;
  }

  const enable = interaction.customId === VOICE_VERBOSE_ENABLE;
  if (!enable) {
    const updated = setVoiceSessionVerbose(guildId, false);
    if (!updated) return;

    await interaction.editReply({
      embeds: [buildVoiceVerbosePromptEmbed(updated)],
      components: buildVoiceVerboseButtons(false),
    });
    return;
  }

  const thread = await ensureVerboseThread(interaction.guild, interaction.channel, session);
  const updated = setVoiceSessionVerbose(guildId, true, { threadId: thread.id });
  if (!updated) return;

  await interaction.editReply({
    embeds: [buildVoiceVerbosePromptEmbed(updated)],
    components: buildVoiceVerboseButtons(true),
  });
}

export async function handleJoinModeButton(interaction: ButtonInteraction) {
  if (!interaction.customId.startsWith('voice-mode:')) return;

  await interaction.deferUpdate();

  const guildId = interaction.guildId;
  if (!guildId || !interaction.guild) return;

  const session = getVoiceSession(guildId);
  const connection = getVoiceConnection(guildId);
  if (!session || !connection) {
    await interaction.editReply({
      content: 'The voice session is no longer active. Run `/join` again first.',
      embeds: [],
      components: [],
    });
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!member || member.voice.channelId !== connection.joinConfig.channelId) {
    await interaction.followUp({
      content: 'You need to be in the same voice channel as the bot to change the talk mode.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const nextMode = interaction.customId === VOICE_MODE_AUTO ? 'auto' : 'slash';
  setVoiceSessionListenMode(guildId, nextMode, { textChannelId: interaction.channelId });

  if (nextMode === 'auto') {
    enableAutoListen(guildId, interaction.guild, connection);
  } else {
    disposeAutoListen(guildId);
  }

  const updatedSession = getVoiceSession(guildId);
  if (!updatedSession) return;

  await interaction.editReply({
    embeds: [
      buildJoinEmbed(updatedSession, {
        channelId: connection.joinConfig.channelId,
        created: false,
        issues: summarizeHealthIssues(collectBridgeHealth()),
      }),
    ],
    components: buildJoinModeButtons(updatedSession.listenMode),
  });
}

export async function handleLeave(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) {
    await interaction.editReply({ content: 'This command only works inside a server.' });
    return;
  }

  const connection = getVoiceConnection(interaction.guild.id);
  if (!connection) {
    await interaction.editReply({ content: 'I am not connected to a voice channel right now.' });
    return;
  }

  const activeListenUserId = getActiveGuildListenUser(interaction.guild.id);
  if (activeListenUserId) {
    await interaction.editReply({ content: 'A `/listen` turn is still running in this server. Try again in a moment.' });
    return;
  }

  const member = await interaction.guild.members.fetch(interaction.user.id);
  if (member.voice.channelId !== connection.joinConfig.channelId) {
    await interaction.editReply({ content: 'You need to be in the same voice channel as the bot to use `/leave`.' });
    return;
  }

  const session = getVoiceSession(interaction.guild.id);
  disposeAutoListen(interaction.guild.id);
  connection.destroy();

  if (!session) {
    const embed = new EmbedBuilder()
      .setTitle('Disconnected')
      .setColor(0x5865f2)
      .setDescription('Left the voice channel.');
    await interaction.editReply({ embeds: [embed] });
    return;
  }

  try {
    const deleted = await deleteOpenClawSessionWithRetry(session.sessionKey, {
      attempts: 3,
      timeoutMs: 15_000,
      backoffMs: 1_000,
    });
    clearVoiceSession(interaction.guild.id);
    const embed = new EmbedBuilder()
      .setTitle('Disconnected')
      .setColor(deleted.deleted ? 0x5865f2 : 0xfee75c)
      .setDescription(
        deleted.deleted
          ? 'Left the voice channel and removed the OpenClaw voice session.'
          : 'Left the voice channel. OpenClaw reported no stored session to delete.',
      )
      .addFields({
        name: 'Session key',
        value: summarizeSessionKey(session.sessionKey),
        inline: false,
      });
    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    const embed = new EmbedBuilder()
      .setTitle('Disconnected with cleanup warning')
      .setColor(0xed4245)
      .setDescription(`Left the voice channel, but OpenClaw session cleanup failed: ${formatCleanupError(error)}`)
      .addFields(
        {
          name: 'Session key',
          value: summarizeSessionKey(session.sessionKey),
          inline: false,
        },
        {
          name: 'Retry path',
          value: 'The local session reference was kept. Re-run `/leave` or `/join` to retry cleanup safely.',
          inline: false,
        },
      );
    await interaction.editReply({ embeds: [embed] });
  }
}

export function buildInfoEmbed(guildId: string | null, userId: string): EmbedBuilder {
  const health = collectBridgeHealth();
  const issues = summarizeHealthIssues(health);
  const connection = guildId ? getVoiceConnection(guildId) : null;
  const session = guildId ? getVoiceSession(guildId) : null;
  const joinUserId = guildId ? getActiveGuildJoinUser(guildId) : null;
  const listenUserId = guildId ? getActiveGuildListenUser(guildId) : null;
  const sessionLines = session
    ? [
        `Key: ${summarizeSessionKey(session.sessionKey)}`,
        `Id: ${summarizeSessionId(session.openClawSessionId)}`,
        `Created by: \`${session.createdByUserId}\``,
        `Age: ${formatAge(Date.now() - session.createdAt)}`,
        session.lastUsedAt ? `Last used: ${formatAge(Date.now() - session.lastUsedAt)}` : 'Last used: not yet',
      ]
    : [formatSessionStatus(guildId, userId)];
  const activityLines = [
    joinUserId ? `Join setup by \`${joinUserId}\`` : 'No join in progress',
    listenUserId ? `Listen lock by \`${listenUserId}\`` : 'No active listen lock',
    connection?.joinConfig.channelId ? `Voice channel: <#${connection.joinConfig.channelId}>` : 'Voice channel: not connected',
    session ? `Talk mode: ${session.listenMode === 'auto' ? 'Auto-listen (Beta)' : 'Slash-to-talk'}` : 'Talk mode: not set',
    session
      ? `Verbose: ${session.verboseEnabled ? (session.verboseThreadId ? `<#${session.verboseThreadId}>` : 'active') : 'off'}`
      : 'Verbose: not set',
    session?.botSpeaking ? 'Bot speech: active' : 'Bot speech: idle',
  ];
  const envLines = health.env.map((item) => `${statusLabel(item.ok)} ${item.name}`);
  const binaryLines = health.binaries.map((item) => `${statusLabel(item.ok)} ${item.name}`);

  const embed = new EmbedBuilder()
    .setTitle('Bridge status')
    .setColor(issues.length ? 0xed4245 : 0x57f287)
    .setDescription(
      issues.length
        ? 'Bridge is running with warnings. Check the issue summary below.'
        : 'Bridge is healthy and ready for the next voice turn.',
    )
    .addFields(
      {
        name: 'Overview',
        value: [
          connection ? 'Voice: connected' : 'Voice: not connected',
          session ? 'Session: active' : joinUserId ? 'Session: preparing' : 'Session: idle',
          issues.length ? `Runtime: ${issues.length} warning(s)` : 'Runtime: healthy',
        ].join('\n'),
      },
      {
        name: 'Session',
        value: sessionLines.join('\n').slice(0, 1024),
      },
      {
        name: 'Activity',
        value: activityLines.join('\n'),
      },
      {
        name: 'Env',
        value: envLines.join('\n'),
        inline: true,
      },
      {
        name: 'Binaries',
        value: binaryLines.join('\n'),
        inline: true,
      },
      {
        name: 'Whisper',
        value: `${statusLabel(health.whisperModel.ok)} ${health.whisperModel.detail}`,
        inline: true,
      },
    )
    .setFooter({ text: 'Use /join to prepare a session and /listen to capture one turn.' })
    .setTimestamp();

  if (issues.length) {
    embed.addFields({
      name: 'Issue summary',
      value: issues.map((issue) => `- ${issue}`).join('\n').slice(0, 1024),
    });
  }

  return embed;
}

export async function handleInfo(interaction: ChatInputCommandInteraction) {
  await interaction.editReply({ embeds: [buildInfoEmbed(interaction.guildId, interaction.user.id)] });
}
