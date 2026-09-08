const { requireAdmin } = require('../lib/group');

module.exports = async ctx => {
  const meta = await requireAdmin(ctx);
  if (!meta) return;
  const admins = meta.participants.filter(p => p.admin).map(p => p.id);
  if (!admins.length) return ctx.reply('ℹ️ No group admins were found.');
  await ctx.sock.sendMessage(ctx.jid, {
    text: `🛡 Admins:\n${admins.map(j => `@${j.split('@')[0].split(':')[0]}`).join(' ')}`,
    mentions: admins
  }, { quoted: ctx.msg });
};
