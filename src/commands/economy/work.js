const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { pool, getOrCreateUser } = require('../../config/database');
const config = require('../../config/config');
const { createSuccessEmbed, createWarningEmbed } = require('../../utils/embedBuilder');
const { formatMoney, formatTimeRemaining } = require('../../utils/formatters');

const WORK_SCENARIOS = [
  { text: '👨‍💻 카페 알바를 뛰며 친절한 손님에게 팁을 듬뿍 받았습니다.', min: 4000, max: 12000 },
  { text: '🚚 새벽 야간 택배 쿠팡 물류센터에서 땀 흘려 일했습니다.', min: 8000, max: 18000 },
  { text: '🖥️ IT 벤처 스타트업 버그를 해결해 개발 외주 급여를 받았습니다.', min: 10000, max: 25000 },
  { text: '🎨 디스코드 서버 디자인 외주 의뢰를 완벽하게 마감했습니다.', min: 6000, max: 15000 },
  { text: '🔥 편의점 야간 알바 중 골목길에서 주운 상품권을 현금화했습니다.', min: 5000, max: 10000 },
  { text: '📈 주식 리서치 조교로 일하며 유용한 리포트를 작성했습니다.', min: 9000, max: 20000 },
  { text: '✨ 대박 사건! 중고거래에서 대박 희귀 물품을 발굴해 시세 차익을 남겼습니다!', min: 30000, max: 70000 }
];

module.exports = {
  data: new SlashCommandBuilder()
    .setName('일하기')
    .setDescription('열심히 일하여 돈을 획득합니다 (쿨타임 10분).'),

  async execute(interaction) {
    const userId = interaction.user.id;
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

    // 작업 선택 및 무작위 급여
    const scenario = WORK_SCENARIOS[Math.floor(Math.random() * WORK_SCENARIOS.length)];
    const earned = Math.floor(Math.random() * (scenario.max - scenario.min + 1)) + scenario.min;

    const newCash = BigInt(userData.cash) + BigInt(earned);

    await pool.query(
      'UPDATE users SET cash = ?, last_work = NOW() WHERE discord_id = ?',
      [newCash.toString(), userId]
    );

    const embed = createSuccessEmbed(
      '근로 성공! 💼',
      `${scenario.text}\n\n` +
      `💰 **획득한 급여:** **${formatMoney(earned)}**\n` +
      `💳 **현재 보유 현금:** **${formatMoney(newCash)}**`
    );

    await interaction.reply({ embeds: [embed] });
  }
};
