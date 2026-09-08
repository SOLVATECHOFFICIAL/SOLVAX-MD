const { requireAdmin } = require('../lib/group');
module.exports = async ctx => {
  const meta = await requireAdmin(ctx);
  if (!meta) return;
  const target = ctx.msg.message?.extendedTextMessage?.contextInfo?.participant || (ctx.args[0] ? `${ctx.args[0].replace(/\D/g,'')}@s.whatsapp.net` : null);
  if (!target) return ctx.reply('Reply to a member or use .demote 234xxxxxxxxxx');
  try { await ctx.sock.groupParticipantsUpdate(ctx.jid, [target], 'demote'); await ctx.reply('✅ Admin removed.'); }
  catch (e) { await ctx.reply(`❌ Could not demote: ${e.message}`); }
};
