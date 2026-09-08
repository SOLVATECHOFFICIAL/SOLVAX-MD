const ytSearch = require('yt-search');

module.exports = async ctx => {
  const q = ctx.text?.trim();
  if (!q) return ctx.reply('Usage: .play song or video title');
  try {
    const result = await ytSearch(q);
    const videos = result.videos?.slice(0, 5) || [];
    if (!videos.length) return ctx.reply('❌ No YouTube results found.');
    const lines = videos.map((v, i) => `${i + 1}. ${v.title}\n   ${v.timestamp || 'Unknown'} • ${v.url}`);
    await ctx.reply(`🔎 YouTube results for: ${q}\n\n${lines.join('\n\n')}\n\nUse the creator's official source where available.`);
  } catch (error) {
    console.error('[COMMAND] play search failed:', error);
    await ctx.reply('❌ YouTube search failed. Please try again.');
  }
};

module.exports.aliases = ['yt'];
