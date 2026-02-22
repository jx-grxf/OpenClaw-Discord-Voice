import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonInteraction,
  ButtonStyle,
  ChatInputCommandInteraction,
  Client,
  EmbedBuilder,
  GatewayIntentBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuInteraction,
} from 'discord.js';
import prism from 'prism-media';
import {
  AudioPlayerStatus,
  EndBehaviorType,
  NoSubscriberBehavior,
  VoiceConnection,
  VoiceConnectionStatus,
  createAudioPlayer,
  createAudioResource,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} from '@discordjs/voice';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing env var: ${name}`);
    process.exit(1);
  }
  return value;
}

const DISCORD_TOKEN = requireEnv('DISCORD_TOKEN');
const DISCORD_CLIENT_ID = requireEnv('DISCORD_CLIENT_ID');
const DISCORD_GUILD_ID = requireEnv('DISCORD_GUILD_ID');
const DISCORD_USER_ID = requireEnv('DISCORD_USER_ID');

const activeSessionByUser = new Map<string, string>();
const activeModeByUser = new Map<string, 'talk' | 'action'>();
const sessionChoiceMapByUser = new Map<string, Map<string, string>>();

const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Check if bot is alive'),
  new SlashCommandBuilder().setName('join').setDescription('Join VC + choose OpenClaw session'),
  new SlashCommandBuilder().setName('leave').setDescription('Leave current voice channel'),
  new SlashCommandBuilder().setName('listen').setDescription('Listen, transcribe, and reply in voice'),
].map((c) => c.toJSON());

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID), {
    body: commands,
  });
  console.log('✅ Slash commands registered');
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

client.once('clientReady', async () => {
  console.log(`✅ Logged in as ${client.user?.tag}`);
  await registerCommands();
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'ping') {
        await interaction.reply('pong 🏓');
        return;
      }

      if (interaction.commandName === 'join') {
        await handleJoinChoice(interaction);
        return;
      }

      await interaction.deferReply();

      if (interaction.commandName === 'leave') {
        await handleLeave(interaction);
        return;
      }

      if (interaction.commandName === 'listen') {
        await handleListen(interaction);
        return;
      }
    }

    if (interaction.isButton()) {
      if (interaction.customId.startsWith('join_')) {
        await handleJoinButtons(interaction);
        return;
      }
      if (interaction.customId.startsWith('mode_')) {
        await handleModeButtons(interaction);
        return;
      }
    }

    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('join_pick_session:')) {
      await handleSessionPick(interaction);
      return;
    }
  } catch (err) {
    console.error('Command error:', err);
    if (!interaction.isRepliable()) return;
    const msg = `❌ Error: ${err instanceof Error ? err.message : 'unknown error'}`;
    try {
      if (interaction.deferred) {
        await interaction.editReply({ content: msg });
      } else if (interaction.replied) {
        await interaction.followUp({ content: msg, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content: msg, flags: MessageFlags.Ephemeral });
      }
    } catch (replyErr) {
      console.error('Failed to send error response:', replyErr);
    }
  }
});

async function handleJoinChoice(interaction: ChatInputCommandInteraction) {
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

async function handleJoinButtons(interaction: ButtonInteraction) {
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

async function handleSessionPick(interaction: StringSelectMenuInteraction) {
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

async function handleModeButtons(interaction: ButtonInteraction) {
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

async function showModePicker(
  interaction: ButtonInteraction | StringSelectMenuInteraction,
  sessionId: string,
  useUpdate = false,
) {
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

  if (useUpdate) {
    await interaction.editReply({ embeds: [embed], components: [row] });
  } else {
    await interaction.reply({ embeds: [embed], components: [row], flags: MessageFlags.Ephemeral });
  }
}

async function getOrCreateConnectionFromMember(interaction: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction): Promise<VoiceConnection | null> {
  const guild = interaction.guild;
  if (!guild) {
    if ('deferred' in interaction && interaction.deferred) {
      await interaction.editReply({ content: 'Nur im Server nutzbar.' });
    } else if (interaction.isRepliable()) {
      await interaction.reply({ content: 'Nur im Server nutzbar.', flags: MessageFlags.Ephemeral });
    }
    return null;
  }

  const member = await guild.members.fetch(interaction.user.id);
  const channel = member.voice.channel;
  if (!channel) {
    if ('deferred' in interaction && interaction.deferred) {
      await interaction.editReply({ content: 'Bitte geh zuerst in einen Voice Channel.', embeds: [], components: [] });
    } else {
      await interaction.reply({ content: 'Bitte geh zuerst in einen Voice Channel.', flags: MessageFlags.Ephemeral });
    }
    return null;
  }

  let connection = getVoiceConnection(guild.id);
  if (!connection) {
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
  }

  await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  return connection;
}

async function handleListen(interaction: ChatInputCommandInteraction) {
  if (!interaction.guild) {
    await interaction.editReply({ content: 'Nur im Server nutzbar.' });
    return;
  }

  const connection = await getOrCreateConnectionFromMember(interaction);
  if (!connection) return;

  await interaction.editReply('🎙️ Sage jetzt einen kurzen Satz… (stoppt nach ~1.2s Stille)');

  const receiver = connection.receiver;
  const opusStream = receiver.subscribe(DISCORD_USER_ID, {
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

async function handleLeave(interaction: ChatInputCommandInteraction) {
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

async function convertPcmToWav(pcmPath: string, wavPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ffmpeg = spawn('ffmpeg', ['-f', 's16le', '-ar', '48000', '-ac', '2', '-i', pcmPath, wavPath, '-y']);
    ffmpeg.on('error', reject);
    ffmpeg.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited with code ${code}`))));
  });
}

async function transcribeWav(wavPath: string): Promise<string> {
  const modelPath = path.resolve(process.cwd(), 'models', 'ggml-base.bin');
  if (!fs.existsSync(modelPath)) throw new Error(`Whisper model missing: ${modelPath}`);

  return await new Promise<string>((resolve, reject) => {
    const proc = spawn('whisper-cli', ['-m', modelPath, '-f', wavPath, '-l', 'de', '-otxt', '-of', 'tmp/transcript'], {
      cwd: process.cwd(),
    });

    let stderr = '';
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`whisper-cli exited with code ${code}: ${stderr}`));
      const txtPath = path.resolve(process.cwd(), 'tmp', 'transcript.txt');
      if (!fs.existsSync(txtPath)) return resolve('');
      resolve(fs.readFileSync(txtPath, 'utf8').trim());
    });
  });
}

async function askOpenClaw(transcript: string, sessionId: string, mode: 'talk' | 'action'): Promise<string> {
  const t = transcript.trim();
  if (!t) return 'Ich habe leider nichts verstanden. Versuch es bitte nochmal.';

  const prompt = [
    'Du bist Claw im Voice-Bridge-Modus.',
    `Aktueller Modus: ${mode === 'action' ? 'ACTION' : 'TALK'}.`,
    mode === 'action'
      ? 'ACTION-Regel: Behandle die nächste Nutzeräußerung als echten Auftrag. Nutze verfügbare Tools, um die Aktion wirklich auszuführen. Behaupte NIEMALS Erfolg ohne Ausführung. Wenn etwas fehlschlägt, sag klar was fehlgeschlagen ist.'
      : 'TALK-Regel: Nur normal antworten, keine Tools ausführen.',
    'Antwortstil: Deutsch, natürlich, kurz (max. 2 Sätze), keine Markdown-Formatierung.',
    '',
    `Nutzeräußerung: ${t}`,
  ].join('\n');

  const raw = await new Promise<string>((resolve, reject) => {
    const proc = spawn('openclaw', [
      'agent',
      '--session-id',
      sessionId,
      '--thinking',
      'off',
      '--message',
      prompt,
      '--json',
    ]);

    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`openclaw agent exited with code ${code}: ${stderr}`));
      resolve(stdout);
    });
  });

  try {
    const data = JSON.parse(raw) as {
      result?: { payloads?: Array<{ text?: string | null }>; meta?: { summaryText?: string } };
      summary?: string;
    };

    const text = data?.result?.payloads?.find((p) => (p.text ?? '').trim().length > 0)?.text?.trim();
    if (text) return text;

    const fallback = data?.result?.meta?.summaryText || data?.summary;
    if (fallback?.trim()) return fallback.trim();
    return 'Ich habe gerade keine gute Antwort bekommen. Versuch es bitte nochmal.';
  } catch {
    return 'Antwort konnte nicht geparst werden. Versuch es bitte nochmal.';
  }
}

async function synthesizeWithSay(text: string, outPath: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('say', ['-v', 'Anna', '-o', outPath, text]);
    proc.on('error', reject);
    proc.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`say exited with code ${code}`))));
  });
}

async function playAudioFile(connection: VoiceConnection, filePath: string): Promise<void> {
  const player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
  const resource = createAudioResource(filePath);
  connection.subscribe(player);

  await new Promise<void>((resolve, reject) => {
    player.once('error', reject);
    player.once(AudioPlayerStatus.Idle, () => resolve());
    player.play(resource);
  });
}

async function listOpenClawSessions(): Promise<Array<{ sessionId: string; key: string; kind: string; ageMs: number }>> {
  const raw = await new Promise<string>((resolve, reject) => {
    const proc = spawn('openclaw', ['sessions', '--json']);
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (d) => (stdout += d.toString()));
    proc.stderr.on('data', (d) => (stderr += d.toString()));
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`openclaw sessions failed (${code}): ${stderr}`));
      resolve(stdout);
    });
  });

  const parsed = JSON.parse(raw) as {
    sessions?: Array<{ sessionId?: string; key?: string; kind?: string; ageMs?: number }>;
  };

  return (parsed.sessions ?? [])
    .filter((s) => !!s.sessionId && !!s.key)
    .map((s) => ({ sessionId: s.sessionId!, key: s.key!, kind: s.kind ?? 'unknown', ageMs: s.ageMs ?? 0 }))
    .sort((a, b) => a.ageMs - b.ageMs);
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function formatAge(ageMs: number): string {
  const min = Math.floor(ageMs / 60000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min}m`;
  const h = Math.floor(min / 60);
  if (h < 24) return `vor ${h}h`;
  const d = Math.floor(h / 24);
  return `vor ${d}d`;
}

client.login(DISCORD_TOKEN);
