'use strict';
module.exports = {
  name: 'promote',
  async run(ctx) {
    const g = await ctx.group();
    if (!g.botIsOwner) return ctx.textReply('❌ Owner-only command.');
    if (!g.botIsAdmin) return ctx.textReply('❌ The linked WhatsApp account is not an admin.');
    if (!ctx.mentions.length) return ctx.textReply('Usage: .promote @tag');
    await ctx.socket.groupParticipantsUpdate(ctx.remoteJid, ctx.mentions, 'promote');
    await ctx.textReply('✅ Member promoted.');
  }
};
