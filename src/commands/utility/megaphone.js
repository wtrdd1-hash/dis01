'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { sendMegaphone } = require('../../utils/shopEngine');
const { formatMoney } = require('../../utils/formatters');
const { getOrCreateUser } = require('../../utils/money');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('확성기')
    .setDescription('전체 서버와 웹 대시보드 상단 전광판에 10분간 네온 공지를 송출합니다 (비용: 5만원 소각).')
    .addStringOption(opt =>
      opt.setName('메시지')
        .setDescription('전광판에 띄울 메시지 (최대 150자)')
        .setRequired(true)
        .setMaxLength(150)
    )
    .addStringOption(opt =>
      opt.setName('테마')
        .setDescription('전광판 네온 색상 테마')
        .setRequired(false)
        .addChoices(
          { name: '👑 골든 럭셔리 (Gold)', value: 'gold' },
          { name: '🔮 사이버펑크 네온 (Neon)', value: 'neon' },
          { name: '🔥 블레이징 레드 (Fire)', value: 'fire' },
          { name: '💎 다이아몬드 블루 (Diamond)', value: 'diamond' }
        )
    ),

  async execute(interaction) {
    const userId = interaction.user.id;
    const username = interaction.user.displayName || interaction.user.username;
    await getOrCreateUser(userId, username, interaction.user.displayAvatarURL());

    const message = interaction.options.getString('메시지');
    const theme = interaction.options.getString('테마') || 'gold';

    try {
      const result = await sendMegaphone(userId, username, message, theme);

      const embed = new EmbedBuilder()
        .setColor(0xF59E0B)
        .setTitle('📢 [실시간 전 서버 & 웹 확성기 발송]')
        .setDescription(`**@${username}** 님의 확성기 메시지가 송출되었습니다!\n\n> 💬 "${message}"`)
        .addFields(
          { name: '송출 테마', value: `\`${theme.toUpperCase()}\``, inline: true },
          { name: '유지 시간', value: '10분간 지속', inline: true },
          { name: '소모 금액', value: '-50,000원 (영구 소각)', inline: true }
        )
        .setFooter({ text: '웹 대시보드 https://easy-scraping.com 상단 티커에서도 실시간 표시됩니다.' })
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    } catch (err) {
      return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
    }
  }
};
