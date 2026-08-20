const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { createCustomEmbed } = require('../../utils/embedBuilder');
const { updateMacroEconomics, getMacroEconomicView } = require('../../utils/macroEconomics');
const { readTreasury } = require('../../utils/taxEngine');
const { formatMoney } = require('../../utils/formatters');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('경제')
    .setDescription('🌐 실시간 거시경제 지표, 중앙은행 기준금리, 물가지수(CPI) 및 경기 사이클 조회'),

  async execute(interaction) {
    await interaction.deferReply();
    try {
      await updateMacroEconomics();
      const view = getMacroEconomicView();
      const treasury = await readTreasury();

      const embed = createCustomEmbed({
        title: `🌐 월덕 국가 거시경제 시황 & 지표 브리핑`,
        description: `현재 가상 경제는 **${view.cycle.name}** 국면입니다.\n${view.cycle.desc}`,
        color: 0x38bdf8,
        fields: [
          {
            name: '🏦 중앙은행 & 통화 정책',
            value: [
              `• **기준금리(Policy Rate):** \`${view.baseInterestRate}\``,
              `• **정기 예금 금리:** \`연 ${view.depositRateAnnual}\``,
              `• **담보 대출 금리:** \`연 ${view.loanRateAnnual}\``,
              `• **시중 통화량(M2):** \`${view.moneySupplyM2Text}\``
            ].join('\n'),
            inline: true
          },
          {
            name: '📊 물가 & 국가 재정',
            value: [
              `• **소비자물가지수(CPI):** \`${view.cpi}pt\``,
              `• **인플레이션율:** \`${view.inflationRate}\``,
              `• **경제 성장률:** \`+${view.gdpGrowthRate}\``,
              `• **국가 국고 잔액:** \`${formatMoney(treasury)}\``
            ].join('\n'),
            inline: true
          },
          {
            name: '💡 중앙은행 거시경제 추천 재테크 전략',
            value: view.investmentAdvice,
            inline: false
          }
        ],
        footer: {
          text: `기준: 한국은행·FRB 테일러 준칙(Taylor Rule) 경제 모델 연동`
        }
      });

      return interaction.editReply({ embeds: [embed] });
    } catch (err) {
      console.error('경제 정보 조회 실패:', err);
      return interaction.editReply({ content: '거시경제 정보를 불러오는 중 오류가 발생했습니다.' });
    }
  }
};
