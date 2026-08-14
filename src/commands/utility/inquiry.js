const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const { pool, getOrCreateUser } = require('../../config/database');
const config = require('../../config/config');
const { createSuccessEmbed, createErrorEmbed } = require('../../utils/embedBuilder');
const { formatMoney } = require('../../utils/formatters');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('문의')
    .setDescription('📩 관리자에게 1:1 문의를 전송합니다. (관리자 Discord DM으로 즉시 전달)')
    .addStringOption(option =>
      option.setName('제목')
        .setDescription('문의할 제목을 간략히 입력하세요')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('내용')
        .setDescription('발생한 문제, 건의사항, 문의 내용을 상세하게 입력하세요')
        .setRequired(true)
    )
    .addStringOption(option =>
      option.setName('분류')
        .setDescription('문의 카테고리를 선택하세요')
        .setRequired(false)
        .addChoices(
          { name: '💬 일반 문의', value: '일반 문의' },
          { name: '🐛 시스템 오류 / 버그 제보', value: '시스템 오류' },
          { name: '💰 경제 시스템 / 계정 복구', value: '경제/계정' },
          { name: '💡 기능 건의 및 제안', value: '기능 건의' },
          { name: '기타 문의', value: '기타' }
        )
    ),

  async execute(interaction) {
    const title = interaction.options.getString('제목').trim();
    const content = interaction.options.getString('내용').trim();
    const category = interaction.options.getString('분류') || '일반 문의';

    const userId = interaction.user.id;
    const username = interaction.user.username;
    const avatar = interaction.user.displayAvatarURL({ dynamic: true });

    if (title.length < 2) {
      return interaction.reply({
        embeds: [createErrorEmbed('입력 오류', '문의 제목을 2글자 이상 입력해주세요.')],
        flags: MessageFlags.Ephemeral
      });
    }

    if (content.length < 5) {
      return interaction.reply({
        embeds: [createErrorEmbed('입력 오류', '문의 내용을 5글자 이상 상세히 입력해주세요.')],
        flags: MessageFlags.Ephemeral
      });
    }

    try {
      const userData = await getOrCreateUser(userId, username, avatar);
      const userCash = BigInt(userData.cash || 0);
      const userBank = BigInt(userData.bank || 0);

      // 주식 평가액 계산
      let stockVal = 0n;
      try {
        const [holdings] = await pool.query(`
          SELECT h.shares, s.price 
          FROM user_stocks h
          JOIN stocks s ON h.stock_id = s.stock_id
          WHERE h.user_id = ?
        `, [userId]);
        for (const h of holdings) {
          stockVal += BigInt(h.shares) * BigInt(h.price);
        }
      } catch (e) {}

      const netWorth = userCash + userBank + stockVal;

      const [result] = await pool.query(`
        INSERT INTO inquiries (user_id, username, avatar, category, title, content, status)
        VALUES (?, ?, ?, ?, ?, ?, 'WAITING')
      `, [userId, username, avatar, category, title, content]);

      const ticketId = result.insertId;

      // 🔔 모든 봇 관리자에게 디스코드 DM으로 실시간 알림 전송
      const client = interaction.client;
      let dmSentCount = 0;

      if (client && client.users) {
        for (const adminId of config.adminIds) {
          try {
            const adminUser = await client.users.fetch(adminId);
            if (adminUser) {
              const dmEmbed = new EmbedBuilder()
                .setTitle(`📩 [새 1:1 고객센터 문의 접수] Ticket #${ticketId}`)
                .setColor(0xf59e0b)
                .setThumbnail(avatar)
                .setDescription(
                  `**작성 유저:** <@${userId}> (\`${username}\` / ID: \`${userId}\`)\n` +
                  `**문의 분류:** \`${category}\`\n` +
                  `**접수 일시:** <t:${Math.floor(Date.now() / 1000)}:F>`
                )
                .addFields(
                  { name: '📌 문의 제목', value: title, inline: false },
                  { name: '📝 상세 문의 내용', value: content.length > 1000 ? content.slice(0, 1000) + '...' : content, inline: false },
                  { 
                    name: '💳 유저 자산 현황', 
                    value: `💵 현금: **${formatMoney(userCash)}** | 🏦 예금: **${formatMoney(userBank)}** | 💎 순자산: **${formatMoney(netWorth)}**`, 
                    inline: false 
                  },
                  {
                    name: '⚡ 빠른 관리자 답장 명령어',
                    value: `\`/admin_reply 문의번호:${ticketId} 답변내용:답변할내용\`\n또는 웹 관리자 패널([easy-scraping.com/admin](https://easy-scraping.com/admin))에서 즉시 답장 가능`,
                    inline: false
                  }
                )
                .setFooter({ text: `월덕 1:1 고객센터 관제 시스템 (Ticket #${ticketId})` })
                .setTimestamp();

              await adminUser.send({ embeds: [dmEmbed] });
              dmSentCount++;
            }
          } catch (dmErr) {
            console.warn(`[Inquiry DM] 관리자(${adminId}) DM 전송 실패:`, dmErr.message);
          }
        }
      }

      const successEmbed = createSuccessEmbed(
        `📩 1:1 문의 접수 완료 (Ticket #${ticketId})`,
        `**${username}**님의 문의가 관리자에게 디스코드 DM으로 안전하게 전달되었습니다!\n\n` +
        `🏷️ **문의 분류:** \`${category}\`\n` +
        `📌 **문의 제목:** **${title}**\n` +
        `📝 **문의 내용:**\n\`\`\`\n${content}\n\`\`\`\n` +
        `💡 관리자가 답변을 등록하면 **디스코드 DM** 및 웹 대시보드([easy-scraping.com](https://easy-scraping.com)) [내 프로필]에서 확인하실 수 있습니다.`
      );

      await interaction.reply({ embeds: [successEmbed], flags: MessageFlags.Ephemeral });
    } catch (err) {
      console.error('Inquiry Command Error:', err);
      await interaction.reply({
        embeds: [createErrorEmbed('접수 오류', '문의 접수 중 오류가 발생했습니다. 잠시 후 다시 시도해주세요.')],
        flags: MessageFlags.Ephemeral
      });
    }
  }
};
