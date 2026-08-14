const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { pool, getOrCreateUser } = require('../../config/database');
const { createSuccessEmbed, createErrorEmbed } = require('../../utils/embedBuilder');
const { formatMoney, formatNumber } = require('../../utils/formatters');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('주식매도')
    .setDescription('보유 중인 주식을 매도합니다.')
    .addStringOption(option =>
      option.setName('종목코드')
        .setDescription('종목 ID (예: NVDA, SAM, AAPL, BTC, ETH, BIO)')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('수량')
        .setDescription('매도할 수량 (숫자 또는 "전량")')
        .setRequired(true)
    ),

  async execute(interaction) {
    const stockIdInput = interaction.options.getString('종목코드').toUpperCase().trim();
    const amountInput = interaction.options.getString('수량').trim();
    const userId = interaction.user.id;

    // 보유 주식 조회
    const [userStocks] = await pool.query(`
      SELECT us.*, s.name, s.price
      FROM user_stocks us
      JOIN stocks s ON us.stock_id = s.stock_id
      WHERE us.user_id = ? AND us.stock_id = ?
    `, [userId, stockIdInput]);

    if (userStocks.length === 0 || BigInt(userStocks[0].amount) <= 0n) {
      return interaction.reply({
        embeds: [createErrorEmbed('매도 불가', `\`${stockIdInput}\` 종목을 보유하고 있지 않습니다. \`/포트폴리오\`를 확인하세요.`)],
        flags: MessageFlags.Ephemeral
      });
    }

    const holding = userStocks[0];
    const currentAmount = BigInt(holding.amount);
    const stockPrice = BigInt(holding.price);
    const totalSpent = BigInt(holding.total_spent);

    let sellAmount = 0n;
    if (amountInput === '전량' || amountInput === '올인' || amountInput === 'all') {
      sellAmount = currentAmount;
    } else {
      const parsed = parseInt(amountInput, 10);
      if (isNaN(parsed) || parsed <= 0) {
        return interaction.reply({
          embeds: [createErrorEmbed('입력 오류', '매도 수량은 1 이상의 정수 또는 "전량"이어야 합니다.')],
          flags: MessageFlags.Ephemeral
        });
      }
      sellAmount = BigInt(parsed);
    }

    if (sellAmount > currentAmount) {
      return interaction.reply({
        embeds: [createErrorEmbed('수량 초과', `보유 수량(${formatNumber(currentAmount)}주)보다 많은 수량을 매도할 수 없습니다.`)],
        flags: MessageFlags.Ephemeral
      });
    }

    const totalProceeds = stockPrice * sellAmount;
    const userData = await getOrCreateUser(userId);
    const newCash = BigInt(userData.cash) + totalProceeds;

    // 비례하여 total_spent 감소
    const spentRatio = Number(sellAmount) / Number(currentAmount);
    const spentDeduction = BigInt(Math.round(Number(totalSpent) * spentRatio));
    const newTotalSpent = totalSpent - spentDeduction;

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      await connection.query('UPDATE users SET cash = ? WHERE discord_id = ?', [newCash.toString(), userId]);

      const remainingAmount = currentAmount - sellAmount;
      if (remainingAmount <= 0n) {
        await connection.query('DELETE FROM user_stocks WHERE user_id = ? AND stock_id = ?', [userId, stockIdInput]);
      } else {
        await connection.query(
          'UPDATE user_stocks SET amount = ?, total_spent = ? WHERE user_id = ? AND stock_id = ?',
          [remainingAmount.toString(), newTotalSpent.toString(), userId, stockIdInput]
        );
      }

      await connection.commit();
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }

    const embed = createSuccessEmbed(
      '주식 매도 완료 📉',
      `**종목:** ${holding.name} (\`${holding.stock_id}\`)\n` +
      `**매도 수량:** **${formatNumber(sellAmount)}주**\n` +
      `**주당 매도 가격:** ${formatMoney(stockPrice)}\n` +
      `**총 수령 정산금:** **${formatMoney(totalProceeds)}**\n\n` +
      `💳 **매도 후 현금:** **${formatMoney(newCash)}**`
    );

    await interaction.reply({ embeds: [embed] });
  }
};
