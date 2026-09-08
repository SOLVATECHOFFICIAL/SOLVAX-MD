const { fetchBuffer } = require('../lib/helpers');

module.exports = async (context) => {
    const { rawText, sendReply, sendLoading, PLAY_SOURCES } = context;
    const song = rawText.slice(6).trim();

    if (!song) {
        return sendReply({ text: '❌ Usage: .play song name' });
    }

    await sendLoading(`⏳ Searching for: ${song}`);

    let success = false;
    let attempts = 0;
    const maxAttempts = PLAY_SOURCES || 2;

    // Source 1: Ryzendesu API
    if (!success && attempts < maxAttempts) {
        attempts++;
        try {
            const apiUrl = `https://api.ryzendesu.vip/api/download/ytmp3?text=${encodeURIComponent(song)}`;
            const response = await fetch(apiUrl);
            const data = await response.json();
            if (data?.url) {
                const buffer = await fetchBuffer(data.url);
                await sendReply({ audio: buffer, mimetype: 'audio/mpeg', fileName: `${song}.mp3` });
                success = true;
            }
        } catch (error) {
            console.log('Play source 1 failed:', error.message);
        }
    }

    // Source 2: Vevioz API
    if (!success && attempts < maxAttempts) {
        attempts++;
        try {
            const apiUrl = `https://api.vevioz.com/api/button/mp3/${encodeURIComponent(song)}`;
            const response = await fetch(apiUrl);
            const data = await response.json();
            if (data?.download) {
                const buffer = await fetchBuffer(data.download);
                await sendReply({ audio: buffer, mimetype: 'audio/mpeg', fileName: `${song}.mp3` });
                success = true;
            }
        } catch (error) {
            console.log('Play source 2 failed:', error.message);
        }
    }

    if (!success) {
        await sendReply({ text: '⚠️ Music source unavailable right now.\n\nTry again later.' });
    }
};