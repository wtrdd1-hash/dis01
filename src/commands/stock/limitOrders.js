'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { formatMoney } = require('../../utils/formatters');
const { safeBigInt } = require('../../utils/money');
const { getUserOrders } = require('../../utils/limitOrderEngine');

const STATUS_KO = { PENDING: '⏳ 미체결', FILLED: '✅ 체결됨', CANCELLED: '🗑️ 취소됨', EXPIRED: '⏰ 만료됨' };
const STATUS_COLOR = { PENDING: 0xF59E0B, FILLED: 0x10B981, CANCELLED: 0x6B7280, EXPIRED: 0xEF4444 };

module.exports = {
  data: new SlashCommandBuilder()
    .setName('예약조회')
    .setDescription('📋 내 지정가 예약 주문 목록을 조회합니다.')
    .addStringOption(opt =>
      opt.setName('상태')
        .setDescription('조회할 주문 상태 (기본: 미체결)')
        .setRequired(false)
        .addChoices(
          { name: '⏳ 미체결 (대기 중)', value: 'PENDING' },
          { name: '✅ 체결 완료', value: 'FILLED' },
          { name: '🗑️ 취소됨', value: 'CANCELLED' },
          { name: '📋 전체', value: 'ALL' }
        )
    ),

  async execute(interaction) {
    const statusFilter = interaction.options.getString('상태') ?? 'PENDING';
    const userId = interaction.user.id;

    const orders = await getUserOrders(userId, statusFilter === 'ALL' ? null : statusFilter, 20);

    if (!orders.length) {
      return interaction.reply({
        content: `📋 **${STATUS_KO[statusFilter] || '전체'}** 주문이 없습니다.\n\`/예약매수\` 또는 \`/예약매도\` 로 지정가 주문을 등록해보세요!`,
        ephemeral: true
      });
    }

    const lines = orders.map(o => {
      const type = o.order_type === 'BUY' ? '🟢 매수' : '🔴 매도';
      const status = STATUS_KO[o.status] || o.status;
      const price = formatMoney(safeBigInt(o.limit_price));
      const filled = o.filled_price ? ` → 체결가 ${formatMoney(safeBigInt(o.filled_price))}` : '';
      const expire = o.expires_at ? ` (${new Date(o.expires_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} 만료)` : '';
      return `**#${o.id}** ${type} | \`${o.stock_id}\` | ${o.amount}주 | 지정가 **${price}**${filled} | ${status}${expire}`;
    });

    const embed = new EmbedBuilder()
      .setColor(STATUS_COLOR[statusFilter] || 0x6366F1)
      .setTitle(`📋 내 예약 주문 목록 (${STATUS_KO[statusFilter] || '전체'})`)
      .setDescription(lines.join('\n'))
      .setFooter({ text: '/예약취소 [주문번호] 로 미체결 주문 취소 가능' })
      .setTimestamp();

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }
};
