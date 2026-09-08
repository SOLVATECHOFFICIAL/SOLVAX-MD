const { fetchBuffer } = require('../lib/helpers');

module.exports = async (context) => {
    const { rawText, sendReply, sendLoading, PLAY_SOURCES } = context;
    const video = rawText.slice(7).trim();

    if (!video) {
        return sendReply({ text: '❌ Usage: .video video name' });
    }

    await sendLoading(`⏳ Searching for video: ${video}`);

    let success = false;
    let attempts = 0;
    const maxAttempts = PLAY_SOURCES || 2;

    // Source 1: Ryzendesu API
    if (!success && attempts < maxAttempts) {
        attempts++;
        try {
            const apiUrl = `https://api.ryzendesu.vip/api/download/ytmp4?text=${encodeURIComponent(video)}`;
            const response = await fetch(apiUrl);
            const data = await response.json();
            if (data?.url) {
                const buffer = await fetchBuffer(data.url);
                await sendReply({ video: buffer, mimetype: 'video/mp4', fileName: `${video}.mp4` });
                success = true;
            }
        } catch (error) {
            console.log('Video source 1 failed:', error.message);
        }
    }

    // Source 2: Vevioz API
    if (!success && attempts < maxAttempts) {
        attempts++;
        try {
            const apiUrl = `https://api.vevioz.com/api/button/mp4/${encodeURIComponent(video)}`;
            const response = await fetch(apiUrl);
            const data = await response.json();
            if (data?.download) {
                const buffer = await fetchBuffer(data.download);
                await sendReply({ video: buffer, mimetype: 'video/mp4', fileName: `${video}.mp4` });
                success = true;
            }
        } catch (error) {
            console.log('Video source 2 failed:', error.message);
        }
    }

    if (!success) {
        await sendReply({ text: '⚠️ Video source unavailable right now.\n\nTry again later.' });
    }
};