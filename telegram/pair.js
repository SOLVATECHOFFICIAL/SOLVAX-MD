'use strict';

const {
    cleanNumber
} = require('../lib/helpers');

const {
    createWhatsAppSession,
    getWhatsAppSession,
    prepareFreshPairing
} = require('../lib/whatsapp');

/*
|--------------------------------------------------------------------------
| SOLVAX MD - PAIR COMMAND
|--------------------------------------------------------------------------
|
| IMPORTANT:
| This file DOES NOT register bot.on('text') dynamically.
|
| /pair only creates a pairing state and asks the user for a number.
| The GLOBAL Telegram text handler in index.js is responsible for
| receiving the number and calling handlePairNumber().
|
| This prevents:
|
|   /pair
|   -> waiting_number
|   -> number ignored
|   -> pairing state stuck forever
|
|--------------------------------------------------------------------------
*/

const WAITING_TIMEOUT = 2 * 60 * 1000;

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

function getUserId(ctx) {
    return String(ctx?.from?.id || '');
}

function getPairingState(userId) {
    return getStates()[userId] || null;
}

function setPairingState(userId, state) {
    getStates()[userId] = {
        ...state,
        userId,
        updatedAt: Date.now()
    };

    return getStates()[userId];
}

function clearPairingState(userId) {
    const states = getStates();
    const state = states[userId];

    if (state?.timeout) {
        clearTimeout(state.timeout);
    }

    delete states[userId];

    return state || null;
}

function refreshPairingTimeout(userId) {
    const states = getStates();
    const state = states[userId];

    if (!state) {
        return;
    }

    if (state.timeout) {
        clearTimeout(state.timeout);
    }

    state.timeout = setTimeout(async () => {
        const current = states[userId];

        if (!current) {
            return;
        }

        /*
         * Do not cancel an operation that has already progressed into
         * actual WhatsApp connection creation.
         */
        if (
            current.stage !== 'waiting_number' &&
            current.stage !== 'waiting_code'
        ) {
            return;
        }

        clearPairingState(userId);

        const bot = global.bot;

        if (!bot) {
            return;
        }

        try {
            await bot.telegram.sendMessage(
                userId,
                '⌛ Pairing request expired.\n\n' +
                'No phone number was received in time.\n\n' +
                'Use /pair to start again.'
            );
        } catch (error) {
            console.error(
                '[PAIR TIMEOUT]',
                error?.stack || error
            );
        }
    }, WAITING_TIMEOUT);

    /*
     * A Node.js timer should not keep the entire application alive.
     */
    if (typeof state.timeout.unref === 'function') {
        state.timeout.unref();
    }
}

function normalizePhoneNumber(input) {
    let number = cleanNumber(input);

    /*
     * WhatsApp pairing requires a real international number.
     *
     * Nigerian convenience:
     *
     * 08132538119
     * becomes
     * 2348132538119
     *
     * International numbers beginning with 00:
     *
     * 002348132538119
     * becomes
     * 2348132538119
     */
    if (number.startsWith('00')) {
        number = number.slice(2);
    }

    /*
     * Nigerian local format.
     */
    if (
        number.length === 11 &&
        number.startsWith('0')
    ) {
        number = `234${number.slice(1)}`;
    }

    /*
     * WhatsApp phone numbers are generally between 7 and 15 digits.
     * This is intentionally only a sanity check.
     *
     * We do NOT attempt to prove that the number actually belongs
     * to WhatsApp. Baileys/WhatsApp handles that part.
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

function isPairingActive(userId) {
    const state = getPairingState(userId);

    if (!state) {
        return false;
    }

    /*
     * Clean obviously stale states.
     */
    if (
        state.updatedAt &&
        Date.now() - state.updatedAt > WAITING_TIMEOUT &&
        (
            state.stage === 'waiting_number' ||
            state.stage === 'waiting_code'
        )
    ) {
        clearPairingState(userId);
        return false;
    }

    return Boolean(state.active);
}

async function reply(ctx, text) {
    try {
        return await ctx.reply(text);
    } catch (error) {
        console.error(
            '[PAIR TELEGRAM REPLY]',
            error?.stack || error
        );
    }
}

async function pairCommand(ctx) {
    const userId = getUserId(ctx);

    if (!userId) {
        return;
    }

    const states = getStates();
    const sessions = getSessions();

    /*
     * Never allow two pairing jobs for one Telegram user.
     */
    if (isPairingActive(userId)) {
        const state = states[userId];

        let message =
            '⏳ A pairing operation is already running.\n\n';

        if (state?.stage === 'waiting_number') {
            message +=
                'Send the WhatsApp phone number here.\n\n' +
                'Example:\n' +
                '2348132538119';
        } else if (state?.stage === 'creating_session') {
            message +=
                'The WhatsApp session is being prepared.';
        } else if (state?.stage === 'requesting_code') {
            message +=
                'The WhatsApp pairing code is being requested.';
        } else if (state?.stage === 'waiting_connection') {
            message +=
                'The pairing code was sent.\n\n' +
                'Finish linking the device in WhatsApp.';
        } else {
            message +=
                'Wait for it to finish before using /pair again.';
        }

        return reply(ctx, message);
    }

    /*
     * If a session already exists, don't accidentally overwrite it.
     */
    if (sessions[userId]) {
        return reply(
            ctx,
            '🟢 Your WhatsApp session is already active.\n\n' +
            'Use /status to check it.\n' +
            'Use /stop if you want to stop it before pairing another account.'
        );
    }

    /*
     * Start a clean waiting state.
     */
    const state = setPairingState(userId, {
        active: true,
        stage: 'waiting_number',
        phoneNumber: null,
        pairingCode: null,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        timeout: null
    });

    refreshPairingTimeout(userId);

    state.timeout = getStates()[userId].timeout;

    return reply(
        ctx,
        '📱 Send the WhatsApp phone number you want to pair.\n\n' +
        'Use international format without +.\n\n' +
        'Example:\n' +
        '2348132538119\n\n' +
        'For a Nigerian number like 08132538119, you can also send the local format.\n\n' +
        'Send only the number.'
    );
}

/*
|--------------------------------------------------------------------------
| HANDLE PHONE NUMBER
|--------------------------------------------------------------------------
|
| Called by the GLOBAL Telegram text handler in index.js.
|
| Example:
|
| Telegram:
|   /pair
|
| Bot:
|   Send phone number...
|
| User:
|   2349063285877
|
| index.js:
|   handlePairNumber(ctx, '2349063285877')
|
|--------------------------------------------------------------------------
*/

async function handlePairNumber(ctx, rawNumber) {
    const userId = getUserId(ctx);

    if (!userId) {
        return false;
    }

    const states = getStates();

    const state = states[userId];

    /*
     * This text is not a pairing response for this user.
     * Tell index.js to continue normal processing.
     */
    if (
        !state ||
        !state.active ||
        state.stage !== 'waiting_number'
    ) {
        return false;
    }

    /*
     * Refresh timeout because the user actually responded.
     */
    if (state.timeout) {
        clearTimeout(state.timeout);
        state.timeout = null;
    }

    const number = normalizePhoneNumber(rawNumber);

    if (!number) {
        refreshPairingTimeout(userId);

        return reply(
            ctx,
            '❌ Invalid phone number.\n\n' +
            'Send a valid WhatsApp number using international format.\n\n' +
            'Example:\n' +
            '2349063285877\n\n' +
            'Do not include +.'
        );
    }

    /*
     * Prevent another session from appearing between /pair and the
     * number message.
     */
    const existingSession = getWhatsAppSession(userId);

    if (existingSession) {
        clearPairingState(userId);

        return reply(
            ctx,
            '🟢 A WhatsApp session is already active for this Telegram account.\n\n' +
            'Use /status to inspect it or /stop before starting another pairing.'
        );
    }

    /*
     * Move state BEFORE starting asynchronous work.
     *
     * This is important.
     *
     * If the socket creation takes several seconds, another /pair
     * command must not start a second operation.
     */
    setPairingState(userId, {
        ...state,
        active: true,
        stage: 'creating_session',
        phoneNumber: number,
        pairingCode: null,
        updatedAt: Date.now(),
        timeout: null
    });

    await reply(
        ctx,
        '🔄 Preparing WhatsApp pairing...\n\n' +
        `📱 Number: ${number}\n\n` +
        'Please wait.'
    );

    try {
        /*
         * Delete/close stale pairing material first.
         *
         * This is especially important after a previous failed pairing.
         */
        try {
            await prepareFreshPairing(userId);
        } catch (cleanupError) {
            console.error(
                '[PAIR PRE-CLEANUP]',
                cleanupError?.stack || cleanupError
            );

            /*
             * Do not immediately abort if cleanup merely found
             * nothing to clean.
             */
        }

        /*
         * Check that the user has not cancelled the operation while
         * cleanup was happening.
         */
        const currentState = states[userId];

        if (
            !currentState ||
            !currentState.active
        ) {
            return true;
        }

        setPairingState(userId, {
            ...currentState,
            active: true,
            stage: 'requesting_code',
            phoneNumber: number,
            updatedAt: Date.now()
        });

        /*
         * createWhatsAppSession is responsible for:
         *
         * - creating Baileys socket
         * - loading auth state
         * - requesting pairing code
         * - storing the session
         * - handling connection events
         *
         * It must NOT install Telegram text listeners.
         */
        const session = await createWhatsAppSession(
            userId,
            number,
            ctx,
            {
                pairing: true
            }
        );

        /*
         * If /stop cancelled the operation while the socket was being
         * created, do not continue sending pairing messages.
         */
        const afterCreate = states[userId];

        if (
            !afterCreate ||
            !afterCreate.active
        ) {
            return true;
        }

        if (!session) {
            clearPairingState(userId);

            return reply(
                ctx,
                '❌ WhatsApp session could not be created.\n\n' +
                'The pairing operation has been reset.\n\n' +
                'Use /pair to try again.'
            );
        }

        /*
         * createWhatsAppSession should store the generated code on:
         *
         * global.sessions[userId].pairingCode
         */
        const sessionRecord =
            getWhatsAppSession(userId) ||
            session;

        const pairingCode =
            sessionRecord?.pairingCode || null;

        if (pairingCode) {
            setPairingState(userId, {
                ...afterCreate,
                active: true,
                stage: 'waiting_connection',
                phoneNumber: number,
                pairingCode,
                updatedAt: Date.now()
            });

            /*
             * The connection result itself is handled by the
             * WhatsApp session lifecycle.
             */
            return reply(
                ctx,
                '🔐 WhatsApp pairing code:\n\n' +
                `${pairingCode}\n\n` +
                'Open WhatsApp on the phone you want to link and enter this code.\n\n' +
                '⏳ Waiting for WhatsApp to finish linking...\n\n' +
                'Use /stop to cancel this pairing.'
            );
        }

        /*
         * Some Baileys/environment combinations may not expose the
         * pairing code immediately. Leave the state alive briefly so
         * the connection layer can finish its work.
         */
        setPairingState(userId, {
            ...afterCreate,
            active: true,
            stage: 'waiting_connection',
            phoneNumber: number,
            pairingCode: null,
            updatedAt: Date.now()
        });

        return reply(
            ctx,
            '📡 WhatsApp pairing has started.\n\n' +
            'The pairing code is being prepared.\n\n' +
            'Check your WhatsApp linking screen and wait for the bot to report the result.'
        );
    } catch (error) {
        console.error(
            '[PAIR CREATE]',
            error?.stack || error
        );

        /*
         * Only clear the state if it still belongs to this pairing
         * operation. A new /pair operation must never be wiped out by
         * an old asynchronous error.
         */
        const current = states[userId];

        if (current?.phoneNumber === number) {
            clearPairingState(userId);
        }

        let message =
            '❌ Pairing failed.\n\n';

        const reason =
            error?.message ||
            error?.output?.payload?.message ||
            'Unknown error';

        /*
         * Keep Telegram output useful without dumping internal
         * stack traces to the user.
         */
        if (
            /401|logged.?out|unauthorized/i.test(reason)
        ) {
            message +=
                'WhatsApp rejected the session.\n\n';
        } else if (
            /timeout|timed out/i.test(reason)
        ) {
            message +=
                'The pairing request timed out.\n\n';
        } else {
            message +=
                'The WhatsApp connection could not be started.\n\n';
        }

        message +=
            'The pairing state has been reset.\n\n' +
            'Use /pair to try again.';

        return reply(ctx, message);
    }

    /*
     * The number was definitely consumed.
     */
    return true;
}

/*
|--------------------------------------------------------------------------
| CANCEL PAIRING
|--------------------------------------------------------------------------
|
| Used by telegram/stop.js.
|
|--------------------------------------------------------------------------
*/

function cancelPairing(userId) {
    userId = String(userId || '');

    if (!userId) {
        return null;
    }

    const state = getPairingState(userId);

    if (!state) {
        return null;
    }

    clearPairingState(userId);

    return state;
}

/*
|--------------------------------------------------------------------------
| GET STATE
|--------------------------------------------------------------------------
*/

function getPairingStatus(userId) {
    userId = String(userId || '');

    const state = getPairingState(userId);

    if (!state) {
        return null;
    }

    return {
        active: Boolean(state.active),
        stage: state.stage || null,
        phoneNumber: state.phoneNumber || null,
        pairingCode: state.pairingCode || null,
        startedAt: state.startedAt || null,
        updatedAt: state.updatedAt || null
    };
}

/*
|--------------------------------------------------------------------------
| EXPORTS
|--------------------------------------------------------------------------
*/

module.exports = pairCommand;

module.exports.handlePairNumber = handlePairNumber;
module.exports.cancelPairing = cancelPairing;
module.exports.clearPairingState = clearPairingState;
module.exports.getPairingStatus = getPairingStatus;
module.exports.normalizePhoneNumber = normalizePhoneNumber;
module.exports.isPairingActive = isPairingActive;
