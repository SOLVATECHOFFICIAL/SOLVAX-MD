const { cleanNumber } = require('../lib/helpers');

module.exports = async (context) => {
    const { sock, sender, rawText, isGroup, sendReply, sendLoading } = context;

    if (!isGroup) {
        return sendReply({ text: '❌ Group only.' });
    }

    const number = cleanNumber(rawText.slice(5));

    if (!number) {
        return sendReply({ text: '❌ Usage: .add 2349012345678' });
    }

    const target = `${number}@s.whatsapp.net`;

    await sendLoading(`⏳ Adding ${number}...`);

    try {
        await sock.groupParticipantsUpdate(sender, [target], 'add');
        await sendReply({ text: `✅ ${number} processed.` });
    } catch (error) {
        await sendReply({ text: `❌ Failed: ${error.message}` });
    }
};