module.exports = async (context) => {
    const { sock, sender, msg, isGroup, sendReply, sendLoading } = context;

    if (!isGroup) {
        return sendReply({ text: '❌ Group only.' });
    }

    const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];

    if (!mentioned.length) {
        return sendReply({ text: '❌ Tag the person to promote.' });
    }

    await sendLoading('⏳ Promoting user...');

    try {
        await sock.groupParticipantsUpdate(sender, [mentioned[0]], 'promote');
        await sendReply({ text: '✅ User promoted.' });
    } catch (error) {
        await sendReply({ text: `❌ Failed: ${error.message}` });
    }
};