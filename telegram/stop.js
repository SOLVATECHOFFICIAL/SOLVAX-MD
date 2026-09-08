const {
    stopWhatsAppSession,
    getWhatsAppSession
} = require('../lib/whatsapp');

module.exports = async function stopCommand(ctx) {
    const userId = ctx.from.id;

    global.sessions = global.sessions || {};
    global.pairingStates = global.pairingStates || {};

    const session = getWhatsAppSession(userId);

    /*
     * Cancel any Telegram-side pairing operation first.
     *
     * This is important when the user presses /stop while
     * WhatsApp is still generating or waiting for a pairing code.
     */
    const pairingState =
        global.pairingStates[userId];

    if (pairingState) {
        delete global.pairingStates[userId];
    }

    /*
     * Nothing is connected.
     */
    if (!session) {
        await ctx.reply(
            '🔴 No active WhatsApp session.\n\n' +
            'There is nothing to stop.'
        );

        return;
    }

    const number =
        session.number || 'Unknown';

    /*
     * Tell the user what is happening before closing the socket.
     */
    const message = await ctx.reply(
        '⏳ Stopping WhatsApp session...\n\n' +
        `📱 Number: ${number}`
    );

    try {
        /*
         * IMPORTANT:
         *
         * removeAuth:false means /stop does NOT delete the
         * WhatsApp authentication files.
         *
         * The socket is stopped and removed from memory, while
         * the credentials remain available for restoration.
         *
         * /pair has its own fresh-pair cleanup and will remove
         * the old auth directory before requesting a new code.
         */
        await stopWhatsAppSession(
            userId,
            {
                removeAuth: false
            }
        );

        /*
         * Make absolutely sure no stale pairing state survives.
         */
        delete global.pairingStates[userId];

        /*
         * Make absolutely sure the old in-memory session is gone.
         */
        if (
            global.sessions[userId]
        ) {
            delete global.sessions[userId];
        }

        try {
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                message.message_id,
                undefined,
                '🔴 WhatsApp session stopped.\n\n' +
                `📱 Number: ${number}\n\n` +
                'The WhatsApp connection has been removed from memory.\n\n' +
                'Use /pair to connect again.'
            );
        } catch {
            await ctx.reply(
                '🔴 WhatsApp session stopped.\n\n' +
                `📱 Number: ${number}\n\n` +
                'Use /pair to connect again.'
            );
        }
    } catch (error) {
        console.error(
            '[STOP ERROR]',
            error?.stack || error
        );

        /*
         * Even if Baileys throws while closing, do not leave
         * the bot believing that the session is still active.
         */
        delete global.pairingStates[userId];

        if (
            global.sessions[userId]
        ) {
            delete global.sessions[userId];
        }

        try {
            await ctx.telegram.editMessageText(
                ctx.chat.id,
                message.message_id,
                undefined,
                '⚠️ WhatsApp stop completed with a cleanup warning.\n\n' +
                `📱 Number: ${number}\n\n` +
                'The old session has been removed from the bot.\n\n' +
                'You can use /pair to start a new pairing.'
            );
        } catch {
            await ctx.reply(
                '⚠️ WhatsApp session cleanup completed.\n\n' +
                'Use /pair to start a new pairing.'
            );
        }
    }
};
