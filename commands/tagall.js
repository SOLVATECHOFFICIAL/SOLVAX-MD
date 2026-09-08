const { requireAdmin } = require('../lib/group');

module.exports = async ctx => {
  const meta = await requireAdmin(ctx);
  if (!meta) return;

  const mentions = meta.participants.map(p => p.id).filter(Boolean);
  const text = ctx.text?.trim() || 'Attention everyone';
  const body = `${text}\n\n${mentions.map(j => `@${j.split('@')[0].split(':')[0]}`).join(' ')}`;

  try {
    await ctx.sock.sendMessage(ctx.jid, { text: body, mentions }, { quoted: ctx.msg });
  } catch (error) {
    console.error('[COMMAND] tagall failed:', error);
    await ctx.reply('❌ Could not tag everyone. The group may be too large for one message.');
  }
};
