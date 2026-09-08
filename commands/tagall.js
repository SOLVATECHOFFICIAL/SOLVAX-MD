const { jidNumber } = require('../lib/helpers');

module.exports = async (context) => {
    const { sock, sender, isGroup, sendReply, sendLoading } = context;

    if (!isGroup) {
        return sendReply({ text: '❌ Group only.' });
    }

    await sendLoading('⏳ Fetching members...');

    try {
        const group = await sock.groupMetadata(sender);
        const mentions = group.participants.map(p => p.id);
        const message = '📢 Everyone\n\n' + mentions.map(jid => `@${jidNumber(jid)}`).join(' ');

        await sendReply({ text: message, mentions });

    } catch (error) {
        await sendReply({ text: '⚠️ Could not tag members.' });
    }
};