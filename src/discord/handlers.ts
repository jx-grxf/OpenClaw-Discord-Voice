import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import prism from 'prism-media';
import { EndBehaviorType, getVoiceConnection } from '@discordjs/voice';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  EmbedBuilder,
  MessageFlags,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
} from 'discord.js';
import { askOpenClaw, listOpenClawSessions } from '../openclaw';
import { convertPcmToWav, playAudioFile, synthesizeWithSay, transcribeWav } from '../audio';
import { getOrCreateConnectionFromMember } from '../voice';
import { activeModeByUser, activeSessionByUser, sessionChoiceMapByUser } from '../state';
import { formatAge, truncate } from '../utils';

export async function handleJoinChoice(interaction: ChatInputCommandInteraction) {
  const embed = new EmbedBuilder()
    .setTitle('🎧 Voice Session wählen')
    .setDescription('Willst du eine **neue OpenClaw Session** starten oder eine **bestehende** fortsetzen?')
    .setColor(0x5865f2);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`join_new:${interaction.user.id}`)
      .setLabel('🆕 New Session')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`join_existing:${interaction.user.id}`)
      .setLabel('📂 Bestehende Session')
      .setStyle(ButtonStyle.Primary),
  );

  await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
}

export async function handleJoinButtons(interaction: ButtonInteraction) {
  if (!interaction.customId.startsWith('join_')) return;

  const parts = interaction.customId.split(':');
  const action = parts[0];
  const ownerId = parts[1];
  const mode = action.replace('join_', '');

  if (ownerId !== interaction.user.id) {
    await interaction.reply({ content: 'Diese Auswahl gehört nicht dir.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (mode === 'new') {
    const sessionId = randomUUID();
    activeSessionByUser.set(interaction.user.id, sessionId);

    const connection = await getOrCreateConnectionFromMember(interaction);
    if (!connection) return;

    const embed = new EmbedBuilder()
      .setTitle('🛠️ Modus wählen')
      .setDescription('Soll ich nur reden oder auch Aktionen auf deinem Mac ausführen dürfen?')
      .setColor(0x5865f2);

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`mode_talk:${interaction.user.id}:${sessionId}`)
        .setLabel('💬 Talk Mode')
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(`mode_action:${interaction.user.id}:${sessionId}`)
        .setLabel('⚡ Action Mode')
        .setStyle(ButtonStyle.Danger),
    );

    await interaction.update({ embeds: [embed], components: [row] });
    return;
  }

  if (mode === 'existing') {
    await interaction.update({
      embeds: [new EmbedBuilder().setTitle('⏳ Lade Sessions…').setColor(0x5865f2)],
      components: [],
    });

    const sessions = await listOpenClawSessions();
    if (!sessions.length) {
      await interaction.editReply({ content: 'Keine Sessions gefunden.', embeds: [], components: [] });
      return;
    }

    const uniqueBySession = new Map<string, { sessionId: string; key: string; kind: string; ageMs: number }>();
    for (const s of sessions) {
      const existing = uniqueBySession.get(s.sessionId);
      if (!existing || s.ageMs < existing.ageMs) uniqueBySession.set(s.sessionId, s);
    }

    const picked = Array.from(uniqueBySession.values()).slice(0, 25);
    const choiceMap = new Map<string, string>();
    const options = picked.map((s, i) => {
      const value = `s${i}`;
      choiceMap.set(value, s.sessionId);
      return {
        label: truncate(s.sessionId, 100),
        description: `${s.kind} • ${formatAge(s.ageMs)} • ${truncate(s.key, 50)}`.slice(0, 100),
        value,
      };
    });
    sessionChoiceMapByUser.set(interaction.user.id, choiceMap);

    const select = new StringSelectMenuBuilder()
      .setCustomId(`join_pick_session:${interaction.user.id}`)
      .setPlaceholder('Session auswählen…')
      .addOptions(options);

    const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
    const embed = new EmbedBuilder()
      .setTitle('📂 Bestehende Session auswählen')
      .setDescription('Wähle eine Session aus der Liste, dann join ich den Voice Channel.')
      .setColor(0x5865f2);

    await interaction.editReply({ embeds: [embed], components: [row] });
  }
}

export async function handleSessionPick(interaction: StringSelectMenuInteraction) {
  const [, ownerId] = interaction.customId.split(':');
  if (ownerId !== interaction.user.id) {
    await interaction.reply({ content: 'Diese Auswahl gehört nicht dir.', flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.update({
    embeds: [new EmbedBuilder().setTitle('⏳ Verbinde Session…').setColor(0x5865f2)],
    components: [],
  });

  const selectedValue = interaction.values[0];
  const choiceMap = sessionChoiceMapByUser.get(interaction.user.id);
  const pickedSessionId = choiceMap?.get(selectedValue);
  if (!pickedSessionId) {
    await interaction.editReply({ content: 'Session-Auswahl abgelaufen. Bitte /join neu starten.', embeds: [], components: [] });
    return;
  }

  activeSessionByUser.set(interaction.user.id, pickedSessionId);
  sessionChoiceMapByUser.delete(interaction.user.id);

  const connection = await getOrCreateConnectionFromMember(interaction);
  if (!connection) return;

  const embed = new EmbedBuilder()
    .setTitle('🛠️ Modus wählen')
    .setDescription('Soll ich nur reden oder auch Aktionen auf deinem Mac ausführen dürfen?')
    .setColor(0x5865f2);

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`mode_talk:${interaction.user.id}:${pickedSessionId}`)
      .setLabel('💬 Talk Mode')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`mode_action:${interaction.user.id}:${pickedSessionId}`)
      .setLabel('⚡ Action Mode')
      .setStyle(ButtonStyle.Danger),
  );

  await interaction.editReply({ embeds: [embed], components: [row] });
}

export async function handleModeButtons(interaction: ButtonInteraction) {
  const [action, ownerId, sessionId] = interaction.customId.split(':');
  const mode = action.replace('mode_', '');

  if (!sessionId) {
    await interaction.reply({ content: 'Session fehlt in der Auswahl.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (ownerId !== interaction.user.id) {
    await interaction.reply({ content: 'Diese Auswahl gehört nicht dir.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (mode !== 'talk' && mode !== 'action') {
    await interaction.reply({ content: 'Unbekannter Modus.', flags: MessageFlags.Ephemeral });
    return;
  }

  activeSessionByUser.set(interaction.user.id, sessionId);
  activeModeByUser.set(interaction.user.id, mode);

  const embed = new EmbedBuilder()
    .setTitle('✅ Voice bereit')
    .setDescription(
      `Session-ID: \`${sessionId}\`\nModus: **${mode === 'action' ? 'Action (darf Tools nutzen)' : 'Talk (nur reden)'}**\n\nNutze jetzt \`/listen\`.`,
    )
    .setColor(0x57f287);

  await interaction.update({ embeds: [embed], components: [] });
}

export async function handleListen(interaction: ChatInputCommandInteraction, discordUserId: string) {
  if (!interaction.guild) {
    await interaction.editReply({ content: 'Nur im Server nutzbar.' });
    return;
  }

  const connection = await getOrCreateConnectionFromMember(interaction);
  if (!connection) return;

  await interaction.editReply('🎙️ Sage jetzt einen kurzen Satz… (stoppt nach ~1.2s Stille)');

  const receiver = connection.receiver;
  const opusStream = receiver.subscribe(discordUserId, {
    end: {
      behavior: EndBehaviorType.AfterSilence,
      duration: 1200,
    },
  });

  let decoder: prism.opus.Decoder;
  try {
    decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });
  } catch (err) {
    console.error('Opus decoder init failed:', err);
    await interaction.followUp({
      content: '❌ Opus decoder fehlt. Installiere `opusscript` (oder `@discordjs/opus`) und starte neu.',
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const tmpDir = path.resolve(process.cwd(), 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true });
  const pcmPath = path.join(tmpDir, 'input.pcm');
  const wavPath = path.join(tmpDir, 'input.wav');
  const ttsPath = path.join(tmpDir, 'reply.aiff');

  const out = fs.createWriteStream(pcmPath);
  opusStream.pipe(decoder).pipe(out);

  opusStream.on('error', async (err) => {
    console.error('Opus stream error:', err);
    await interaction.followUp({ content: '❌ Fehler beim Audio-Stream.', flags: MessageFlags.Ephemeral });
  });

  out.on('finish', async () => {
    try {
      await convertPcmToWav(pcmPath, wavPath);
      const transcript = await transcribeWav(wavPath);
      let sessionId = activeSessionByUser.get(interaction.user.id);
      if (!sessionId) {
        sessionId = randomUUID();
        activeSessionByUser.set(interaction.user.id, sessionId);
      }
      const mode = activeModeByUser.get(interaction.user.id) ?? 'talk';
      const replyText = await askOpenClaw(transcript, sessionId, mode);

      await synthesizeWithSay(replyText, ttsPath);
      await playAudioFile(connection, ttsPath);

      await interaction.followUp(`📝 Du hast gesagt: **${transcript || '(nichts erkannt)'}**\n🤖 Antwort: **${replyText}**`);
    } catch (err) {
      console.error('Listen pipeline failed:', err);
      await interaction.followUp({
        content: '⚠️ Aufnahme ok, aber Verarbeitung fehlgeschlagen. Check Logs.',
        flags: MessageFlags.Ephemeral,
      });
    }
  });

  out.on('error', async (err) => {
    console.error('Write stream error:', err);
    await interaction.followUp({ content: '❌ Fehler beim Speichern der Aufnahme.', flags: MessageFlags.Ephemeral });
  });
}

export async function handleLeave(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) {
    await interaction.editReply({ content: 'Nur im Server nutzbar.' });
    return;
  }

  const connection = getVoiceConnection(interaction.guild.id);
  if (!connection) {
    await interaction.editReply({ content: 'Ich bin aktuell in keinem Voice Channel.' });
    return;
  }

  connection.destroy();
  await interaction.editReply('👋 Voice Channel verlassen');
}

export async function handleInfo(interaction: ChatInputCommandInteraction) {
  await interaction.editReply('This is a temporary test');
}

