'use strict';
module.exports = {
  name: 'demote',
  async run(ctx) {
    const g = await ctx.group();
    if (!g.botIsOwner) return ctx.textReply('❌ Owner-only command.');
    if (!g.botIsAdmin) return ctx.textReply('❌ The linked WhatsApp account is not an admin.');
    if (!ctx.mentions.length) return ctx.textReply('Usage: .demote @tag');
    await ctx.socket.groupParticipantsUpdate(ctx.remoteJid, ctx.mentions, 'demote');
    await ctx.textReply('✅ Admin demoted.');
  }
};
