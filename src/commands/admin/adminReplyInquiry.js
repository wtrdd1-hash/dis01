const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { pool } = require('../../config/database');
const config = require('../../config/config');
const { createAdminEmbed, createErrorEmbed } = require('../../utils/embedBuilder');
const { logAdminAction } = require('../../utils/logger');
const { safeImageUrl } = require('../../utils/sanitize');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('admin_reply')
    .setDescription('[관리자] 유저가 제출한 1:1 고객센터 문의에 답변을 등록하고 DM 알림을 전송합니다.')
    .addIntegerOption(option =>
      option.setName('문의번호')
        .setDescription('답변할 문의 티켓 번호 (예: 1, 2, 3...)')
        .setMinValue(1)
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('답변내용')
        .setDescription('유저에게 전송할 답변 내용')
        .setRequired(true)
    ),

  async execute(interaction) {
    if (!config.isAdmin(interaction.user.id)) {
      return interaction.reply({
        embeds: [createErrorEmbed('권한 없음', '이 명령어는 봇 관리자 전용입니다.')],
        flags: MessageFlags.Ephemeral
      });
    }

    const ticketId = interaction.options.getInteger('문의번호');
    const answer = interaction.options.getString('답변내용');
    const adminUsername = interaction.user.username;

    try {
      const [tickets] = await pool.query('SELECT * FROM inquiries WHERE id = ?', [ticketId]);
      if (tickets.length === 0) {
        return interaction.reply({
          embeds: [createErrorEmbed('문의 없음', `티켓 번호 #${ticketId}에 해당하는 문의를 찾을 수 없습니다.`)],
          flags: MessageFlags.Ephemeral
        });
      }

      const ticket = tickets[0];

      await pool.query(`
        UPDATE inquiries 
        SET status = 'ANSWERED', answer = ?, answered_by = ?, answered_at = NOW() 
        WHERE id = ?
      `, [answer, adminUsername, ticketId]);

      // 유저에게 Discord DM 알림 시도
      let dmSuccess = false;
      try {
        const targetUser = await interaction.client.users.fetch(ticket.user_id);
        if (targetUser) {
          const userDmEmbed = new EmbedBuilder()
            .setTitle(`📬 [1:1 고객센터 답변 도착] Ticket #${ticketId}`)
            .setColor(0x10b981)
            .setDescription(`안녕하세요, **${ticket.username}**님!\n등록하신 1:1 문의에 관리자 답변이 등록되었습니다.`)
            .addFields(
              { name: '📌 내 문의 제목', value: ticket.title, inline: false },
              { name: '📝 내 문의 내용', value: ticket.content.length > 500 ? ticket.content.slice(0, 500) + '...' : ticket.content, inline: false },
              { name: '💬 관리자 공식 답변', value: `\`\`\`\n${answer}\n\`\`\``, inline: false }
            );

          const safeImg = safeImageUrl(ticket.image_url);
          if (safeImg) {
            const absoluteImg = safeImg.startsWith('/')
              ? `https://easy-scraping.com${safeImg}`
              : safeImg;
            userDmEmbed.setImage(absoluteImg);
            userDmEmbed.addFields({ name: '🖼️ 첨부하셨던 사진', value: `[사진 다시보기](${absoluteImg})`, inline: false });
          }

          userDmEmbed.setFooter({ text: `답변자: @${adminUsername} · 웹사이트 [내 프로필]에서도 언제든 확인하실 수 있습니다.` });
          userDmEmbed.setTimestamp();

          await targetUser.send({ embeds: [userDmEmbed] });
          dmSuccess = true;
        }
      } catch (dmErr) {
        console.warn(`[Inquiry DM] 유저(${ticket.user_id}) DM 전송 실패:`, dmErr.message);
      }

      logAdminAction(interaction.user.id, adminUsername, 'INQUIRY_REPLY', ticket.user_id, {
        ticketId,
        user: ticket.username,
        answer
      });

      const replyEmbed = createAdminEmbed(
        `1:1 문의 답변 등록 완료 (Ticket #${ticketId})`,
        `**문의 유저:** <@${ticket.user_id}> (${ticket.username})\n` +
        `**문의 제목:** ${ticket.title}\n` +
        `**답변 내용:** ${answer}\n\n` +
        `**유저 DM 알림 전송:** ${dmSuccess ? '✅ 성공적으로 DM 전송됨' : '⚠️ DM 전송 실패 (유저 DM 비활성화 등 - 웹에서 확인 가능)'}`
      );

      await interaction.reply({ embeds: [replyEmbed] });
    } catch (err) {
      console.error('adminReply Error:', err);
      await interaction.reply({
        embeds: [createErrorEmbed('오류 발생', err.message)],
        flags: MessageFlags.Ephemeral
      });
    }
  }
};
