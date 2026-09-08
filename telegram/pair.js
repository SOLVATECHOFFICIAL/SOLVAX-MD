'use strict';

const { cleanNumber } = require('../lib/helpers');

const {
    createWhatsAppSession,
    getWhatsAppSession,
    prepareFreshPairing,
    completelyResetUser
} = require('../lib/whatsapp');

const WAITING_TIMEOUT =
    2 * 60 * 1000;

/*
|--------------------------------------------------------------------------
| GLOBAL STATE
|--------------------------------------------------------------------------
*/

function getStates() {
    if (!global.pairingStates) {
        global.pairingStates = {};
    }

    return global.pairingStates;
}

function getSessions() {
    if (!global.sessions) {
        global.sessions = {};
    }

    return global.sessions;
}

/*
|--------------------------------------------------------------------------
| BASIC HELPERS
|--------------------------------------------------------------------------
*/

function getUserId(ctx) {
    return String(
        ctx?.from?.id || ''
    );
}

function getPairingState(userId) {
    return (
        getStates()[
            String(userId)
        ] || null
    );
}

function setPairingState(
    userId,
    state
) {
    const states =
        getStates();

    const key =
        String(userId);

    states[key] = {
        ...state,

        userId: key,

        updatedAt:
            Date.now()
    };

    return states[key];
}

function clearPairingState(
    userId
) {
    const states =
        getStates();

    const key =
        String(userId);

    const state =
        states[key];

    if (
        state?.timeout
    ) {
        try {
            clearTimeout(
                state.timeout
            );
        } catch (_) {}
    }

    delete states[key];

    return state || null;
}

/*
|--------------------------------------------------------------------------
| TELEGRAM REPLY
|--------------------------------------------------------------------------
*/

async function reply(
    ctx,
    text,
    extra = {}
) {
    try {
        return await ctx.reply(
            String(text || ''),
            extra
        );
    } catch (error) {
        console.error(
            '[PAIR TELEGRAM REPLY]',
            error?.stack || error
        );

        return null;
    }
}

/*
|--------------------------------------------------------------------------
| COPYABLE PAIRING CODE
|--------------------------------------------------------------------------
*/

async function replyPairingCode(
    ctx,
    code
) {
    const cleanCode =
        String(
            code || ''
        )
            .trim()
            .toUpperCase();

    if (!cleanCode) {
        return reply(
            ctx,
            '❌ WhatsApp did not return a pairing code.'
        );
    }

    /*
     * Telegram HTML <code> makes the code easy to select/copy.
     *
     * We still provide a plain-text fallback if HTML parsing fails.
     */

    const escaped =
        cleanCode
            .replace(
                /&/g,
                '&amp;'
            )
            .replace(
                /</g,
                '&lt;'
            )
            .replace(
                />/g,
                '&gt;'
            );

    try {
        return await ctx.reply(
            '🔐 <b>WhatsApp pairing code</b>\n\n' +

            `<code>${escaped}</code>\n\n` +

            '📱 On the WhatsApp phone:\n' +
            '1. Open WhatsApp\n' +
            '2. Open Linked Devices\n' +
            '3. Choose Link a device\n' +
            '4. Choose the phone-number linking option\n' +
            '5. Enter the code above\n\n' +

            '⏳ The code may expire.\n\n' +

            '🛑 Use /stop if you want to cancel this pairing.',
            {
                parse_mode: 'HTML'
            }
        );
    } catch (error) {
        console.error(
            '[PAIR CODE HTML]',
            error?.stack || error
        );

        return reply(
            ctx,
            '🔐 WhatsApp pairing code:\n\n' +
            cleanCode +
            '\n\n' +

            'Open WhatsApp → Linked Devices → Link a device → phone-number linking.\n\n' +

            'Enter the code before it expires.'
        );
    }
}

/*
|--------------------------------------------------------------------------
| PHONE NUMBER NORMALIZATION
|--------------------------------------------------------------------------
*/

function normalizePhoneNumber(
    input
) {
    let number =
        cleanNumber(
            input
        );

    /*
     * Convert:
     *
     * 00 234...
     *
     * into:
     *
     * 234...
     */

    if (
        number.startsWith('00')
    ) {
        number =
            number.slice(2);
    }

    /*
     * Nigerian local number:
     *
     * 08132538119
     *
     * becomes:
     *
     * 2348132538119
     */

    if (
        number.length === 11 &&
        number.startsWith('0')
    ) {
        number =
            `234${number.slice(1)}`;
    }

    /*
     * Baileys/WhatsApp phone-number
     * format should contain digits only.
     */

    if (
        !number ||
        number.length < 7 ||
        number.length > 15
    ) {
        return null;
    }

    return number;
}

/*
|--------------------------------------------------------------------------
| PAIRING TIMEOUT
|--------------------------------------------------------------------------
*/

function refreshPairingTimeout(
    userId
) {
    const states =
        getStates();

    const key =
        String(userId);

    const state =
        states[key];

    if (!state) {
        return;
    }

    if (
        state.timeout
    ) {
        try {
            clearTimeout(
                state.timeout
            );
        } catch (_) {}
    }

    const timeout =
        setTimeout(
            async () => {
                const current =
                    states[key];

                if (!current) {
                    return;
                }

                if (
                    current.stage !==
                        'waiting_number' &&
                    current.stage !==
                        'creating_session' &&
                    current.stage !==
                        'requesting_code' &&
                    current.stage !==
                        'waiting_connection'
                ) {
                    return;
                }

                /*
                 * Complete cleanup, not merely state deletion.
                 *
                 * This prevents an unfinished socket from surviving
                 * after the Telegram pairing state expires.
                 */

                try {
                    await completelyResetUser(
                        key,
                        {
                            notify: false,
                            reason:
                                'Pairing timeout.'
                        }
                    );
                } catch (error) {
                    console.error(
                        '[PAIR TIMEOUT RESET]',
                        error?.stack || error
                    );
                }

                clearPairingState(
                    key
                );

                const bot =
                    global.bot;

                if (!bot) {
                    return;
                }

                try {
                    await bot.telegram.sendMessage(
                        key,
                        '⌛ Pairing request expired.\n\n' +

                        'No pairing was completed within the allowed time.\n\n' +

                        '🧹 The temporary WhatsApp session was cleared.\n\n' +

                        'Use /pair to start again.'
                    );
                } catch (error) {
                    console.error(
                        '[PAIR TIMEOUT TELEGRAM]',
                        error?.stack || error
                    );
                }
            },
            WAITING_TIMEOUT
        );

    if (
        typeof timeout.unref ===
        'function'
    ) {
        timeout.unref();
    }

    state.timeout =
        timeout;
}

/*
|--------------------------------------------------------------------------
| PAIRING ACTIVE CHECK
|--------------------------------------------------------------------------
*/

function isPairingActive(
    userId
) {
    const state =
        getPairingState(
            userId
        );

    if (!state) {
        return false;
    }

    if (
        !state.active
    ) {
        return false;
    }

    if (
        state.updatedAt &&
        Date.now() -
            state.updatedAt >
            WAITING_TIMEOUT
    ) {
        clearPairingState(
            userId
        );

        return false;
    }

    return true;
}

/*
|--------------------------------------------------------------------------
| /PAIR
|--------------------------------------------------------------------------
*/

async function pairCommand(
    ctx
) {
    const userId =
        getUserId(ctx);

    if (!userId) {
        return;
    }

    const states =
        getStates();

    const sessions =
        getSessions();

    /*
     * ------------------------------------------------------------
     * ALREADY PAIRING
     * ------------------------------------------------------------
     */

    if (
        isPairingActive(
            userId
        )
    ) {
        const state =
            states[userId];

        if (
            state?.stage ===
            'waiting_number'
        ) {
            return reply(
                ctx,
                '⏳ A pairing operation is already waiting for a number.\n\n' +

                'Send the WhatsApp number here.\n\n' +

                'Example:\n' +
                '2349049979183\n\n' +

                'Or use /stop to cancel it.'
            );
        }

        if (
            state?.stage ===
            'creating_session'
        ) {
            return reply(
                ctx,
                '⏳ WhatsApp pairing is currently being prepared.\n\n' +
                'Please wait or use /stop to cancel it.'
            );
        }

        if (
            state?.stage ===
            'requesting_code'
        ) {
            return reply(
                ctx,
                '⏳ WhatsApp is currently requesting a pairing code.\n\n' +
                'Please wait or use /stop to cancel it.'
            );
        }

        if (
            state?.stage ===
            'waiting_connection'
        ) {
            return reply(
                ctx,
                '🔐 A pairing code has already been requested.\n\n' +
                'Finish linking the WhatsApp account or use /stop to cancel it.'
            );
        }

        return reply(
            ctx,
            '⏳ A pairing operation is already running.\n\n' +
            'Use /stop to cancel it.'
        );
    }

    /*
     * ------------------------------------------------------------
     * EXISTING SESSION
     * ------------------------------------------------------------
     *
     * With the new architecture, /pair does NOT silently replace
     * an active account.
     *
     * User should /stop first.
     */

    if (
        sessions[userId]
    ) {
        return reply(
            ctx,
            '🟢 A WhatsApp session is already active.\n\n' +

            'Use /status to inspect it.\n\n' +

            'Use /stop to completely clear it.\n\n' +

            'Then use /pair to link the same number or another number.'
        );
    }

    /*
     * ------------------------------------------------------------
     * START PAIRING STATE
     * ------------------------------------------------------------
     */

    const state =
        setPairingState(
            userId,
            {
                active: true,

                stage:
                    'waiting_number',

                phoneNumber:
                    null,

                pairingCode:
                    null,

                startedAt:
                    Date.now(),

                updatedAt:
                    Date.now(),

                timeout:
                    null
            }
        );

    refreshPairingTimeout(
        userId
    );

    /*
     * Keep the actual timeout reference in the state.
     */

    state.timeout =
        getStates()[
            userId
        ]?.timeout ||
        null;

    return reply(
        ctx,

        '📱 <b>Send the WhatsApp phone number you want to pair.</b>\n\n' +

        'Use international format without <code>+</code>.\n\n' +

        'Example:\n' +
        '<code>2349049979183</code>\n\n' +

        'For a Nigerian number like:\n' +
        '<code>09049979183</code>\n\n' +

        'you can also send the local format.\n\n' +

        'Send only the number.\n\n' +

        '🛑 Use /stop to cancel.',
        {
            parse_mode: 'HTML'
        }
    );
}

/*
|--------------------------------------------------------------------------
| HANDLE NUMBER AFTER /PAIR
|--------------------------------------------------------------------------
*/

async function handlePairNumber(
    ctx,
    rawNumber
) {
    const userId =
        getUserId(ctx);

    if (!userId) {
        return false;
    }

    const states =
        getStates();

    const state =
        states[userId];

    /*
     * Only accept a number while the user is specifically waiting
     * for a number.
     */

    if (
        !state ||
        state.active !== true ||
        state.stage !==
            'waiting_number'
    ) {
        return false;
    }

    /*
     * Stop the old number-entry timeout while we validate and
     * create the session.
     */

    if (
        state.timeout
    ) {
        try {
            clearTimeout(
                state.timeout
            );
        } catch (_) {}

        state.timeout =
            null;
    }

    /*
     * ------------------------------------------------------------
     * NORMALIZE NUMBER
     * ------------------------------------------------------------
     */

    const number =
        normalizePhoneNumber(
            rawNumber
        );

    if (!number) {
        refreshPairingTimeout(
            userId
        );

        await reply(
            ctx,
            '❌ Invalid phone number.\n\n' +

            'Send a valid WhatsApp number using digits only.\n\n' +

            'Example:\n' +
            '2349049979183\n\n' +

            'Do not include +.'
        );

        return false;
    }

    /*
     * ------------------------------------------------------------
     * CHECK AGAIN FOR SESSION
     * ------------------------------------------------------------
     */

    const existingSession =
        getWhatsAppSession(
            userId
        );

    if (
        existingSession
    ) {
        clearPairingState(
            userId
        );

        return reply(
            ctx,
            '🟢 A WhatsApp session is already active.\n\n' +

            'Use /stop first if you want to completely clear it.\n\n' +

            'After that, /pair can be used with the same number or another number.'
        );
    }

    /*
     * ------------------------------------------------------------
     * STORE NUMBER
     * ------------------------------------------------------------
     */

    setPairingState(
        userId,
        {
            ...state,

            active: true,

            stage:
                'creating_session',

            phoneNumber:
                number,

            pairingCode:
                null,

            timeout:
                null
        }
    );

    await reply(
        ctx,

        '🔄 <b>Preparing WhatsApp pairing...</b>\n\n' +

        `📱 Number: <code>${number}</code>\n\n` +

        'Please wait.',
        {
            parse_mode: 'HTML'
        }
    );

    /*
     * ------------------------------------------------------------
     * CLEAN ANY LEFTOVER DATA
     * ------------------------------------------------------------
     *
     * This is a fresh pairing.
     */

    try {
        await prepareFreshPairing(
            userId
        );
    } catch (error) {
        console.error(
            '[PAIR PREPARE]',
            error?.stack || error
        );

        clearPairingState(
            userId
        );

        return reply(
            ctx,
            '❌ Could not prepare a fresh WhatsApp session.\n\n' +
            'The pairing state was reset.\n\n' +
            'Use /pair to try again.'
        );
    }

    /*
     * ------------------------------------------------------------
     * CHECK WHETHER /STOP WAS USED
     * ------------------------------------------------------------
     */

    const afterPrepare =
        getPairingState(
            userId
        );

    if (
        !afterPrepare ||
        afterPrepare.active !== true
    ) {
        return false;
    }

    /*
     * ------------------------------------------------------------
     * REQUESTING CODE
     * ------------------------------------------------------------
     */

    setPairingState(
        userId,
        {
            ...afterPrepare,

            active: true,

            stage:
                'requesting_code',

            phoneNumber:
                number,

            pairingCode:
                null,

            timeout:
                null
        }
    );

    try {
        /*
         * --------------------------------------------------------
         * CREATE SOCKET + REQUEST CODE
         * --------------------------------------------------------
         */

        const session =
            await createWhatsAppSession(
                userId,
                number,
                ctx,
                {
                    pairing: true
                }
            );

        /*
         * --------------------------------------------------------
         * CHECK FOR /STOP DURING CREATION
         * --------------------------------------------------------
         */

        const currentState =
            getPairingState(
                userId
            );

        if (
            !currentState ||
            currentState.active !== true
        ) {
            /*
             * /stop may have happened while createWhatsAppSession
             * was awaiting WhatsApp.
             *
             * Clean anything that might have appeared meanwhile.
             */

            try {
                await completelyResetUser(
                    userId,
                    {
                        notify: false,
                        reason:
                            'Pairing cancelled.'
                    }
                );
            } catch (cleanupError) {
                console.error(
                    '[PAIR CANCEL CLEANUP]',
                    cleanupError?.stack ||
                    cleanupError
                );
            }

            return false;
        }

        /*
         * --------------------------------------------------------
         * SESSION CREATION FAILED
         * --------------------------------------------------------
         */

        if (!session) {
            clearPairingState(
                userId
            );

            return reply(
                ctx,
                '❌ WhatsApp session could not be created.\n\n' +

                'The temporary pairing state was cleared.\n\n' +

                'Use /pair to try again.'
            );
        }

        /*
         * --------------------------------------------------------
         * GET CODE
         * --------------------------------------------------------
         */

        const pairingCode =
            String(
                session.pairingCode ||
                ''
            )
                .trim()
                .toUpperCase();

        /*
         * --------------------------------------------------------
         * CODE EXISTS
         * --------------------------------------------------------
         */

        if (
            pairingCode
        ) {
            setPairingState(
                userId,
                {
                    ...currentState,

                    active: true,

                    stage:
                        'waiting_connection',

                    phoneNumber:
                        number,

                    pairingCode,

                    timeout:
                        null
                }
            );

            /*
             * Give the user a fresh timeout while WhatsApp waits
             * for the account to finish linking.
             */

            refreshPairingTimeout(
                userId
            );

            return replyPairingCode(
                ctx,
                pairingCode
            );
        }

        /*
         * --------------------------------------------------------
         * NO CODE
         * --------------------------------------------------------
         */

        setPairingState(
            userId,
            {
                ...currentState,

                active: true,

                stage:
                    'waiting_connection',

                phoneNumber:
                    number,

                pairingCode:
                    null,

                timeout:
                    null
            }
        );

        refreshPairingTimeout(
            userId
        );

        return reply(
            ctx,

            '📡 WhatsApp pairing has started.\n\n' +

            '⚠️ No pairing code was returned yet.\n\n' +

            'Wait briefly and check WhatsApp.\n\n' +

            'Use /stop to cancel the session.'
        );

    } catch (error) {
        console.error(
            '[PAIR CREATE]',
            error?.stack || error
        );

        /*
         * --------------------------------------------------------
         * COMPLETE CLEANUP ON FAILURE
         * --------------------------------------------------------
         */

        try {
            await completelyResetUser(
                userId,
                {
                    notify: false,
                    reason:
                        'Pairing failed.'
                }
            );
        } catch (cleanupError) {
            console.error(
                '[PAIR FAILURE CLEANUP]',
                cleanupError?.stack ||
                cleanupError
            );
        }

        clearPairingState(
            userId
        );

        /*
         * --------------------------------------------------------
         * USER-FRIENDLY ERROR
         * --------------------------------------------------------
         */

        const reason =
            String(
                error?.message ||
                error?.output?.payload?.message ||
                ''
            );

        let message =
            '❌ Pairing failed.\n\n';

        if (
            /401|logged.?out|unauthorized/i
                .test(reason)
        ) {
            message +=
                'WhatsApp rejected the pairing session.\n\n';
        } else if (
            /timeout|timed out/i
                .test(reason)
        ) {
            message +=
                'The WhatsApp connection timed out.\n\n';
        } else if (
            /socket|connection/i
                .test(reason)
        ) {
            message +=
                'The WhatsApp connection could not be started.\n\n';
        } else {
            message +=
                'The WhatsApp connection could not be started.\n\n';
        }

        message +=
            '🧹 The temporary session and pairing state were cleared.\n\n' +

            'You can use /pair again with the same number or another number.';

        return reply(
            ctx,
            message
        );
    }
}

/*
|--------------------------------------------------------------------------
| CANCEL PAIRING
|--------------------------------------------------------------------------
*/

async function cancelPairing(
    userId
) {
    const key =
        String(
            userId || ''
        );

    if (!key) {
        return null;
    }

    const state =
        getPairingState(
            key
        );

    if (!state) {
        return null;
    }

    /*
     * Clear Telegram-side state immediately.
     */

    clearPairingState(
        key
    );

    /*
     * Also clean a socket/auth directory if one was already created.
     */

    try {
        await completelyResetUser(
            key,
            {
                notify: false,
                reason:
                    'Pairing cancelled.'
            }
        );
    } catch (error) {
        console.error(
            '[PAIR CANCEL RESET]',
            error?.stack || error
        );
    }

    return state;
}

/*
|--------------------------------------------------------------------------
| PAIRING STATUS
|--------------------------------------------------------------------------
*/

function getPairingStatus(
    userId
) {
    const state =
        getPairingState(
            String(userId || '')
        );

    if (!state) {
        return null;
    }

    return {
        active:
            Boolean(
                state.active
            ),

        stage:
            state.stage ||
            null,

        phoneNumber:
            state.phoneNumber ||
            null,

        pairingCode:
            state.pairingCode ||
            null,

        startedAt:
            state.startedAt ||
            null,

        updatedAt:
            state.updatedAt ||
            null
    };
}

/*
|--------------------------------------------------------------------------
| CLEAR STATE ONLY
|--------------------------------------------------------------------------
|
| Kept as a separate export because index.js and other parts of the
| bot may need to clear the Telegram state without doing a full
| WhatsApp reset during shutdown.
|--------------------------------------------------------------------------
*/

function clearPairingStateExport(
    userId
) {
    return clearPairingState(
        String(userId || '')
    );
}

/*
|--------------------------------------------------------------------------
| EXPORTS
|--------------------------------------------------------------------------
*/

module.exports =
    pairCommand;

module.exports.handlePairNumber =
    handlePairNumber;

module.exports.cancelPairing =
    cancelPairing;

module.exports.clearPairingState =
    clearPairingStateExport;

module.exports.getPairingStatus =
    getPairingStatus;

module.exports.normalizePhoneNumber =
    normalizePhoneNumber;

module.exports.isPairingActive =
    isPairingActive;

module.exports.replyPairingCode =
    replyPairingCode;
