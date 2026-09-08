module.exports = async (ctx) => {
    const userId = ctx.from.id;
    const sessions = global.sessions;
    const session = sessions[userId];

    if (!session) {
        return ctx.reply('❌ No active WhatsApp session.\n\nUse /pair to link WhatsApp.');
    }

    const number = session.number || 'Unknown';

    if (session.connected && session.state === 'connected') {
        return ctx.reply(`✅ WhatsApp is FULLY CONNECTED and ready.\n\n📱 Number: ${number}`);
    }

    if (session.state === 'connecting') {
        return ctx.reply(`⏳ WhatsApp is CONNECTING.\n\n📱 Number: ${number}`);
    }

    return ctx.reply(`🔴 WhatsApp is not connected.\n\n📱 Number: ${number}\n\nUse /pair to reconnect.`);
};