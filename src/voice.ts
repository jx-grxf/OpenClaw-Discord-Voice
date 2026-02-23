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

