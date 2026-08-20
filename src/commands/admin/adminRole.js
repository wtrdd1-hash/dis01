'use strict';
/**
 * 👑 [관리자] 관리자 계정 추가/제거/목록 명령어
 *
 * DB의 admin_roles 테이블을 통해 런타임에 관리자를 추가/제거할 수 있다.
 * .env의 ADMIN_IDS와 합집합으로 적용되며, reloadAdminIds() 호출로 즉시 반영.
 *
 * ⚠️ 이 명령은 "초대된 다른 관리자"도 실행할 수 있으므로,
 *    한 명 이상의 .env 관리자가 항상 존재하도록 운영해야 한다.
 */

const { SlashCommandBuilder, MessageFlags, PermissionFlagsBits } = require('discord.js');
const { pool } = require('../../config/database');
const config = require('../../config/config');

async function logAdminAction(adminId, adminUsername, action, targetUserId, details = null) {
  try {
    await pool.query(
      `INSERT INTO admin_logs (admin_id, admin_username, action, target_user_id, details)
       VALUES (?, ?, ?, ?, ?)`,
      [String(adminId), adminUsername || 'admin', action, targetUserId ? String(targetUserId) : null, details ? JSON.stringify(details) : null]
    );
  } catch (e) {
    // admin_logs 누락 시 무시 (로그 실패가 명령을 막지 않도록)
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('admin_role')
    .setDescription('[관리자] 관리자 계정을 추가/제거/목록으로 관리합니다.')
    .addSubcommand(sub =>
      sub.setName('add')
        .setDescription('특정 유저를 관리자로 추가합니다.')
        .addUserOption(opt => opt.setName('유저').setDescription('관리자로 추가할 유저').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('remove')
        .setDescription('특정 유저를 관리자에서 제거합니다.')
        .addUserOption(opt => opt.setName('유저').setDescription('관리자에서 제거할 유저').setRequired(true))
    )
    .addSubcommand(sub =>
      sub.setName('list')
        .setDescription('현재 등록된 모든 관리자 목록을 표시합니다.')
    )
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

  async execute(interaction) {
    if (!config.isAdmin(interaction.user.id)) {
      return interaction.reply({
        embeds: [{
          color: 0xef4444,
          title: '❌ 권한 없음',
          description: '이 명령어는 봇 관리자 전용입니다.',
          timestamp: new Date()
        }],
        flags: MessageFlags.Ephemeral
      });
    }

    const sub = interaction.options.getSubcommand();
    const guildId = interaction.guild?.id;

    if (sub === 'add') {
      const target = interaction.options.getUser('유저');
      if (!target) {
        return interaction.reply({ content: '❌ 유저를 지정하세요.', flags: MessageFlags.Ephemeral });
      }
      // 자기 자신을 추가하려는 경우 (이미 admin인 경우는 무시)
      if (target.id === interaction.user.id && config.isAdmin(target.id)) {
        return interaction.reply({
          embeds: [{ color: 0xfbbf24, title: '⚠️ 이미 관리자', description: `<@${target.id}>님은 이미 관리자입니다.` }],
          flags: MessageFlags.Ephemeral
        });
      }
      // 자신을 제거하려는 경우는 별도 명령(/admin_role remove)에서 차단
      try {
        await pool.query(
          `INSERT INTO admin_roles (discord_id, username, granted_by, is_active)
           VALUES (?, ?, ?, 1)
           ON DUPLICATE KEY UPDATE is_active = 1, username = VALUES(username), granted_by = VALUES(granted_by), updated_at = NOW()`,
          [String(target.id), target.username || '', String(interaction.user.id)]
        );
        await config.reloadAdminIds();
        await logAdminAction(interaction.user.id, interaction.user.username, 'ADMIN_ROLE_ADD', target.id, { guildId });
        return interaction.reply({
          embeds: [{
            color: 0x34d399,
            title: '✅ 관리자 추가 완료',
            description: `<@${target.id}> (${target.username}) 님이 **관리자**로 등록되었습니다.\n즉시 반영되었습니다.`,
            timestamp: new Date()
          }]
        });
      } catch (e) {
        console.error('[admin_role add] 실패:', e);
        return interaction.reply({
          embeds: [{
            color: 0xef4444,
            title: '❌ 추가 실패',
            description: e.message || 'DB 오류가 발생했습니다. admin_roles 테이블이 존재하는지 확인하세요.'
          }],
          flags: MessageFlags.Ephemeral
        });
      }
    }

    if (sub === 'remove') {
      const target = interaction.options.getUser('유저');
      if (!target) {
        return interaction.reply({ content: '❌ 유저를 지정하세요.', flags: MessageFlags.Ephemeral });
      }
      // 자기 자신은 제거 불가 (lockout 방지) — 단 .env 에 등록된 경우에만 허용
      const isSelf = target.id === interaction.user.id;
      const inEnv = config.adminIds.includes(String(target.id));
      const inDb = (await pool.query(
        'SELECT discord_id FROM admin_roles WHERE discord_id = ? AND is_active = 1',
        [String(target.id)]
      ).catch(() => [[]]))[0];
      const isDbAdmin = Array.isArray(inDb) && inDb.length > 0;

      if (isSelf && !inEnv) {
        return interaction.reply({
          embeds: [{
            color: 0xfbbf24,
            title: '⚠️ 자기 자신 제거 불가',
            description: '본인 계정이 DB에서만 관리자이고 .env에 백업이 없으면 lockout 됩니다.\n.lockout 방지 차원에서 .env ADMIN_IDS에 본인이 포함되어 있을 때만 제거 가능합니다.'
          }],
          flags: MessageFlags.Ephemeral
        });
      }
      try {
        await pool.query(
          'UPDATE admin_roles SET is_active = 0, updated_at = NOW() WHERE discord_id = ?',
          [String(target.id)]
        );
        await config.reloadAdminIds();
        await logAdminAction(interaction.user.id, interaction.user.username, 'ADMIN_ROLE_REMOVE', target.id, { guildId });
        return interaction.reply({
          embeds: [{
            color: 0x34d399,
            title: '✅ 관리자 제거 완료',
            description: `<@${target.id}> (${target.username}) 님이 **관리자**에서 제거되었습니다.\n즉시 반영되었습니다.` + (isDbAdmin ? '' : '\n(DB에 등록된 적이 없어 사실상 무영향 처리되었습니다.)'),
            timestamp: new Date()
          }]
        });
      } catch (e) {
        console.error('[admin_role remove] 실패:', e);
        return interaction.reply({
          embeds: [{
            color: 0xef4444,
            title: '❌ 제거 실패',
            description: e.message || 'DB 오류가 발생했습니다.'
          }],
          flags: MessageFlags.Ephemeral
        });
      }
    }

    if (sub === 'list') {
      try {
        await config.reloadAdminIds();
        const [dbRows] = await pool.query(
          'SELECT discord_id, username, granted_by, is_active, created_at FROM admin_roles ORDER BY is_active DESC, created_at ASC'
        ).catch(() => [[]]);

        const list = (dbRows || []).map(r => ({
          id: String(r.discord_id),
          username: r.username || '',
          source: r.granted_by ? `DB (추가: <@${r.granted_by}>)` : 'DB (초기)',
          active: r.is_active === 1,
          createdAt: r.created_at
        }));

        const envIds = config.adminIds;
        const envList = envIds.map(id => {
          const inDb = list.find(x => x.id === String(id) && x.active);
          return { id: String(id), username: inDb?.username || '(미등록)', source: inDb ? '.env + DB' : '.env', active: true };
        });
        const dbOnly = list.filter(x => !envIds.includes(String(x.id)));

        const all = [...envList, ...dbOnly];
        const desc = all.length === 0
          ? '⚠️ 등록된 관리자가 없습니다. .env의 ADMIN_IDS 또는 DB의 admin_roles에 추가하세요.'
          : all.map((a, i) => `${i + 1}. <@${a.id}> \`${a.id}\` — 출처: **${a.source}**${a.active ? ' ✅' : ' ❌ 비활성'}`).join('\n');

        return interaction.reply({
          embeds: [{
            color: 0x818cf8,
            title: '👑 현재 관리자 계정 목록',
            description: desc + `\n\n**총 ${envIds.length}명 (.env) + ${list.filter(x => x.active).length}명 (DB 활성) = ${all.length}명**`,
            timestamp: new Date()
          }],
          flags: MessageFlags.Ephemeral
        });
      } catch (e) {
        console.error('[admin_role list] 실패:', e);
        return interaction.reply({
          embeds: [{
            color: 0xef4444,
            title: '❌ 목록 조회 실패',
            description: e.message || 'DB 오류가 발생했습니다.'
          }],
          flags: MessageFlags.Ephemeral
        });
      }
    }

    return interaction.reply({ content: '❓ 알 수 없는 서브커맨드입니다.', flags: MessageFlags.Ephemeral });
  }
};