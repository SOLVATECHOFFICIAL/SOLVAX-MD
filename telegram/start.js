module.exports = async (ctx) => {
    const name = global.BOT_NAME || 'SolvaX MD';
    const owner = global.OWNER_NAME || 'Owner';
    await ctx.reply(
        `⚔️ *${name} v11*\n\n` +
        `👑 Owner: ${owner}\n` +
        `📚 Built for Teaching & Group Management\n\n` +
        `Send /help for commands.\n` +
        `Send /pair to link WhatsApp.\n` +
        `Send /status to check connection.\n` +
        `Send /stop to disconnect.`,
        { parse_mode: 'Markdown' }
    );
};