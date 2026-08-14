const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { pool, getOrCreateUser } = require('../../config/database');
const { createGambleEmbed, createErrorEmbed } = require('../../utils/embedBuilder');
const { formatMoney } = require('../../utils/formatters');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('도박')
    .setDescription('🎲 주사위 롤(1~100) 확률 도박을 진행합니다.')
    .addStringOption(option =>
      option.setName('배팅금액')
        .setDescription('배팅할 금액 또는 "올인"')
        .setRequired(true)
    ),

  async execute(interaction) {
    const betInput = interaction.options.getString('배팅금액').trim();
    const userId = interaction.user.id;

    const userData = await getOrCreateUser(userId);
    const userCash = BigInt(userData.cash);

    let betAmount = 0n;
    if (betInput === '올인' || betInput === '전체' || betInput === 'all') {
      betAmount = userCash;
    } else {
      const parsed = parseInt(betInput, 10);
      if (isNaN(parsed) || parsed <= 0) {
        return interaction.reply({
          embeds: [createErrorEmbed('입력 오류', '배팅 금액은 1,000원 이상의 정수 또는 "올인"이어야 합니다.')],
          flags: MessageFlags.Ephemeral
        });
      }
      betAmount = BigInt(parsed);
    }

    if (betAmount < 1000n) {
      return interaction.reply({
        embeds: [createErrorEmbed('배팅 제한', '최소 배팅 금액은 1,000원입니다.')],
        flags: MessageFlags.Ephemeral
      });
    }

    if (userCash < betAmount) {
      return interaction.reply({
        embeds: [createErrorEmbed('현금 부족', `보유 현금(${formatMoney(userCash)})이 배팅금(${formatMoney(betAmount)})보다 부족합니다.`)],
        flags: MessageFlags.Ephemeral
      });
    }

    // 1~100 주사위 굴리기
    const roll = Math.floor(Math.random() * 100) + 1;

    let multiplier = 0;
    let resultTitle = '';

    if (roll >= 90) {
      multiplier = 4;
      resultTitle = `🔥 주사위 \`${roll}\` | **대박 4배 당첨!!** 🎯`;
    } else if (roll >= 60) {
      multiplier = 2;
      resultTitle = `✨ 주사위 \`${roll}\` | **승리! 2배 획득!** 🎲`;
    } else {
      multiplier = 0;
      resultTitle = `💀 주사위 \`${roll}\` | **패배... 60 미만입니다.**`;
    }

    const payout = betAmount * BigInt(multiplier);
    const profit = payout - betAmount;
    const newCash = userCash + profit;

    await pool.query('UPDATE users SET cash = ? WHERE discord_id = ?', [newCash.toString(), userId]);
    await pool.query(
      'INSERT INTO gambling_logs (user_id, game, bet, payout, profit) VALUES (?, "dice", ?, ?, ?)',
      [userId, betAmount.toString(), payout.toString(), profit.toString()]
    );

    const embed = createGambleEmbed(
      '🎲 주사위 승부 결과',
      `${resultTitle}\n\n` +
      `• 기준점: 60 이상 (2배) / 90 이상 (4배)\n` +
      `💰 **배팅금:** ${formatMoney(betAmount)}\n` +
      `🎁 **획득금:** ${formatMoney(payout)}\n` +
      `💳 **현재 잔액:** **${formatMoney(newCash)}**`
    );

    await interaction.reply({ embeds: [embed] });
  }
};
