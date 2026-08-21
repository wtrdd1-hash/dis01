'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const PrestigeShopService = require('../../core/economy/PrestigeShopService');
const { formatMoney } = require('../../utils/formatters');
const { getOrCreateUser } = require('../../utils/money');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('명예상점')
    .setDescription('주간 로테이션 명예 상점에서 외형 및 배지 상품을 구매합니다.')
    .addSubcommand(sub =>
      sub
        .setName('목록')
        .setDescription('현재 판매 중인 주간 명예 상점 상품 목록을 확인합니다.')
    )
    .addSubcommand(sub =>
      sub
        .setName('구매')
        .setDescription('명예 상점 상품을 구매합니다.')
        .addStringOption(opt =>
          opt
            .setName('상품키')
            .setDescription('구매할 상품 키 (예: color_neon_cyan, frame_cyber_circuit)')
            .setRequired(true)
        )
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const userId = interaction.user.id;
    const username = interaction.user.displayName || interaction.user.username;
    await getOrCreateUser(userId, username, interaction.user.displayAvatarURL());

    if (subcommand === '목록') {
      await interaction.deferReply();
      try {
        const items = await PrestigeShopService.listCatalog({ userId, activeOnly: true });
        const embed = new EmbedBuilder()
          .setColor(0xA855F7)
          .setTitle('✨ 월덕 주간 명예 상점 (Weekly Prestige Store)')
          .setDescription('매주 로테이션되는 특별한 닉네임 컬러, 프로필 테두리, 덕하우스 스킨 및 명판 배지를 만나보세요!\n*모든 구매 대금은 시장에서 100% 완전 소각됩니다.*')
          .setTimestamp();

        for (const item of items.slice(0, 10)) {
          const durText = item.isPermanent ? '영구 보유' : `${item.durationSeconds / 86400}일`;
          const status = item.isOwned ? (item.isPermanent ? '✅ 보유중' : '⏳ 사용중 (연장가능)') : '🛒 구매가능';
          embed.addFields({
            name: `${item.icon} ${item.name} [${item.rarity}] (${item.itemKey})`,
            value: `> **가격**: ${formatMoney(item.price)} | **기간**: ${durText}\n> **상태**: ${status}\n> *${item.description || ''}*`,
            inline: false
          });
        }

        return interaction.editReply({ embeds: [embed] });
      } catch (err) {
        return interaction.editReply(`❌ 카탈로그 조회 오류: ${err.message}`);
      }
    }

    if (subcommand === '구매') {
      const itemKey = interaction.options.getString('상품키').trim();
      await interaction.deferReply();
      try {
        const result = await PrestigeShopService.purchaseItem(userId, itemKey);
        const embed = new EmbedBuilder()
          .setColor(0x10B981)
          .setTitle('🎉 명예 상점 구매 완료!')
          .setDescription(result.message)
          .addFields(
            { name: '상품명', value: result.item.name, inline: true },
            { name: '유효 기간', value: result.item.isPermanent ? '영구' : `${result.item.durationSeconds / 86400}일`, inline: true },
            { name: '구매 후 잔액', value: formatMoney(result.newCash), inline: true }
          )
          .setFooter({ text: '웹 대시보드(/shop)의 [외형 로드아웃] 탭에서 즉시 장착할 수 있습니다.' })
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      } catch (err) {
        return interaction.editReply(`❌ 구매 실패: ${err.message}`);
      }
    }
  }
};
