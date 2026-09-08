const {
    completelyResetUser,
    getWhatsAppSession
} = require('../lib/whatsapp');

const { getPairingStatus } = require('./pair');

module.exports = async (ctx) => {
    const userId = String(ctx.from.id);

    try {
        const beforePairing = getPairingStatus(userId);
        const beforeSession = getWhatsAppSession(userId);

        // Completely wipe the user's WhatsApp state, including any active pairing.
        // This intentionally removes saved auth so /pair starts fresh.
        await completelyResetUser(userId, {
            notify: false
        });

        const hadSomething =
            Boolean(beforePairing) ||
            Boolean(beforeSession);

        if (!hadSomething) {
            await ctx.reply(
                '🛑 Everything for your WhatsApp session has been reset.\n\n' +
                '🧹 Pairing state cleared\n' +
                '🧹 Saved session cleared\n' +
                '🧹 Reconnection cancelled\n' +
                '🧹 Old authentication removed\n\n' +
                'You can use /pair to start fresh.'
            );

            return;
        }

        await ctx.reply(
            '🛑 WhatsApp session completely stopped.\n\n' +
            '🧹 Pairing state cleared\n' +
            '🧹 Pairing timer cleared\n' +
            '🧹 Pairing code cleared\n' +
            '🧹 WhatsApp socket closed\n' +
            '🧹 Saved authentication removed\n' +
            '🧹 Reconnection cancelled\n\n' +
            'You can now use /pair again with the same number or another number.'
        );
    } catch (error) {
        console.error(
            `[STOP] Failed to completely reset user ${userId}:`,
            error
        );

        // Even if something above throws, make one final cleanup attempt.
        try {
            await completelyResetUser(userId, {
                notify: false
            });
        } catch (cleanupError) {
            console.error(
                `[STOP] Final cleanup failed for ${userId}:`,
                cleanupError
            );
        }

        await ctx.reply(
            '⚠️ The stop command encountered an error.\n\n' +
            'A cleanup attempt was made. Please use /pair to start a fresh session.'
        );
    }
};
