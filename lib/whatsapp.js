'use strict';

const fs = require('fs');
const path = require('path');
const pino = require('pino');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers
} = require('@whiskeysockets/baileys');

const {
    cleanNumber,
    sleep,
    jidNumber
} = require('./helpers');

const {
    enqueue
} = require('./queue');

/*
|--------------------------------------------------------------------------
| Paths
|--------------------------------------------------------------------------
*/

const AUTH_ROOT = path.join(
    process.cwd(),
    'sessions'
);

const logger = pino({
    level:
        process.env.LOG_LEVEL ||
        'info'
});

/*
|--------------------------------------------------------------------------
| Global stores
|--------------------------------------------------------------------------
*/

function getSessions() {
    if (!global.sessions) {
        global.sessions = {};
    }

    return global.sessions;
}

function getPairingStates() {
    if (!global.pairingStates) {
        global.pairingStates = {};
    }

    return global.pairingStates;
}

/*
|--------------------------------------------------------------------------
| Filesystem helpers
|--------------------------------------------------------------------------
*/

function ensureAuthRoot() {
    if (!fs.existsSync(AUTH_ROOT)) {
        fs.mkdirSync(
            AUTH_ROOT,
            {
                recursive: true
            }
        );
    }
}

function getSessionDir(userId) {
    return path.join(
        AUTH_ROOT,
        `wa_${String(userId)}`
    );
}

function removeDirectory(directory) {
    if (!directory) {
        return;
    }

    try {
        if (fs.existsSync(directory)) {
            fs.rmSync(
                directory,
                {
                    recursive: true,
                    force: true
                }
            );
        }
    } catch (error) {
        console.error(
            `[WHATSAPP] Failed to remove directory ${directory}:`,
            error
        );
    }
}

/*
|--------------------------------------------------------------------------
| Pairing state helpers
|--------------------------------------------------------------------------
*/

function getPairingState(userId) {
    return getPairingStates()[
        String(userId)
    ] || null;
}

function clearPairingState(userId) {
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

function setPairingState(
    userId,
    state
) {
    const states =
        getPairingStates();

    const key =
        String(userId);

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

/*
|--------------------------------------------------------------------------
| Session helpers
|--------------------------------------------------------------------------
*/

function getWhatsAppSession(userId) {
    return getSessions()[
        String(userId)
    ] || null;
}

function isCurrentSession(
    userId,
    session
) {
    return (
        getSessions()[
            String(userId)
        ] === session
    );
}

function isWhatsAppConnected(
    userId
) {
    const session =
        getWhatsAppSession(userId);

    return Boolean(
        session &&
        session.connected &&
        !session.stopping &&
        session.socket
    );
}

/*
|--------------------------------------------------------------------------
| Browser identity
|--------------------------------------------------------------------------
|
| IMPORTANT:
|
| Browsers.ubuntu is a function.
|
| Correct:
|     Browsers.ubuntu('Chrome')
|
| Incorrect:
|     Browsers.ubuntu
|
|--------------------------------------------------------------------------
*/

function getBrowserIdentity() {
    return Browsers.ubuntu(
        'Chrome'
    );
}

/*
|--------------------------------------------------------------------------
| Telegram notification helper
|--------------------------------------------------------------------------
*/

async function telegramSend(
    userId,
    text
) {
    try {
        if (!global.bot) {
            return false;
        }

        await global.bot.telegram.sendMessage(
            String(userId),
            String(text)
        );

        return true;
    } catch (error) {
        console.error(
            `[WHATSAPP] Telegram notification failed for ${userId}:`,
            error
        );

        return false;
    }
}

/*
|--------------------------------------------------------------------------
| Disconnect helpers
|--------------------------------------------------------------------------
*/

function getDisconnectCode(
    update
) {
    return (
        update
            ?.lastDisconnect
            ?.error
            ?.output
            ?.statusCode
    );
}

function getDisconnectMessage(
    error
) {
    const code =
        error?.output?.statusCode ??
        error?.statusCode ??
        'unknown';

    switch (code) {
        case DisconnectReason.loggedOut:
            return 'WhatsApp logged out this session.';

        case DisconnectReason.connectionReplaced:
            return 'This WhatsApp session was replaced by another linked session.';

        case DisconnectReason.badSession:
            return 'The WhatsApp authentication session became invalid.';

        case DisconnectReason.multideviceMismatch:
            return 'WhatsApp reported a device/session mismatch.';

        case DisconnectReason.forbidden:
            return 'WhatsApp rejected this session.';

        case DisconnectReason.restartRequired:
            return 'WhatsApp requested a session restart.';

        case DisconnectReason.connectionClosed:
            return 'The WhatsApp connection was closed.';

        case DisconnectReason.connectionLost:
            return 'The connection to WhatsApp was lost.';

        case DisconnectReason.timedOut:
            return 'The WhatsApp connection timed out.';

        default:
            return `WhatsApp connection closed (code: ${code}).`;
    }
}

/*
|--------------------------------------------------------------------------
| JID helpers
|--------------------------------------------------------------------------
*/

function isIgnoredJid(jid) {
    if (!jid) {
        return true;
    }

    if (
        jid ===
        'status@broadcast'
    ) {
        return true;
    }

    if (
        jid.endsWith(
            '@broadcast'
        )
    ) {
        return true;
    }

    if (
        jid.endsWith(
            '@newsletter'
        )
    ) {
        return true;
    }

    return false;
}

/*
|--------------------------------------------------------------------------
| Message helpers
|--------------------------------------------------------------------------
*/

function getRemoteJid(msg) {
    return (
        msg?.key?.remoteJid ||
        ''
    );
}

function isSelfMessage(msg) {
    /*
     * CRITICAL SELF-BOT RULE:
     *
     * Only messages sent by the linked WhatsApp
     * account itself are processed.
     *
     * Everybody else is ignored.
     */
    return (
        msg?.key?.fromMe === true
    );
}

function getMessageText(
    message
) {
    if (!message) {
        return '';
    }

    /*
     * Normal text message.
     */
    if (
        typeof message.conversation ===
        'string'
    ) {
        return message.conversation;
    }

    /*
     * Extended text.
     */
    if (
        typeof message
            .extendedTextMessage
            ?.text ===
        'string'
    ) {
        return (
            message
                .extendedTextMessage
                .text
        );
    }

    /*
     * Image caption.
     */
    if (
        typeof message
            .imageMessage
            ?.caption ===
        'string'
    ) {
        return (
            message
                .imageMessage
                .caption
        );
    }

    /*
     * Video caption.
     */
    if (
        typeof message
            .videoMessage
            ?.caption ===
        'string'
    ) {
        return (
            message
                .videoMessage
                .caption
        );
    }

    /*
     * Document caption.
     */
    if (
        typeof message
            .documentMessage
            ?.caption ===
        'string'
    ) {
        return (
            message
                .documentMessage
                .caption
        );
    }

    /*
     * Ephemeral wrapper.
     */
    if (
        message
            .ephemeralMessage
            ?.message
    ) {
        return getMessageText(
            message
                .ephemeralMessage
                .message
        );
    }

    /*
     * View-once wrapper.
     */
    if (
        message
            .viewOnceMessage
            ?.message
    ) {
        return getMessageText(
            message
                .viewOnceMessage
                .message
        );
    }

    /*
     * View-once v2 wrapper.
     */
    if (
        message
            .viewOnceMessageV2
            ?.message
    ) {
        return getMessageText(
            message
                .viewOnceMessageV2
                .message
        );
    }

    return '';
}

/*
|--------------------------------------------------------------------------
| Reply helper
|--------------------------------------------------------------------------
*/

async function sendReply(
    sock,
    jid,
    text,
    options = {}
) {
    if (!sock) {
        return null;
    }

    if (!jid) {
        return null;
    }

    const message =
        String(text ?? '');

    try {
        return await enqueue(
            `wa-reply:${jid}`,
            async () => {
                return await sock.sendMessage(
                    jid,
                    {
                        text: message,
                        ...options
                    }
                );
            }
        );
    } catch (error) {
        console.error(
            `[WHATSAPP] Failed to send reply to ${jid}:`,
            error
        );

        return null;
    }
}

/*
|--------------------------------------------------------------------------
| Incoming WhatsApp messages
|--------------------------------------------------------------------------
*/

async function handleIncomingMessage(
    userId,
    session,
    msg
) {
    const key =
        String(userId);

    if (!msg) {
        return;
    }

    /*
     * Ignore messages from an old socket.
     */
    if (
        !isCurrentSession(
            key,
            session
        )
    ) {
        return;
    }

    /*
     * Ignore anything after /stop or
     * another complete reset.
     */
    if (session.stopping) {
        return;
    }

    /*
     * Only the linked account itself
     * may execute commands.
     */
    if (
        !isSelfMessage(msg)
    ) {
        return;
    }

    const jid =
        getRemoteJid(msg);

    if (
        isIgnoredJid(jid)
    ) {
        return;
    }

    const text =
        getMessageText(
            msg.message
        );

    if (
        !text ||
        !text.trim()
    ) {
        return;
    }

    console.log(
        `[WHATSAPP] Self message from ${key} in ${jid}: ${text}`
    );

    /*
     * index.js owns the command parser.
     */
    if (
        typeof global
            .handleWhatsAppCommand !==
        'function'
    ) {
        console.error(
            '[WHATSAPP] global.handleWhatsAppCommand is not available.'
        );

        return;
    }

    try {
        await global.handleWhatsAppCommand(
            key,
            session,
            msg
        );
    } catch (error) {
        console.error(
            `[WHATSAPP] Command handler failed for ${key}:`,
            error
        );
    }
}

/*
|--------------------------------------------------------------------------
| COMPLETE USER RESET
|--------------------------------------------------------------------------
|
| This is what /stop uses.
|
| It removes:
|
| - socket
| - session object
| - pairing state
| - pairing timer
| - reconnect timer
| - saved Baileys authentication
|
|--------------------------------------------------------------------------
*/

async function completelyResetUser(
    userId,
    options = {}
) {
    const key =
        String(userId || '');

    if (!key) {
        return false;
    }

    const {
        notify = false,
        reason =
            'WhatsApp session ended.'
    } = options;

    const sessions =
        getSessions();

    const session =
        sessions[key];

    /*
     * Stop this session immediately.
     */
    if (session) {
        session.stopping = true;
        session.connected = false;
        session.connecting = false;
        session.reconnecting = false;

        if (
            session.reconnectTimer
        ) {
            clearTimeout(
                session.reconnectTimer
            );

            session.reconnectTimer =
                null;
        }
    }

    /*
     * Remove pairing state.
     */
    clearPairingState(
        key
    );

    /*
     * Close socket.
     *
     * Do NOT call sock.logout().
     *
     * We want a local clean reset so
     * /pair can begin from scratch.
     */
    if (
        session?.socket
    ) {
        const socket =
            session.socket;

        session.socket =
            null;

        try {
            if (
                typeof socket.end ===
                'function'
            ) {
                socket.end(
                    new Error(
                        'SolvaX MD session completely reset'
                    )
                );
            }
        } catch (error) {
            console.error(
                `[WHATSAPP] Failed closing socket for ${key}:`,
                error
            );
        }
    }

    /*
     * Delete only the exact session we
     * intended to reset.
     *
     * This prevents an old socket from
     * deleting a newly created session.
     */
    if (
        !session ||
        sessions[key] === session
    ) {
        delete sessions[key];
    }

    /*
     * Remove ALL local authentication
     * files for this Telegram user.
     */
    removeDirectory(
        getSessionDir(key)
    );

    if (notify) {
        await telegramSend(
            key,
            String(reason)
        );
    }

    return true;
}

/*
|--------------------------------------------------------------------------
| Prepare fresh pairing
|--------------------------------------------------------------------------
|
| This function clears an old WhatsApp socket
| and old authentication, BUT intentionally
| leaves global.pairingStates alone.
|
| pair.js needs its pairing state while this
| operation is happening.
|--------------------------------------------------------------------------
*/

async function prepareFreshPairing(
    userId
) {
    const key =
        String(userId);

    const sessions =
        getSessions();

    const existing =
        sessions[key];

    if (existing) {
        existing.stopping =
            true;

        existing.connected =
            false;

        existing.connecting =
            false;

        existing.reconnecting =
            false;

        if (
            existing.reconnectTimer
        ) {
            clearTimeout(
                existing.reconnectTimer
            );

            existing.reconnectTimer =
                null;
        }

        const socket =
            existing.socket;

        existing.socket =
            null;

        if (socket) {
            try {
                if (
                    typeof socket.end ===
                    'function'
                ) {
                    socket.end(
                        new Error(
                            'Preparing fresh WhatsApp pairing'
                        )
                    );
                }
            } catch (error) {
                console.error(
                    `[WHATSAPP] Failed closing old socket for ${key}:`,
                    error
                );
            }
        }

        if (
            sessions[key] ===
            existing
        ) {
            delete sessions[key];
        }
    }

    /*
     * Remove old authentication.
     */
    removeDirectory(
        getSessionDir(key)
    );

    ensureAuthRoot();

    /*
     * Small delay to let the previous socket
     * finish closing before a new socket is
     * created.
     */
    await sleep(300);

    return true;
}

/*
|--------------------------------------------------------------------------
| CREATE WHATSAPP SESSION
|--------------------------------------------------------------------------
*/

async function createWhatsAppSession(
    userId,
    options = {}
) {
    const key =
        String(userId);

    const {
        pairing = false,
        phoneNumber = null
    } = options;

    const sessions =
        getSessions();

    /*
     * Never create two simultaneous
     * sessions for one Telegram user.
     */
    const existing =
        sessions[key];

    if (
        existing?.connecting &&
        !existing.stopping
    ) {
        throw new Error(
            'A WhatsApp connection is already being created for this user.'
        );
    }

    if (
        existing?.socket &&
        !existing.stopping
    ) {
        return existing;
    }

    ensureAuthRoot();

    const sessionDir =
        getSessionDir(key);

    fs.mkdirSync(
        sessionDir,
        {
            recursive: true
        }
    );

    /*
     * Load Baileys authentication state.
     */
    const {
        state,
        saveCreds
    } =
        await useMultiFileAuthState(
            sessionDir
        );

    /*
     * Create the internal session record
     * BEFORE the socket is made.
     */
    const session = {
        userId: key,

        socket: null,

        phoneNumber:
            phoneNumber ||
            null,

        pairingCode:
            null,

        connected: false,

        connecting: true,

        stopping: false,

        reconnecting: false,

        pairing:
            Boolean(pairing),

        reconnectTimer:
            null,

        createdAt:
            Date.now(),

        connectedAt:
            null
    };

    /*
     * Store it immediately.
     */
    sessions[key] =
        session;

    try {
        /*
         * IMPORTANT:
         *
         * Do not use fetchLatestBaileysVersion()
         * here because package.json pins:
         *
         * @whiskeysockets/baileys 6.7.24
         *
         * Mixing runtime versions with a pinned
         * package can create compatibility problems.
         */
        const sock =
            makeWASocket({
                auth: state,

                logger,

                browser:
                    getBrowserIdentity(),

                markOnlineOnConnect:
                    false,

                syncFullHistory:
                    false,

                generateHighQualityLinkPreview:
                    false
            });

        /*
         * Attach socket to this exact session.
         */
        session.socket =
            sock;

        /*
         * Save authentication changes.
         */
        sock.ev.on(
            'creds.update',
            saveCreds
        );

        /*
        |--------------------------------------------------------------------------
        | CONNECTION UPDATE
        |--------------------------------------------------------------------------
        */

        sock.ev.on(
            'connection.update',
            async (update) => {
                try {
                    /*
                     * This socket may already be stale.
                     */
                    if (
                        !isCurrentSession(
                            key,
                            session
                        )
                    ) {
                        return;
                    }

                    const {
                        connection,
                        lastDisconnect
                    } = update;

                    /*
                     * CONNECTING
                     */
                    if (
                        connection ===
                        'connecting'
                    ) {
                        session.connecting =
                            true;

                        return;
                    }

                    /*
                     * OPEN
                     */
                    if (
                        connection ===
                        'open'
                    ) {
                        if (
                            session.stopping
                        ) {
                            return;
                        }

                        session.connected =
                            true;

                        session.connecting =
                            false;

                        session.reconnecting =
                            false;

                        session.connectedAt =
                            Date.now();

                        if (
                            session.reconnectTimer
                        ) {
                            clearTimeout(
                                session.reconnectTimer
                            );

                            session.reconnectTimer =
                                null;
                        }

                        /*
                         * Get the actual connected
                         * WhatsApp number when available.
                         */
                        try {
                            const userJid =
                                sock?.user?.id;

                            if (
                                userJid
                            ) {
                                const number =
                                    jidNumber(
                                        userJid
                                    );

                                if (
                                    number
                                ) {
                                    session.phoneNumber =
                                        number;
                                }
                            }
                        } catch (error) {
                            console.error(
                                `[WHATSAPP] Could not read connected number for ${key}:`,
                                error
                            );
                        }

                        console.log(
                            `[WHATSAPP] Connected for Telegram user ${key}` +
                            (
                                session.phoneNumber
                                    ? ` (${session.phoneNumber})`
                                    : ''
                            )
                        );

                        /*
                         * If this was a pairing request,
                         * notify Telegram.
                         */
                        const pairingState =
                            getPairingState(
                                key
                            );

                        if (
                            session.pairing ||
                            pairingState
                        ) {
                            session.pairing =
                                false;

                            clearPairingState(
                                key
                            );

                            await telegramSend(
                                key,
                                '✅ WhatsApp connected successfully.\n\n' +
                                (
                                    session.phoneNumber
                                        ? `📱 Number: ${session.phoneNumber}\n\n`
                                        : ''
                                ) +
                                'Your WhatsApp account is now linked to SolvaX MD.\n\n' +
                                'Commands sent by this linked account can now be processed.'
                            );
                        }

                        return;
                    }

                    /*
                     * CLOSE
                     */
                    if (
                        connection ===
                        'close'
                    ) {
                        const code =
                            getDisconnectCode(
                                update
                            );

                        /*
                         * Never let an old socket
                         * touch a newer session.
                         */
                        if (
                            !isCurrentSession(
                                key,
                                session
                            )
                        ) {
                            return;
                        }

                        /*
                         * If /stop already reset it,
                         * nothing else is needed.
                         */
                        if (
                            session.stopping
                        ) {
                            return;
                        }

                        console.error(
                            `[WHATSAPP] Connection closed for ${key}. Code: ${code}`
                        );

                        /*
                         * IMPORTANT:
                         *
                         * NO AUTOMATIC RECONNECT.
                         *
                         * Every real WhatsApp disconnect
                         * is treated as a complete stop.
                         */
                        await completelyResetUser(
                            key,
                            {
                                notify: true,

                                reason:
                                    '❌ WhatsApp session ended.\n\n' +
                                    `${getDisconnectMessage(lastDisconnect?.error)}\n\n` +
                                    '🧹 WhatsApp session cleared.\n' +
                                    '🧹 Saved authentication removed.\n' +
                                    '🧹 Pairing state cleared.\n' +
                                    '🧹 Reconnection cancelled.\n\n' +
                                    'Use /pair to link the same number or another number.'
                            }
                        );

                        return;
                    }
                } catch (error) {
                    console.error(
                        `[WHATSAPP] connection.update error for ${key}:`,
                        error
                    );

                    /*
                     * Fail closed.
                     *
                     * If lifecycle processing itself
                     * fails, don't leave a zombie socket.
                     */
                    if (
                        isCurrentSession(
                            key,
                            session
                        ) &&
                        !session.stopping
                    ) {
                        await completelyResetUser(
                            key,
                            {
                                notify: true,

                                reason:
                                    '❌ WhatsApp connection failed unexpectedly.\n\n' +
                                    '🧹 The session has been completely cleared.\n\n' +
                                    'Use /pair to start again.'
                            }
                        );
                    }
                }
            }
        );

        /*
        |--------------------------------------------------------------------------
        | INCOMING MESSAGES
        |--------------------------------------------------------------------------
        */

        sock.ev.on(
            'messages.upsert',
            async (event) => {
                if (
                    !isCurrentSession(
                        key,
                        session
                    )
                ) {
                    return;
                }

                if (
                    session.stopping
                ) {
                    return;
                }

                if (
                    !event ||
                    !Array.isArray(
                        event.messages
                    )
                ) {
                    return;
                }

                /*
                 * Process each message separately.
                 */
                for (
                    const msg of
                    event.messages
                ) {
                    try {
                        await handleIncomingMessage(
                            key,
                            session,
                            msg
                        );
                    } catch (error) {
                        console.error(
                            `[WHATSAPP] Message handling failed for ${key}:`,
                            error
                        );
                    }
                }
            }
        );

        /*
        |--------------------------------------------------------------------------
        | PAIRING CODE
        |--------------------------------------------------------------------------
        */

        if (
            pairing &&
            !state.creds.registered
        ) {
            if (!phoneNumber) {
                throw new Error(
                    'A WhatsApp phone number is required for pairing.'
                );
            }

            const normalized =
                cleanNumber(
                    phoneNumber
                );

            if (!normalized) {
                throw new Error(
                    'Invalid WhatsApp phone number.'
                );
            }

            /*
             * Baileys needs digits only.
             */
            if (
                !/^\d{8,15}$/.test(
                    normalized
                )
            ) {
                throw new Error(
                    'Invalid WhatsApp phone number format.'
                );
            }

            /*
             * Make sure Telegram pairing still exists.
             */
            const pairingState =
                getPairingState(
                    key
                );

            if (!pairingState) {
                throw new Error(
                    'Pairing request was cancelled before the WhatsApp code was requested.'
                );
            }

            session.phoneNumber =
                normalized;

            session.pairing =
                true;

            console.log(
                `[WHATSAPP] Requesting WhatsApp pairing for ${key}: ${normalized}`
            );

            /*
             * This is the REAL WhatsApp pairing
             * request.
             *
             * WhatsApp itself controls what security
             * notification/UI appears on the phone.
             */
            const code =
                await sock.requestPairingCode(
                    normalized
                );

            /*
             * Check whether the socket is still ours.
             */
            if (
                !isCurrentSession(
                    key,
                    session
                ) ||
                session.stopping
            ) {
                return null;
            }

            /*
             * Check Telegram pairing state again.
             */
            const currentPairingState =
                getPairingState(
                    key
                );

            if (
                !currentPairingState
            ) {
                await completelyResetUser(
                    key,
                    {
                        notify: false
                    }
                );

                return null;
            }

            /*
             * Store code on the session.
             */
            session.pairingCode =
                String(code)
                    .trim()
                    .toUpperCase();

            /*
             * Store code in pairing state.
             */
            currentPairingState.code =
                session.pairingCode;

            currentPairingState.phoneNumber =
                normalized;

            currentPairingState.codeGeneratedAt =
                Date.now();

            currentPairingState.stage =
                'waiting_connection';

            console.log(
                `[WHATSAPP] Pairing code generated for ${key}: ${session.pairingCode}`
            );
        }

        session.connecting =
            true;

        return session;
    } catch (error) {
        console.error(
            `[WHATSAPP] Failed to create WhatsApp session for ${key}:`,
            error
        );

        /*
         * Clean up any half-created socket/session.
         */
        if (
            isCurrentSession(
                key,
                session
            )
        ) {
            await completelyResetUser(
                key,
                {
                    notify: false
                }
            );
        }

        throw error;
    }
}

/*
|--------------------------------------------------------------------------
| STOP ONE SESSION
|--------------------------------------------------------------------------
|
| This function is used for controlled application
| shutdown when we may want to preserve authentication.
|
| /stop should use completelyResetUser() instead.
|--------------------------------------------------------------------------
*/

async function stopWhatsAppSession(
    userId,
    options = {}
) {
    const key =
        String(userId);

    const {
        removeAuth = false
    } = options;

    const sessions =
        getSessions();

    const session =
        sessions[key];

    if (!session) {
        clearPairingState(
            key
        );

        if (
            removeAuth
        ) {
            removeDirectory(
                getSessionDir(key)
            );
        }

        return false;
    }

    session.stopping =
        true;

    session.connected =
        false;

    session.connecting =
        false;

    session.reconnecting =
        false;

    if (
        session.reconnectTimer
    ) {
        clearTimeout(
            session.reconnectTimer
        );

        session.reconnectTimer =
            null;
    }

    /*
     * Do not destroy pairing state until
     * the controlled stop is underway.
     */
    clearPairingState(
        key
    );

    const socket =
        session.socket;

    session.socket =
        null;

    if (socket) {
        try {
            if (
                typeof socket.end ===
                'function'
            ) {
                socket.end(
                    new Error(
                        'SolvaX MD application shutdown'
                    )
                );
            }
        } catch (error) {
            console.error(
                `[WHATSAPP] Failed stopping session ${key}:`,
                error
            );
        }
    }

    if (
        sessions[key] ===
        session
    ) {
        delete sessions[key];
    }

    /*
     * For normal server shutdown:
     *
     * removeAuth = false
     *
     * means saved authentication remains.
     *
     * This allows restoreSessions() after Railway/
     * server restart.
     */
    if (
        removeAuth
    ) {
        removeDirectory(
            getSessionDir(key)
        );
    }

    return true;
}

/*
|--------------------------------------------------------------------------
| RESTORE SAVED SESSIONS
|--------------------------------------------------------------------------
*/

async function restoreSessions() {
    ensureAuthRoot();

    let entries = [];

    try {
        entries =
            fs.readdirSync(
                AUTH_ROOT,
                {
                    withFileTypes:
                        true
                }
            );
    } catch (error) {
        console.error(
            '[WHATSAPP] Failed reading sessions directory:',
            error
        );

        return;
    }

    for (
        const entry of entries
    ) {
        /*
         * Only directories.
         */
        if (
            !entry.isDirectory()
        ) {
            continue;
        }

        /*
         * Only our WhatsApp session folders.
         */
        if (
            !entry.name.startsWith(
                'wa_'
            )
        ) {
            continue;
        }

        const userId =
            entry.name.slice(3);

        if (!userId) {
            continue;
        }

        const sessionDir =
            path.join(
                AUTH_ROOT,
                entry.name
            );

        const credsFile =
            path.join(
                sessionDir,
                'creds.json'
            );

        /*
         * If there is no credentials file,
         * the folder is incomplete.
         */
        if (
            !fs.existsSync(
                credsFile
            )
        ) {
            console.log(
                `[WHATSAPP] Removing incomplete session ${entry.name}`
            );

            removeDirectory(
                sessionDir
            );

            continue;
        }

        try {
            console.log(
                `[WHATSAPP] Restoring WhatsApp session for Telegram user ${userId}`
            );

            await createWhatsAppSession(
                userId,
                {
                    pairing: false
                }
            );

            /*
             * Avoid opening every account simultaneously.
             */
            await sleep(250);
        } catch (error) {
            console.error(
                `[WHATSAPP] Failed restoring session ${userId}:`,
                error
            );

            /*
             * Broken saved sessions should not
             * remain as unusable zombie folders.
             */
            await completelyResetUser(
                userId,
                {
                    notify: false
                }
            );
        }
    }
}

/*
|--------------------------------------------------------------------------
| STOP ALL SESSIONS
|--------------------------------------------------------------------------
|
| Used during application shutdown.
|
| By default authentication is preserved.
|--------------------------------------------------------------------------
*/

async function stopAllWhatsAppSessions(
    options = {}
) {
    const {
        removeAuth = false
    } = options;

    const sessions =
        getSessions();

    const userIds =
        Object.keys(
            sessions
        );

    for (
        const userId of userIds
    ) {
        try {
            await stopWhatsAppSession(
                userId,
                {
                    removeAuth
                }
            );
        } catch (error) {
            console.error(
                `[WHATSAPP] Failed stopping session ${userId}:`,
                error
            );
        }
    }

    /*
     * Clear any pairing timers left behind.
     */
    const pairingStates =
        getPairingStates();

    for (
        const userId of Object.keys(
            pairingStates
        )
    ) {
        clearPairingState(
            userId
        );
    }
}

/*
|--------------------------------------------------------------------------
| EXPORTS
|--------------------------------------------------------------------------
*/

module.exports = {
    AUTH_ROOT,

    getSessionDir,

    getWhatsAppSession,

    isWhatsAppConnected,

    getPairingState,

    setPairingState,

    clearPairingState,

    prepareFreshPairing,

    createWhatsAppSession,

    completelyResetUser,

    stopWhatsAppSession,

    stopAllWhatsAppSessions,

    restoreSessions,

    sendReply,

    handleIncomingMessage,

    getMessageText,

    getRemoteJid,

    isSelfMessage,

    isIgnoredJid,

    getDisconnectCode,

    getDisconnectMessage,

    jidNumber
};
