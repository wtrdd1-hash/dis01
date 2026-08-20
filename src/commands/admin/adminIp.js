const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const config = require('../../config/config');
const { createErrorEmbed, createSuccessEmbed } = require('../../utils/embedBuilder');
const { getBannedIpsList, unbanIp, banIp, WHITELIST_IPS } = require('../../web/security');
const { lookupIp, isValidIp } = require('../../utils/geoIp');
const { pool } = require('../../config/database');

function formatGeoField(geo) {
  const loc = [geo.countryName || geo.country, geo.city].filter(Boolean).join(' / ');
  return `${geo.flag} **${loc || '알 수 없음'}**\nIP: \`${geo.ip}\`${geo.timezone ? `\n시간대: ${geo.timezone}` : ''}`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('아이피')
    .setDescription('[관리자] 웹 보안 IP 차단/해제 및 국가 조회를 관리합니다.')
    .addSubcommand(sub =>
      sub
        .setName('목록')
        .setDescription('현재 차단된 IP 목록 및 화이트리스트 보호 IP를 확인합니다.')
    )
    .addSubcommand(sub =>
      sub
        .setName('조회')
        .setDescription('IP 주소의 국가·도시 정보를 조회합니다.')
        .addStringOption(opt =>
          opt
            .setName('ip')
            .setDescription('조회할 IP 주소')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('유저')
        .setDescription('특정 유저의 최근 웹 접속 IP·국가를 조회합니다.')
        .addStringOption(opt =>
          opt
            .setName('대상')
            .setDescription('Discord ID 또는 닉네임')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('해제')
        .setDescription('차단된 특정 IP의 차단을 즉시 해제합니다.')
        .addStringOption(opt =>
          opt
            .setName('ip')
            .setDescription('차단 해제할 IP 주소 (예: 23.234.116.83)')
            .setRequired(true)
        )
    )
    .addSubcommand(sub =>
      sub
        .setName('차단')
        .setDescription('특정 악성 IP를 수동으로 차단합니다.')
        .addStringOption(opt =>
          opt
            .setName('ip')
            .setDescription('차단할 IP 주소')
            .setRequired(true)
        )
        .addStringOption(opt =>
          opt
            .setName('사유')
            .setDescription('차단 사유 (기본: 관리자 수동 차단)')
            .setRequired(false)
        )
        .addIntegerOption(opt =>
          opt
            .setName('시간')
            .setDescription('차단 시간(분 단위, 기본: 1440분 / 24시간)')
            .setRequired(false)
        )
    ),

  async execute(interaction) {
    if (!config.isAdmin(interaction.user.id)) {
      return interaction.reply({
        embeds: [createErrorEmbed('권한 없음', '이 명령어는 봇 관리자 전용입니다.')],
        flags: MessageFlags.Ephemeral
      });
    }

    const subcommand = interaction.options.getSubcommand();

    if (subcommand === '목록') {
      const bannedList = getBannedIpsList();
      const whitelistArr = Array.from(WHITELIST_IPS);

      const embed = new EmbedBuilder()
        .setColor(0x2B2D31)
        .setTitle('🛡️ 웹 보안 IP 관리 현황')
        .setTimestamp();

      embed.addFields({
        name: '🛡️ 화이트리스트 (절대 차단 불가 IP)',
        value: whitelistArr.map(ip => `• \`${ip}\``).join('\n') || '없음',
        inline: false
      });

      if (bannedList.length === 0) {
        embed.addFields({
          name: '🚫 현재 차단된 IP 목록 (0개)',
          value: '✅ 현재 차단된 IP가 없습니다.',
          inline: false
        });
      } else {
        const banItems = bannedList.slice(0, 15).map((b, idx) => {
          const geo = lookupIp(b.ip);
          return `**${idx + 1}.** \`${b.ip}\` ${geo.flag} ${geo.countryName} | 사유: *${b.reason}* | 남은 시간: **${b.remainingMinutes}분**`;
        }).join('\n\n');

        embed.addFields({
          name: `🚫 현재 차단된 IP 목록 (총 ${bannedList.length}개)`,
          value: banItems + (bannedList.length > 15 ? `\n...외 ${bannedList.length - 15}개` : ''),
          inline: false
        });
      }

      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    if (subcommand === '조회') {
      const targetIp = interaction.options.getString('ip').trim();
      if (!isValidIp(targetIp)) {
        return interaction.reply({
          embeds: [createErrorEmbed('조회 실패', `\`${targetIp}\`는 올바른 IP 주소가 아닙니다.`)],
          flags: MessageFlags.Ephemeral
        });
      }
      const geo = lookupIp(targetIp);
      const embed = new EmbedBuilder()
        .setColor(0x38bdf8)
        .setTitle('🌐 IP 국가·도시 조회')
        .setDescription(formatGeoField(geo))
        .setTimestamp();
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    if (subcommand === '유저') {
      const q = interaction.options.getString('대상').trim();
      const like = `%${q.replace(/[%_]/g, '')}%`;
      const [rows] = await pool.query(`
        SELECT ip, country, country_name, city, url, created_at, user_id, username
        FROM web_access_logs
        WHERE user_id = ? OR username = ? OR username LIKE ?
        ORDER BY id DESC
        LIMIT 10
      `, [q, q, like]);

      if (!rows || rows.length === 0) {
        return interaction.reply({
          embeds: [createErrorEmbed('조회 결과 없음', `\`${q}\` 유저의 최근 웹 접속 기록이 없습니다.`)],
          flags: MessageFlags.Ephemeral
        });
      }

      const lines = rows.map((row, idx) => {
        const geo = row.ip && row.ip !== 'DELETED' ? lookupIp(row.ip) : null;
        const flag = geo ? geo.flag : '🌐';
        const country = row.country_name || (geo && geo.countryName) || row.country || '알 수 없음';
        const when = row.created_at ? new Date(row.created_at).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '-';
        return `**${idx + 1}.** ${flag} \`${row.ip}\` · ${country}\n${when} · \`${row.url || '-'}\``;
      }).join('\n\n');

      const embed = new EmbedBuilder()
        .setColor(0x38bdf8)
        .setTitle(`🌐 유저 접속 IP · @${rows[0].username || q}`)
        .setDescription(lines.slice(0, 4000))
        .setFooter({ text: `Discord ID: ${rows[0].user_id || q}` })
        .setTimestamp();
      return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }

    if (subcommand === '해제') {
      const targetIp = interaction.options.getString('ip').trim();
      const success = unbanIp(targetIp);

      if (success) {
        return interaction.reply({
          embeds: [createSuccessEmbed('IP 차단 해제 완료', `✅ IP \`${targetIp}\`의 차단이 성공적으로 해제되었습니다. 이제 정상 접속할 수 있습니다.`)],
          flags: MessageFlags.Ephemeral
        });
      }
      return interaction.reply({
        embeds: [createErrorEmbed('차단 해제 실패', `⚠️ IP \`${targetIp}\`는 현재 차단 목록에 등록되어 있지 않습니다.`)],
        flags: MessageFlags.Ephemeral
      });
    }

    if (subcommand === '차단') {
      const targetIp = interaction.options.getString('ip').trim();
      const reason = interaction.options.getString('사유') || '관리자 수동 차단';
      const duration = interaction.options.getInteger('시간') || 1440;

      const result = banIp(targetIp, reason, duration);

      if (result.success) {
        const geo = lookupIp(result.ip || targetIp);
        return interaction.reply({
          embeds: [createSuccessEmbed('IP 수동 차단 완료', `${result.message}\n${formatGeoField(geo)}\n📌 **사유:** ${reason}\n⏱️ **차단 기간:** ${duration}분`)],
          flags: MessageFlags.Ephemeral
        });
      }
      return interaction.reply({
        embeds: [createErrorEmbed('IP 차단 실패', result.message)],
        flags: MessageFlags.Ephemeral
      });
    }
  }
};
