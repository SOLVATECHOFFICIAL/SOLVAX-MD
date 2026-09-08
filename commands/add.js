const { cleanNumber, toJid } = require('../lib/helpers');
const { requireAdmin } = require('../lib/group');
module.exports = async ctx => {
  const meta = await requireAdmin(ctx);
  if (!meta) return;
  const clean = cleanNumber(ctx.args[0]);
  if (clean.length < 10 || clean.length > 15) return ctx.reply('Usage: .add 2349012345678');
  try { await ctx.sock.groupParticipantsUpdate(ctx.jid, [toJid(clean)], 'add'); await ctx.reply(`✅ Add request sent for ${clean}.`); }
  catch (e) { await ctx.reply(`❌ Could not add: ${e.message}`); }
};
