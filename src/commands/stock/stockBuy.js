const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { pool, getOrCreateUser } = require('../../config/database');
const { createSuccessEmbed, createErrorEmbed } = require('../../utils/embedBuilder');
const { formatMoney, formatNumber } = require('../../utils/formatters');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('주식매수')
    .setDescription('원하는 주식을 매수합니다.')
    .addStringOption(option =>
      option.setName('종목코드')
        .setDescription('종목 ID (예: NVDA, SAM, AAPL, BTC, ETH, BIO)')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('수량')
        .setDescription('매수할 수량 (숫자 또는 "올인")')
        .setRequired(true)
    ),

  async execute(interaction) {
    const stockIdInput = interaction.options.getString('종목코드').toUpperCase().trim();
    const amountInput = interaction.options.getString('수량').trim();
    const userId = interaction.user.id;

    // 종목 존재 여부 확인
    const [stocks] = await pool.query('SELECT * FROM stocks WHERE stock_id = ?', [stockIdInput]);
    if (stocks.length === 0) {
      return interaction.reply({
        embeds: [createErrorEmbed('종목 없음', `\`${stockIdInput}\` 종목을 찾을 수 없습니다. \`/주식시세\`에서 종목 코드를 확인하세요.`)],
        flags: MessageFlags.Ephemeral
      });
    }

    const stock = stocks[0];
    const stockPrice = BigInt(stock.price);
    const userData = await getOrCreateUser(userId);
    const userCash = BigInt(userData.cash);

    let buyAmount = 0n;
    if (amountInput === '올인' || amountInput === '전체' || amountInput === 'all') {
      buyAmount = userCash / stockPrice;
    } else {
      const parsed = parseInt(amountInput, 10);
      if (isNaN(parsed) || parsed <= 0) {
        return interaction.reply({
          embeds: [createErrorEmbed('입력 오류', '매수 수량은 1 이상의 정수 또는 "올인"이어야 합니다.')],
          flags: MessageFlags.Ephemeral
        });
      }
      buyAmount = BigInt(parsed);
    }

    if (buyAmount <= 0n) {
      return interaction.reply({
        embeds: [createErrorEmbed('매수 불가', '매수할 수 있는 현금이 부족하거나 수량이 0주입니다.')],
        flags: MessageFlags.Ephemeral
      });
    }

    const totalCost = stockPrice * buyAmount;

    if (userCash < totalCost) {
      return interaction.reply({
        embeds: [createErrorEmbed('현금 부족', `매수 금액(${formatMoney(totalCost)})이 보유 현금(${formatMoney(userCash)})보다 많습니다.`)],
        flags: MessageFlags.Ephemeral
      });
    }

    const newCash = userCash - totalCost;

    // 트랜잭션으로 유저 현금 및 보유 주식 업데이트
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      await connection.query('UPDATE users SET cash = ? WHERE discord_id = ?', [newCash.toString(), userId]);

      await connection.query(`
        INSERT INTO user_stocks (user_id, stock_id, amount, total_spent)
        VALUES (?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          amount = amount + VALUES(amount),
          total_spent = total_spent + VALUES(total_spent)
      `, [userId, stock.stock_id, buyAmount.toString(), totalCost.toString()]);

      await connection.commit();
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }

    const embed = createSuccessEmbed(
      '주식 매수 완료 📈',
      `**종목:** ${stock.name} (\`${stock.stock_id}\`)\n` +
      `**매수 수량:** **${formatNumber(buyAmount)}주**\n` +
      `**주당 가격:** ${formatMoney(stockPrice)}\n` +
      `**총 결제 금액:** **${formatMoney(totalCost)}**\n\n` +
      `💳 **매수 후 현금:** **${formatMoney(newCash)}**`
    );

    await interaction.reply({ embeds: [embed] });
  }
};
