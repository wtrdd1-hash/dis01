const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const config = require('../../config/config');
const { createAdminEmbed, createErrorEmbed } = require('../../utils/embedBuilder');
const { createDatabaseBackup, listBackups } = require('../../utils/backupEngine');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('admin_backup')
    .setDescription('[관리자] MySQL 데이터베이스 백업을 즉시 생성하거나 목록을 조회합니다.')
    .addSubcommand(subcommand =>
      subcommand
        .setName('create')
        .setDescription('지금 즉시 전체 데이터베이스 백업 파일(.sql.gz)을 생성합니다.')
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('list')
        .setDescription('서버에 보관된 최신 DB 백업 파일 목록을 조회합니다.')
    ),

  async execute(interaction) {
    if (!config.isAdmin(interaction.user.id)) {
      return interaction.reply({
        embeds: [createErrorEmbed('권한 없음', '이 명령어는 봇 관리자 전용입니다.')],
        flags: MessageFlags.Ephemeral
      });
    }

    const sub = interaction.options.getSubcommand();

    if (sub === 'create') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const res = await createDatabaseBackup({
          reason: 'DISCORD_COMMAND_MANUAL',
          triggeredBy: `@${interaction.user.username} (${interaction.user.id})`
        });

        const embed = createAdminEmbed(
          '💾 데이터베이스 백업 생성 완료',
          `**파일명:** \`${res.filename}\`\n` +
          `**백업 용량:** **${res.sizeMb}**\n` +
          `**생성 시각:** ${new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })}\n\n` +
          `✅ 전체 사용자 자산, 주식 장부, 세금 국고 데이터가 안전하게 압축 백업되었습니다.\n` +
          `🌐 관리자 콘솔 웹에서도 다운로드가 가능합니다.`
        );

        return interaction.editReply({ embeds: [embed] });
      } catch (err) {
        return interaction.editReply({
          embeds: [createErrorEmbed('백업 생성 실패', err.message || '데이터베이스 덤프 처리 중 오류가 발생했습니다.')]
        });
      }
    }

    if (sub === 'list') {
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      try {
        const backups = await listBackups();
        if (!backups.length) {
          return interaction.editReply({
            embeds: [createAdminEmbed('💾 DB 백업 보관소', '현재 저장된 백업 파일이 없습니다.')]
          });
        }

        const top10 = backups.slice(0, 8).map((b, idx) => {
          const dateStr = new Date(b.createdAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' });
          return `**${idx + 1}.** \`${b.filename}\` (${b.sizeFormatted}) - ⏱️ ${dateStr}`;
        }).join('\n');

        const embed = createAdminEmbed(
          '💾 데이터베이스 백업 보관소 현황',
          `**총 보관 백업 수:** **${backups.length}개**\n` +
          `**자동 백업 주기:** **매 6시간마다 자동 생성** (30일 초과 시 자동 정리)\n\n` +
          `**[최근 백업 파일 목록]**\n${top10}`
        );

        return interaction.editReply({ embeds: [embed] });
      } catch (err) {
        return interaction.editReply({
          embeds: [createErrorEmbed('목록 조회 실패', err.message)]
        });
      }
    }
  }
};
