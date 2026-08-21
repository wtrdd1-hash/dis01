'use strict';

const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { getShopCatalog, buyShopItem, getUserInventory, openLuckyBox } = require('../../utils/shopEngine');
const { formatMoney } = require('../../utils/formatters');
const { getOrCreateUser } = require('../../utils/money');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('상점')
    .setDescription('월덕 명예 상점에서 오라, 칭호, 전략 버프 카드, 럭키 박스를 구매합니다.')
    .addSubcommand(sub =>
      sub
        .setName('목록')
        .setDescription('판매 중인 모든 상점 아이템 및 가격을 확인합니다.')
    )
    .addSubcommand(sub =>
      sub
        .setName('구매')
        .setDescription('상점에서 아이템을 구매합니다.')
        .addStringOption(opt =>
          opt.setName('아이템')
            .setDescription('구매할 아이템 선택')
            .setRequired(true)
            .addChoices(
              { name: '✨ 사이버펑크 네온 오라 (10만원 / 30일)', value: 'aura_cyberpunk' },
              { name: '👑 황금빛 부의 오라 (25만원 / 30일)', value: 'aura_golden' },
              { name: '💎 다이아몬드 갤럭시 오라 (50만원 / 30일)', value: 'aura_diamond' },
              { name: '🎖️ [월덕 만수르] 영구 칭호 (20만원)', value: 'title_mansour' },
              { name: '🎖️ [월가의 늑대] 영구 칭호 (20만원)', value: 'title_wolf' },
              { name: '🎖️ [카지노 지배자] 영구 칭호 (20만원)', value: 'title_casino_king' },
              { name: '🛡️ 카지노 안심 보험 카드 (1.5만원)', value: 'card_casino_insurance' },
              { name: '📈 증권가 극비 찌라시 힌트권 (3만원)', value: 'card_stock_rumor' },
              { name: '📉 주식 거래 수수료 면제권 (5만원)', value: 'card_zero_tax' },
              { name: '🛢️ 초고순도 오버클럭 냉각유 (1만원)', value: 'buff_overclock_oil' },
              { name: '🛡️ 드릴 강화 파괴 방지권 (5만원)', value: 'item_protect_ticket' },
              { name: '🎁 황금오리 미스터리 럭키 박스 (5천원)', value: 'lucky_box' }
            )
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('인벤토리')
        .setDescription('내가 보유 중인 아이템 및 활성화된 오라/칭호를 확인합니다.')
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const userId = interaction.user.id;
    const username = interaction.user.displayName || interaction.user.username;
    await getOrCreateUser(userId, username, interaction.user.displayAvatarURL());

    if (subcommand === '목록') {
      const catalog = getShopCatalog();
      const embed = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('🛍️ 월덕 명품 상점 & 화폐 소비 센터')
        .setDescription('화폐를 소모하여 특별한 명예 오라, 칭호, 전략 버프 카드를 획득하세요!\n모든 구매 금액은 **100% 시장에서 영구 소각**됩니다.')
        .setThumbnail('https://easy-scraping.com/icon.png')
        .setTimestamp();

      const auras = catalog.filter(i => i.type === 'AURA').map(i => `${i.emoji} **${i.name}**\n가격: **${formatMoney(i.price)}** | ${i.description}`).join('\n\n');
      const titles = catalog.filter(i => i.type === 'TITLE').map(i => `${i.emoji} **${i.name}**\n가격: **${formatMoney(i.price)}** | ${i.description}`).join('\n\n');
      const cards = catalog.filter(i => ['CARD', 'BUFF', 'CONSUMABLE', 'BOX'].includes(i.type)).map(i => `${i.emoji} **${i.name}**\n가격: **${formatMoney(i.price)}** | ${i.description}`).join('\n\n');

      embed.addFields(
        { name: '✨ [명예] 프로필 네온 오라 (30일)', value: auras, inline: false },
        { name: '🎖️ [명예] 레전더리 영구 칭호', value: titles, inline: false },
        { name: '🃏 [전략 & 행운] 버프 카드 및 럭키 박스', value: cards, inline: false }
      );

      return interaction.reply({ embeds: [embed] });
    }

    if (subcommand === '구매') {
      const itemKey = interaction.options.getString('아이템');
      try {
        if (itemKey === 'lucky_box') {
          // 럭키박스 구매 + 즉시 오픈
          const buyResult = await buyShopItem(userId, username, itemKey);
          const gachaResult = await openLuckyBox(userId, username);

          const embed = new EmbedBuilder()
            .setColor(0xF59E0B)
            .setTitle('🎁 황금오리 미스터리 럭키 박스 개봉!')
            .setDescription(`**@${username}** 님께서 럭키 박스를 개봉했습니다!\n\n${gachaResult.message}`)
            .addFields(
              { name: '획득 아이템', value: `**${gachaResult.reward.name}**`, inline: true },
              { name: '잔여 현금', value: formatMoney(buyResult.afterCash), inline: true }
            )
            .setTimestamp();
          return interaction.reply({ embeds: [embed] });
        }

        const result = await buyShopItem(userId, username, itemKey);
        const embed = new EmbedBuilder()
          .setColor(0x10B981)
          .setTitle('🛍️ 아이템 구매 완료!')
          .setDescription(`**@${username}** 님, 아이템 구매가 정상 완료되었습니다.`)
          .addFields(
            { name: '구매 상품', value: `**${result.item.name}**`, inline: true },
            { name: '소모 금액', value: `-${formatMoney(result.item.price)}`, inline: true },
            { name: '잔여 현금', value: formatMoney(result.afterCash), inline: true },
            { name: '효과/설명', value: result.item.description, inline: false }
          )
          .setTimestamp();
        return interaction.reply({ embeds: [embed] });
      } catch (err) {
        return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
      }
    }

    if (subcommand === '인벤토리') {
      const inv = await getUserInventory(userId);
      const embed = new EmbedBuilder()
        .setColor(0x3B82F6)
        .setTitle(`🎒 @${username} 님의 보관함 (인벤토리)`)
        .setTimestamp();

      const itemsStr = inv.items.length
        ? inv.items.map(i => `• **${i.item_name}** x${i.quantity} ${i.expires_at ? `(만료: ${new Date(i.expires_at).toLocaleDateString()})` : ''}`).join('\n')
        : '보관 중인 아이템이 없습니다. `/상점 목록`에서 구매해보세요!';

      embed.addFields(
        { name: '📦 보유 아이템', value: itemsStr, inline: false },
        { name: '⛏️ 드릴 장비 현황', value: `• 강화 단계: **+${inv.drill.enhancement_level}강**\n• 파괴 방지권: **${inv.drill.protection_tickets}개**\n• 오버클럭: ${inv.drill.overclock_until && new Date(inv.drill.overclock_until) > new Date() ? '🟢 활성화 중 (+20%)' : '⚪ 미적용'}`, inline: false }
      );

      return interaction.reply({ embeds: [embed] });
    }
  }
};
