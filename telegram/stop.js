'use strict';

const {
    getWhatsAppSession,
    stopWhatsAppSession
} = require('../lib/whatsapp');

const {
    cancelPairing,
    getPairingStatus
} = require('./pair');

function getUserId(ctx) {
    return String(ctx?.from?.id || '');
}

async function safeReply(ctx, text) {
    try {
        return await ctx.reply(String(text || ''));
    } catch (error) {
        console.error('[STOP TELEGRAM REPLY]', error?.stack || error);
    }
}

async function stopCommand(ctx) {
    const userId = getUserId(ctx);

    if (!userId) {
        return;
    }

    /*
     * ------------------------------------------------------------
     * 1. CHECK FOR A PENDING PAIRING
     * ------------------------------------------------------------
     *
     * A user can have a pairing operation running even when there
     * is no completed WhatsApp session yet.
     *
     * Therefore we MUST cancel the pairing state first.
     *
     * The old version checked the WhatsApp session first and
     * returned immediately when there was no session. That meant:
     *
     *   /pair
     *   -> send number
     *   -> pairing starts
     *   -> /stop
     *
     * could leave pairingStates[userId] alive.
     *
     * Then the next number the user sent could accidentally be
     * interpreted as another pairing step.
     *
     * We do not want that particular species of bug.
     * ------------------------------------------------------------
     */

    const pairingStatus = getPairingStatus(userId);

    let pairingCancelled = false;

    if (pairingStatus?.active) {
        cancelPairing(userId);
        pairingCancelled = true;
    }

    /*
     * ------------------------------------------------------------
     * 2. CHECK FOR AN EXISTING WHATSAPP SESSION
     * ------------------------------------------------------------
     */

    const session = getWhatsAppSession(userId);

    if (!session) {
        if (pairingCancelled) {
            return safeReply(
                ctx,
                '🛑 Pairing cancelled.\n\n' +
                'No active WhatsApp session is running.\n\n' +
                'Your saved pairing request has been cleared.\n\n' +
                'Use /pair to start again.'
            );
        }

        return safeReply(
            ctx,
            '🔴 No active WhatsApp session.\n\n' +
            'There is nothing to stop.'
        );
    }

    /*
     * ------------------------------------------------------------
     * 3. STOP THE WHATSAPP SOCKET
     * ------------------------------------------------------------
     *
     * stopWhatsAppSession() is responsible for safely closing the
     * Baileys socket and removing the in-memory session.
     *
     * IMPORTANT:
     *
     * We intentionally use:
     *
     *     removeAuth: false
     *
     * This means /stop stops the running connection but does NOT
     * delete the WhatsApp authentication credentials.
     *
     * That allows the bot to restore the session after a normal
     * process restart.
     *
     * If you later want a separate /logout command, that command
     * can explicitly remove the authentication directory.
     * ------------------------------------------------------------
     */

    let stopped = false;

    try {
        stopped = await stopWhatsAppSession(userId, {
            removeAuth: false
        });
    } catch (error) {
        console.error('[STOP WHATSAPP]', error?.stack || error);

        /*
         * Even if the socket reports an error while closing,
         * pairing state has already been cancelled above.
         *
         * Do not pretend everything succeeded.
         */

        return safeReply(
            ctx,
            '⚠️ The WhatsApp session encountered an error while stopping.\n\n' +
            'The pending pairing state was cleared.\n\n' +
            'Check /status before starting another pairing.'
        );
    }

    /*
     * ------------------------------------------------------------
     * 4. REPORT RESULT
     * ------------------------------------------------------------
     */

    if (stopped) {
        return safeReply(
            ctx,
            '🛑 WhatsApp session stopped.\n\n' +
            '🔐 Your saved login credentials were kept.\n' +
            '🧹 Any pending pairing operation was cleared.\n\n' +
            'Use /pair to connect another account when needed.'
        );
    }

    /*
     * The session existed when we checked it, but the stop function
     * did not report a successful shutdown.
     *
     * Avoid claiming success when we do not know that it happened.
     */

    return safeReply(
        ctx,
        '⚠️ The WhatsApp session could not be confirmed as stopped.\n\n' +
        'The pending pairing state has been cleared.\n\n' +
        'Use /status to check the current connection state.'
    );
}

module.exports = stopCommand;
