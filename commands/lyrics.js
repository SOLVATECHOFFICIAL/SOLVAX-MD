'use strict';
module.exports = {
  name: 'lyrics',
  async run(ctx) {
    const q = ctx.args.join(' ').trim();
    if (!q) return ctx.textReply('Usage: .lyrics song title');
    await ctx.textReply(`🎶 Lyrics search: ${q}\n⚠️ Connect your existing lyrics API here.`);
  }
};
