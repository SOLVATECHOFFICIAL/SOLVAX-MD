const { sleep } = require('../lib/helpers');

const {
    createWhatsAppSession,
    getWhatsAppSession,
    completelyResetUser
} = require('../lib/whatsapp');

const WAITING_TIMEOUT = 2 * 60 * 1000;
const PAIRING_CODE_TIMEOUT = 60 * 1000;

/* =========================================================
   GLOBAL PAIRING STATE
========================================================= */

function getPairingStates() {
    if (!global.pairingStates) {
        global.pairingStates = {};
    }

    return global.pairingStates;
}

function getState(userId) {
    const states = getPairingStates();
    return states[String(userId)] || null;
}

function setState(userId, data) {
    const states = getPairingStates();
    const key = String(userId);

    states[key] = {
        ...(states[key] || {}),
        ...data,
        updatedAt: Date.now()
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

/* =========================================================
   PAIRING TIMEOUT
========================================================= */

function refreshPairingTimeout(ctx, userId) {
    const key = String(userId);
    const state = getState(key);

    if (!state) {
        return;
    }

    if (state.timeout) {
        clearTimeout(state.timeout);
    }

    const timeout = setTimeout(async () => {
        const current = getState(key);

        if (!current) {
            return;
        }

        try {
            await ctx.reply(
                '⏰ Pairing request timed out.\n\n' +
                'The WhatsApp pairing process was cancelled because ' +
                'the connection was not completed within 2 minutes.\n\n' +
                'Use /pair to start again.'
            );
        } catch (error) {
            console.error(
                `[PAIR TIMEOUT] Telegram reply failed for ${key}:`,
                error?.message || error
            );
        }

        try {
            await completelyResetUser(key);
        } catch (error) {
            console.error(
                `[PAIR TIMEOUT] WhatsApp cleanup failed for ${key}:`,
                error?.message || error
            );
        }

        clearState(key);
    }, WAITING_TIMEOUT);

    state.timeout = timeout;
    state.updatedAt = Date.now();
}

/* =========================================================
   PHONE NUMBER NORMALIZATION
========================================================= */

function normalizePhoneNumber(input) {
    let value = String(input || '').trim();

    if (!value) {
        return null;
    }

    // Remove spaces, brackets, hyphens and other formatting.
    value = value.replace(/[^\d+]/g, '');

    // Convert 00XXXXXXXX to +XXXXXXXX.
    if (value.startsWith('00')) {
        value = '+' + value.slice(2);
    }

    // Nigerian local number:
    // 08012345678 -> +2348012345678
    if (value.startsWith('0') && !value.startsWith('00')) {
        value = '+234' + value.slice(1);
    }

    // Remove the plus sign.
    value = value.replace(/\D/g, '');

    if (!value) {
        return null;
    }

    // International phone numbers are normally 10–15 digits.
    if (value.length < 10 || value.length > 15) {
        return null;
    }

    return value;
}

/* =========================================================
   PAIRING INSTRUCTIONS
========================================================= */

async function sendPairingInstructions(ctx, phoneNumber) {
    await ctx.reply(
        '📱 Number: ' + phoneNumber + '\n\n' +
        '📲 On the WhatsApp phone:\n\n' +
        '1. Open WhatsApp\n' +
        '2. Open Settings\n' +
        '3. Tap Linked devices\n' +
        '4. Tap Link a device\n' +
        '5. Tap Link with phone number instead\n' +
        '6. Enter the pairing code sent below\n\n' +
        '⚠️ Keep WhatsApp open while linking.\n\n' +
        '⏳ The pairing code may take a few seconds to appear.'
    );
}

/* =========================================================
   SEND PAIRING CODE
========================================================= */

async function replyPairingCode(ctx, code) {
    if (!code) {
        throw new Error('Pairing code was empty.');
    }

    const formattedCode = String(code)
        .replace(/\s+/g, '')
        .toUpperCase();

    await ctx.reply(
        '🔐 WHATSAPP PAIRING CODE\n\n' +
        '`' + formattedCode + '`\n\n' +
        '📲 Enter this code on WhatsApp using:\n' +
        'Settings → Linked devices → Link a device → ' +
        'Link with phone number instead\n\n' +
        '⏳ Waiting for WhatsApp to complete the connection...',
        {
            parse_mode: 'Markdown'
        }
    );
}

/* =========================================================
   WAIT FOR PAIRING CODE
========================================================= */

async function waitForPairingCode(
    userId,
    session,
    timeout = PAIRING_CODE_TIMEOUT
) {
    const key = String(userId);
    const started = Date.now();

    while (Date.now() - started < timeout) {

        // Check the session returned by createWhatsAppSession().
        if (session?.pairingCode) {
            return session.pairingCode;
        }

        // Check the currently registered WhatsApp session.
        const currentSession = getWhatsAppSession(key);

        if (currentSession?.pairingCode) {
            return currentSession.pairingCode;
        }

        // Check the shared pairing state.
        const state = getState(key);

        if (state?.pairingCode) {
            return state.pairingCode;
        }

        await sleep(500);
    }

    return null;
}

/* =========================================================
   BEGIN /PAIR
========================================================= */

async function beginPairing(ctx) {
    const userId = ctx.from?.id;

    if (!userId) {
        return;
    }

    const key = String(userId);

    const existing = getState(key);

    if (existing) {
        return ctx.reply(
            '⚠️ You already have a pairing request in progress.\n\n' +
            'Send your WhatsApp number or use /cancel to cancel it.'
        );
    }

    setState(key, {
        status: 'waiting_number',
        phoneNumber: null,
        pairingCode: null,
        createdAt: Date.now()
    });

    await ctx.reply(
        '🔄 WhatsApp Pairing\n\n' +
        'Send your WhatsApp number with country code.\n\n' +
        'Example:\n' +
        '`2348012345678`\n\n' +
        'For Nigerian numbers, you can also send:\n' +
        '`08012345678`\n\n' +
        'Use /cancel to stop.',
        {
            parse_mode: 'Markdown'
        }
    );

    refreshPairingTimeout(ctx, key);
}

/* =========================================================
   HANDLE PHONE NUMBER
========================================================= */

async function handlePairNumber(ctx) {
    const userId = ctx.from?.id;

    if (!userId) {
        return;
    }

    const key = String(userId);
    const state = getState(key);

    if (!state) {
        return ctx.reply(
            '⚠️ No active pairing request.\n\n' +
            'Use /pair first.'
        );
    }

    /*
     * Only accept a phone number while waiting for one.
     * This prevents duplicate session creation when the
     * user sends multiple messages.
     */
    if (state.status !== 'waiting_number') {
        if (
            state.status === 'creating_session' ||
            state.status === 'requesting_code' ||
            state.status === 'waiting_code' ||
            state.status === 'code_sent' ||
            state.status === 'waiting_connection'
        ) {
            return ctx.reply(
                '⏳ A WhatsApp pairing request is already being processed.\n\n' +
                'Please wait for the current attempt to finish.'
            );
        }

        return;
    }

    const phoneNumber = normalizePhoneNumber(
        ctx.message?.text
    );

    if (!phoneNumber) {
        return ctx.reply(
            '❌ Invalid phone number.\n\n' +
            'Send the number in international format.\n\n' +
            'Example:\n' +
            '`2348012345678`',
            {
                parse_mode: 'Markdown'
            }
        );
    }

    setState(key, {
        status: 'creating_session',
        phoneNumber,
        pairingCode: null,
        code: null
    });

    refreshPairingTimeout(ctx, key);

    try {
        await ctx.reply(
            '🔄 Preparing WhatsApp...\n\n' +
            '📱 Number: ' + phoneNumber + '\n\n' +
            '🧹 Clearing any old session first.\n' +
            '📡 Starting a fresh WhatsApp linking request.\n\n' +
            'Please wait.'
        );

        setState(key, {
            status: 'requesting_code'
        });

        /*
         * createWhatsAppSession expects:
         *
         * createWhatsAppSession(userId, phoneNumber, options)
         */
        const session = await createWhatsAppSession(
            key,
            phoneNumber,
            {
                fresh: true
            }
        );

        if (!session) {
            throw new Error(
                'WhatsApp session manager returned no session.'
            );
        }

        setState(key, {
            status: 'waiting_code'
        });

        await sendPairingInstructions(
            ctx,
            phoneNumber
        );

        refreshPairingTimeout(ctx, key);

        const pairingCode = await waitForPairingCode(
            key,
            session,
            PAIRING_CODE_TIMEOUT
        );

        if (!pairingCode) {
            throw new Error(
                'WhatsApp did not generate a pairing code within the expected time.'
            );
        }

        setState(key, {
            status: 'code_sent',
            pairingCode,
            code: pairingCode
        });

        await replyPairingCode(
            ctx,
            pairingCode
        );

        /*
         * WhatsApp connection handling is responsible for
         * detecting the final successful connection.
         */
        setState(key, {
            status: 'waiting_connection'
        });

        refreshPairingTimeout(ctx, key);

    } catch (error) {
        console.error(
            `[PAIR] Failed for user ${key}:`,
            error?.stack || error
        );

        try {
            await completelyResetUser(key);
        } catch (cleanupError) {
            console.error(
                `[PAIR] Cleanup failed for ${key}:`,
                cleanupError?.stack || cleanupError
            );
        }

        clearState(key);

        try {
            await ctx.reply(
                '❌ Pairing failed.\n\n' +
                'The WhatsApp connection could not be started.\n\n' +
                '🧹 Pairing state cleared\n' +
                '🧹 WhatsApp session cleared\n' +
                '🧹 Saved authentication removed\n\n' +
                'Use /pair to start a fresh attempt.'
            );
        } catch (replyError) {
            console.error(
                `[PAIR] Failed to send failure message for ${key}:`,
                replyError?.message || replyError
            );
        }
    }
}

/* =========================================================
   CANCEL PAIRING
========================================================= */

async function cancelPairing(ctx) {
    const userId = ctx.from?.id;

    if (!userId) {
        return;
    }

    const key = String(userId);
    const state = getState(key);

    if (!state) {
        return ctx.reply(
            'ℹ️ There is no active pairing request.'
        );
    }

    try {
        await completelyResetUser(key);
    } catch (error) {
        console.error(
            `[PAIR CANCEL] Cleanup failed for ${key}:`,
            error?.stack || error
        );
    }

    clearState(key);

    await ctx.reply(
        '🛑 WhatsApp pairing cancelled.\n\n' +
        '🧹 Pairing state cleared\n' +
        '🧹 WhatsApp session cleared\n' +
        '🧹 Saved authentication removed\n' +
        '🧹 Reconnection cancelled\n\n' +
        'Use /pair to start again.'
    );
}

/* =========================================================
   PAIRING STATUS
========================================================= */

function getPairingStatus(userId) {
    const key = String(userId);
    const state = getState(key);

    if (!state) {
        return null;
    }

    return {
        status: state.status || null,
        phoneNumber: state.phoneNumber || null,
        pairingCode: state.pairingCode || null,
        code: state.code || null,
        createdAt: state.createdAt || null,
        updatedAt: state.updatedAt || null
    };
}

/* =========================================================
   EXPORTS
========================================================= */

module.exports = {
    beginPairing,
    handlePairNumber,
    cancelPairing,
    getPairingStatus,
    normalizePhoneNumber,
    waitForPairingCode
};

Important: this fixes "telegram/pair.js", but there is still one required change in "index.js": "/pair" must call "beginPairing(ctx)", not "pairCommand(ctx)", because the module exports an object containing "beginPairing".

So the next file to replace should be "index.js", specifically its Telegram "/pair" handling.
