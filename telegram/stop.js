module.exports = async (ctx) => {
    const userId = ctx.from.id;
    const sessions = global.sessions;
    const session = sessions[userId];

    if (!session) {
        return ctx.reply('❌ No active WhatsApp session to disconnect.');
    }

    try {
        session.stopped = true;
        if (session.sock) session.sock.end(undefined);
    } catch (error) {}

    delete sessions[userId];

    await ctx.reply('✅ WhatsApp disconnected successfully.');
};