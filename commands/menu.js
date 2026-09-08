module.exports = async (context) => {
    const { sendReply, BOT_NAME, OWNER_NAME } = context;
    const name = global.BOT_NAME || BOT_NAME || 'SolvaX MD';
    const owner = global.OWNER_NAME || OWNER_NAME || 'Owner';

    const menu =
`╭┈〔 ✦ ${name} ✦ 〕┈┈┈
┊ 👑 Owner: ${owner}
┊ 📚 Teaching Web Devs
├┈┈┈┈┈┈┈┈┈┈
┊ 📜 Everyone:
┊ .menu
┊ .ping
┊ .vv
┊ .play
┊ .video
┊ .sticker
┊ .lyrics
┊ .groupinfo
├┈┈┈┈┈┈┈┈┈┈
┊ 👑 Admin:
┊ .tagall
┊ .tagadmin
┊ .add
┊ .kick
┊ .promote
┊ .demote
┊ .mute
├┈┈┈┈┈┈┈┈┈┈
┊ 🛡️ Anti-System:
┊ .antilink
┊ .antimention
┊ .antiviewonce
┊ .antibot
╰┈┈〔 v11 │ SolvaX MD 〕┈┈╯`;

    await sendReply({ text: menu });
};