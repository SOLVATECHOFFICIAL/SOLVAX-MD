module.exports = async (context) => {
    const { rawText, sendReply, sendLoading } = context;
    const song = rawText.slice(8).trim();

    if (!song) {
        return sendReply({ text: '❌ Usage: .lyrics artist - song' });
    }

    await sendLoading(`⏳ Searching lyrics for: ${song}`);

    try {
        const parts = song.split(' - ');
        const artist = parts.length > 1 ? parts[0].trim() : '';
        const title = parts.length > 1 ? parts.slice(1).join(' - ').trim() : song;

        if (!artist) {
            return sendReply({ text: '❌ Use this format:\n.lyrics Artist - Song' });
        }

        const url = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;
        const response = await fetch(url);
        const data = await response.json();

        if (!data?.lyrics) {
            return sendReply({ text: '⚠️ Lyrics not found.' });
        }

        const lyrics = String(data.lyrics);
        const limitedLyrics = lyrics.length > 6000
            ? lyrics.slice(0, 6000) + '\n\n[lyrics truncated]'
            : lyrics;

        await sendReply({ text: `📜 ${song}\n\n${limitedLyrics}` });

    } catch (error) {
        await sendReply({ text: '⚠️ Lyrics could not be found.' });
    }
};