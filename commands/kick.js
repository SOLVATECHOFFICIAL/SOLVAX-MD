const { requireAdmin } = require('../lib/group');
module.exports = async ctx => {
  const meta = await requireAdmin(ctx);
  if (!meta) return;
  const target = ctx.msg.message?.extendedTextMessage?.contextInfo?.participant || (ctx.args[0] ? `${ctx.args[0].replace(/\D/g,'')}@s.whatsapp.net` : null);
  if (!target) return ctx.reply('Reply to a member or use .kick 234xxxxxxxxxx');
  try { await ctx.sock.groupParticipantsUpdate(ctx.jid, [target], 'remove'); await ctx.reply('✅ Member removed.'); }
  catch (e) { await ctx.reply(`❌ Could not remove member: ${e.message}`); }
};
