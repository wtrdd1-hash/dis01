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
        .setDescription('종목 ID (예: WTRD, MINE, CASN, BANK, NEKO, CHKN, SLOT, SCRP)')
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
    const currentAmount = Number(holding.amount);
    const stockPrice = BigInt(holding.price);
    const totalSpent = BigInt(holding.total_spent || 0);

    let sellAmount = 0;
    const lowerInput = amountInput.toLowerCase();
    if (lowerInput === '전량' || lowerInput === '올인' || lowerInput === '최대' || lowerInput === '전체' || lowerInput === 'all' || lowerInput === 'max') {
      sellAmount = currentAmount;
    } else {
      const parsed = parseFloat(amountInput);
      if (isNaN(parsed) || parsed < 0.0001) {
        return interaction.reply({
          embeds: [createErrorEmbed('입력 오류', '매도 수량은 0.0001 이상의 수 또는 "전량" / "최대"이어야 합니다.')],
          flags: MessageFlags.Ephemeral
        });
      }
      sellAmount = Math.round(parsed * 10000) / 10000;
    }

    if (sellAmount > currentAmount + 0.00001) {
      const displayHolding = (currentAmount % 1 === 0) ? currentAmount.toLocaleString() : currentAmount.toFixed(4);
      return interaction.reply({
        embeds: [createErrorEmbed('수량 초과', `보유 수량(${displayHolding}주)보다 많은 수량을 매도할 수 없습니다.`)],
        flags: MessageFlags.Ephemeral
      });
    }

    const totalProceeds = BigInt(Math.floor(Number(stockPrice) * sellAmount));
    const userData = await getOrCreateUser(userId);
    const newCash = BigInt(userData.cash || 0) + totalProceeds;

    // 비례하여 total_spent 감소
    const spentRatio = Math.min(1.0, sellAmount / (currentAmount || 1));
    const spentDeduction = BigInt(Math.round(Number(totalSpent) * spentRatio));
    const newTotalSpent = totalSpent > spentDeduction ? totalSpent - spentDeduction : 0n;
    const newAmountNum = Math.max(0, Math.round((currentAmount - sellAmount) * 10000) / 10000);

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      await connection.query('UPDATE users SET cash = ? WHERE discord_id = ?', [newCash.toString(), userId]);

      if (newAmountNum <= 0.00001) {
        await connection.query('DELETE FROM user_stocks WHERE user_id = ? AND stock_id = ?', [userId, stockIdInput]);
      } else {
        await connection.query(
          'UPDATE user_stocks SET amount = ?, total_spent = ? WHERE user_id = ? AND stock_id = ?',
          [newAmountNum.toFixed(4), newTotalSpent.toString(), userId, stockIdInput]
        );
      }

      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    const displaySellAmount = (sellAmount % 1 === 0) ? sellAmount.toLocaleString() : sellAmount.toFixed(4);
    const displayRemainAmount = (newAmountNum % 1 === 0) ? newAmountNum.toLocaleString() : newAmountNum.toFixed(4);

    const embed = createSuccessEmbed(
      '주식 매도 완료',
      `**종목:** \`[${holding.stock_id}]\` ${holding.name}\n` +
      `**매도 수량:** **${displaySellAmount}주**\n` +
      `**체결 단가:** ${formatMoney(stockPrice)}\n` +
      `**총 정산 금액:** **+${formatMoney(totalProceeds)}**\n\n` +
      `💳 **현재 보유 현금:** ${formatMoney(newCash)}\n` +
      `📦 **남은 주식 수량:** ${displayRemainAmount}주`
    );

    await interaction.reply({ embeds: [embed] });
  }
};
