const ytSearch = require('yt-search');

module.exports = async ctx => {
  const q = ctx.text?.trim();
  if (!q) return ctx.reply('Usage: .lyrics artist - song');
  try {
    const result = await ytSearch(`${q} official lyrics`);
    const first = result.videos?.[0];
    if (!first) return ctx.reply('❌ No matching result found.');
    await ctx.reply(`🎵 Lyrics search for: ${q}\n\n${first.title}\n👤 ${first.author?.name || 'Unknown'}\n🔗 ${first.url}\n\nThe bot does not reproduce copyrighted lyrics.`);
  } catch (error) {
    console.error('[COMMAND] lyrics search failed:', error);
    await ctx.reply('❌ Lyrics search failed. Please try again.');
  }
};
