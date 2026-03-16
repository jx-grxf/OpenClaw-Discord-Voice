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
import { askOpenClaw } from '../openclaw.js';
import { getOrCreateVoiceSession, getVoiceSession, markVoiceSessionUsed } from '../state.js';
import { getOrCreateConnectionFromMember } from '../voice.js';

function formatPipelineError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim();
  return 'Unknown voice bridge error.';
}

function formatSessionStatus(userId: string): string {
  const session = getVoiceSession(userId);
  if (!session) return 'No voice session has been prepared for you yet.';

  if (!session.initializedAt) {
    return [`Prepared key: \`${session.sessionKey}\``, 'A real OpenClaw session will appear after your first successful `/listen`.'].join(
      '\n',
    );
  }

  const details = [`OpenClaw key: \`${session.sessionKey}\``];
  if (session.openClawSessionId) {
    details.push(`OpenClaw session id: \`${session.openClawSessionId}\``);
  }
  return details.join('\n');
}

export function resolveReceiveUserId(interactionUserId: string, configuredUserId?: string | null): string {
  const configured = configuredUserId?.trim();
  return configured || interactionUserId;
}

export async function handleJoin(interaction: ChatInputCommandInteraction) {
  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({ content: 'This command only works inside a server.', flags: MessageFlags.Ephemeral });
    return;
  }

  const connection = await getOrCreateConnectionFromMember(interaction);
  if (!connection) return;

  const { session, created } = getOrCreateVoiceSession(guildId, interaction.user.id);
  const health = collectBridgeHealth();
  const issues = summarizeHealthIssues(health);

  const embed = new EmbedBuilder()
    .setTitle('Voice bridge ready')
    .setColor(issues.length ? 0xfee75c : 0x57f287)
    .setDescription(
      [
        `Connected to your voice channel. ${created ? 'Prepared' : 'Reusing'} your voice session key.`,
        `OpenClaw key: \`${session.sessionKey}\``,
        session.initializedAt
          ? 'This key already maps to a real OpenClaw session.'
          : 'The real OpenClaw session will be created on your first successful `/listen` turn.',
        'Use `/listen` for one spoken turn.',
      ].join('\n'),
    );

  if (issues.length) {
    embed.addFields({
      name: 'Warnings',
      value: issues.map((issue) => `- ${issue}`).join('\n').slice(0, 1024),
    });
  }

  await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
}

export async function handleListen(interaction: ChatInputCommandInteraction, configuredReceiveUserId?: string | null) {
  const guildId = interaction.guildId;
  if (!guildId || !interaction.guild) {
    await interaction.editReply({ content: 'This command only works inside a server.' });
    return;
  }

  const connection = await getOrCreateConnectionFromMember(interaction);
  if (!connection) return;

  const { session } = getOrCreateVoiceSession(guildId, interaction.user.id);
  const receiveUserId = resolveReceiveUserId(interaction.user.id, configuredReceiveUserId);
  const usingConfiguredReceiveUser = receiveUserId !== interaction.user.id;
  await interaction.editReply(
    `Listening now. Speak a short sentence. I will stop after about 1.2s of silence.\nOpenClaw key: \`${session.sessionKey}\``,
  );

  const botMember = await interaction.guild.members.fetchMe();
  const receiveMember = await interaction.guild.members.fetch(receiveUserId).catch(() => null);

  const receiver = connection.receiver;
  const tmpDir = createRequestTempDir();
  const requestId = path.basename(tmpDir);
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
    await interaction.followUp({
      content: 'Opus decoding is unavailable. Install `opusscript` or `@discordjs/opus`, then restart the bot.',
      flags: MessageFlags.Ephemeral,
    });
    await removeRequestTempDir(tmpDir);
    return;
  }

  const pcmPath = path.join(tmpDir, 'input.pcm');
  const wavPath = path.join(tmpDir, 'input.wav');
  const transcriptBasePath = path.join(tmpDir, 'transcript');
  const ttsPath = path.join(tmpDir, 'reply.aiff');
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
    try {
      opusStream.destroy();
    } catch {}
    if (!out.destroyed) {
      out.destroy();
    }
    await interaction.followUp({ content: message, flags: MessageFlags.Ephemeral });
    await removeRequestTempDir(tmpDir);
  };

  const noAudioTimer = setTimeout(async () => {
    if (completed || receivedOpusPackets > 0) return;
    console.warn(logPrefix, 'No audio received before timeout', {
      guildId: interaction.guild?.id,
      interactionUserId: interaction.user.id,
      receiveUserId,
      configuredReceiveUserId: configuredReceiveUserId ?? null,
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
    configuredReceiveUserId: configuredReceiveUserId ?? null,
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

  if (usingConfiguredReceiveUser) {
    log('Using configured Discord receive target override', {
      interactionUserId: interaction.user.id,
      receiveUserId,
    });
  }

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

      const openClawResult = await askOpenClaw(transcript, session.sessionKey);
      markVoiceSessionUsed(interaction.user.id, {
        initialized: true,
        sessionKey: openClawResult.sessionKey,
        openClawSessionId: openClawResult.sessionId,
      });
      log('OpenClaw turn finished', {
        sessionKey: openClawResult.sessionKey,
        sessionId: openClawResult.sessionId,
      });

      await synthesizeWithSay(openClawResult.reply, ttsPath);
      log('TTS synthesis finished', { ttsPath });
      await playAudioFile(connection, ttsPath);
      log('Reply playback finished');

      completed = true;
      clearTimeout(noAudioTimer);
      cleanupListeners();
      await interaction.followUp(
        [
          `You said: **${transcript}**`,
          `OpenClaw replied: **${openClawResult.reply}**`,
          `OpenClaw key: \`${openClawResult.sessionKey}\``,
          openClawResult.sessionId ? `OpenClaw session id: \`${openClawResult.sessionId}\`` : null,
        ]
          .filter(Boolean)
          .join('\n'),
      );
    } catch (error) {
      console.error(logPrefix, 'Listen pipeline failed', error);
      completed = true;
      clearTimeout(noAudioTimer);
      cleanupListeners();
      await interaction.followUp({
        content: `Processing failed: ${formatPipelineError(error)}`,
        flags: MessageFlags.Ephemeral,
      });
    } finally {
      await removeRequestTempDir(tmpDir);
    }
  });

  opusStream.pipe(decoder).pipe(out);
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

  connection.destroy();
  await interaction.editReply('Left the voice channel.');
}

export async function handleInfo(interaction: ChatInputCommandInteraction) {
  const health = collectBridgeHealth();
  const issues = summarizeHealthIssues(health);
  const connection = interaction.guild ? getVoiceConnection(interaction.guild.id) : null;

  const embed = new EmbedBuilder()
    .setTitle('Bridge status')
    .setColor(issues.length ? 0xed4245 : 0x57f287)
    .addFields(
      {
        name: 'Voice',
        value: connection ? `Connected to guild ${connection.joinConfig.guildId}` : 'Not connected',
      },
      {
        name: 'Session',
        value: formatSessionStatus(interaction.user.id),
      },
      {
        name: 'Env',
        value: health.env.map((item) => `${item.ok ? 'OK' : 'MISSING'} ${item.name}`).join('\n'),
      },
      {
        name: 'Binaries',
        value: health.binaries.map((item) => `${item.ok ? 'OK' : 'MISSING'} ${item.name}`).join('\n'),
      },
      {
        name: 'Whisper',
        value: `${health.whisperModel.ok ? 'OK' : 'MISSING'} ${health.whisperModel.detail}`,
      },
    );

  if (issues.length) {
    embed.addFields({
      name: 'Issues',
      value: issues.map((issue) => `- ${issue}`).join('\n').slice(0, 1024),
    });
  }

  await interaction.editReply({ embeds: [embed] });
}
