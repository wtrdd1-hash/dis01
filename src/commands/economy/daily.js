const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { pool, getOrCreateUser } = require('../../config/database');
const config = require('../../config/config');
const { createSuccessEmbed, createWarningEmbed } = require('../../utils/embedBuilder');
const { formatMoney, formatTimeRemaining } = require('../../utils/formatters');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('출석')
    .setDescription('매일 출석체크 보상과 연속 출석 보너스를 받습니다.'),

  async execute(interaction) {
    const userId = interaction.user.id;
    const userData = await getOrCreateUser(userId);

    const now = new Date();
    const lastDaily = userData.last_daily ? new Date(userData.last_daily) : null;

    const cooldownMs = 24 * 60 * 60 * 1000; // 24시간
    const streakResetMs = 48 * 60 * 60 * 1000; // 48시간 지나면 연속 출석 리셋

    if (lastDaily) {
      const diffMs = now.getTime() - lastDaily.getTime();
      if (diffMs < cooldownMs) {
        const remainingMs = cooldownMs - diffMs;
        const embed = createWarningEmbed(
          '출석체크 대기 시간',
          `이미 오늘 출석체크를 완료하셨습니다!\n다음 출석까지: **${formatTimeRemaining(remainingMs)}** 남았습니다.`
        );
        return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      }
    }

    let streak = userData.daily_streak || 0;
    if (lastDaily && (now.getTime() - lastDaily.getTime() > streakResetMs)) {
      streak = 0; // 연속 출석 초기화
    }
    streak += 1;

    // 보상 계산: 기본 보상 + (연속출석 * 연속 보너스) (최대 10일 연속 보너스 적용)
    const cappedStreak = Math.min(streak, 10);
    const streakBonus = (cappedStreak - 1) * config.dailyStreakBonus;

    // 🏦 자동 경제 조절 장치: 현재 경제 상황에 맞춘 동적 배율 적용
    let mult = 1.0;
    try {
      const { getDynamicSettings } = require('../../utils/economyBalancer');
      const dyn = getDynamicSettings();
      if (dyn && dyn.dailyRewardMultiplier) mult = dyn.dailyRewardMultiplier;
    } catch (e) {}

    const baseReward = config.dailyReward + streakBonus;
    const totalReward = Math.max(100, Math.round(baseReward * mult));

    const newCash = BigInt(userData.cash) + BigInt(totalReward);

    await pool.query(
      'UPDATE users SET cash = ?, last_daily = NOW(), daily_streak = ? WHERE discord_id = ?',
      [newCash.toString(), streak, userId]
    );

    const embed = createSuccessEmbed(
      '출석체크 완료! 🎉',
      `**기본 출석 보상:** ${formatMoney(config.dailyReward)}\n` +
      `**🔥 연속 출석:** \`${streak}일째\` (보너스 +${formatMoney(streakBonus)})\n\n` +
      `💰 **총 수령 금액:** **${formatMoney(totalReward)}**\n` +
      `💳 **현재 잔액:** **${formatMoney(newCash)}**`
    );

    await interaction.reply({ embeds: [embed] });
  }
};
