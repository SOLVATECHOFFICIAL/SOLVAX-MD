module.exports = async ctx => {
  const start = Date.now();
  await ctx.reply('🏓 Pong!');
  const ms = Date.now() - start;
  await ctx.reply(`⚡ Response: ${ms}ms`);
};
