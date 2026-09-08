'use strict';
module.exports = {
  name: 'sticker',
  async run(ctx) {
    await ctx.textReply('⚠️ .sticker is registered. Connect your media conversion/downloader function here for image/video/gif → sticker.');
  }
};
