'use strict';
module.exports = {
  name: 'play',
  async run(ctx) {
    const q = ctx.args.join(' ').trim();
    if (!q) return ctx.textReply('Usage: .play song name');
    await ctx.textReply(`🎵 YouTube search: ${q}\n⚠️ Connect your existing YouTube downloader here.`);
  }
};
