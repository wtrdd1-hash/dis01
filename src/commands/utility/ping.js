const { SlashCommandBuilder } = require('discord.js');
const { createSuccessEmbed } = require('../../utils/embedBuilder');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('핑')
    .setDescription('봇 응답 속도와 웹소켓 지연을 확인합니다.'),

  async execute(interaction) {
    const sent = await interaction.reply({
      embeds: [createSuccessEmbed('핑', '측정 중...')],
      fetchReply: true
    });

    const roundtrip = sent.createdTimestamp - interaction.createdTimestamp;
    const wsPing = Math.round(interaction.client.ws.ping);

    await interaction.editReply({
      embeds: [
        createSuccessEmbed(
          '핑',
          `왕복: **${roundtrip}ms**\n웹소켓: **${wsPing}ms**`
        )
      ]
    });
  }
};
