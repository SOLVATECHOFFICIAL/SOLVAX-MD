const { downloadMediaMessage } = require('@whiskeysockets/baileys');
const sharp = require('sharp');
const { getMediaType, unwrapMessage } = require('../lib/helpers');

module.exports = async ctx => {
  const type = getMediaType(ctx.msg.message);
  if (type !== 'image') return ctx.reply('🖼️ Send an image with the caption .sticker. Static images are supported.');
  try {
    const buffer = await downloadMediaMessage(ctx.msg, 'buffer', {}, {
      logger: console,
      reuploadRequest: ctx.sock.updateMediaMessage
    });
    const webp = await sharp(buffer, { animated: false })
      .resize(512, 512, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .webp({ quality: 85 })
      .toBuffer();
    await ctx.sock.sendMessage(ctx.jid, { sticker: webp }, { quoted: ctx.msg });
  } catch (error) {
    await ctx.reply(`❌ Sticker conversion failed: ${error.message}`);
  }
};
