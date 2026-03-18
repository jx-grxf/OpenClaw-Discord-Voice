import fs from 'node:fs';
import path from 'node:path';
import prism from 'prism-media';
import { EndBehaviorType, getVoiceConnection } from '@discordjs/voice';
import { ChatInputCommandInteraction, EmbedBuilder, MessageFlags } from 'discord.js';
import {
  convertPcmToWav,
  createRequestTempDir,
  playAudioFile,
  removeRequestTempDir,
  synthesizeWithSay,
  transcribeWav,
} from '../audio.js';
import { collectBridgeHealth, summarizeHealthIssues } from '../diagnostics.js';
import { askOpenClaw, createOpenClawSession, deleteOpenClawSession } from '../openclaw.js';
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
} from '../state.js';
import { formatAge, truncate } from '../utils.js';
import { getOrCreateConnectionFromMember } from '../voice.js';

function formatPipelineError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return 'Unknown voice bridge error.';
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
  if (!guildId) {
    await interaction.reply({ content: 'This command only works inside a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const connection = await getOrCreateConnectionFromMember(interaction);
  if (!connection) return;

  const health = collectBridgeHealth();
  const issues = summarizeHealthIssues(health);
  let session = getVoiceSession(guildId);
  let created = false;

  if (!session) {
    const joinLock = beginGuildJoin(guildId, interaction.user.id);
    if (!joinLock.ok) {
      await interaction.editReply({
        content: 'A voice session is already being prepared in this server. Wait a moment, then try again.',
      });
      return;
    }

    const channelId = connection.joinConfig.channelId;
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

  const embed = new EmbedBuilder()
    .setTitle('Voice bridge ready')
    .setColor(issues.length ? 0xfee75c : 0x57f287)
    .setDescription(`Connected to your voice channel. ${created ? 'Created' : 'Reusing'} the active OpenClaw voice session.`)
    .addFields(
      {
        name: 'Voice',
        value: connection.joinConfig.channelId ? `<#${connection.joinConfig.channelId}>` : 'Connected',
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
        value: 'Run `/listen` for one spoken turn or `/info` for full diagnostics.',
        inline: false,
      },
    )
    .setFooter({ text: created ? 'Fresh OpenClaw session prepared' : 'Existing OpenClaw session reused' });

  if (issues.length) {
    embed.addFields({
      name: 'Warnings',
      value: issues.map((issue) => `- ${issue}`).join('\n').slice(0, 1024),
    });
  }

  await interaction.editReply({ embeds: [embed] });
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

  const connection = await getOrCreateConnectionFromMember(interaction);
  if (!connection) return;

  const listenLock = beginGuildListen(guildId, interaction.user.id);
  if (!listenLock.ok) {
    await interaction.editReply(
      'Another `/listen` request is already running in this server. Wait for it to finish, then try again.',
    );
    return;
  }

  const releaseListenLock = () => {
    endGuildListen(guildId, interaction.user.id);
  };
  const receiveUserId = interaction.user.id;
  let tmpDir: string | null = null;

  try {
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

    const botMember = await interaction.guild.members.fetchMe();
    const receiveMember = await interaction.guild.members.fetch(receiveUserId).catch(() => null);

    const receiver = connection.receiver;
    tmpDir = createRequestTempDir();
    const requestTmpDir = tmpDir;
    const requestId = path.basename(requestTmpDir);
    const logPrefix = `[listen:${requestId}]`;
    const log = (message: string, details?: Record<string, unknown>) => {
      console.log(logPrefix, message, details ?? {});
    };

    const opusStream = receiver.subscribe(receiveUserId, {
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
      await interaction.followUp({
        content: 'Opus decoding is unavailable. Install `opusscript` or `@discordjs/opus`, then restart the bot.',
        flags: MessageFlags.Ephemeral,
      });
      await removeRequestTempDir(requestTmpDir);
      return;
    }

    const pcmPath = path.join(requestTmpDir, 'input.pcm');
    const wavPath = path.join(requestTmpDir, 'input.wav');
    const transcriptBasePath = path.join(requestTmpDir, 'transcript');
    const ttsPath = path.join(requestTmpDir, 'reply.aiff');
    const out = fs.createWriteStream(pcmPath);

    let completed = false;
    let receivedOpusPackets = 0;
    let receivedOpusBytes = 0;
    let receivedPcmBytes = 0;
    let speakingStarted = false;
    let ssrcMapped = false;

    const onSpeakingStart = (userId: string) => {
      if (userId !== receiveUserId) return;
      speakingStarted = true;
      log('Speaking started', { userId });
    };

    const onSpeakingEnd = (userId: string) => {
      if (userId !== receiveUserId) return;
      log('Speaking ended', { userId, opusPackets: receivedOpusPackets, pcmBytes: receivedPcmBytes });
    };

    const onSsrcCreate = (data: { userId: string; audioSSRC: number }) => {
      if (data.userId !== receiveUserId) return;
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

    const finishWithError = async (message: string) => {
      if (completed) return;
      completed = true;
      clearTimeout(noAudioTimer);
      cleanupListeners();
      releaseListenLock();
      try {
        opusStream.destroy();
      } catch {}
      if (!out.destroyed) {
        out.destroy();
      }
      await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
      await removeRequestTempDir(requestTmpDir);
    };

    const noAudioTimer = setTimeout(async () => {
      if (completed || receivedOpusPackets > 0) return;
      console.warn(logPrefix, 'No audio received before timeout', {
        guildId: interaction.guild?.id,
        interactionUserId: interaction.user.id,
        receiveUserId,
        speakingStarted,
        ssrcMapped,
      });
      await finishWithError(
        'I did not receive any voice signal from you. Check that Discord voice activity or push-to-talk is actually sending audio, then try `/listen` again.',
      );
    }, 12_000);

    log('Receive pipeline started', {
      guildId: interaction.guild.id,
      channelId: connection.joinConfig.channelId,
      interactionUserId: interaction.user.id,
      receiveUserId,
      sessionKey: session.sessionKey,
      botVoiceState: botMember.voice ? {
        channelId: botMember.voice.channelId,
        selfMute: botMember.voice.selfMute,
        selfDeaf: botMember.voice.selfDeaf,
        serverMute: botMember.voice.serverMute,
        serverDeaf: botMember.voice.serverDeaf,
        suppress: botMember.voice.suppress,
      } : null,
      receiveMemberVoiceState: receiveMember?.voice ? {
        channelId: receiveMember.voice.channelId,
        selfMute: receiveMember.voice.selfMute,
        selfDeaf: receiveMember.voice.selfDeaf,
        serverMute: receiveMember.voice.serverMute,
        serverDeaf: receiveMember.voice.serverDeaf,
        suppress: receiveMember.voice.suppress,
      } : null,
    });

    opusStream.on('data', (chunk) => {
      receivedOpusPackets += 1;
      receivedOpusBytes += chunk.length;
      if (receivedOpusPackets === 1) {
        clearTimeout(noAudioTimer);
        log('First opus packet received', {
          bytes: chunk.length,
          speakingStarted,
          ssrcMapped,
        });
      } else if (receivedOpusPackets % 50 === 0) {
        log('Still receiving opus packets', {
          opusPackets: receivedOpusPackets,
          opusBytes: receivedOpusBytes,
        });
      }
    });

    decoder.on('data', (chunk: Buffer) => {
      receivedPcmBytes += chunk.length;
    });

    opusStream.on('end', () => {
      log('Opus stream ended', {
        opusPackets: receivedOpusPackets,
        opusBytes: receivedOpusBytes,
        pcmBytes: receivedPcmBytes,
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

      log('PCM file complete', {
        opusPackets: receivedOpusPackets,
        opusBytes: receivedOpusBytes,
        pcmBytes: receivedPcmBytes,
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
        log('Transcription finished', { transcriptLength: transcript.length });
        if (!transcript.trim()) {
          throw new Error('Audio arrived, but Whisper could not recognize any speech. Try speaking more clearly or a little louder.');
        }

        const openClawResult = await askOpenClaw(transcript, {
          sessionKey: session.sessionKey,
          sessionId: session.openClawSessionId,
        });
        log('OpenClaw turn finished', {
          sessionKey: openClawResult.sessionKey,
          sessionId: openClawResult.sessionId,
        });

        await synthesizeWithSay(openClawResult.reply, ttsPath);
        log('TTS synthesis finished', { ttsPath });
        await playAudioFile(connection, ttsPath);
        log('Reply playback finished');
        markVoiceSessionUsed(guildId, {
          initialized: true,
          sessionKey: openClawResult.sessionKey,
          openClawSessionId: openClawResult.sessionId,
        });

        completed = true;
        clearTimeout(noAudioTimer);
        cleanupListeners();
        releaseListenLock();
        const replyEmbed = new EmbedBuilder()
          .setTitle('Turn complete')
          .setColor(0x57f287)
          .addFields(
            {
              name: 'You said',
              value: transcript,
              inline: false,
            },
            {
              name: 'OpenClaw replied',
              value: openClawResult.reply,
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
          )
          .setFooter({ text: 'Use /info if you need the full bridge state' });
        await interaction.followUp({ embeds: [replyEmbed] });
      } catch (error) {
        console.error(logPrefix, 'Listen pipeline failed', error);
        completed = true;
        clearTimeout(noAudioTimer);
        cleanupListeners();
        releaseListenLock();
        await interaction.followUp({
          content: `Processing failed: ${formatPipelineError(error)}`,
          flags: MessageFlags.Ephemeral,
        });
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

  const session = clearVoiceSession(interaction.guild.id);
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
    const deleted = await deleteOpenClawSession(session.sessionKey);
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
      .setDescription(`Left the voice channel, but OpenClaw session cleanup failed: ${formatPipelineError(error)}`)
      .addFields({
        name: 'Session key',
        value: summarizeSessionKey(session.sessionKey),
        inline: false,
      });
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
