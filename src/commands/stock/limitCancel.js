'use strict';

const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { formatMoney } = require('../../utils/formatters');
const { safeBigInt } = require('../../utils/money');
const { cancelLimitOrder } = require('../../utils/limitOrderEngine');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('예약취소')
    .setDescription('📋 미체결 예약 주문을 취소합니다.')
    .addIntegerOption(opt =>
      opt.setName('주문번호').setDescription('/예약조회 에서 확인한 주문 ID').setRequired(true)
    ),

  async execute(interaction) {
    const orderId = interaction.options.getInteger('주문번호');
    const userId = interaction.user.id;

    try {
      const order = await cancelLimitOrder(userId, orderId);
      const embed = new EmbedBuilder()
        .setColor(0x94A3B8)
        .setTitle('🗑️ 예약 주문 취소 완료')
        .setDescription(`주문 **#${orderId}** 이 성공적으로 취소되었습니다.`)
        .addFields(
          { name: '종목', value: `\`${order.stock_id}\``, inline: true },
          { name: '유형', value: order.order_type === 'BUY' ? '🟢 예약 매수' : '🔴 예약 매도', inline: true },
          { name: '지정가', value: formatMoney(safeBigInt(order.limit_price)), inline: true },
          { name: '수량', value: `${order.amount}주`, inline: true }
        )
        .setTimestamp();
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    } catch (err) {
      return interaction.reply({
        content: `❌ ${err.message}`,
        flags: MessageFlags.Ephemeral
      });
    }
  }
};
