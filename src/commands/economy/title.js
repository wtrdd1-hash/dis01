'use strict';

const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const CosmeticLoadoutService = require('../../core/economy/CosmeticLoadoutService');
const { getOrCreateUser } = require('../../utils/money');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('칭호')
    .setDescription('내가 보유한 칭호 목록을 확인하고 원하는 칭호를 장착하거나 변경합니다.')
    .addSubcommand(sub =>
      sub.setName('목록')
        .setDescription('내 보유 칭호 목록 및 현재 장착된 칭호를 확인합니다.')
    )
    .addSubcommand(sub =>
      sub.setName('장착')
        .setDescription('보유 중인 칭호를 선택하여 장착합니다.')
        .addStringOption(opt =>
          opt.setName('칭호이름')
            .setDescription('장착할 칭호 이름 또는 키워드 (예: 버거, 테스터, 버그악용자, 내꼬리)')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub.setName('해제')
        .setDescription('현재 장착된 칭호를 해제합니다.')
    ),

  async execute(interaction) {
    const userId = interaction.user.id;
    const username = interaction.user.displayName || interaction.user.username;
    await getOrCreateUser(userId, username, interaction.user.displayAvatarURL());

    const sub = interaction.options.getSubcommand();

    if (sub === '목록') {
      const data = await CosmeticLoadoutService.getUserLoadout(userId);
      const equippedTitle = data.loadout?.TITLE;
      const titleItems = (data.items || []).filter(i => i.itemType === 'TITLE');

      const embed = new EmbedBuilder()
        .setColor(0x38BDF8)
        .setTitle('👑 [나의 명예 칭호 보관함]')
        .setDescription(
          `**현재 장착된 칭호:** ${equippedTitle ? `**\`[${equippedTitle.name}]\`** ${equippedTitle.icon}` : '*(미장착)*'}\n\n` +
          `**보유 칭호 목록 (${titleItems.length}개):**\n` +
          (titleItems.length > 0
            ? titleItems.map((t, idx) => `${idx + 1}. ${t.icon} **\`[${t.name}]\`** ${t.isPermanent ? '(영구)' : ''}`).join('\n')
            : '보유한 칭호가 없습니다.')
        )
        .setFooter({ text: '💡 /칭호 장착 [칭호이름] 명령어로 원하는 칭호로 언제든 변경할 수 있습니다.' })
        .setTimestamp();

      return interaction.reply({ embeds: [embed] });
    }

    if (sub === '장착') {
      const query = interaction.options.getString('칭호이름').trim().toLowerCase();
      const data = await CosmeticLoadoutService.getUserLoadout(userId);
      const titleItems = (data.items || []).filter(i => i.itemType === 'TITLE');

      const target = titleItems.find(t => 
        t.name.toLowerCase().includes(query) || 
        t.itemKey.toLowerCase().includes(query)
      );

      if (!target) {
        return interaction.reply({
          content: `❌ \`${query}\` 에 해당하는 보유 칭호를 찾을 수 없습니다.\n\`/칭호 목록\` 명령어로 보유 칭호를 먼저 확인하세요.`,
          ephemeral: true
        });
      }

      try {
        await CosmeticLoadoutService.equipItem(userId, 'TITLE', target.itemKey);
        const embed = new EmbedBuilder()
          .setColor(0x10B981)
          .setTitle('✨ [칭호 장착 완료]')
          .setDescription(`**<@${userId}>** 님의 대표 칭호가 **\`[${target.name}]\`** (으)로 변경되었습니다!\n\n랭킹 및 프로필에 즉시 반영됩니다.`)
          .setTimestamp();

        return interaction.reply({ embeds: [embed] });
      } catch (err) {
        return interaction.reply({ content: `❌ 장착 실패: ${err.message}`, ephemeral: true });
      }
    }

    if (sub === '해제') {
      try {
        await CosmeticLoadoutService.unequipSlot(userId, 'TITLE');
        return interaction.reply({ content: '✅ 칭호 장착을 해제했습니다.', ephemeral: true });
      } catch (err) {
        return interaction.reply({ content: `❌ 해제 실패: ${err.message}`, ephemeral: true });
      }
    }
  }
};
