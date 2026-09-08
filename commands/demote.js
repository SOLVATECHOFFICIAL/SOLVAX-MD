const { jidNumber } = require('../lib/helpers');

module.exports = async (context) => {
    const { sock, sender, msg, isGroup, sendReply, sendLoading, getGroupAdmins } = context;

    if (!isGroup) {
        return sendReply({ text: '❌ Group only.' });
    }

    const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];

    if (!mentioned.length) {
        return sendReply({ text: '❌ Tag the person to demote.' });
    }

    const target = mentioned[0];
    const targetNumber = jidNumber(target);

    if (targetNumber === global.OWNER_NUMBER || global.CO_OWNERS.includes(targetNumber)) {
        return sendReply({ text: '❌ Cannot demote the owner.' });
    }

    const admins = await getGroupAdmins();

    if (!admins.some(jid => jidNumber(jid) === targetNumber)) {
        return sendReply({ text: '❌ User is not an admin.' });
    }

    await sendLoading('⏳ Demoting user...');

    try {
        await sock.groupParticipantsUpdate(sender, [target], 'demote');
        await sendReply({ text: '✅ User demoted.' });
    } catch (error) {
        await sendReply({ text: `❌ Failed: ${error.message}` });
    }
};