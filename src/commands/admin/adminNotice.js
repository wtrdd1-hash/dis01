'use strict';

const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const config = require('../../config/config');
const {
  createAnnouncement,
  listAnnouncements,
  deleteAnnouncement,
  toggleAnnouncement
} = require('../../utils/announcementService');
const { logAdminAction } = require('../../utils/logger');

const TYPE_CHOICES = [
  { name: '🔥 중요 공지', value: 'IMPORTANT' },
  { name: '🎉 이벤트 안내', value: 'EVENT' },
  { name: '🛠️ 점검 안내', value: 'MAINTENANCE' },
  { name: '📢 일반 공지', value: 'GENERAL' }
];

async function deny(interaction) {
  return interaction.reply({
    content: '❌ 이 명령어는 봇 관리자 전용입니다.',
    flags: MessageFlags.Ephemeral
  });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('admin_notice')
    .setDescription('[관리자] 웹사이트 팝업 공지를 등록하고 관리합니다.')
    .addSubcommand((sub) => sub
      .setName('create')
      .setDescription('웹사이트에 공지와 실시간 팝업을 등록합니다.')
      .addStringOption((option) => option
        .setName('title')
        .setDescription('공지 제목 (최대 200자)')
        .setMaxLength(200)
        .setRequired(true))
      .addStringOption((option) => option
        .setName('content')
        .setDescription('공지 본문')
        .setMaxLength(4000)
        .setRequired(true))
      .addStringOption((option) => option
        .setName('type')
        .setDescription('공지 구분')
        .addChoices(...TYPE_CHOICES)
        .setRequired(false))
      .addBooleanOption((option) => option
        .setName('popup')
        .setDescription('현재 접속자에게 팝업으로 즉시 표시 (기본: 켬)')
        .setRequired(false))
      .addIntegerOption((option) => option
        .setName('hours')
        .setDescription('자동 종료까지 시간 (미입력 시 계속 활성)')
        .setMinValue(1)
        .setMaxValue(720)
        .setRequired(false)))
    .addSubcommand((sub) => sub
      .setName('list')
      .setDescription('최근 공지 목록을 확인합니다.'))
    .addSubcommand((sub) => sub
      .setName('toggle')
      .setDescription('공지를 활성화 또는 비활성화합니다.')
      .addIntegerOption((option) => option
        .setName('id')
        .setDescription('공지 ID')
        .setMinValue(1)
        .setRequired(true)))
    .addSubcommand((sub) => sub
      .setName('delete')
      .setDescription('공지를 영구 삭제합니다.')
      .addIntegerOption((option) => option
        .setName('id')
        .setDescription('공지 ID')
        .setMinValue(1)
        .setRequired(true))
      .addBooleanOption((option) => option
        .setName('confirm')
        .setDescription('삭제 확인')
        .setRequired(true))),

  async execute(interaction) {
    if (!config.isAdmin(interaction.user.id)) return deny(interaction);

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const subcommand = interaction.options.getSubcommand();
    const adminName = interaction.user.globalName || interaction.user.username || 'ADMIN';

    try {
      if (subcommand === 'create') {
        const popupOption = interaction.options.getBoolean('popup');
        const hours = interaction.options.getInteger('hours');
        const endsAt = hours ? new Date(Date.now() + hours * 60 * 60 * 1000) : null;
        const notice = await createAnnouncement({
          title: interaction.options.getString('title'),
          content: interaction.options.getString('content'),
          type: interaction.options.getString('type') || 'GENERAL',
          isPopup: popupOption !== false,
          endsAt,
          author: adminName
        });
        await logAdminAction(interaction.user.id, adminName, 'DISCORD_ANNOUNCEMENT_CREATE', String(notice.id), {
          title: notice.title,
          type: notice.type,
          popup: notice.is_popup,
          hours: hours || null
        });
        return interaction.editReply(
          `✅ 공지 #${notice.id} 등록 완료\n` +
          `**${notice.title}** · ${notice.type} · 팝업 ${notice.is_popup ? 'ON' : 'OFF'}`
        );
      }

      if (subcommand === 'list') {
        const rows = await listAnnouncements(10);
        if (!rows.length) return interaction.editReply('등록된 공지가 없습니다.');
        const lines = rows.map((row) => {
          const state = row.is_active ? '🟢' : '⚫';
          const popup = row.is_popup ? '팝업' : '목록';
          return `${state} #${row.id} [${row.type}] ${String(row.title).slice(0, 80)} (${popup})`;
        });
        return interaction.editReply(`📢 **최근 공지**\n${lines.join('\n')}`);
      }

      const id = interaction.options.getInteger('id');
      if (subcommand === 'toggle') {
        const updated = await toggleAnnouncement(id);
        if (!updated) return interaction.editReply(`❌ 공지 #${id}를 찾을 수 없습니다.`);
        await logAdminAction(interaction.user.id, adminName, 'DISCORD_ANNOUNCEMENT_TOGGLE', String(id), {
          active: !!updated.is_active
        });
        return interaction.editReply(`✅ 공지 #${id}를 ${updated.is_active ? '활성화' : '비활성화'}했습니다.`);
      }

      if (subcommand === 'delete') {
        if (interaction.options.getBoolean('confirm') !== true) {
          return interaction.editReply('❌ 삭제하려면 `confirm:true`를 선택해야 합니다.');
        }
        const deleted = await deleteAnnouncement(id);
        if (!deleted) return interaction.editReply(`❌ 공지 #${id}를 찾을 수 없습니다.`);
        await logAdminAction(interaction.user.id, adminName, 'DISCORD_ANNOUNCEMENT_DELETE', String(id));
        return interaction.editReply(`✅ 공지 #${id}를 삭제했습니다.`);
      }

      return interaction.editReply('❌ 지원하지 않는 하위 명령입니다.');
    } catch (err) {
      return interaction.editReply(`❌ 공지 처리 실패: ${err.message || '알 수 없는 오류'}`);
    }
  }
};
