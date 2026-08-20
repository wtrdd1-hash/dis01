const { SlashCommandBuilder } = require('discord.js');
const { createCustomEmbed } = require('../../utils/embedBuilder');
const { getTopTaxPayers, getUserTaxStats, readTreasury, getPolicy } = require('../../utils/taxEngine');
const { formatMoney } = require('../../utils/formatters');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('세금')
    .setDescription('🏛️ 나의 누적 납부 세금 내역, 납세 순위 및 서버 최고 성실 납세자 랭킹을 조회합니다.')
    .addUserOption(option =>
      option.setName('유저')
        .setDescription('납세 내역을 조회할 유저 (비우면 본인)')
        .setRequired(false)
    ),

  async execute(interaction) {
    await interaction.deferReply();
    try {
      const targetUser = interaction.options.getUser('유저') || interaction.user;
      const isSelf = targetUser.id === interaction.user.id;
      const username = targetUser.globalName || targetUser.username || targetUser.tag;

      const userStats = await getUserTaxStats(targetUser.id);
      const topPayers = await getTopTaxPayers(10);
      const treasury = await readTreasury();
      const policy = getPolicy();

      // 성실 납세자 랭킹 텍스트 구성
      let rankText = '';
      if (topPayers.length === 0) {
        rankText = '아직 세금 납부 기록이 없습니다.';
      } else {
        rankText = topPayers.map(p => {
          const isTop1 = p.rank === 1 && BigInt(p.totalTaxPaid || 0) > 0n;
          const medal = isTop1 ? '🥇 👑 [세금왕]' : (p.rank === 2 ? '🥈' : (p.rank === 3 ? '🥉' : `**${p.rank}위**`));
          return `${medal} **@${p.username}**: \`${p.totalTaxPaidText}\` (${p.taxCount}회 납부)`;
        }).join('\n');
      }

      const isKing = userStats.taxRank === 1 && BigInt(userStats.totalTaxPaid || 0) > 0n;

      const embed = createCustomEmbed({
        title: `🏛️ 국가 세무청 · 세금 납부 장부 & 성실 납세자 명예의 전당`,
        description: `현재 국가 국고 잔액: **${formatMoney(treasury)}**\n(모든 세금은 100% 국고로 귀속되며 취약계층 지원금 및 국가 인프라에 쓰입니다.)`,
        color: isKing ? 0xfbbf24 : 0x38bdf8,
        fields: [
          {
            name: `👤 @${username} 님의 누적 납세 현황 ${isKing ? '👑 [세금왕]' : ''}`,
            value: [
              `• **총 누적 납부 세금:** 🏛️ **${userStats.totalTaxPaidText}**`,
              `• **서버 납세 순위:** **${userStats.taxRank}위** ${isKing ? '(👑 **영예의 세금왕**)' : ''} (총 ${userStats.taxCount}회 징수)`,
              `• **누진 재산세:** \`${userStats.wealthTaxPaidText}\``,
              `• **주식 거래세:** \`${userStats.tradeTaxPaidText}\``,
              `• **기타/관리자 징수:** \`${userStats.adminTaxPaidText}\``
            ].join('\n'),
            inline: false
          },
          {
            name: '🏆 서버 최고 성실 납세자 TOP 10 (명예의 전당)',
            value: rankText,
            inline: false
          }
        ],
        footer: {
          text: `과세 기준: 총 순자산 500만원 이상 초과 누진 과세 (3%~15%)`
        }
      });

      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('세금 정보 조회 오류:', err);
      return interaction.editReply({ content: '세금 납부 정보를 불러오는 중 오류가 발생했습니다.' });
    }
  }
};
