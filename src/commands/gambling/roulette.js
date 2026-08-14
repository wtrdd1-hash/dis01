const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { pool, getOrCreateUser } = require('../../config/database');
const { createGambleEmbed, createErrorEmbed } = require('../../utils/embedBuilder');
const { formatMoney } = require('../../utils/formatters');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('룰렛')
    .setDescription('🎡 카지노 룰렛 (레드/블랙/잭팟 그린) 도박을 진행합니다.')
    .addStringOption(option =>
      option.setName('색상')
        .setDescription('배팅할 색상 선택')
        .setRequired(true)
        .addChoices(
          { name: '🔴 레드 (2배 / 45% 확률)', value: 'RED' },
          { name: '⚫ 블랙 (2배 / 45% 확률)', value: 'BLACK' },
          { name: '🟢 그린 잭팟 (10배 / 10% 확률)', value: 'GREEN' }
        )
    )
    .addStringOption(option =>
      option.setName('배팅금액')
        .setDescription('배팅할 금액 또는 "올인"')
        .setRequired(true)
    ),

  async execute(interaction) {
    const colorChoice = interaction.options.getString('색상');
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

    // 룰렛 결과 뽑기 (0~9: GREEN 10%, 10~54: RED 45%, 55~99: BLACK 45%)
    const rand = Math.floor(Math.random() * 100);
    let outcomeColor = '';
    let outcomeEmoji = '';

    if (rand < 10) {
      outcomeColor = 'GREEN';
      outcomeEmoji = '🟢 GREEN';
    } else if (rand < 55) {
      outcomeColor = 'RED';
      outcomeEmoji = '🔴 RED';
    } else {
      outcomeColor = 'BLACK';
      outcomeEmoji = '⚫ BLACK';
    }

    let multiplier = 0;
    if (colorChoice === outcomeColor) {
      multiplier = outcomeColor === 'GREEN' ? 10 : 2;
    }

    const payout = betAmount * BigInt(multiplier);
    const profit = payout - betAmount;
    const newCash = userCash + profit;

    await pool.query('UPDATE users SET cash = ? WHERE discord_id = ?', [newCash.toString(), userId]);
    await pool.query(
      'INSERT INTO gambling_logs (user_id, game, bet, payout, profit) VALUES (?, "roulette", ?, ?, ?)',
      [userId, betAmount.toString(), payout.toString(), profit.toString()]
    );

    const embed = createGambleEmbed(
      '🎡 카지노 룰렛 결과',
      `**룰렛 정지 위치:** ${outcomeEmoji}\n` +
      `**내 선택:** \`${colorChoice}\`\n\n` +
      `${multiplier > 0 ? `🎉 **축하합니다! ${multiplier}배 당첨!**` : '💀 **아쉽게도 패배했습니다.**'}\n\n` +
      `💰 **배팅금:** ${formatMoney(betAmount)}\n` +
      `🎁 **획득금:** ${formatMoney(payout)}\n` +
      `💳 **현재 잔액:** **${formatMoney(newCash)}**`
    );

    await interaction.reply({ embeds: [embed] });
  }
};
