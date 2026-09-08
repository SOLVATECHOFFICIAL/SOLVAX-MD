const { requireAdmin, resolveTarget } = require('../lib/group');

module.exports = async ctx => {
  const meta = await requireAdmin(ctx);
  if (!meta) return;

  const target = resolveTarget(ctx);
  if (!target) return ctx.reply('Reply to a member or provide a valid number, e.g. .promote 234xxxxxxxxxx');

  const botJid = ctx.sock.user?.id || '';
  if (target === botJid || target.split('@')[0].split(':')[0] === botJid.split('@')[0].split(':')[0]) {
    return ctx.reply('❌ The bot account cannot be targeted by this command.');
  }

  try {
    await ctx.sock.groupParticipantsUpdate(ctx.jid, [target], 'promote');
    await ctx.reply('✅ Member promoted.');
  } catch (e) {
    console.error('[COMMAND] promote failed:', e);
    await ctx.reply('❌ The group operation could not be completed. Check the target and the bot permissions.');
  }
};
