const { setGroup, getGroup } = require('../lib/database');
const { requireAdmin } = require('../lib/group');

module.exports = async ctx => {
  const meta = await requireAdmin(ctx);
  if (!meta) return;
  const next = !getGroup(ctx.jid).antiLink;
  setGroup(ctx.jid, { antiLink: next });
  await ctx.reply(next ? '🛡 Anti-link enabled. Links sent by members will be removed.' : '🛡 Anti-link disabled.');
};
