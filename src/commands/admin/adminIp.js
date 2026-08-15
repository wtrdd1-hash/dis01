const { SlashCommandBuilder, MessageFlags, EmbedBuilder } = require('discord.js');
const config = require('../../config/config');
const { createAdminEmbed, createErrorEmbed, createSuccessEmbed } = require('../../utils/embedBuilder');
const { getBannedIpsList, unbanIp, banIp, WHITELIST_IPS } = require('../../web/security');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('아이피')
    .setDescription('[관리자] 웹 보안 IP 차단/해제 및 목록을 관리합니다.')
    .addSubcommand(sub =>
      sub
        .setName('목록')
        .setDescription('현재 차단된 IP 목록 및 화이트리스트 보호 IP를 확인합니다.')
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
    // 관리자 권한 확인
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

      // 화이트리스트 필드
      embed.addFields({
        name: '🛡️ 화이트리스트 (절대 차단 불가 IP)',
        value: whitelistArr.map(ip => `• \`${ip}\``).join('\n') || '없음',
        inline: false
      });

      // 차단 목록 필드
      if (bannedList.length === 0) {
        embed.addFields({
          name: '🚫 현재 차단된 IP 목록 (0개)',
          value: '✅ 현재 차단된 IP가 없습니다.',
          inline: false
        });
      } else {
        const banItems = bannedList.slice(0, 15).map((b, idx) => {
          return `**${idx + 1}.** \`${b.ip}\` | 사유: *${b.reason}* | 남은 시간: **${b.remainingMinutes}분** (차단일시: ${b.bannedAt})`;
        }).join('\n\n');

        embed.addFields({
          name: `🚫 현재 차단된 IP 목록 (총 ${bannedList.length}개)`,
          value: banItems + (bannedList.length > 15 ? `\n...외 ${bannedList.length - 15}개` : ''),
          inline: false
        });
      }

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
      } else {
        return interaction.reply({
          embeds: [createErrorEmbed('차단 해제 실패', `⚠️ IP \`${targetIp}\`는 현재 차단 목록에 등록되어 있지 않습니다.`)],
          flags: MessageFlags.Ephemeral
        });
      }
    }

    if (subcommand === '차단') {
      const targetIp = interaction.options.getString('ip').trim();
      const reason = interaction.options.getString('사유') || '관리자 수동 차단';
      const duration = interaction.options.getInteger('시간') || 1440;

      const result = banIp(targetIp, reason, duration);

      if (result.success) {
        return interaction.reply({
          embeds: [createSuccessEmbed('IP 수동 차단 완료', `${result.message}\n📌 **사유:** ${reason}\n⏱️ **차단 기간:** ${duration}분`)],
          flags: MessageFlags.Ephemeral
        });
      } else {
        return interaction.reply({
          embeds: [createErrorEmbed('IP 차단 실패', result.message)],
          flags: MessageFlags.Ephemeral
        });
      }
    }
  }
};
