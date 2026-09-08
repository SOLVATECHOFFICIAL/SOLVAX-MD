const {
    sleep
} = require('../lib/helpers');

const {
    createWhatsAppSession,
    getWhatsAppSession,
    prepareFreshPairing,
    completelyResetUser
} = require('../lib/whatsapp');

const WAITING_TIMEOUT = 2 * 60 * 1000;

/*
|--------------------------------------------------------------------------
| Pairing state storage
|--------------------------------------------------------------------------
*/

function getPairingStates() {
    if (!global.pairingStates) {
        global.pairingStates = {};
    }

    return global.pairingStates;
}

function getState(userId) {
    return getPairingStates()[
        String(userId)
    ] || null;
}

function setState(userId, state) {
    const states =
        getPairingStates();

    const key =
        String(userId);

    /*
     * Clear an old timeout before replacing
     * the state.
     */
    if (states[key]?.timeout) {
        clearTimeout(
            states[key].timeout
        );
    }

    states[key] = {
        ...state,
        userId: key
    };

    return states[key];
}

function clearState(userId) {
    const states =
        getPairingStates();

    const key =
        String(userId);

    const state =
        states[key];

    if (state?.timeout) {
        clearTimeout(
            state.timeout
        );
    }

    delete states[key];
}

/*
|--------------------------------------------------------------------------
| Pairing timeout
|--------------------------------------------------------------------------
*/

function refreshPairingTimeout(userId) {
    const key =
        String(userId);

    const state =
        getState(key);

    if (!state) {
        return;
    }

    if (state.timeout) {
        clearTimeout(
            state.timeout
        );
    }

    state.timeout =
        setTimeout(
            async () => {
                const current =
                    getState(key);

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
                            '⏰ <b>Pairing timed out.</b>\n\n' +
                            '🧹 The incomplete WhatsApp session was cleared.\n' +
                            '🧹 Pairing state was cleared.\n' +
                            '🧹 Saved authentication was removed.\n\n' +
                            'Use /pair to start again.',
                            {
                                parse_mode: 'HTML'
                            }
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

/*
|--------------------------------------------------------------------------
| Phone number normalization
|--------------------------------------------------------------------------
*/

function normalizePhoneNumber(input) {
    let number =
        String(input || '')
            .trim();

    /*
     * Remove spaces, brackets and hyphens.
     */
    number =
        number.replace(
            /[\s()\-]/g,
            ''
        );

    /*
     * Remove + from international numbers.
     */
    if (
        number.startsWith('+')
    ) {
        number =
            number.slice(1);
    }

    /*
     * Convert 00 international prefix.
     *
     * 00234813...
     * ->
     * 234813...
     */
    if (
        number.startsWith('00')
    ) {
        number =
            number.slice(2);
    }

    /*
     * Nigerian local format.
     *
     * 08132538119
     * ->
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
     * Baileys pairing numbers must contain
     * digits only.
     */
    if (
        !/^\d{8,15}$/.test(
            number
        )
    ) {
        return '';
    }

    return number;
}

/*
|--------------------------------------------------------------------------
| Telegram messages
|--------------------------------------------------------------------------
*/

async function sendPairingInstructions(
    ctx,
    phoneNumber
) {
    try {
        await ctx.reply(
            '📡 <b>WhatsApp linking request started.</b>\n\n' +

            `📱 Number: <code>${phoneNumber}</code>\n\n` +

            'WhatsApp is now processing the device-link request.\n\n' +

            '📲 <b>On the WhatsApp phone:</b>\n' +
            '1. Open WhatsApp\n' +
            '2. Open <b>Settings</b>\n' +
            '3. Tap <b>Linked Devices</b>\n' +
            '4. Check for the new device/linking request\n\n' +

            'If WhatsApp displays an approval or confirmation prompt, complete it there.\n\n' +

            '⏳ SolvaX MD is waiting for WhatsApp to finish the connection.\n\n' +

            'Use /stop to cancel this attempt.',
            {
                parse_mode: 'HTML'
            }
        );

        return true;
    } catch (error) {
        console.error(
            '[PAIR] Failed sending linking instructions:',
            error
        );

        return false;
    }
}

async function replyPairingCode(
    ctx,
    code
) {
    const cleanCode =
        String(code || '')
            .trim()
            .toUpperCase();

    if (!cleanCode) {
        return false;
    }

    /*
     * HTML <code> gives Telegram users a convenient
     * copyable code.
     */
    try {
        await ctx.reply(
            '🔐 <b>WhatsApp pairing code</b>\n\n' +

            `<code>${cleanCode}</code>\n\n` +

            'Open WhatsApp on the phone you want to link.\n\n' +

            'Go to:\n' +
            '<b>Settings → Linked Devices → Link a Device</b>\n\n' +

            'If WhatsApp asks for the displayed pairing code, enter the code above.\n\n' +

            '⏳ Waiting for WhatsApp to finish linking...\n\n' +

            'Use /stop to cancel.',
            {
                parse_mode: 'HTML'
            }
        );

        return true;
    } catch (error) {
        console.error(
            '[PAIR] HTML code message failed:',
            error
        );

        /*
         * Fallback if Telegram has a problem
         * parsing the HTML.
         */
        try {
            await ctx.reply(
                '🔐 WhatsApp pairing code:\n\n' +
                cleanCode +
                '\n\n' +

                'Open WhatsApp → Settings → Linked Devices → Link a Device.\n\n' +

                'Enter the code when WhatsApp asks for it.\n\n' +

                '⏳ Waiting for WhatsApp to finish linking...\n\n' +

                'Use /stop to cancel.'
            );

            return true;
        } catch (fallbackError) {
            console.error(
                '[PAIR] Code fallback failed:',
                fallbackError
            );

            return false;
        }
    }
}

/*
|--------------------------------------------------------------------------
| Wait for Baileys pairing code
|--------------------------------------------------------------------------
|
| createWhatsAppSession() may need a short amount of time
| before session.pairingCode becomes available.
|
| We therefore poll instead of checking only once.
|--------------------------------------------------------------------------
*/

async function waitForPairingCode(
    userId,
    session,
    timeoutMs = 20000
) {
    const key =
        String(userId);

    const started =
        Date.now();

    while (
        Date.now() - started <
        timeoutMs
    ) {
        /*
         * Make sure the session wasn't replaced
         * or cancelled.
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
         * First check the session.
         */
        if (
            currentSession.pairingCode
        ) {
            const code =
                String(
                    currentSession.pairingCode
                )
                    .trim()
                    .toUpperCase();

            if (code) {
                return code;
            }
        }

        /*
         * Then check Telegram pairing state.
         */
        const state =
            getState(key);

        if (
            state?.code
        ) {
            const code =
                String(
                    state.code
                )
                    .trim()
                    .toUpperCase();

            if (code) {
                return code;
            }
        }

        await sleep(250);
    }

    return null;
}

/*
|--------------------------------------------------------------------------
| /pair
|--------------------------------------------------------------------------
*/

async function beginPairing(ctx) {
    const userId =
        String(ctx.from.id);

    /*
     * Do not allow two simultaneous pairing
     * requests for the same Telegram account.
     */
    const existingState =
        getState(userId);

    if (existingState) {
        await ctx.reply(
            '⚠️ You already have an active pairing request.\n\n' +
            'Finish it first or use /stop to completely clear it.'
        );

        return;
    }

    /*
     * Check for an existing WhatsApp session.
     */
    const existingSession =
        getWhatsAppSession(userId);

    if (
        existingSession &&
        !existingSession.stopping
    ) {
        if (
            existingSession.connected
        ) {
            await ctx.reply(
                '✅ Your WhatsApp account is already connected.\n\n' +
                'Use /stop first if you want to remove it and pair another number.'
            );

            return;
        }

        await ctx.reply(
            '⚠️ A WhatsApp session is already being prepared.\n\n' +
            'Use /stop to completely clear it before using /pair again.'
        );

        return;
    }

    /*
     * Create Telegram-side pairing state.
     */
    setState(
        userId,
        {
            stage: 'waiting_number',
            createdAt: Date.now()
        }
    );

    refreshPairingTimeout(
        userId
    );

    await ctx.reply(
        '📱 <b>WhatsApp pairing</b>\n\n' +

        'Send the WhatsApp phone number you want to link.\n\n' +

        'Use international format without +.\n\n' +

        '<b>Example:</b>\n' +
        '<code>2348132538119</code>\n\n' +

        'A Nigerian local number such as:\n' +
        '<code>08132538119</code>\n\n' +

        'is also accepted.\n\n' +

        'Send only the number.',
        {
            parse_mode: 'HTML'
        }
    );
}

/*
|--------------------------------------------------------------------------
| Handle submitted phone number
|--------------------------------------------------------------------------
*/

async function handlePairNumber(
    ctx,
    rawNumber
) {
    const userId =
        String(ctx.from.id);

    const state =
        getState(userId);

    /*
     * This prevents random Telegram messages from
     * accidentally being interpreted as numbers.
     */
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
            'Send only the phone number using international format without +.\n\n' +
            'Example:\n' +
            '2348132538119'
        );

        return true;
    }

    /*
     * Move state immediately so another Telegram
     * message cannot start a second pairing request.
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

    refreshPairingTimeout(
        userId
    );

    await ctx.reply(
        '🔄 <b>Preparing WhatsApp...</b>\n\n' +
        `📱 Number: <code>${phoneNumber}</code>\n\n` +
        '🧹 Clearing any old session first.\n' +
        '📡 Starting a fresh WhatsApp linking request.\n\n' +
        'Please wait.',
        {
            parse_mode: 'HTML'
        }
    );

    try {
        /*
         * Remove stale socket/authentication.
         *
         * IMPORTANT:
         * prepareFreshPairing() does NOT remove our
         * Telegram pairing state.
         */
        await prepareFreshPairing(
            userId
        );

        /*
         * Check whether /stop was used during cleanup.
         */
        let currentState =
            getState(userId);

        if (!currentState) {
            return true;
        }

        if (
            currentState.stage ===
            'cancelled'
        ) {
            return true;
        }

        /*
         * Tell the state machine we are now asking
         * WhatsApp for its authentication request/code.
         */
        setState(
            userId,
            {
                stage: 'requesting_code',
                phoneNumber,
                createdAt:
                    currentState.createdAt
            }
        );

        refreshPairingTimeout(
            userId
        );

        /*
         * Start the actual Baileys WhatsApp session.
         *
         * createWhatsAppSession() calls:
         *
         * sock.requestPairingCode(phoneNumber)
         *
         * when pairing=true.
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
         * Check again because /stop could have been
         * pressed while Baileys was connecting.
         */
        currentState =
            getState(userId);

        if (
            !currentState ||
            currentState.stage ===
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

        if (!session) {
            throw new Error(
                'WhatsApp session was not created.'
            );
        }

        /*
         * Show the user that the real WhatsApp
         * linking request is now underway.
         */
        await sendPairingInstructions(
            ctx,
            phoneNumber
        );

        /*
         * Move to code waiting state.
         *
         * Even if WhatsApp provides its own native
         * linking/approval UI, keeping the pairing-code
         * fallback makes the flow compatible with the
         * Baileys authentication method being used.
         */
        setState(
            userId,
            {
                stage: 'waiting_code',
                phoneNumber,
                createdAt:
                    currentState.createdAt
            }
        );

        refreshPairingTimeout(
            userId
        );

        /*
         * Wait for the code instead of immediately
         * assuming it exists.
         */
        const code =
            await waitForPairingCode(
                userId,
                session,
                20000
            );

        /*
         * Check cancellation one more time.
         */
        currentState =
            getState(userId);

        if (
            !currentState ||
            currentState.stage ===
            'cancelled'
        ) {
            return true;
        }

        /*
         * If WhatsApp hasn't produced a code, don't
         * leave a zombie session behind.
         */
        if (!code) {
            console.error(
                `[PAIR] WhatsApp did not return a pairing code for ${userId}.`
            );

            await completelyResetUser(
                userId,
                {
                    notify: false
                }
            );

            await ctx.reply(
                '❌ WhatsApp did not return a pairing code.\n\n' +
                '🧹 The incomplete session has been cleared.\n\n' +
                'Use /pair to start a fresh linking attempt.'
            );

            return true;
        }

        /*
         * Store the code in the Telegram state.
         */
        currentState.code =
            code;

        currentState.codeGeneratedAt =
            Date.now();

        currentState.stage =
            'waiting_connection';

        currentState.phoneNumber =
            phoneNumber;

        refreshPairingTimeout(
            userId
        );

        /*
         * Send the actual code.
         */
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
         * Complete cleanup on every failure.
         */
        await completelyResetUser(
            userId,
            {
                notify: false
            }
        );

        await ctx.reply(
            '❌ <b>Pairing failed.</b>\n\n' +

            'The WhatsApp connection could not be started.\n\n' +

            '🧹 Pairing state cleared\n' +
            '🧹 WhatsApp session cleared\n' +
            '🧹 Saved authentication removed\n' +
            '🧹 Reconnection cancelled\n\n' +

            'Use /pair to start a completely fresh attempt.',
            {
                parse_mode: 'HTML'
            }
        );

        return true;
    }
}

/*
|--------------------------------------------------------------------------
| Cancel pairing
|--------------------------------------------------------------------------
*/

async function cancelPairing(
    userId
) {
    const key =
        String(userId);

    const state =
        getState(key);

    /*
     * Mark it cancelled immediately.
     *
     * This matters if createWhatsAppSession()
     * is still waiting for Baileys.
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
     * Completely wipe everything.
     */
    await completelyResetUser(
        key,
        {
            notify: false
        }
    );

    return Boolean(state);
}

/*
|--------------------------------------------------------------------------
| Status
|--------------------------------------------------------------------------
*/

function getPairingStatus(
    userId
) {
    const state =
        getState(userId);

    if (!state) {
        return null;
    }

    /*
     * Never expose the internal Timeout object.
     */
    return {
        ...state,
        timeout: undefined
    };
}

/*
|--------------------------------------------------------------------------
| Exports
|--------------------------------------------------------------------------
*/

module.exports =
    beginPairing;

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
