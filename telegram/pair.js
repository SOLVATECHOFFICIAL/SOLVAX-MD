const {
    cleanNumber,
    sleep
} = require('../lib/helpers');

const {
    createWhatsAppSession,
    getWhatsAppSession,
    prepareFreshPairing,
    completelyResetUser
} = require('../lib/whatsapp');

const WAITING_TIMEOUT = 2 * 60 * 1000;

function getPairingStates() {
    if (!global.pairingStates) {
        global.pairingStates = {};
    }

    return global.pairingStates;
}

function getState(userId) {
    return getPairingStates()[String(userId)] || null;
}

function setState(userId, state) {
    const states = getPairingStates();
    const key = String(userId);

    if (states[key]?.timeout) {
        clearTimeout(states[key].timeout);
    }

    states[key] = {
        ...state,
        userId: key
    };

    return states[key];
}

function clearState(userId) {
    const states = getPairingStates();
    const key = String(userId);

    const state = states[key];

    if (state?.timeout) {
        clearTimeout(state.timeout);
    }

    delete states[key];
}

function refreshPairingTimeout(userId) {
    const key = String(userId);
    const state = getState(key);

    if (!state) {
        return;
    }

    if (state.timeout) {
        clearTimeout(state.timeout);
    }

    state.timeout = setTimeout(
        async () => {
            const current = getState(key);

            if (!current) {
                return;
            }

            try {
                await completelyResetUser(
                    key,
                    {
                        notify: false
                    }
                );

                if (global.bot) {
                    await global.bot.telegram.sendMessage(
                        key,
                        '⏰ Pairing timed out.\n\n' +
                        '🧹 The incomplete WhatsApp session was cleared.\n\n' +
                        'Use /pair to start a fresh pairing.'
                    );
                }
            } catch (error) {
                console.error(
                    `[PAIR] Timeout cleanup failed for ${key}:`,
                    error
                );
            }
        },
        WAITING_TIMEOUT
    );
}

function normalizePhoneNumber(input) {
    let number = String(input || '')
        .trim()
        .replace(/[^\d+]/g, '');

    if (!number) {
        return '';
    }

    /*
     * Convert:
     *
     * +2348132538119
     *      ↓
     * 2348132538119
     */
    if (number.startsWith('+')) {
        number = number.slice(1);
    }

    /*
     * International format with 00:
     *
     * 002348132538119
     *      ↓
     * 2348132538119
     */
    if (number.startsWith('00')) {
        number = number.slice(2);
    }

    /*
     * Nigerian local format:
     *
     * 08132538119
     *      ↓
     * 2348132538119
     */
    if (
        number.startsWith('0') &&
        number.length >= 10
    ) {
        number =
            '234' +
            number.slice(1);
    }

    /*
     * Final validation.
     */
    if (!/^\d{8,15}$/.test(number)) {
        return '';
    }

    return number;
}

async function replyPairingCode(ctx, code) {
    const cleanCode = String(code || '')
        .trim()
        .toUpperCase();

    if (!cleanCode) {
        return false;
    }

    /*
     * Telegram HTML <code> makes the pairing code
     * much easier to tap and copy.
     */
    try {
        await ctx.reply(
            '🔐 <b>WhatsApp pairing code:</b>\n\n' +
            `<code>${cleanCode}</code>\n\n` +
            'Open WhatsApp on the phone you want to link and enter this code.\n\n' +
            '⏳ Waiting for WhatsApp to finish linking...\n\n' +
            'Use /stop to cancel this pairing.',
            {
                parse_mode: 'HTML'
            }
        );

        return true;
    } catch (error) {
        console.error(
            '[PAIR] HTML pairing-code message failed:',
            error
        );

        /*
         * Fallback in case Telegram rejects the HTML.
         */
        try {
            await ctx.reply(
                '🔐 WhatsApp pairing code:\n\n' +
                cleanCode +
                '\n\n' +
                'Open WhatsApp on the phone you want to link and enter this code.\n\n' +
                '⏳ Waiting for WhatsApp to finish linking...\n\n' +
                'Use /stop to cancel this pairing.'
            );

            return true;
        } catch (fallbackError) {
            console.error(
                '[PAIR] Pairing-code fallback failed:',
                fallbackError
            );

            return false;
        }
    }
}

async function waitForPairingCode(
    userId,
    session,
    timeoutMs = 15000
) {
    const key = String(userId);

    const started = Date.now();

    while (
        Date.now() - started <
        timeoutMs
    ) {
        /*
         * Make sure this is still the current session.
         */
        const currentSession =
            getWhatsAppSession(key);

        if (
            !currentSession ||
            currentSession !== session ||
            currentSession.stopping
        ) {
            return null;
        }

        /*
         * First source:
         * session.pairingCode
         */
        if (
            currentSession.pairingCode
        ) {
            return String(
                currentSession.pairingCode
            )
                .trim()
                .toUpperCase();
        }

        /*
         * Second source:
         * global pairing state.
         */
        const state =
            getState(key);

        if (
            state?.code
        ) {
            return String(
                state.code
            )
                .trim()
                .toUpperCase();
        }

        await sleep(250);
    }

    return null;
}

async function beginPairing(ctx) {
    const userId = String(
        ctx.from.id
    );

    const existingState =
        getState(userId);

    if (existingState) {
        await ctx.reply(
            '⚠️ You already have an active pairing request.\n\n' +
            'Finish that pairing or use /stop to completely cancel it.'
        );

        return;
    }

    const existingSession =
        getWhatsAppSession(userId);

    if (
        existingSession &&
        !existingSession.stopping
    ) {
        if (existingSession.connected) {
            await ctx.reply(
                '✅ Your WhatsApp account is already connected.\n\n' +
                'Use /stop first if you want to remove it and pair another number.'
            );

            return;
        }

        await ctx.reply(
            '⚠️ A WhatsApp session is already being prepared.\n\n' +
            'Use /stop to completely clear it before starting again.'
        );

        return;
    }

    setState(
        userId,
        {
            stage: 'waiting_number',
            createdAt: Date.now()
        }
    );

    refreshPairingTimeout(userId);

    await ctx.reply(
        '📱 <b>Send the WhatsApp phone number you want to pair.</b>\n\n' +
        'Use international format without +.\n\n' +
        '<b>Example:</b>\n' +
        '<code>2348132538119</code>\n\n' +
        'For a Nigerian number like <code>08132538119</code>, local format is also accepted.\n\n' +
        'Send only the number.',
        {
            parse_mode: 'HTML'
        }
    );
}

async function handlePairNumber(
    ctx,
    rawNumber
) {
    const userId = String(
        ctx.from.id
    );

    const state =
        getState(userId);

    if (!state) {
        return false;
    }

    if (
        state.stage !==
        'waiting_number'
    ) {
        return false;
    }

    const phoneNumber =
        normalizePhoneNumber(
            rawNumber
        );

    if (!phoneNumber) {
        await ctx.reply(
            '❌ Invalid WhatsApp number.\n\n' +
            'Send the number using international format without +.\n\n' +
            'Example:\n' +
            '2348132538119'
        );

        return true;
    }

    /*
     * Update state BEFORE creating the socket.
     */
    setState(
        userId,
        {
            stage: 'creating_session',
            phoneNumber,
            createdAt:
                state.createdAt
        }
    );

    refreshPairingTimeout(userId);

    await ctx.reply(
        '📡 WhatsApp pairing has started.\n\n' +
        `📱 Number: ${phoneNumber}\n\n` +
        '🔄 Preparing a fresh WhatsApp session...\n\n' +
        'Please wait.'
    );

    try {
        /*
         * Remove any stale WhatsApp socket/auth first.
         *
         * This function intentionally does not delete the
         * Telegram pairing state.
         */
        await prepareFreshPairing(
            userId
        );

        /*
         * Check whether /stop happened while cleanup
         * was running.
         */
        const currentState =
            getState(userId);

        if (
            !currentState ||
            currentState.stage ===
            'cancelled'
        ) {
            return true;
        }

        setState(
            userId,
            {
                stage: 'requesting_code',
                phoneNumber,
                createdAt:
                    currentState.createdAt
            }
        );

        refreshPairingTimeout(userId);

        /*
         * Create the Baileys socket.
         *
         * createWhatsAppSession() itself requests the
         * pairing code and stores it in:
         *
         * session.pairingCode
         *
         * and:
         *
         * pairingState.code
         */
        const session =
            await createWhatsAppSession(
                userId,
                {
                    pairing: true,
                    phoneNumber
                }
            );

        /*
         * /stop could have been used while the socket
         * was being created.
         */
        const afterCreate =
            getState(userId);

        if (
            !afterCreate ||
            afterCreate.stage ===
            'cancelled'
        ) {
            await completelyResetUser(
                userId,
                {
                    notify: false
                }
            );

            return true;
        }

        /*
         * Make sure the session returned by Baileys
         * still belongs to this Telegram user.
         */
        if (!session) {
            throw new Error(
                'WhatsApp session was not returned.'
            );
        }

        setState(
            userId,
            {
                stage: 'waiting_code',
                phoneNumber,
                createdAt:
                    afterCreate.createdAt
            }
        );

        refreshPairingTimeout(userId);

        /*
         * Wait for the actual pairing code.
         *
         * This fixes the "No pairing code was returned yet"
         * race condition where pair.js checked the session
         * immediately before createWhatsAppSession had finished
         * assigning session.pairingCode.
         */
        const code =
            await waitForPairingCode(
                userId,
                session,
                15000
            );

        /*
         * Check cancellation again.
         */
        const finalState =
            getState(userId);

        if (
            !finalState ||
            finalState.stage ===
            'cancelled'
        ) {
            return true;
        }

        if (!code) {
            console.error(
                `[PAIR] No pairing code returned for ${userId}.`
            );

            await completelyResetUser(
                userId,
                {
                    notify: false
                }
            );

            await ctx.reply(
                '❌ WhatsApp did not return a pairing code.\n\n' +
                'The incomplete session has been cleared.\n\n' +
                'Use /pair to start a completely fresh attempt.'
            );

            return true;
        }

        /*
         * Save it into Telegram pairing state too.
         */
        finalState.code =
            code;

        finalState.stage =
            'waiting_connection';

        finalState.codeGeneratedAt =
            Date.now();

        finalState.phoneNumber =
            phoneNumber;

        /*
         * Refresh the timeout now that the code exists.
         */
        refreshPairingTimeout(
            userId
        );

        await replyPairingCode(
            ctx,
            code
        );

        return true;
    } catch (error) {
        console.error(
            `[PAIR] Pairing failed for ${userId}:`,
            error
        );

        /*
         * Do not leave a half-created session behind.
         */
        await completelyResetUser(
            userId,
            {
                notify: false
            }
        );

        await ctx.reply(
            '❌ Pairing failed.\n\n' +
            'The WhatsApp connection could not be started.\n\n' +
            '🧹 The pairing state and saved session have been completely reset.\n\n' +
            'Use /pair to try again.'
        );

        return true;
    }
}

async function cancelPairing(
    userId
) {
    const key = String(userId);

    const state =
        getState(key);

    /*
     * Mark cancellation immediately.
     *
     * This is important because createWhatsAppSession()
     * can still be waiting on Baileys.
     */
    if (state) {
        state.stage =
            'cancelled';

        if (state.timeout) {
            clearTimeout(
                state.timeout
            );

            state.timeout = null;
        }
    }

    /*
     * Completely destroy the WhatsApp state.
     */
    await completelyResetUser(
        key,
        {
            notify: false
        }
    );

    return Boolean(state);
}

function getPairingStatus(userId) {
    const state =
        getState(userId);

    if (!state) {
        return null;
    }

    return {
        ...state,

        /*
         * Never expose the actual Timeout object.
         */
        timeout: undefined
    };
}

module.exports = beginPairing;

module.exports.beginPairing =
    beginPairing;

module.exports.handlePairNumber =
    handlePairNumber;

module.exports.cancelPairing =
    cancelPairing;

module.exports.getPairingStatus =
    getPairingStatus;

module.exports.normalizePhoneNumber =
    normalizePhoneNumber;

module.exports.waitForPairingCode =
    waitForPairingCode;
