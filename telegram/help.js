module.exports = async (ctx) => {
    const name = global.BOT_NAME || 'SolvaX MD';
    const owner = global.OWNER_NAME || 'Owner';
    const helpText =
`⚔️ *${name} v11*

👑 Owner: ${owner}
📚 Teaching Web Devs

━━━━━━━━━━━━━━━━

📜 *EVERYONE*

.menu
.ping
.vv
.play [song]
.video [song]
.sticker
.lyrics [artist - title]
.groupinfo

━━━━━━━━━━━━━━━━

👑 *ADMIN*

.tagall
.tagadmin
.add [number]
.kick @tag
.promote @tag
.demote @tag
.mute on
.mute off
.lock
.unlock

━━━━━━━━━━━━━━━━

🛡️ *ANTI-SYSTEM*

.antilink
.antimention
.antiviewonce
.antibot

Options:

on
off
kick
delete
warn
admin on
admin off
warns <number>
resetwarns
clearwarns @tag

━━━━━━━━━━━━━━━━

📲 *TELEGRAM*

/start
/help
/pair
/status
/stop`;

    await ctx.reply(helpText, { parse_mode: 'Markdown' });
};