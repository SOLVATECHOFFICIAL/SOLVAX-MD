const fs = require('fs');
const path = require('path');
const { sleep } = require('../lib/helpers');
const {
    createWhatsAppSession,
    getWhatsAppSession,
    completelyResetUser
} = require('../lib/whatsapp');

let configuredPairingSeconds = 300;
try {
    const configPath = path.join(process.cwd(), 'config.json');
    if (fs.existsSync(configPath)) {
        const config = require(configPath);
        configuredPairingSeconds = Number(config.maxPairingSeconds) || configuredPairingSeconds;
    }
} catch (_) {}
const WAITING_TIMEOUT = Math.max(30, configuredPairingSeconds) * 1000;

/* =========================================================
   SHARED PAIRING STATE
========================================================= */

function getState(userId) {
    return global.pairingStates?.[String(userId)] || null;
}

function setState(userId, data) {
    const key = String(userId);
    const state = global.pairingStates?.[key] || {};
    global.pairingStates[key] = {
        ...state,
        ...data,
        updatedAt: Date.now()
    };
    return global.pairingStates[key];
}

function clearState(userId) {
    const key = String(userId);
    const state = getState(key);
    if (state?.timeout) clearTimeout(state.timeout);
    if (global.pairingStates) delete global.pairingStates[key];
}

/* =========================================================
   PAIRING TIMEOUT
========================================================= */

function refreshPairingTimeout(ctx, userId) {
    const key = String(userId);
    const state = getState(key);

    if (!state) return;

    if (state.timeout) {
        clearTimeout(state.timeout);
    }

    state.timeout = setTimeout(async () => {
        const current = getState(key);

        if (!current) return;

        try {
            await ctx.reply(
                '⏰ Pairing request timed out.\n\n' +
                'The WhatsApp pairing process was cancelled because no pairing was completed within 2 minutes.\n\n' +
                'Use /pair to start again.'
            );
        } catch (error) {
            console.error(
                `[PAIR TIMEOUT] Telegram message failed for ${key}:`,
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

    setState(key, {
        timeout: state.timeout
    });
}

/* =========================================================
   PHONE NUMBER NORMALIZATION
========================================================= */

function normalizePhoneNumber(input) {
    let value = String(input || '').trim();

    if (!value) {
        return null;
    }

    // Remove spaces, brackets, hyphens, etc.
    value = value.replace(/[^\d+]/g, '');

    // Convert 00XXXXXXXX to +XXXXXXXX
    if (value.startsWith('00')) {
        value = '+' + value.slice(2);
    }

    // Nigerian local format:
    // 08012345678 -> +2348012345678
    if (value.startsWith('0') && !value.startsWith('00')) {
        value = '+234' + value.slice(1);
    }

    // Remove +
    value = value.replace(/\D/g, '');

    if (!value) {
        return null;
    }

    // Basic international phone validation.
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

async function waitForPairingCode(userId, session, timeout = 20000) {
    const key = String(userId);
    const started = Date.now();

    while (Date.now() - started < timeout) {
        // First check the returned session object.
        if (session?.pairingCode) {
            return session.pairingCode;
        }

        // Then check global session in case the code was
        // generated asynchronously.
        const currentSession = getWhatsAppSession(key);

        if (currentSession?.pairingCode) {
            return currentSession.pairingCode;
        }

        // Finally check pairingStates maintained by
        // lib/whatsapp.js.
        const managerState = global.pairingStates?.[key];

        if (managerState?.pairingCode) {
            return managerState.pairingCode;
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
        createdAt: Date.now(),
        chatId: ctx.chat?.id || null
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

    if (
        state.status !== 'waiting_number' &&
        state.status !== 'waiting_code' &&
        state.status !== 'creating_session' &&
        state.status !== 'requesting_code'
    ) {
        return;
    }

    // If the user sends another message while already creating
    // a session, don't start another socket.
    if (
        state.status === 'creating_session' ||
        state.status === 'requesting_code' ||
        state.status === 'waiting_code'
    ) {
        return ctx.reply(
            '⏳ A WhatsApp pairing request is already being processed.\n\n' +
            'Please wait for the current attempt to finish.'
        );
    }

    const phoneNumber = normalizePhoneNumber(ctx.message?.text);

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

        /*
         * IMPORTANT:
         *
         * createWhatsAppSession() expects:
         *
         * createWhatsAppSession(userId, phoneNumber, options)
         *
         * NOT:
         *
         * createWhatsAppSession(userId, { phoneNumber })
         *
         * The fresh option tells whatsapp.js to perform
         * the complete reset itself.
         */

        setState(key, {
            status: 'requesting_code'
        });

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

        await sendPairingInstructions(ctx, phoneNumber);

        setState(key, {
            status: 'waiting_code'
        });

        /*
         * The corrected whatsapp.js returns pairingCode
         * directly on the session object.
         */
        const pairingCode = await waitForPairingCode(
            key,
            session,
            60000
        );

        if (!pairingCode) {
            throw new Error(
                'WhatsApp did not generate a pairing code within the expected time.'
            );
        }

        setState(key, {
            status: 'code_sent',
            code: pairingCode
        });

        await replyPairingCode(ctx, pairingCode);

        /*
         * Keep waiting state alive while WhatsApp finishes
         * linking. whatsapp.js is responsible for detecting
         * the actual connection.
         */
        setState(key, {
            status: 'waiting_connection'
        });


    } catch (error) {
        console.error(
            `[PAIR] Failed for user ${key}:`,
            error?.stack || error
        );

        try {
            await completelyResetUser(key);
        } catch (cleanupError) {
            console.error(
                `[PAIR] Cleanup failed for user ${key}:`,
                cleanupError?.stack || cleanupError
            );
        }

        clearState(key);

        await ctx.reply(
            '❌ Pairing failed.\n\n' +
            'The WhatsApp connection could not be started.\n\n' +
            '🧹 Pairing state cleared\n' +
            '🧹 WhatsApp session cleared\n' +
            '🧹 Saved authentication removed\n' +
            '🧹 Reconnection cancelled\n\n' +
            'Use /pair to start a completely fresh attempt.'
        );
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

    setState(key, {
        status: 'cancelled'
    });

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
