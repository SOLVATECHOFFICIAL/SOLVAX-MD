const { setGroup, getGroup } = require('../lib/database');
const { requireAdmin } = require('../lib/group');
module.exports = async ctx => {
  const meta = await requireAdmin(ctx);
  if (!meta) return;
  const next = !getGroup(ctx.jid).muted;
  setGroup(ctx.jid, { muted: next });
  await ctx.reply(next ? '🔇 Bot command mode is now admin-only in this group.' : '🔊 Bot command mode restored for members.');
};
