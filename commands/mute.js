const { setGroup, getGroup } = require('../lib/database');
const { requireAdmin } = require('../lib/group');

module.exports = async ctx => {
  const meta = await requireAdmin(ctx);
  if (!meta) return;
  const next = !getGroup(ctx.jid).muted;
  setGroup(ctx.jid, { muted: next });
  await ctx.reply(next ? '🔇 Bot commands are now restricted to group admins.' : '🔊 Bot commands are available to members again.');
};
