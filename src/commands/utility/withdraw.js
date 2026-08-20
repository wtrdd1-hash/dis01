'use strict';

const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } = require('discord.js');
const { withdrawUserAccount } = require('../../utils/userWithdrawEngine');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('탈퇴')
    .setDescription('월덕 가상 경제 서비스 회원 탈퇴 및 모든 개인정보/가상 자산을 영구 삭제합니다.'),

  async execute(interaction) {
    const userId = interaction.user.id;
    const username = interaction.user.username;

    const warnEmbed = new EmbedBuilder()
      .setColor(0xEF4444)
      .setTitle('⚠️ 회원 탈퇴 및 데이터 영구 파기 안내')
      .setDescription(`**@${username}** 님, 정말로 서비스를 탈퇴하시겠습니까?\n\n탈퇴 시 아래의 모든 데이터가 **즉시 영구 삭제**되며, **어떠한 경우에도 복구할 수 없습니다.**`)
      .addFields(
        { name: '💵 가상 자산', value: '• 보유 현금 및 은행 예치금 전액 소멸\n• 보유 주식 및 사업체 전액 소멸', inline: true },
        { name: '📊 기록 및 데이터', value: '• 도박/거래/랭킹 내역 영구 삭제\n• 디스코드 계정 연동 정보 삭제', inline: true }
      )
      .setFooter({ text: '신중히 결정해 주세요. (60초 후 자동 취소됩니다)' })
      .setTimestamp();

    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId('confirm_withdraw')
        .setLabel('🔴 영구 탈퇴 및 데이터 전체 삭제')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId('cancel_withdraw')
        .setLabel('취소 (계속 이용하기)')
        .setStyle(ButtonStyle.Secondary)
    );

    const replyMsg = await interaction.reply({
      embeds: [warnEmbed],
      components: [row],
      ephemeral: true,
      fetchReply: true
    });

    const collector = replyMsg.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: 60000,
      filter: (i) => i.user.id === userId
    });

    collector.on('collect', async (i) => {
      if (i.customId === 'cancel_withdraw') {
        await i.update({
          content: '✅ 회원 탈퇴가 취소되었습니다. 계속해서 서비스를 이용하실 수 있습니다.',
          embeds: [],
          components: []
        });
        return;
      }

      if (i.customId === 'confirm_withdraw') {
        try {
          await withdrawUserAccount(userId, '디스코드 /탈퇴 명령어 실행');

          const successEmbed = new EmbedBuilder()
            .setColor(0x10B981)
            .setTitle('👋 회원 탈퇴 완료')
            .setDescription(`**@${username}** 님의 회원 탈퇴 및 모든 가상 자산, 개인정보 데이터가 성공적으로 영구 파기되었습니다.\n\n그동안 서비스를 이용해 주셔서 진심으로 감사드립니다. 언제든 새로운 마음으로 다시 시작하실 수 있습니다.`)
            .setTimestamp();

          await i.update({
            embeds: [successEmbed],
            components: []
          });
        } catch (err) {
          await i.update({
            content: `❌ 탈퇴 처리 중 오류가 발생했습니다: ${err.message}`,
            embeds: [],
            components: []
          });
        }
      }
    });

    collector.on('end', async (collected, reason) => {
      if (reason === 'time' && collected.size === 0) {
        try {
          await interaction.editReply({
            content: '⏱️ 탈퇴 확인 시간이 만료되어 자동으로 취소되었습니다.',
            embeds: [],
            components: []
          });
        } catch (e) {}
      }
    });
  }
};
