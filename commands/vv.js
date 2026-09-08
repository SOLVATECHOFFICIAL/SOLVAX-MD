const { fetchBuffer } = require('../lib/helpers');

module.exports = async (context) => {
    const { sock, msg, sendReply, sendLoading } = context;

    await sendLoading('⏳ Attempting to decrypt view-once...');

    let success = false;
    const methods = 5;

    for (let method = 1; method <= methods; method++) {
        try {
            let media = null;

            if (method === 1) {
                media = await sock.downloadMediaMessage(msg);
            }

            if (method === 2 && !media) {
                const msgObj = msg.message?.viewOnceMessage?.message || msg.message;
                if (msgObj?.imageMessage?.url) {
                    const url = msgObj.imageMessage.url;
                    const response = await fetch(url);
                    media = await response.buffer();
                } else if (msgObj?.videoMessage?.url) {
                    const url = msgObj.videoMessage.url;
                    const response = await fetch(url);
                    media = await response.buffer();
                }
            }

            if (method === 3 && !media) {
                const msgObj = msg.message?.viewOnceMessage?.message || msg.message;
                if (msgObj?.imageMessage?.mediaKey || msgObj?.videoMessage?.mediaKey) {
                    media = await sock.downloadMediaMessage(msg);
                }
            }

            if (method === 4 && !media) {
                try {
                    const msgObj = msg.message?.viewOnceMessage?.message || msg.message;
                    if (msgObj?.imageMessage || msgObj?.videoMessage) {
                        const mediaKey = msgObj.imageMessage?.mediaKey || msgObj.videoMessage?.mediaKey;
                        if (mediaKey) {
                            const url = msgObj.imageMessage?.url || msgObj.videoMessage?.url;
                            if (url) {
                                const response = await fetch(url);
                                const buffer = await response.buffer();
                                media = buffer;
                            }
                        }
                    }
                } catch (e) {}
            }

            if (method === 5 && !media) {
                media = await sock.downloadMediaMessage(msg);
            }

            if (media) {
                const msgObj = msg.message?.viewOnceMessage?.message || msg.message;
                if (msgObj?.imageMessage) {
                    await sendReply({ image: media, caption: '🔓 View-once decrypted!' });
                } else if (msgObj?.videoMessage) {
                    await sendReply({ video: media, caption: '🔓 View-once decrypted!' });
                } else {
                    await sendReply({ image: media, caption: '🔓 View-once decrypted!' });
                }
                success = true;
                break;
            }

        } catch (error) {
            console.log(`Method ${method} failed:`, error.message);
        }
    }

    if (!success) {
        await sendReply({
            text: '❌ Could not decrypt view-once.\n\nThis is a WhatsApp limitation.\nTry asking the sender to send normally.'
        });
    }
};