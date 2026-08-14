const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { pool, getOrCreateUser } = require('../../config/database');
const { formatMoney, formatNumber } = require('../../utils/formatters');
const config = require('../../config/config');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('클리커')
    .setDescription('⛏️ 골드 및 도박 턴을 채굴하는 인터랙티브 클리커 게임을 플레이합니다.'),

  async execute(interaction) {
    const userId = interaction.user.id;
    const userData = await getOrCreateUser(userId, interaction.user.globalName || interaction.user.username);

    // 턴 계산
    const maxTurns = 50;
    let turns = userData.gamble_turns ?? 50;
    const lastUpdate = userData.last_turn_update ? new Date(userData.last_turn_update).getTime() : Date.now();
    const elapsedSec = Math.floor((Date.now() - lastUpdate) / 1000);
    const recovered = Math.floor(elapsedSec / 30);
    if (recovered > 0 && turns < maxTurns) {
      turns = Math.min(maxTurns, turns + recovered);
    }

    const clickerLevel = userData.clicker_level || 1;
    const autoLevel = userData.auto_miner_level || 0;
    const power = clickerLevel * 10;
    const upgradeCost = clickerLevel * 4500;

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`click_mine_${userId}`)
        .setLabel('⛏️ 광석 채굴하기 (클릭!)')
        .setStyle(ButtonStyle.Success)
        .setEmoji('💎'),
      new ButtonBuilder()
        .setCustomId(`click_upgrade_${userId}`)
        .setLabel(`🔨 곡괭이 강화 (${formatMoney(upgradeCost)})`)
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setLabel('🌐 웹 클리커 바로가기')
        .setStyle(ButtonStyle.Link)
        .setURL('https://easy-scraping.com')
    );

    const embed = new EmbedBuilder()
      .setTitle('⛏️ 골드 & 도박 턴 마이닝 클리커')
      .setColor(config.colors.primary)
      .setDescription(`아래 **[⛏️ 광석 채굴하기]** 버튼을 연속으로 클릭하여 골드를 벌고 ⚡도박 턴을 충전하세요!\n웹 대시보드([easy-scraping.com](https://easy-scraping.com))에서는 마우스 연타 클리커로 훨씬 더 빠르게 채굴할 수 있습니다.`)
      .addFields(
        { name: '💵 보유 현금', value: formatMoney(userData.cash), inline: true },
        { name: '⚡ 남은 도박 턴', value: `\`${turns} / 50\` (30초당 +1턴)`, inline: true },
        { name: '🔨 채굴 파워', value: `Lv.${clickerLevel} (클릭당 +${formatMoney(power)})`, inline: true },
        { name: '🤖 자동 채굴', value: `Lv.${autoLevel} (초당 +${formatMoney(autoLevel * 15)})`, inline: true },
        { name: '📊 누적 클릭 수', value: `${formatNumber(userData.total_clicks || 0)}회`, inline: true },
        { name: '🎁 보너스 혜택', value: `클릭 시 10% 확률 3배 크리티컬 및 도박 턴 드랍!`, inline: true }
      )
      .setFooter({ text: '월덕 가상 경제 클리커 시스템' })
      .setTimestamp();

    await interaction.reply({ embeds: [embed], components: [row] });
  }
};
