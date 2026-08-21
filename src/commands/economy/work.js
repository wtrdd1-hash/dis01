const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getOrCreateUser } = require('../../config/database');
const config = require('../../config/config');
const { createSuccessEmbed, createWarningEmbed } = require('../../utils/embedBuilder');
const { formatMoney, formatTimeRemaining } = require('../../utils/formatters');
const { safeBigInt, withUserLock, tryClaimCooldown } = require('../../utils/money');

const WORK_SCENARIOS = [
  { text: '☕ 편의점과 카페에서 알바를 뛰며 성실히 손님을 응대했습니다.', min: 500, max: 1000 },
  { text: '📦 새벽 물류센터에서 분류 작업을 돕고 일당을 수령했습니다.', min: 800, max: 1400 },
  { text: '🖥️ IT 버그 수정 및 코드 리뷰 외주를 성실히 납품했습니다.', min: 900, max: 1500 },
  { text: '🎨 디스코드 배너와 이모지 디자인 외주 작업을 완료했습니다.', min: 600, max: 1200 },
  { text: '🧹 동네 상가 청소 및 전단지 배포를 완료했습니다.', min: 500, max: 900 },
  { text: '📈 가상 주식 기업 리서치 리포트를 정성껏 작성해 제출했습니다.', min: 800, max: 1500 }
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('일하기')
    .setDescription('열심히 일하여 500~1,500원의 근로 소득을 얻습니다 (쿨타임 10분).'),

  async execute(interaction) {
    const userId = interaction.user.id;
    const username = interaction.user.username;
    return withUserLock(userId, async () => {
      const userData = await getOrCreateUser(userId);

      const now = new Date();
      const lastWork = userData.last_work ? new Date(userData.last_work) : null;
      const cooldownMs = config.workCooldownMinutes * 60 * 1000;

      if (lastWork) {
        const diffMs = now.getTime() - lastWork.getTime();
        if (diffMs < cooldownMs) {
          const remainingMs = cooldownMs - diffMs;
          const embed = createWarningEmbed(
            '체력 회복 대기 중 😴',
            `지금은 일할 수 있는 체력이 부족합니다!\n휴식 남은 시간: **${formatTimeRemaining(remainingMs)}**`
          );
          return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }
      }

      const scenario = WORK_SCENARIOS[Math.floor(Math.random() * WORK_SCENARIOS.length)];
      const rawEarned = Math.floor(Math.random() * (scenario.max - scenario.min + 1)) + scenario.min;

      let mult = 1.0;
      try {
        const { getDynamicSettings } = require('../../utils/economyBalancer');
        const dyn = getDynamicSettings();
        if (dyn && dyn.workRewardMultiplier) mult = dyn.workRewardMultiplier;
      } catch (e) {}

      const earned = Math.max(300, Math.round(rawEarned * mult));
      const claimed = await tryClaimCooldown(userId, 'last_work', cooldownMs);
      if (!claimed) {
        const embed = createWarningEmbed(
          '체력 회복 대기 중 😴',
          '지금은 일할 수 있는 체력이 부족합니다!'
        );
        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }

      const { grantTreasurySubsidy } = require('../../utils/taxEngine');
      const subResult = await grantTreasurySubsidy(userId, username, safeBigInt(earned), `🏛️ [공공 근로 수당] ${scenario.text}`);
      const newCash = subResult.newCash;
      const treasuryLeft = subResult.newTreasury;

      const embed = createSuccessEmbed(
        '근로 성공! 💼',
        `${scenario.text}\n\n` +
        `💰 **획득한 급여:** **+${formatMoney(earned)}** (🏛️ 국고 지급)\n` +
        `💳 **현재 보유 현금:** **${formatMoney(newCash)}**\n` +
        `🏛️ **국고 잔액:** **${formatMoney(treasuryLeft)}**`
      );

      await interaction.reply({ embeds: [embed] });
    });
  }
};
