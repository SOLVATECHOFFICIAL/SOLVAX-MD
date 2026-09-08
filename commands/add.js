const { requireAdmin, normalizeTarget } = require('../lib/group');

module.exports = async ctx => {
  const meta = await requireAdmin(ctx);
  if (!meta) return;

  const target = normalizeTarget(ctx.args[0]);
  if (!target) return ctx.reply('Usage: .add 2349012345678');

  try {
    await ctx.sock.groupParticipantsUpdate(ctx.jid, [target], 'add');
    await ctx.reply(`✅ Add request sent for ${target.split('@')[0]}.`);
  } catch (e) {
    console.error('[COMMAND] add failed:', e);
    await ctx.reply('❌ Could not add that number. Make sure the number is valid and can be added to the group.');
  }
};
