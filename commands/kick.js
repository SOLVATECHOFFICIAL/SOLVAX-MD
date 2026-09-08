'use strict';
module.exports = {
  name: 'kick',
  async run(ctx) {
    const g = await ctx.group();
    if (!g.botIsAdmin) return ctx.textReply('❌ The linked WhatsApp account must be a group admin.');
    if (!ctx.mentions.length) return ctx.textReply('Usage: .kick @tag');
    await ctx.socket.groupParticipantsUpdate(ctx.remoteJid, ctx.mentions, 'remove');
    await ctx.textReply('✅ Member(s) removed.');
  }
};
