const fs = require('fs');
const path = require('path');
const pino = require('pino');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
    makeCacheableSignalKeyStore
} = require('@whiskeysockets/baileys');

const {
    sleep,
    isLoggedOut,
    disconnectCode,
    jidNumber,
    getText
} = require('./helpers');

const {
    enqueueCommand
} = require('./queue');

const logger = pino({
    level: process.env.LOG_LEVEL || 'silent'
});

global.sessions = global.sessions || {};

const sessions = global.sessions;

/*
|--------------------------------------------------------------------------
| Configuration
|--------------------------------------------------------------------------
*/

const SESSION_ROOT = path.join(
    process.cwd(),
    'sessions'
);

const CONNECTION_TIMEOUT = 60 * 1000;
const DEFAULT_QUERY_TIMEOUT = 60 * 1000;
const KEEP_ALIVE_INTERVAL = 25 * 1000;

/*
|--------------------------------------------------------------------------
| Session helpers
|--------------------------------------------------------------------------
*/

function sessionDir(userId) {
    return path.join(
        SESSION_ROOT,
        `wa_${String(userId)}`
    );
}

function ensureSessionRoot() {
    fs.mkdirSync(
        SESSION_ROOT,
        {
            recursive: true
        }
    );
}

function removeDirectory(dir) {
    try {
        if (fs.existsSync(dir)) {
            fs.rmSync(
                dir,
                {
                    recursive: true,
                    force: true
                }
            );
        }
    } catch (error) {
        console.error(
            '[WHATSAPP] Failed to remove session directory:',
            error?.message || error
        );
    }
}

function browserIdentity() {
    /*
     * Keep this stable.
     *
     * Do not dynamically fetch another Baileys version here.
     * The package version in package.json is pinned.
     */
    try {
        return Browsers.ubuntu('Chrome');
    } catch {
        return [
            'Ubuntu',
            'Chrome',
            '22.04.4'
        ];
    }
}

function getSession(userId) {
    return sessions[userId] || null;
}

function createSessionRecord(userId, number, options = {}) {
    const record = {
        userId: String(userId),

        number: String(number),

        sock: null,

        connection: 'connecting',

        pairing: Boolean(options.pairing),

        pairingCode: null,

        pairingError: null,

        lastDisconnectReason: null,

        intentionalStop: false,

        createdAt: Date.now(),

        connectedAt: null,

        reconnecting: false,

        closed: false,

        generation: Date.now()
    };

    sessions[userId] = record;

    return record;
}

/*
|--------------------------------------------------------------------------
| Safe socket close
|--------------------------------------------------------------------------
*/

async function closeSocket(
    userId,
    reason = 'Socket closed',
    removeAuth = false
) {
    const session = sessions[userId];

    if (!session) {
        if (removeAuth) {
            removeDirectory(
                sessionDir(userId)
            );
        }

        return;
    }

    session.intentionalStop = true;
    session.closed = true;

    if (session.sock) {
        try {
            /*
             * end() closes this bot connection.
             *
             * We deliberately do not use logout() here.
             * logout() asks WhatsApp to remove the linked
             * device, which is different from simply stopping
             * the bot.
             */
            if (typeof session.sock.end === 'function') {
                session.sock.end(
                    new Error(reason)
                );
            }
        } catch (error) {
            console.error(
                '[WHATSAPP] Socket close error:',
                error?.message || error
            );
        }
    }

    session.sock = null;

    /*
     * Only delete the authentication directory when explicitly
     * requested. This allows /stop to be distinguished from a
     * fresh-pair operation.
     */
    if (removeAuth) {
        removeDirectory(
            sessionDir(userId)
        );
    }

    /*
     * Only delete the global session if it is still the same
     * session record. This prevents an old socket's close event
     * from deleting a newly-created session.
     */
    if (sessions[userId] === session) {
        delete sessions[userId];
    }

    await sleep(300);
}

/*
|--------------------------------------------------------------------------
| Pairing cleanup
|--------------------------------------------------------------------------
*/

async function prepareFreshPairing(userId) {
    /*
     * Any existing bot session belonging to this Telegram user
     * must be completely removed before a new pairing begins.
     */
    const existing = sessions[userId];

    if (existing) {
        existing.intentionalStop = true;
        existing.closed = true;

        try {
            if (
                existing.sock &&
                typeof existing.sock.end === 'function'
            ) {
                existing.sock.end(
                    new Error(
                        'Replacing old WhatsApp pairing session'
                    )
                );
            }
        } catch {}

        if (sessions[userId] === existing) {
            delete sessions[userId];
        }

        await sleep(500);
    }

    /*
     * A fresh pairing needs a fresh authentication directory.
     *
     * Otherwise an old/incomplete auth state can interfere
     * with a new pairing attempt.
     */
    removeDirectory(
        sessionDir(userId)
    );

    await sleep(300);
}

/*
|--------------------------------------------------------------------------
| Connection reason
|--------------------------------------------------------------------------
*/

function getDisconnectMessage(error) {
    const code = disconnectCode(error);

    if (code === DisconnectReason.loggedOut) {
        return 'WhatsApp logged out this linked device.';
    }

    if (code === DisconnectReason.connectionClosed) {
        return 'Connection Closed';
    }

    if (code === DisconnectReason.connectionLost) {
        return 'WhatsApp connection was lost.';
    }

    if (code === DisconnectReason.timedOut) {
        return 'WhatsApp connection timed out.';
    }

    if (code === DisconnectReason.restartRequired) {
        return 'WhatsApp requested a connection restart.';
    }

    if (code === DisconnectReason.multideviceMismatch) {
        return 'WhatsApp reported a multi-device mismatch.';
    }

    if (error?.message) {
        return error.message;
    }

    return 'Connection Closed';
}

/*
|--------------------------------------------------------------------------
| Telegram notifications
|--------------------------------------------------------------------------
*/

async function telegramReply(ctx, text) {
    if (!ctx) {
        return;
    }

    try {
        if (typeof ctx.reply === 'function') {
            await ctx.reply(text);
        }
    } catch (error) {
        console.error(
            '[WHATSAPP] Telegram reply failed:',
            error?.message || error
        );
    }
}

async function notifyPairingCode(
    ctx,
    number,
    code
) {
    if (!ctx || !code) {
        return;
    }

    const formatted = String(code)
        .replace(/\s+/g, '')
        .toUpperCase();

    try {
        await telegramReply(
            ctx,
            '🔐 WhatsApp pairing code:\n\n' +
            `📱 Number: ${number}\n` +
            `🔑 Code: \`${formatted}\`\n\n` +
            'Enter this code in WhatsApp Linked Devices.\n\n' +
            '⏳ Complete the linking before the code expires.'
        );
    } catch {}
}

/*
|--------------------------------------------------------------------------
| Create WhatsApp session
|--------------------------------------------------------------------------
*/

async function createWhatsAppSession(
    userId,
    number,
    telegramContext = null,
    options = {}
) {
    ensureSessionRoot();

    const cleanNumber = String(number || '')
        .replace(/[^0-9]/g, '');

    if (!cleanNumber) {
        throw new Error(
            'Invalid WhatsApp phone number.'
        );
    }

    /*
     * Prevent multiple sockets for one Telegram user.
     *
     * During pairing we intentionally destroy the old session
     * and its auth files first.
     */
    if (options.pairing === true) {
        await prepareFreshPairing(userId);
    } else if (sessions[userId]) {
        const existing = sessions[userId];

        if (
            existing.connection === 'open' &&
            existing.number === cleanNumber
        ) {
            return existing;
        }

        await closeSocket(
            userId,
            'Replacing existing WhatsApp session',
            false
        );
    }

    const dir = sessionDir(userId);

    fs.mkdirSync(
        dir,
        {
            recursive: true
        }
    );

    const {
        state,
        saveCreds
    } = await useMultiFileAuthState(dir);

    const session = createSessionRecord(
        userId,
        cleanNumber,
        options
    );

    /*
     * Create the socket.
     *
     * The Baileys package version is pinned in package.json,
     * so we do not call fetchLatestBaileysVersion().
     */
    let sock;

    try {
        sock = makeWASocket({
            auth: {
                creds: state.creds,

                keys: makeCacheableSignalKeyStore(
                    state.keys,
                    logger
                )
            },

            logger,

            browser: browserIdentity(),

            markOnlineOnConnect: false,

            syncFullHistory: false,

            generateHighQualityLinkPreview: false,

            connectTimeoutMs:
                CONNECTION_TIMEOUT,

            defaultQueryTimeoutMs:
                DEFAULT_QUERY_TIMEOUT,

            keepAliveIntervalMs:
                KEEP_ALIVE_INTERVAL,

            retryRequestDelayMs: 250,

            printQRInTerminal: false
        });
    } catch (error) {
        session.pairingError = error;

        if (sessions[userId] === session) {
            delete sessions[userId];
        }

        throw error;
    }

    /*
     * Store socket only on the current session.
     */
    session.sock = sock;

    /*
     * Save authentication credentials whenever Baileys updates
     * them.
     */
    sock.ev.on(
        'creds.update',
        saveCreds
    );

    /*
     |--------------------------------------------------------------------------
     | Pairing code
     |--------------------------------------------------------------------------
     */

    if (options.pairing === true) {
        try {
            /*
             * requestPairingCode MUST be called on the newly
             * created socket.
             */
            const pairingCode =
                await sock.requestPairingCode(
                    cleanNumber
                );

            /*
             * The socket may have been replaced while the
             * asynchronous request was running.
             */
            if (sessions[userId] !== session) {
                try {
                    sock.end(
                        new Error(
                            'Pairing session replaced.'
                        )
                    );
                } catch {}

                throw new Error(
                    'Pairing session was replaced. Please try /pair again.'
                );
            }

            session.pairingCode =
                String(pairingCode)
                    .replace(/\s+/g, '')
                    .toUpperCase();

            session.pairingError = null;

            console.log(
                `[WHATSAPP] Pairing code generated for ${cleanNumber}: ${session.pairingCode}`
            );

            /*
             * The pairing.js file waits for this value.
             *
             * We do NOT need to send a second Telegram message
             * here because pair.js already displays the code.
             */
        } catch (error) {
            session.pairingError = error;

            console.error(
                '[WHATSAPP] Pairing code request failed:',
                error?.stack || error
            );

            /*
             * Close this exact socket. Do not touch a newer
             * session that may already have been created.
             */
            try {
                session.intentionalStop = true;

                if (
                    sock &&
                    typeof sock.end === 'function'
                ) {
                    sock.end(
                        new Error(
                            'Pairing code request failed.'
                        )
                    );
                }
            } catch {}

            if (sessions[userId] === session) {
                delete sessions[userId];
            }

            throw error;
        }
    }

    /*
     |--------------------------------------------------------------------------
     | Connection updates
     |--------------------------------------------------------------------------
     */

    sock.ev.on(
        'connection.update',
        async (update) => {
            /*
             * IMPORTANT:
             *
             * An old socket can still fire connection.update
             * after a new socket has already been created.
             *
             * Never let an old socket modify the new session.
             */
            if (sessions[userId] !== session) {
                return;
            }

            const {
                connection,
                lastDisconnect
            } = update;

            if (connection) {
                session.connection =
                    connection;
            }

            /*
             * Connection successfully opened.
             */
            if (connection === 'open') {
                session.connection = 'open';

                session.connectedAt =
                    Date.now();

                session.reconnecting = false;

                session.pairingError = null;

                console.log(
                    `[WHATSAPP] Connected: ${cleanNumber}`
                );

                if (
                    session.pairing === true &&
                    telegramContext
                ) {
                    await telegramReply(
                        telegramContext,
                        '🟢 WhatsApp connected successfully.\n\n' +
                        `📱 Number: ${cleanNumber}\n\n` +
                        '🤖 Your self-bot is now active.'
                    );
                }

                return;
            }

            /*
             * Connection closed.
             */
            if (connection === 'close') {
                const reason =
                    getDisconnectMessage(
                        lastDisconnect?.error
                    );

                session.connection =
                    'close';

                session.lastDisconnectReason =
                    reason;

                session.closed = true;

                const wasIntentional =
                    session.intentionalStop === true;

                const loggedOut =
                    isLoggedOut(
                        lastDisconnect?.error
                    );

                console.log(
                    `[WHATSAPP] Connection closed for ${cleanNumber}: ${reason}`
                );

                /*
                 * Do not reconnect if this socket was deliberately
                 * stopped or replaced.
                 */
                if (
                    wasIntentional ||
                    sessions[userId] !== session
                ) {
                    return;
                }

                /*
                 * Logged-out sessions should not automatically
                 * reconnect forever.
                 */
                if (loggedOut) {
                    session.pairingError =
                        new Error(reason);

                    if (
                        sessions[userId] === session
                    ) {
                        delete sessions[userId];
                    }

                    /*
                     * Keep auth files here so the explicit pairing
                     * flow can decide whether to remove them.
                     */
                    if (
                        session.pairing === true &&
                        telegramContext
                    ) {
                        await telegramReply(
                            telegramContext,
                            '❌ Pairing failed.\n\n' +
                            `${reason}\n\n` +
                            'Check that the number belongs to the WhatsApp account you are linking, then use /pair to try again.'
                        );
                    }

                    return;
                }

                /*
                 * If this was a pairing attempt and WhatsApp
                 * closed before authentication completed, report
                 * the failure rather than silently looping.
                 */
                if (
                    session.pairing === true &&
                    !session.connectedAt
                ) {
                    session.pairingError =
                        new Error(reason);

                    if (
                        sessions[userId] === session
                    ) {
                        delete sessions[userId];
                    }

                    if (telegramContext) {
                        await telegramReply(
                            telegramContext,
                            '❌ Pairing failed.\n\n' +
                            `${reason}\n\n` +
                            'Check that the number belongs to the WhatsApp account you are linking, then use /pair to try again.'
                        );
                    }

                    return;
                }

                /*
                 * Temporary network failures.
                 *
                 * Reconnect using the same authentication state.
                 */
                if (!session.reconnecting) {
                    session.reconnecting = true;

                    await sleep(1500);

                    /*
                     * Make sure nobody replaced this session while
                     * we were waiting.
                     */
                    if (
                        sessions[userId] !== session ||
                        session.intentionalStop
                    ) {
                        return;
                    }

                    try {
                        await reconnectWhatsAppSession(
                            userId,
                            session,
                            telegramContext
                        );
                    } catch (error) {
                        console.error(
                            '[WHATSAPP] Reconnect failed:',
                            error?.stack || error
                        );

                        session.reconnecting = false;

                        if (
                            sessions[userId] === session
                        ) {
                            delete sessions[userId];
                        }
                    }
                }
            }
        }
    );

    /*
     |--------------------------------------------------------------------------
     | Incoming messages
     |--------------------------------------------------------------------------
     */

    sock.ev.on(
        'messages.upsert',
        async (event) => {
            /*
             * Ignore messages belonging to an old socket.
             */
            if (sessions[userId] !== session) {
                return;
            }

            const messages =
                event?.messages || [];

            if (!Array.isArray(messages)) {
                return;
            }

            for (const msg of messages) {
                try {
                    /*
                     * CRITICAL SELF-BOT RULE:
                     *
                     * Only process messages sent BY THE LINKED
                     * WHATSAPP ACCOUNT itself.
                     *
                     * Messages from other people are ignored.
                     */
                    if (msg?.key?.fromMe !== true) {
                        continue;
                    }

                    /*
                     * Ignore protocol/status messages.
                     */
                    const jid =
                        msg?.key?.remoteJid;

                    if (!jid) {
                        continue;
                    }

                    if (
                        jid === 'status@broadcast'
                    ) {
                        continue;
                    }

                    /*
                     * Ignore protocol/system messages that don't
                     * contain normal text.
                     */
                    const text =
                        getText(
                            msg?.message
                        );

                    if (!text) {
                        continue;
                    }

                    /*
                     * Allow both:
                     *
                     * .menu
                     *
                     * and:
                     *
                     * menu
                     *
                     * The command handler itself still receives
                     * the normal dot-prefixed format.
                     */
                    const commandText =
                        text.startsWith('.')
                            ? text
                            : `.${text}`;

                    /*
                     * This is the linked account's identity.
                     *
                     * It is NOT the destination of the reply.
                     */
                    const senderNumber =
                        cleanNumber;

                    const isGroup =
                        jid.endsWith('@g.us');

                    /*
                     * Commands are queued per chat so that two
                     * commands sent rapidly into the same chat
                     * don't corrupt each other's responses.
                     */
                    const queueKey =
                        `${userId}:${jid}`;

                    await enqueueCommand(
                        async () => {
                            if (
                                sessions[userId] !== session
                            ) {
                                return;
                            }

                            if (
                                typeof global.handleWhatsAppCommand !==
                                'function'
                            ) {
                                console.error(
                                    '[WHATSAPP] global.handleWhatsAppCommand is not defined.'
                                );

                                return;
                            }

                            await global.handleWhatsAppCommand(
                                sock,
                                msg,
                                jid,
                                senderNumber,
                                isGroup,
                                commandText,
                                userId
                            );
                        },
                        queueKey
                    );
                } catch (error) {
                    console.error(
                        '[WHATSAPP] Message handler error:',
                        error?.stack || error
                    );
                }
            }
        }
    );

    /*
     |--------------------------------------------------------------------------
     | Store the session
     |--------------------------------------------------------------------------
     */

    /*
     * The session was already registered before socket creation.
     * Verify that nobody replaced it.
     */
    if (sessions[userId] !== session) {
        try {
            session.intentionalStop = true;

            sock.end(
                new Error(
                    'Session was replaced.'
                )
            );
        } catch {}

        throw new Error(
            'WhatsApp session was replaced.'
        );
    }

    return session;
}

/*
|--------------------------------------------------------------------------
| Reconnect existing authenticated session
|--------------------------------------------------------------------------
*/

async function reconnectWhatsAppSession(
    userId,
    oldSession,
    telegramContext = null
) {
    if (
        sessions[userId] !== oldSession
    ) {
        return null;
    }

    const dir =
        sessionDir(userId);

    if (!fs.existsSync(dir)) {
        throw new Error(
            'WhatsApp authentication directory no longer exists.'
        );
    }

    const {
        state,
        saveCreds
    } = await useMultiFileAuthState(dir);

    let sock;

    sock = makeWASocket({
        auth: {
            creds: state.creds,

            keys: makeCacheableSignalKeyStore(
                state.keys,
                logger
            )
        },

        logger,

        browser: browserIdentity(),

        markOnlineOnConnect: false,

        syncFullHistory: false,

        generateHighQualityLinkPreview: false,

        connectTimeoutMs:
            CONNECTION_TIMEOUT,

        defaultQueryTimeoutMs:
            DEFAULT_QUERY_TIMEOUT,

        keepAliveIntervalMs:
            KEEP_ALIVE_INTERVAL,

        retryRequestDelayMs: 250,

        printQRInTerminal: false
    });

    oldSession.sock = sock;

    oldSession.connection =
        'connecting';

    oldSession.closed = false;

    sock.ev.on(
        'creds.update',
        saveCreds
    );

    /*
     * Re-register connection handling.
     *
     * The main create function handles the initial socket;
     * reconnecting needs the same protections.
     */
    sock.ev.on(
        'connection.update',
        async (update) => {
            if (
                sessions[userId] !== oldSession
            ) {
                return;
            }

            const {
                connection,
                lastDisconnect
            } = update;

            if (connection) {
                oldSession.connection =
                    connection;
            }

            if (connection === 'open') {
                oldSession.connection =
                    'open';

                oldSession.connectedAt =
                    Date.now();

                oldSession.reconnecting =
                    false;

                oldSession.pairingError =
                    null;

                console.log(
                    `[WHATSAPP] Reconnected: ${oldSession.number}`
                );

                return;
            }

            if (connection === 'close') {
                const reason =
                    getDisconnectMessage(
                        lastDisconnect?.error
                    );

                oldSession.connection =
                    'close';

                oldSession.lastDisconnectReason =
                    reason;

                oldSession.reconnecting =
                    false;

                const loggedOut =
                    isLoggedOut(
                        lastDisconnect?.error
                    );

                if (
                    oldSession.intentionalStop
                ) {
                    return;
                }

                if (loggedOut) {
                    oldSession.pairingError =
                        new Error(reason);

                    if (
                        sessions[userId] === oldSession
                    ) {
                        delete sessions[userId];
                    }

                    if (telegramContext) {
                        await telegramReply(
                            telegramContext,
                            '🔴 WhatsApp session ended.\n\n' +
                            `📱 Number: ${oldSession.number}\n\n` +
                            'Use /pair to link it again.'
                        );
                    }

                    return;
                }

                /*
                 * Avoid an uncontrolled reconnect loop.
                 * A later /status or /pair can establish a fresh
                 * connection if necessary.
                 */
                if (
                    sessions[userId] === oldSession
                ) {
                    delete sessions[userId];
                }
            }
        }
    );

    /*
     * Re-register message processing.
     */
    sock.ev.on(
        'messages.upsert',
        async (event) => {
            if (
                sessions[userId] !== oldSession
            ) {
                return;
            }

            const messages =
                event?.messages || [];

            for (const msg of messages) {
                try {
                    /*
                     * SELF-BOT ONLY.
                     */
                    if (
                        msg?.key?.fromMe !== true
                    ) {
                        continue;
                    }

                    const jid =
                        msg?.key?.remoteJid;

                    if (
                        !jid ||
                        jid === 'status@broadcast'
                    ) {
                        continue;
                    }

                    const text =
                        getText(
                            msg?.message
                        );

                    if (!text) {
                        continue;
                    }

                    const commandText =
                        text.startsWith('.')
                            ? text
                            : `.${text}`;

                    const isGroup =
                        jid.endsWith('@g.us');

                    const queueKey =
                        `${userId}:${jid}`;

                    await enqueueCommand(
                        async () => {
                            if (
                                sessions[userId] !==
                                oldSession
                            ) {
                                return;
                            }

                            if (
                                typeof global.handleWhatsAppCommand !==
                                'function'
                            ) {
                                return;
                            }

                            await global.handleWhatsAppCommand(
                                sock,
                                msg,
                                jid,
                                oldSession.number,
                                isGroup,
                                commandText,
                                userId
                            );
                        },
                        queueKey
                    );
                } catch (error) {
                    console.error(
                        '[WHATSAPP] Reconnect message error:',
                        error?.stack || error
                    );
                }
            }
        }
    );

    return oldSession;
}

/*
|--------------------------------------------------------------------------
| Stop WhatsApp session
|--------------------------------------------------------------------------
*/

async function stopWhatsAppSession(
    userId,
    options = {}
) {
    const session =
        sessions[userId];

    /*
     * Even if the in-memory session is already gone, the caller
     * may explicitly request removal of the authentication files.
     */
    if (!session) {
        if (
            options.removeAuth === true
        ) {
            removeDirectory(
                sessionDir(userId)
            );
        }

        return false;
    }

    /*
     * Mark it BEFORE closing the socket.
     *
     * This is extremely important because sock.end() can cause
     * connection.update({ connection: 'close' }) immediately.
     */
    session.intentionalStop = true;
    session.closed = true;

    try {
        if (
            session.sock &&
            typeof session.sock.end === 'function'
        ) {
            session.sock.end(
                new Error(
                    'WhatsApp session stopped by user.'
                )
            );
        }
    } catch (error) {
        console.error(
            '[WHATSAPP] Stop error:',
            error?.message || error
        );
    }

    session.sock = null;

    /*
     * Delete the global reference immediately.
     *
     * This means a new /pair can start without waiting for the
     * old connection.update event to finish.
     */
    if (
        sessions[userId] === session
    ) {
        delete sessions[userId];
    }

    /*
     * /stop normally preserves auth.
     *
     * If /pair wants a completely fresh pairing, it calls
     * prepareFreshPairing(), which removes the auth directory.
     */
    if (
        options.removeAuth === true
    ) {
        removeDirectory(
            sessionDir(userId)
        );
    }

    /*
     * Clear any pending pairing state too.
     */
    if (
        global.pairingStates
    ) {
        delete global.pairingStates[userId];
    }

    await sleep(500);

    return true;
}

/*
|--------------------------------------------------------------------------
| Get session
|--------------------------------------------------------------------------
*/

function getWhatsAppSession(
    userId
) {
    return sessions[userId] || null;
}

/*
|--------------------------------------------------------------------------
| Send reply
|--------------------------------------------------------------------------
*/

async function sendReply(
    sock,
    jid,
    text,
    quoted = null,
    options = {}
) {
    if (!sock) {
        throw new Error(
            'WhatsApp socket is unavailable.'
        );
    }

    if (!jid) {
        throw new Error(
            'WhatsApp destination JID is missing.'
        );
    }

    const content = {
        text: String(text ?? '')
    };

    /*
     * IMPORTANT:
     *
     * jid is the ACTUAL CHAT where the command was sent.
     *
     * We do not replace it with the linked phone number.
     */
    if (
        quoted &&
        options.quoted !== false
    ) {
        return sock.sendMessage(
            jid,
            content,
            {
                quoted
            }
        );
    }

    return sock.sendMessage(
        jid,
        content
    );
}

/*
|--------------------------------------------------------------------------
| Restore sessions after process restart
|--------------------------------------------------------------------------
*/

async function restoreSessions() {
    ensureSessionRoot();

    if (
        !fs.existsSync(SESSION_ROOT)
    ) {
        return;
    }

    const entries =
        fs.readdirSync(
            SESSION_ROOT,
            {
                withFileTypes: true
            }
        );

    for (const entry of entries) {
        if (
            !entry.isDirectory()
        ) {
            continue;
        }

        if (
            !entry.name.startsWith('wa_')
        ) {
            continue;
        }

        const userId =
            entry.name.slice(3);

        if (!userId) {
            continue;
        }

        /*
         * Do not restore two sessions for the same Telegram user.
         */
        if (sessions[userId]) {
            continue;
        }

        try {
            const dir =
                sessionDir(userId);

            const {
                state,
                saveCreds
            } = await useMultiFileAuthState(
                dir
            );

            /*
             * If there are no credentials, this is probably an
             * incomplete pairing directory. Leave it for the
             * next /pair cleanup rather than creating a broken
             * socket.
             */
            if (
                !state?.creds?.me?.id
            ) {
                console.log(
                    `[WHATSAPP] Skipping incomplete session: ${userId}`
                );

                continue;
            }

            const session =
                createSessionRecord(
                    userId,
                    jidNumber(
                        state.creds.me.id
                    ),
                    {
                        pairing: false
                    }
                );

            let sock;

            try {
                sock = makeWASocket({
                    auth: {
                        creds: state.creds,

                        keys:
                            makeCacheableSignalKeyStore(
                                state.keys,
                                logger
                            )
                    },

                    logger,

                    browser:
                        browserIdentity(),

                    markOnlineOnConnect:
                        false,

                    syncFullHistory:
                        false,

                    generateHighQualityLinkPreview:
                        false,

                    connectTimeoutMs:
                        CONNECTION_TIMEOUT,

                    defaultQueryTimeoutMs:
                        DEFAULT_QUERY_TIMEOUT,

                    keepAliveIntervalMs:
                        KEEP_ALIVE_INTERVAL,

                    retryRequestDelayMs:
                        250,

                    printQRInTerminal:
                        false
                });
            } catch (error) {
                delete sessions[userId];

                console.error(
                    `[WHATSAPP] Restore socket failed for ${userId}:`,
                    error?.stack || error
                );

                continue;
            }

            session.sock = sock;

            sock.ev.on(
                'creds.update',
                saveCreds
            );

            sock.ev.on(
                'connection.update',
                async (update) => {
                    if (
                        sessions[userId] !==
                        session
                    ) {
                        return;
                    }

                    const {
                        connection,
                        lastDisconnect
                    } = update;

                    if (connection) {
                        session.connection =
                            connection;
                    }

                    if (
                        connection === 'open'
                    ) {
                        session.connection =
                            'open';

                        session.connectedAt =
                            Date.now();

                        session.reconnecting =
                            false;

                        console.log(
                            `[WHATSAPP] Restored session connected: ${session.number}`
                        );

                        return;
                    }

                    if (
                        connection === 'close'
                    ) {
                        const reason =
                            getDisconnectMessage(
                                lastDisconnect?.error
                            );

                        session.connection =
                            'close';

                        session.lastDisconnectReason =
                            reason;

                        const loggedOut =
                            isLoggedOut(
                                lastDisconnect?.error
                            );

                        console.log(
                            `[WHATSAPP] Restored session closed for ${session.number}: ${reason}`
                        );

                        /*
                         * Do not reconnect forever.
                         *
                         * The next /pair can clean the auth directory
                         * and create a fresh connection.
                         */
                        if (
                            loggedOut ||
                            sessions[userId] ===
                                session
                        ) {
                            delete sessions[userId];
                        }
                    }
                }
            );

            sock.ev.on(
                'messages.upsert',
                async (event) => {
                    if (
                        sessions[userId] !==
                        session
                    ) {
                        return;
                    }

                    const messages =
                        event?.messages || [];

                    for (
                        const msg of messages
                    ) {
                        try {
                            /*
                             * Only commands sent by the linked
                             * account itself.
                             */
                            if (
                                msg?.key?.fromMe !==
                                true
                            ) {
                                continue;
                            }

                            const jid =
                                msg?.key?.remoteJid;

                            if (
                                !jid ||
                                jid ===
                                    'status@broadcast'
                            ) {
                                continue;
                            }

                            const text =
                                getText(
                                    msg?.message
                                );

                            if (!text) {
                                continue;
                            }

                            const commandText =
                                text.startsWith('.')
                                    ? text
                                    : `.${text}`;

                            const isGroup =
                                jid.endsWith(
                                    '@g.us'
                                );

                            const queueKey =
                                `${userId}:${jid}`;

                            await enqueueCommand(
                                async () => {
                                    if (
                                        sessions[userId] !==
                                        session
                                    ) {
                                        return;
                                    }

                                    if (
                                        typeof global.handleWhatsAppCommand !==
                                        'function'
                                    ) {
                                        return;
                                    }

                                    await global.handleWhatsAppCommand(
                                        sock,
                                        msg,
                                        jid,
                                        session.number,
                                        isGroup,
                                        commandText,
                                        userId
                                    );
                                },
                                queueKey
                            );
                        } catch (error) {
                            console.error(
                                '[WHATSAPP] Restored message error:',
                                error?.stack ||
                                    error
                            );
                        }
                    }
                }
            );

            console.log(
                `[WHATSAPP] Restoring session for Telegram user ${userId}`
            );
        } catch (error) {
            console.error(
                `[WHATSAPP] Failed to restore session ${userId}:`,
                error?.stack || error
            );

            delete sessions[userId];
        }
    }
}

/*
|--------------------------------------------------------------------------
| Exports
|--------------------------------------------------------------------------
*/

module.exports = {
    createWhatsAppSession,
    stopWhatsAppSession,
    getWhatsAppSession,
    sendReply,
    restoreSessions,
    sessionDir,
    prepareFreshPairing
};
