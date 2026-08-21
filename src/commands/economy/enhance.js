'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getDrillEquipment, enhanceDrill, applyOverclockOil, ENHANCE_TABLE } = require('../../utils/enhancementEngine');
const { formatMoney } = require('../../utils/formatters');
const { getOrCreateUser } = require('../../utils/money');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('강화')
    .setDescription('채굴 드릴 장비를 강화하여 채굴 효율을 파격적으로 향상시킵니다 (+1 ~ +15강).')
    .addSubcommand(sub =>
      sub
        .setName('시도')
        .setDescription('드릴 강화를 1회 시도합니다.')
        .addBooleanOption(opt =>
          opt.setName('파괴방지권')
            .setDescription('보유 중인 파괴 방지권을 사용하여 하락 및 초기화를 막습니다.')
            .setRequired(false)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('정보')
        .setDescription('내 드릴 강화 상태 및 단계별 성공 확률/비용 표를 확인합니다.')
    )
    .addSubcommand(sub =>
      sub
        .setName('오버클럭')
        .setDescription('인벤토리에 보유 중인 오버클럭 냉각유를 주입하여 24시간 동안 채굴 효율 +20%를 얻습니다.')
    ),

  async execute(interaction) {
    const subcommand = interaction.options.getSubcommand();
    const userId = interaction.user.id;
    const username = interaction.user.displayName || interaction.user.username;
    await getOrCreateUser(userId, username, interaction.user.displayAvatarURL());

    if (subcommand === '정보') {
      const drill = await getDrillEquipment(userId);
      const nextLevel = drill.enhancementLevel + 1;
      const nextInfo = ENHANCE_TABLE.find(t => t.level === nextLevel);

      const embed = new EmbedBuilder()
        .setColor(0x3B82F6)
        .setTitle(`⚡ [대장간] @${username} 님의 채굴 드릴 정보`)
        .setDescription(`현재 드릴 강화 단계: **+${drill.enhancementLevel}강** (채굴 효율 **+${drill.bonusPercent}%**)\n🛡️ 보유 파괴 방지권: **${drill.protectionTickets}장**\n🛢️ 오버클럭 부스트: ${drill.isOverclocked ? '🟢 활성화 중 (+20%)' : '⚪ 미적용'}`)
        .setTimestamp();

      if (nextInfo) {
        embed.addFields({
          name: `다음 강화 도전: [+${nextLevel}강]`,
          value: `• 필요 비용: **${formatMoney(nextInfo.cost)}**\n• 성공 확률: **${nextInfo.rate}%**\n• 실패 페널티: \`${nextInfo.failPenalty}\`\n• 성공 시 추가 버프: **+${nextInfo.bonus}%**`,
          inline: false
        });
      } else {
        embed.addFields({ name: '👑 최고 등급 달성', value: '드릴이 이미 최종 단계(+15강)에 도달했습니다!', inline: false });
      }

      return interaction.reply({ embeds: [embed] });
    }

    if (subcommand === '시도') {
      const useProtection = interaction.options.getBoolean('파괴방지권') || false;
      try {
        const result = await enhanceDrill(userId, username, useProtection);
        const isSuccess = result.success;

        const embed = new EmbedBuilder()
          .setColor(isSuccess ? 0x10B981 : 0xEF4444)
          .setTitle(isSuccess ? '✨ 드릴 강화 대성공!' : '💥 드릴 강화 실패...')
          .setDescription(result.message)
          .addFields(
            { name: '이전 단계', value: `+${result.previousLevel}강`, inline: true },
            { name: '현재 단계', value: `**+${result.currentLevel}강**`, inline: true },
            { name: '소모 비용', value: `-${formatMoney(result.cost)}`, inline: true },
            { name: '잔여 현금', value: formatMoney(result.afterCash), inline: true }
          )
          .setTimestamp();

        return interaction.reply({ embeds: [embed] });
      } catch (err) {
        return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
      }
    }

    if (subcommand === '오버클럭') {
      try {
        const result = await applyOverclockOil(userId);
        return interaction.reply({ content: `✅ ${result.message}` });
      } catch (err) {
        return interaction.reply({ content: `❌ ${err.message}`, ephemeral: true });
      }
    }
  }
};
