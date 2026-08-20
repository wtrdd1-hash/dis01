const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { createWarningEmbed } = require('../../utils/embedBuilder');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('tts')
    .setDescription('입력한 텍스트를 디스코드 음성(TTS)으로 낭독합니다.')
    .addStringOption(option =>
      option.setName('내용')
        .setDescription('음성으로 읽어줄 텍스트 내용 (최대 200자)')
        .setRequired(true)
        .setMaxLength(200)
    ),

  async execute(interaction) {
    const text = interaction.options.getString('내용');

    if (!text || text.trim().length === 0) {
      const embed = createWarningEmbed('입력 오류', '읽어줄 텍스트 내용을 입력해주세요.');
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    const username = interaction.user.displayName || interaction.user.username;
    const safeText = String(text.trim()).replace(/@(everyone|here)/gi, '@\u200b$1');

    await interaction.reply({
      content: `🔊 **[${username}]**: ${safeText}`,
      tts: true
    });
  }
};
