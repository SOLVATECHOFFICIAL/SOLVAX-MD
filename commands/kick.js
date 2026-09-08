const { jidNumber } = require('../lib/helpers');

module.exports = async (context) => {
    const { sock, sender, msg, isGroup, sendReply, sendLoading, getGroupAdmins, isOwner } = context;

    if (!isGroup) {
        return sendReply({ text: '❌ Group only.' });
    }

    const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];

    if (!mentioned.length) {
        return sendReply({ text: '❌ Tag the person to remove.' });
    }

    const target = mentioned[0];
    const targetNumber = jidNumber(target);

    if (targetNumber === global.OWNER_NUMBER || global.CO_OWNERS.includes(targetNumber)) {
        return sendReply({ text: '❌ Cannot remove the owner.' });
    }

    const admins = await getGroupAdmins();

    if (admins.some(jid => jidNumber(jid) === targetNumber)) {
        return sendReply({ text: '❌ Cannot remove an admin.' });
    }

    await sendLoading('⏳ Removing user...');

    try {
        await sock.groupParticipantsUpdate(sender, [target], 'remove');
        await sendReply({ text: '✅ User removed.' });
    } catch (error) {
        await sendReply({ text: `❌ Failed: ${error.message}` });
    }
};