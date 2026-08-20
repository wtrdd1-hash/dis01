const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { getOrCreateUser } = require('../../config/database');
const config = require('../../config/config');
const { createSuccessEmbed, createWarningEmbed } = require('../../utils/embedBuilder');
const { formatMoney, formatTimeRemaining } = require('../../utils/formatters');
const { safeBigInt, applyCashDelta, withUserLock, tryClaimCooldown } = require('../../utils/money');

const WORK_SCENARIOS = [
  { text: '☕ 편의점과 카페에서 알바를 뛰며 손님 응대를 성실히 마쳤습니다.', min: 1200, max: 2800 },
  { text: '📦 새벽 물류센터 상하차 지원을 나가 땀 흘려 일했습니다.', min: 2500, max: 4800 },
  { text: '🖥️ IT 스타트업 버그 픽스 및 개발 외주를 성공적으로 납품했습니다.', min: 3500, max: 6500 },
  { text: '🎨 디스코드 배너 및 이모지 디자인 외주 작업을 완수했습니다.', min: 2000, max: 4500 },
  { text: '🧹 동네 상가 청소 및 전단지 배포 아르바이트를 완료했습니다.', min: 1000, max: 2200 },
  { text: '📈 가상 주식 기업 리서치 리포트를 정성껏 작성해 제출했습니다.', min: 3000, max: 6000 },
  { text: '✨ 대박 행운! 우수 직원 포상 보너스와 넉넉한 팁을 받았습니다!', min: 8000, max: 15000 }
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('일하기')
    .setDescription('열심히 일하여 돈을 획득합니다 (쿨타임 10분).'),

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

    const earned = Math.max(100, Math.round(rawEarned * mult));
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
