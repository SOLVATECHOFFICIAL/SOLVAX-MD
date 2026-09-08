const ytSearch = require('yt-search');
module.exports = async ctx => {
  const q = ctx.text?.trim();
  if (!q) return ctx.reply('Usage: .lyrics artist - song');
  const result = await ytSearch(`${q} official`);
  const first = result.videos?.[0];
  if (!first) return ctx.reply('❌ No matching result found.');
  await ctx.reply(`🎵 Search result for: ${q}\n\n${first.title}\n👤 ${first.author?.name || 'Unknown'}\n🔗 ${first.url}\n\nLyrics are not reproduced by the bot.`);
};
