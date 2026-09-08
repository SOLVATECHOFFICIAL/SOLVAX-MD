const { getAntiSettings, updateAntiSettings } = require('../lib/database');

module.exports = async (context) => {
    const { sender, isGroup, msg, sendReply, text, jidNumber } = context;

    // Determine which anti command
    let type = null;
    let title = null;

    if (text === '.antilink' || text.startsWith('.antilink ')) { type = 'antilink'; title = 'ANTILINK'; }
    else if (text === '.antimention' || text.startsWith('.antimention ')) { type = 'antimention'; title = 'ANTIMENTION'; }
    else if (text === '.antiviewonce' || text.startsWith('.antiviewonce ')) { type = 'antiviewonce'; title = 'ANTIVIEWONCE'; }
    else if (text === '.antibot' || text.startsWith('.antibot ')) { type = 'antibot'; title = 'ANTIBOT'; }
    else return;

    const groupId = isGroup ? sender.split('@')[0] : 'private';
    const settings = getAntiSettings(groupId, type);

    // Show panel if no arguments
    if (text === `.${type}`) {
        const status = settings.enabled ? '🟢 ON' : '🔴 OFF';
        const action = settings.action.toUpperCase();

        const panel =
`╭─⚔ ${title} ⚔
┊
◆ Enabled      : ${status}
◆ Action       : ${action}
◆ Allow Admins : ${settings.adminAllowed ? '✅ Yes' : '❌ No'}
◆ Max Warns    : ${settings.warns}
┊
◆ Commands:
◆ ${type} on
◆ ${type} off
◆ ${type} kick
◆ ${type} delete
◆ ${type} warn
◆ ${type} admin on
◆ ${type} admin off
◆ ${type} warns 3
◆ ${type} resetwarns
╰─⚔`;

        await sendReply({ text: panel });
        return;
    }

    // Parse arguments
    const args = text.slice(type.length + 2).trim().split(/\s+/);
    const option = args[0];
    const value = args[1];

    if (option === 'on') {
        updateAntiSettings(groupId, type, 'enabled', true);
    } else if (option === 'off') {
        updateAntiSettings(groupId, type, 'enabled', false);
    } else if (['kick', 'delete', 'warn'].includes(option)) {
        updateAntiSettings(groupId, type, 'action', option);
    } else if (option === 'admin' && value === 'on') {
        updateAntiSettings(groupId, type, 'adminAllowed', true);
    } else if (option === 'admin' && value === 'off') {
        updateAntiSettings(groupId, type, 'adminAllowed', false);
    } else if (option === 'warns') {
        const count = parseInt(value);
        if (!Number.isInteger(count) || count < 1 || count > 100) {
            return sendReply({ text: '❌ Warns must be between 1 and 100.' });
        }
        updateAntiSettings(groupId, type, 'warns', count);
    } else if (option === 'resetwarns') {
        updateAntiSettings(groupId, type, 'warnings', {});
    } else if (option === 'clearwarns') {
        const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        if (!mentioned.length) {
            return sendReply({ text: `❌ Tag a user.\n\n.${type} clearwarns @tag` });
        }
        const updated = { ...settings.warnings };
        delete updated[mentioned[0]];
        updateAntiSettings(groupId, type, 'warnings', updated);
    } else {
        return sendReply({ text: `❌ Invalid ${type} option.` });
    }

    await sendReply({ text: `✅ ${title} settings updated.` });
};