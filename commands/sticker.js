const sharp = require('sharp');

module.exports = async (context) => {
    const { sock, msg, sendReply, sendLoading } = context;

    await sendLoading('⏳ Creating sticker...');

    try {
        const media = await sock.downloadMediaMessage(msg);

        if (!media) {
            return sendReply({ text: '❌ Reply to an image with .sticker' });
        }

        const webp = await sharp(media).webp().toBuffer();

        await sendReply({ sticker: webp });
    } catch (error) {
        await sendReply({ text: '❌ Could not create sticker.' });
    }
};