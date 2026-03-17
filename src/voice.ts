import {
  VoiceConnection,
  VoiceConnectionStatus,
  entersState,
  getVoiceConnection,
  joinVoiceChannel,
} from '@discordjs/voice';
import {
  ButtonInteraction,
  ChatInputCommandInteraction,
  MessageFlags,
  StringSelectMenuInteraction,
} from 'discord.js';

export async function getOrCreateConnectionFromMember(
  interaction: ChatInputCommandInteraction | ButtonInteraction | StringSelectMenuInteraction,
): Promise<VoiceConnection | null> {
  const guild = interaction.guild;
  if (!guild) {
    if ('deferred' in interaction && interaction.deferred) {
      await interaction.editReply({ content: 'This command only works inside a server.' });
    } else if (interaction.isRepliable()) {
      await interaction.reply({ content: 'This command only works inside a server.', flags: MessageFlags.Ephemeral });
    }
    return null;
  }

  const member = await guild.members.fetch(interaction.user.id);
  const channel = member.voice.channel;
  if (!channel) {
    const message = 'Join a voice channel first, then try again.';
    if ('deferred' in interaction && interaction.deferred) {
      await interaction.editReply({ content: message, embeds: [], components: [] });
    } else {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    }
    return null;
  }

  let connection = getVoiceConnection(guild.id);
  if (!connection) {
    console.log('Creating voice connection', {
      guildId: guild.id,
      channelId: channel.id,
      userId: interaction.user.id,
    });
    connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: false,
    });
  } else if (connection.joinConfig.channelId !== channel.id) {
    console.log('Rejected voice connection move', {
      guildId: guild.id,
      fromChannelId: connection.joinConfig.channelId,
      requestedChannelId: channel.id,
      userId: interaction.user.id,
    });
    const message = 'I am already connected to another voice channel in this server. Use `/leave` there first, then try again.';
    if ('deferred' in interaction && interaction.deferred) {
      await interaction.editReply({ content: message, embeds: [], components: [] });
    } else {
      await interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
    }
    return null;
  }

  try {
    await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
  } catch (error) {
    try {
      connection.destroy();
    } catch {}
    throw error;
  }
  console.log('Voice connection ready', {
    guildId: guild.id,
    channelId: channel.id,
    userId: interaction.user.id,
  });
  return connection;
}
