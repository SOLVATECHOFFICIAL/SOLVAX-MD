'use strict';
module.exports = {
  name: 'ping',
  async run(ctx) {
    const t = Date.now();
    await ctx.textReply('🏓 Pong!');
    await ctx.textReply(`⚡ ${Date.now() - t}ms`);
  }
};
