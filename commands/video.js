const ytSearch = require('yt-search');
module.exports = async ctx => {
  const q = ctx.text?.trim();
  if (!q) return ctx.reply('Usage: .video video title');
  const result = await ytSearch(q);
  const videos = result.videos?.slice(0, 5) || [];
  if (!videos.length) return ctx.reply('❌ No results found.');
  await ctx.reply(`🎬 Best result:\n\n${videos[0].title}\n⏱ ${videos[0].timestamp || 'Unknown'}\n👤 ${videos[0].author?.name || 'Unknown'}\n\n${videos[0].url}`);
};

module.exports.aliases = ['ytvideo'];
