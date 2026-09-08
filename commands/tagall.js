const { requireAdmin } = require('../lib/group');
module.exports = async ctx => {
  const meta = await requireAdmin(ctx);
  if (!meta) return;
  const mentions = meta.participants.map(p => p.id);
  const text = ctx.text || 'Attention everyone';
  await ctx.sock.sendMessage(ctx.jid, { text: `${text}\n\n${mentions.map(j => `@${j.split('@')[0]}`).join(' ')}`, mentions }, { quoted: ctx.msg });
};
