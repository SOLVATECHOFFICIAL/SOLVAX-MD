'use strict';
module.exports = {
  name: 'video',
  async run(ctx) {
    const q = ctx.args.join(' ').trim();
    if (!q) return ctx.textReply('Usage: .video video name or YouTube URL');
    await ctx.textReply(`🎬 YouTube video search: ${q}\n⚠️ Connect your existing YouTube downloader here.`);
  }
};
