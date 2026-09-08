const ytSearch = require('yt-search');

module.exports = async ctx => {
  const q = ctx.text?.trim();
  if (!q) return ctx.reply('Usage: .video video title');
  try {
    const result = await ytSearch(q);
    const first = result.videos?.[0];
    if (!first) return ctx.reply('❌ No results found.');
    await ctx.reply(`🎬 Best result:\n\n${first.title}\n⏱ ${first.timestamp || 'Unknown'}\n👤 ${first.author?.name || 'Unknown'}\n\n${first.url}`);
  } catch (error) {
    console.error('[COMMAND] video search failed:', error);
    await ctx.reply('❌ YouTube search failed. Please try again.');
  }
};

module.exports.aliases = ['ytvideo'];
