'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const DuckHouseService = require('../../core/economy/DuckHouseService');
const { formatMoney } = require('../../utils/formatters');
const { getOrCreateUser } = require('../../utils/money');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('덕하우스')
    .setDescription('나만의 덕하우스 전시 공간을 조회하고 확장합니다.')
    .addSubcommand(sub =>
      sub
        .setName('보기')
        .setDescription('내 덕하우스 또는 다른 유저의 덕하우스를 조회합니다.')
        .addUserOption(opt =>
          opt
            .setName('유저')
            .setDescription('조회할 대상 유저 (미지정 시 본인)')
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('확장')
        .setDescription('덕하우스 공간을 다음 등급으로 영구 확장합니다.')
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const targetUser = interaction.options.getUser('유저') || interaction.user;
    const targetId = targetUser.id;
    const targetName = targetUser.displayName || targetUser.username;
    await getOrCreateUser(targetId, targetName, targetUser.displayAvatarURL());

    if (subcommand === '보기') {
      await interaction.deferReply();
      try {
        const data = await DuckHouseService.getDuckHouse(targetId);
        const h = data.house;
        const embed = new EmbedBuilder()
          .setColor(0x6366F1)
          .setTitle(`🏰 ${h.houseName} (${targetName}님의 덕하우스)`)
          .setDescription(`**등급**: Lv.${h.level} [${h.levelName}]\n**전시 슬롯**: ${h.maxSlots}개 (현재 배치: ${data.slots.length}개)`)
          .setThumbnail(targetUser.displayAvatarURL())
          .setTimestamp();

        if (data.slots.length > 0) {
          const slotDesc = data.slots.map(s => `• **${s.slotIndex + 1}번 슬롯**: ${s.itemName}`).join('\n');
          embed.addFields({ name: '🖼️ 전시 중인 트로피 & 컬렉션', value: slotDesc, inline: false });
        } else {
          embed.addFields({ name: '🖼️ 전시 슬롯', value: '현재 전시 중인 아이템이 없습니다. 웹 대시보드(/shop)에서 배치하세요!', inline: false });
        }

        if (h.nextLevel) {
          embed.addFields({
            name: '⬆️ 다음 단계 확장 안내',
            value: `> **Lv.${h.nextLevel.level} ${h.nextLevel.name}** (슬롯 ${h.nextLevel.slots}개)\n> 확장 비용: **${formatMoney(h.nextLevel.cost)}**\n> 명령어: \`/덕하우스 확장\``,
            inline: false
          });
        }

        return interaction.editReply({ embeds: [embed] });
      } catch (err) {
        return interaction.editReply(`❌ 덕하우스 조회 실패: ${err.message}`);
      }
    }

    if (subcommand === '확장') {
      await interaction.deferReply();
      try {
        const result = await DuckHouseService.upgradeDuckHouse(interaction.user.id);
        const embed = new EmbedBuilder()
          .setColor(0x10B981)
          .setTitle('🏰 덕하우스 확장 공사 완료!')
          .setDescription(result.message)
          .addFields(
            { name: '새로운 등급', value: `Lv.${result.newLevel}`, inline: true },
            { name: '최대 전시 슬롯', value: `${result.newMaxSlots}개`, inline: true },
            { name: '확장 후 잔액', value: formatMoney(result.newCash), inline: true }
          )
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      } catch (err) {
        return interaction.editReply(`❌ 덕하우스 확장 실패: ${err.message}`);
      }
    }
  }
};
