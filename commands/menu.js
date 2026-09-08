'use strict';

module.exports = async (context) => {
    // Destructure needed properties from context
    const { sendReply, isGroup, senderNumber, BOT_NAME, OWNER_NAME } = context;

    // Use global config if available, otherwise fallback to context or hardcoded
    const botName = global.BOT_NAME || BOT_NAME || 'SolvaX MD';
    const ownerName = global.OWNER_NAME || OWNER_NAME || 'Solomon';

    // Build the menu text
    const menu =
`╭┈〔 ✦ ${botName} ✦ 〕┈┈┈
┊ 👑 Owner: ${ownerName}
┊ 📚 Teaching Web Devs
├┈┈┈┈┈┈┈┈┈┈
┊ 📜 *Everyone*:
┊ .menu
┊ .ping
┊ .vv
┊ .play [song]
┊ .video [song]
┊ .sticker
┊ .lyrics [artist - song]
┊ .groupinfo
├┈┈┈┈┈┈┈┈┈┈
┊ 👑 *Admin*:
┊ .tagall
┊ .tagadmin
┊ .add [number]
┊ .kick @tag
┊ .promote @tag
┊ .demote @tag
┊ .mute on / off
┊ .lock / .unlock
├┈┈┈┈┈┈┈┈┈┈
┊ 🛡️ *Anti-System*:
┊ .antilink
┊ .antimention
┊ .antiviewonce
┊ .antibot
╰┈┈〔 v11 │ SolvaX MD 〕┈┈╯`;

    // Send the menu (the router already handles private/public replies)
    await sendReply({ text: menu });
};
