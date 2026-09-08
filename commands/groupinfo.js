const { jidNumber } = require('../lib/helpers');

module.exports = async (context) => {
    const { sock, sender, isGroup, sendReply, sendLoading } = context;

    if (!isGroup) {
        return sendReply({ text: '❌ Use this command inside a group.' });
    }

    await sendLoading('⏳ Fetching group information...');

    try {
        const group = await sock.groupMetadata(sender);

        const admins = group.participants
            .filter(p => p.admin)
            .map(p => jidNumber(p.id));

        const memberCount = group.participants.length;
        const created = group.creation
            ? new Date(group.creation * 1000).toLocaleDateString()
            : 'Unknown';

        const info =
`📊 GROUP INFO

Name: ${group.subject || 'Unknown'}
Description: ${group.desc || 'None'}
Admins: ${admins.length}
Members: ${memberCount}
Created: ${created}

👑 Admins:
${admins.join('\n') || 'None'}`;

        await sendReply({ text: info });

    } catch (error) {
        await sendReply({ text: '⚠️ Could not fetch group information.' });
    }
};