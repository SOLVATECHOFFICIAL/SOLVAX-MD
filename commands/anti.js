'use strict';

const { getAntiSettings, updateAntiSettings } = require('../lib/database');

module.exports = async (context) => {
    const {
        text,
        isGroup,
        sender,
        msg,
        sendReply,
        jidNumber,
        getMentionedJids
    } = context;

    // Determine which anti command is being used
    let type = null;
    let title = null;

    if (text === '.antilink' || text.startsWith('.antilink ')) {
        type = 'antilink';
        title = 'ANTILINK';
    } else if (text === '.antimention' || text.startsWith('.antimention ')) {
        type = 'antimention';
        title = 'ANTIMENTION';
    } else if (text === '.antiviewonce' || text.startsWith('.antiviewonce ')) {
        type = 'antiviewonce';
        title = 'ANTIVIEWONCE';
    } else if (text === '.antibot' || text.startsWith('.antibot ')) {
        type = 'antibot';
        title = 'ANTIBOT';
    } else {
        return; // not an anti command
    }

    // Group ID for storing settings (use 'private' for non-group chats, but anti only makes sense in groups)
    const groupId = isGroup ? sender.split('@')[0] : 'private';

    // Get current settings
    const settings = getAntiSettings(groupId, type);

    // --- If no arguments, show the settings panel ---
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
◆ ${type} clearwarns @tag
╰─⚔`;

        await sendReply({ text: panel });
        return;
    }

    // --- Parse arguments ---
    const args = text.slice(type.length + 2).trim().split(/\s+/);
    const option = args[0];
    const value = args[1];

    // --- Process each option ---
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
        // Reset all warnings for this group
        updateAntiSettings(groupId, type, 'warnings', {});
    } else if (option === 'clearwarns') {
        // Clear warnings for a specific user (tag them)
        const mentioned = getMentionedJids ? getMentionedJids(msg) : (msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || []);
        if (!mentioned.length) {
            return sendReply({ text: `❌ Tag a user.\n\n.${type} clearwarns @tag` });
        }
        // Remove the mentioned user from the warnings object
        const warnings = settings.warnings || {};
        delete warnings[mentioned[0]];
        updateAntiSettings(groupId, type, 'warnings', warnings);
    } else {
        return sendReply({ text: `❌ Invalid option for ${type}.\n\nUse .${type} to see available options.` });
    }

    // --- Confirm update ---
    await sendReply({ text: `✅ ${title} settings updated.` });
};
