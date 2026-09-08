const { jidNumber } = require('../lib/helpers');

module.exports = async (context) => {
    const { getGroupAdmins, isGroup, sendReply } = context;

    if (!isGroup) {
        return sendReply({ text: '❌ Group only.' });
    }

    try {
        const admins = await getGroupAdmins();

        if (!admins.length) {
            return sendReply({ text: '❌ No admins found.' });
        }

        const message = '👑 Admins:\n\n' + admins.map(jid => `@${jidNumber(jid)}`).join(' ');

        await sendReply({ text: message, mentions: admins });

    } catch (error) {
        await sendReply({ text: '⚠️ Could not fetch admins.' });
    }
};