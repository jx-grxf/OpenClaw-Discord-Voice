import dotenv from 'dotenv';
import { getVoiceConnections } from '@discordjs/voice';
import { Client, GatewayIntentBits, MessageFlags, REST, Routes, SlashCommandBuilder } from 'discord.js';
import { assertStartupReadiness } from './diagnostics.js';
import { handleInfo, handleJoin, handleLeave, handleListen } from './discord/handlers.js';
import { handleHelpButton, handleHelpCommand } from './discord/help.js';
import { clearAllVoiceState } from './state.js';

dotenv.config({ override: true });

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing env var: ${name}`);
    process.exit(1);
  }
  return value;
}

const DISCORD_TOKEN = requireEnv('DISCORD_TOKEN');
const DISCORD_GUILD_ID = requireEnv('DISCORD_GUILD_ID');
assertStartupReadiness(process.env);

const commands = [
  new SlashCommandBuilder().setName('ping').setDescription('Check if bot is alive'),
  new SlashCommandBuilder().setName('join').setDescription('Join your voice channel and prepare the bridge'),
  new SlashCommandBuilder().setName('leave').setDescription('Leave current voice channel'),
  new SlashCommandBuilder().setName('listen').setDescription('Listen, transcribe, and reply in voice'),
  new SlashCommandBuilder().setName('info').setDescription('Show bridge status and dependency health'),
  new SlashCommandBuilder().setName('help').setDescription('Open the interactive help menu'),
].map((c) => c.toJSON());

async function registerCommands(applicationId: string) {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(applicationId, DISCORD_GUILD_ID), {
    body: commands,
  });
  console.log('Slash commands registered');
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

let shutdownStarted = false;

function destroyAllVoiceConnections() {
  const connections = Array.from(getVoiceConnections().entries());
  for (const [guildId, connection] of connections) {
    try {
      console.log('Destroying voice connection during shutdown', {
        guildId,
        channelId: connection.joinConfig.channelId,
      });
      connection.destroy();
    } catch (error) {
      console.error('Failed to destroy voice connection during shutdown', { guildId, error });
    }
  }
}

async function gracefulShutdown(signal: NodeJS.Signals | 'UNCAUGHT_EXCEPTION' | 'UNHANDLED_REJECTION') {
  if (shutdownStarted) return;
  shutdownStarted = true;

  console.log(`Received ${signal}. Cleaning up Discord voice connections...`);

  try {
    destroyAllVoiceConnections();
    clearAllVoiceState();
    client.destroy();
  } catch (error) {
    console.error('Shutdown cleanup failed', error);
  }

  setTimeout(() => process.exit(0), 50).unref();
}

process.on('SIGINT', () => {
  void gracefulShutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void gracefulShutdown('SIGTERM');
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught exception:', error);
  void gracefulShutdown('UNCAUGHT_EXCEPTION');
});

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
  void gracefulShutdown('UNHANDLED_REJECTION');
});

client.once('clientReady', async () => {
  console.log(`Logged in as ${client.user?.tag}`);
  const applicationId = client.application?.id;
  if (!applicationId) {
    throw new Error('Could not determine Discord application id after login.');
  }
  await registerCommands(applicationId);
});

client.on('interactionCreate', async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'ping') {
        await interaction.reply('pong');
        return;
      }

      if (interaction.commandName === 'join') {
        await handleJoin(interaction);
        return;
      }

      if (interaction.commandName === 'help') {
        await handleHelpCommand(interaction);
        return;
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      if (interaction.commandName === 'leave') {
        await handleLeave(interaction);
        return;
      }

      if (interaction.commandName === 'listen') {
        await handleListen(interaction);
        return;
      }

      if (interaction.commandName === 'info') {
        await handleInfo(interaction);
        return;
      }

      await interaction.editReply('Unknown command.');
      return;
    }

    if (interaction.isButton()) {
      await handleHelpButton(interaction);
    }

  } catch (err) {
    console.error('Command error:', err);
    if (!interaction.isRepliable()) return;
    const msg = `Error: ${err instanceof Error ? err.message : 'unknown error'}`;
    try {
      if (interaction.deferred) {
        await interaction.editReply({ content: msg });
      } else if (interaction.replied) {
        await interaction.followUp({ content: msg, flags: 64 });
      } else {
        await interaction.reply({ content: msg, flags: 64 });
      }
    } catch (replyErr) {
      console.error('Failed to send error response:', replyErr);
    }
  }
});

client.login(DISCORD_TOKEN);
