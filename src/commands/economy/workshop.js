'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const WorkshopService = require('../../core/economy/WorkshopService');
const { formatMoney } = require('../../utils/formatters');
const { getOrCreateUser } = require('../../utils/money');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('제작소')
    .setDescription('컬렉션 제작소에서 아이템을 분해하고 100% 확정 제작을 진행합니다.')
    .addSubcommand(sub =>
      sub
        .setName('목록')
        .setDescription('제작 가능한 확정 레시피 및 보유 황금 깃털 조각을 확인합니다.')
    )
    .addSubcommand(sub =>
      sub
        .setName('제작')
        .setDescription('재료와 제작비를 소모하여 아이템을 확정 제작합니다.')
        .addStringOption(opt =>
          opt
            .setName('레시피키')
            .setDescription('제작할 레시피 키 (예: craft_collector_bronze, craft_duck_statue)')
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
        const [recipes, materials] = await Promise.all([
          WorkshopService.listRecipes(),
          WorkshopService.getUserMaterials(userId)
        ]);

        const embed = new EmbedBuilder()
          .setColor(0xF59E0B)
          .setTitle('🔨 월덕 컬렉션 제작소 (Workshop)')
          .setDescription(`내 보유 재료: **🪶 황금 깃털 조각 ${materials.goldenFeatherShards}개**\n\n*중복/미사용 아이템을 웹(/shop)에서 분해하여 조각을 획득하고 영구 컬렉션을 제작하세요!*`)
          .setTimestamp();

        for (const r of recipes) {
          embed.addFields({
            name: `${r.icon} ${r.name} [${r.rarity}] (${r.recipeKey})`,
            value: `> **필요 재료**: 🪶 ${r.materialCost}개 | **제작비**: ${formatMoney(r.cashCost)} (소각)\n> *${r.description || ''}*`,
            inline: false
          });
        }

        return interaction.editReply({ embeds: [embed] });
      } catch (err) {
        return interaction.editReply(`❌ 제작소 조회 오류: ${err.message}`);
      }
    }

    if (subcommand === '제작') {
      const recipeKey = interaction.options.getString('레시피키').trim();
      await interaction.deferReply();
      try {
        const result = await WorkshopService.craftItem(userId, recipeKey);
        const embed = new EmbedBuilder()
          .setColor(0x10B981)
          .setTitle('🎉 제작 성공!')
          .setDescription(result.message)
          .addFields(
            { name: '완성 아이템', value: `${result.resultItem.icon} ${result.resultItem.name}`, inline: true },
            { name: '남은 황금 깃털 조각', value: `🪶 ${result.remainingShards}개`, inline: true },
            { name: '제작 후 잔액', value: formatMoney(result.newCash), inline: true }
          )
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      } catch (err) {
        return interaction.editReply(`❌ 제작 실패: ${err.message}`);
      }
    }
  }
};
