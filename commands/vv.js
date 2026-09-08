'use strict';
module.exports = {
  name: 'vv',
  async run(ctx) {
    const q = ctx.message?.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!q) return ctx.textReply('❌ Reply to a view-once photo/video with .vv.');
    const media = q.viewOnceMessage?.message || q.viewOnceMessageV2?.message || q.viewOnceMessageV2Extension?.message;
    if (!media) return ctx.textReply('❌ The quoted message is not a supported view-once media message.');
    return ctx.textReply('⚠️ View-once media detected. Your Baileys media-download/re-upload layer must be connected here; this command will not pretend a missing media file exists.');
  }
};
