module.exports = async ctx => {
  const session = global.sessions[ctx.from.id];
  if (!session) return ctx.reply('🔴 No WhatsApp session is active.\n\nUse /pair to link one.');
  const state = session.connected ? '🟢 Connected' : `🟡 ${session.state || 'Connecting'}`;
  await ctx.reply(`${state}\n\n📱 ${session.number || 'Unknown'}\n🕒 Session started: ${new Date(session.createdAt || Date.now()).toLocaleString()}`);
};
