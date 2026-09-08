'use strict';

const fs = require('fs');
const path = require('path');
const P = require('pino');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
    makeCacheableSignalKeyStore,
    jidNormalizedUser
} = require('@whiskeysockets/baileys');

const {
    jidNumber,
    isGroupJid,
    getText
} = require('./helpers');

const {
    enqueueCommand
} = require('./queue');

/*
|--------------------------------------------------------------------------
| GLOBAL STATE
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

function getBot() {
    return global.bot || null;
}

/*
|--------------------------------------------------------------------------
| PATHS
|--------------------------------------------------------------------------
*/

const AUTH_ROOT = path.join(__dirname, '..', 'sessions');

function getSessionDir(userId) {
    return path.join(
        AUTH_ROOT,
        `wa_${String(userId)}`
    );
}

function ensureDirectory(dir) {
    fs.mkdirSync(dir, {
        recursive: true
    });
}

function removeDirectory(dir) {
    try {
        if (!fs.existsSync(dir)) {
            return;
        }

        fs.rmSync(dir, {
            recursive: true,
            force: true
        });
    } catch (error) {
        console.error(
            '[WHATSAPP REMOVE DIR]',
            error?.stack || error
        );
    }
}

/*
|--------------------------------------------------------------------------
| SMALL HELPERS
|--------------------------------------------------------------------------
*/

function sleep(ms) {
    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

function browserIdentity() {
    /*
     * IMPORTANT:
     *
     * Browsers.ubuntu is a function in Baileys.
     *
     * It must be CALLED.
     *
     * Wrong:
     *     browser: Browsers.ubuntu
     *
     * Correct:
     *     browser: Browsers.ubuntu('Chrome')
     */

    return Browsers.ubuntu('Chrome');
}

function getSession(userId) {
    const sessions = getSessions();

    return sessions[String(userId)] || null;
}

function setSession(userId, session) {
    const sessions = getSessions();

    sessions[String(userId)] = session;

    return session;
}

function deleteSession(userId, expectedSession = null) {
    const sessions = getSessions();
    const key = String(userId);

    /*
     * Never let an old socket delete a newer session.
     *
     * This matters when a user stops/restarts/pairs quickly.
     */

    if (
        expectedSession &&
        sessions[key] &&
        sessions[key] !== expectedSession
    ) {
        return false;
    }

    delete sessions[key];

    return true;
}

function normalizePhone(number) {
    return String(number || '')
        .replace(/[^0-9]/g, '');
}

function makeSessionRecord(userId, phoneNumber) {
    return {
        userId: String(userId),

        phoneNumber:
            normalizePhone(phoneNumber) || null,

        socket: null,

        pairingCode: null,

        connected: false,

        connecting: false,

        stopping: false,

        pairing: false,

        createdAt: Date.now(),

        connectedAt: null,

        lastDisconnectAt: null,

        reconnecting: false,

        reconnectAttempts: 0,

        lastError: null
    };
}

/*
|--------------------------------------------------------------------------
| TELEGRAM NOTIFICATIONS
|--------------------------------------------------------------------------
*/

async function telegramSend(userId, text) {
    const bot = getBot();

    if (!bot || !userId) {
        return false;
    }

    try {
        await bot.telegram.sendMessage(
            String(userId),
            String(text || '')
        );

        return true;
    } catch (error) {
        console.error(
            '[WHATSAPP TELEGRAM]',
            error?.stack || error
        );

        return false;
    }
}

/*
|--------------------------------------------------------------------------
| PAIRING STATE HELPERS
|--------------------------------------------------------------------------
*/

function getPairingState(userId) {
    return getPairingStates()[String(userId)] || null;
}

function clearPairingStateIfOwned(
    userId,
    expectedPhone = null
) {
    const states = getPairingStates();
    const key = String(userId);
    const state = states[key];

    if (!state) {
        return;
    }

    if (
        expectedPhone &&
        state.phoneNumber &&
        String(state.phoneNumber) !== String(expectedPhone)
    ) {
        return;
    }

    if (state.timeout) {
        clearTimeout(state.timeout);
    }

    delete states[key];
}

function updatePairingState(
    userId,
    updates
) {
    const states = getPairingStates();
    const key = String(userId);

    if (!states[key]) {
        return null;
    }

    states[key] = {
        ...states[key],
        ...updates,
        updatedAt: Date.now()
    };

    return states[key];
}

/*
|--------------------------------------------------------------------------
| CONNECTION ERROR MESSAGE
|--------------------------------------------------------------------------
*/

function getDisconnectMessage(error) {
    const code =
        error?.output?.statusCode ??
        error?.statusCode ??
        error?.data?.statusCode ??
        null;

    switch (code) {
        case DisconnectReason.loggedOut:
            return 'WhatsApp logged out this session.';

        case DisconnectReason.badSession:
            return 'WhatsApp rejected the saved session.';

        case DisconnectReason.connectionClosed:
            return 'The WhatsApp connection was closed.';

        case DisconnectReason.connectionLost:
            return 'The WhatsApp connection was lost.';

        case DisconnectReason.connectionReplaced:
            return 'The WhatsApp session was replaced by another connection.';

        case DisconnectReason.timedOut:
            return 'The WhatsApp connection timed out.';

        case DisconnectReason.restartRequired:
            return 'WhatsApp requested a connection restart.';

        case DisconnectReason.multideviceMismatch:
            return 'WhatsApp reported a multi-device mismatch.';

        default:
            return error?.message ||
                'Unknown WhatsApp connection error.';
    }
}

function getDisconnectCode(update) {
    return (
        update?.lastDisconnect?.error?.output?.statusCode ??
        update?.lastDisconnect?.error?.statusCode ??
        update?.lastDisconnect?.error?.data?.statusCode ??
        null
    );
}

/*
|--------------------------------------------------------------------------
| SOCKET CLOSE
|--------------------------------------------------------------------------
*/

function closeSocket(session, reason = 'closed') {
    if (!session) {
        return;
    }

    const sock = session.socket;

    session.stopping = true;
    session.connected = false;
    session.connecting = false;

    if (!sock) {
        return;
    }

    try {
        /*
         * end() closes the connection without intentionally logging
         * the WhatsApp account out.
         *
         * This is what /stop should use.
         */

        if (typeof sock.end === 'function') {
            sock.end(
                new Error(
                    `SolvaX session ${reason}`
                )
            );
        }
    } catch (error) {
        console.error(
            '[WHATSAPP CLOSE]',
            error?.stack || error
        );
    }

    session.socket = null;
}

/*
|--------------------------------------------------------------------------
| PREPARE FRESH PAIRING
|--------------------------------------------------------------------------
*/

async function prepareFreshPairing(userId) {
    const key = String(userId);

    const existing = getSession(key);

    if (existing) {
        existing.stopping = true;

        closeSocket(
            existing,
            'preparing fresh pairing'
        );

        deleteSession(
            key,
            existing
        );
    }

    /*
     * Pairing should start with a clean authentication directory.
     *
     * This is deliberately destructive to the OLD auth state.
     * It is only used when /pair explicitly requests a fresh link.
     */

    const dir = getSessionDir(key);

    removeDirectory(dir);

    await sleep(300);

    return true;
}

/*
|--------------------------------------------------------------------------
| SEND REPLY TO WHATSAPP
|--------------------------------------------------------------------------
*/

async function sendReply(
    session,
    remoteJid,
    text,
    options = {}
) {
    if (!session) {
        throw new Error(
            'WhatsApp session does not exist.'
        );
    }

    if (!session.socket) {
        throw new Error(
            'WhatsApp socket is not available.'
        );
    }

    if (!remoteJid) {
        throw new Error(
            'No WhatsApp chat was specified.'
        );
    }

    const message = String(text || '');

    if (!message) {
        return null;
    }

    return session.socket.sendMessage(
        remoteJid,
        {
            text: message
        },
        options
    );
}

/*
|--------------------------------------------------------------------------
| HANDLE INCOMING WHATSAPP COMMAND
|--------------------------------------------------------------------------
|
| index.js supplies global.handleWhatsAppCommand.
|
| We keep the event listener here very small.
|
| IMPORTANT:
|
| msg.key.fromMe === true
|
| means the message was sent by the linked WhatsApp account.
|
| This prevents random group members from controlling the bot.
|--------------------------------------------------------------------------
*/

async function handleIncomingMessage(
    userId,
    session,
    msg
) {
    if (!msg || !msg.key) {
        return;
    }

    /*
     * Ignore messages that are not from the linked account itself.
     */

    if (msg.key.fromMe !== true) {
        return;
    }

    /*
     * Ignore protocol/status traffic.
     */

    const remoteJid =
        msg.key.remoteJid || '';

    if (!remoteJid) {
        return;
    }

    if (
        remoteJid === 'status@broadcast' ||
        remoteJid.endsWith('@broadcast')
    ) {
        return;
    }

    /*
     * Do not process messages while this socket is stopping.
     */

    if (session.stopping) {
        return;
    }

    /*
     * Verify this socket still belongs to the active session.
     */

    if (
        getSession(userId) !== session
    ) {
        return;
    }

    try {
        const handler =
            global.handleWhatsAppCommand;

        if (typeof handler !== 'function') {
            console.error(
                '[WHATSAPP COMMAND]',
                'global.handleWhatsAppCommand is not available.'
            );

            return;
        }

        await handler(
            userId,
            session,
            msg
        );
    } catch (error) {
        console.error(
            '[WHATSAPP COMMAND]',
            error?.stack || error
        );
    }
}

/*
|--------------------------------------------------------------------------
| CREATE WHATSAPP SESSION
|--------------------------------------------------------------------------
*/

async function createWhatsAppSession(
    userId,
    phoneNumber,
    telegramCtx = null,
    options = {}
) {
    const key = String(userId);

    const pairing =
        Boolean(options?.pairing);

    const number =
        normalizePhone(phoneNumber);

    if (!key) {
        throw new Error(
            'Telegram user ID is required.'
        );
    }

    if (!number) {
        throw new Error(
            'WhatsApp phone number is required.'
        );
    }

    /*
     * If another session belongs to this Telegram user, do not
     * silently overwrite it.
     */

    const existing = getSession(key);

    if (existing) {
        if (
            existing.connected ||
            existing.connecting
        ) {
            return existing;
        }

        deleteSession(
            key,
            existing
        );
    }

    ensureDirectory(AUTH_ROOT);

    const authDir =
        getSessionDir(key);

    ensureDirectory(authDir);

    /*
     * Multi-file auth is simple and reliable enough for this bot.
     */

    const {
        state,
        saveCreds
    } = await useMultiFileAuthState(
        authDir
    );

    /*
     * The auth state may have changed while we were awaiting disk I/O.
     * Re-check before installing a new session.
     */

    const another =
        getSession(key);

    if (another) {
        if (
            another.connected ||
            another.connecting
        ) {
            return another;
        }

        deleteSession(
            key,
            another
        );
    }

    const session =
        makeSessionRecord(
            key,
            number
        );

    session.pairing =
        pairing;

    session.connecting =
        true;

    setSession(
        key,
        session
    );

    /*
     * If the user cancelled pairing while the auth state was being
     * prepared, do not continue creating the socket.
     */

    const pairingState =
        getPairingState(key);

    if (
        pairing &&
        (
            !pairingState ||
            pairingState.active !== true
        )
    ) {
        deleteSession(
            key,
            session
        );

        return null;
    }

    /*
     * ------------------------------------------------------------
     * CREATE BAILEYS SOCKET
     * ------------------------------------------------------------
     */

    let sock;

    try {
        sock = makeWASocket({
            auth: {
                creds: state.creds,

                keys: makeCacheableSignalKeyStore(
                    state.keys,
                    P({
                        level: 'silent'
                    })
                )
            },

            /*
             * Keep this fixed.
             *
             * Do NOT call fetchLatestBaileysVersion() here while
             * package.json pins Baileys to 6.7.24.
             */

            browser: browserIdentity(),

            printQRInTerminal: false,

            markOnlineOnConnect: false,

            syncFullHistory: false,

            generateHighQualityLinkPreview: false,

            logger: P({
                level: 'silent'
            })
        });

        session.socket = sock;

    } catch (error) {
        deleteSession(
            key,
            session
        );

        throw error;
    }

    /*
     * ------------------------------------------------------------
     * SAVE AUTH CREDENTIALS
     * ------------------------------------------------------------
     */

    sock.ev.on(
        'creds.update',
        async () => {
            try {
                /*
                 * Do not save credentials from a stale socket if a
                 * newer session has replaced it.
                 */

                if (
                    getSession(key) !== session
                ) {
                    return;
                }

                await saveCreds();
            } catch (error) {
                console.error(
                    '[WHATSAPP CREDS]',
                    error?.stack || error
                );
            }
        }
    );

    /*
     * ------------------------------------------------------------
     * CONNECTION UPDATE
     * ------------------------------------------------------------
     */

    sock.ev.on(
        'connection.update',
        async update => {
            /*
             * Ignore events from an obsolete socket.
             */

            if (
                getSession(key) !== session
            ) {
                return;
            }

            const {
                connection,
                lastDisconnect
            } = update;

            if (connection === 'connecting') {
                session.connecting = true;
                session.connected = false;

                updatePairingState(
                    key,
                    {
                        stage:
                            session.pairing
                                ? 'waiting_connection'
                                : 'connecting'
                    }
                );
            }

            if (connection === 'open') {
                session.connected = true;
                session.connecting = false;
                session.stopping = false;
                session.reconnecting = false;
                session.reconnectAttempts = 0;
                session.connectedAt = Date.now();
                session.lastError = null;

                /*
                 * Capture the actual WhatsApp JID if available.
                 */

                try {
                    const actualJid =
                        jidNormalizedUser(
                            sock.user
                        );

                    if (actualJid) {
                        session.phoneNumber =
                            jidNumber(actualJid);
                    }
                } catch (_) {
                    /*
                     * Not fatal.
                     */
                }

                /*
                 * Pairing is complete.
                 */

                if (session.pairing) {
                    const currentState =
                        getPairingState(key);

                    if (
                        currentState &&
                        currentState.active
                    ) {
                        clearPairingStateIfOwned(
                            key,
                            currentState.phoneNumber
                        );
                    }

                    await telegramSend(
                        key,
                        '✅ WhatsApp connected successfully.\n\n' +
                        `📱 Number: ${session.phoneNumber || number}\n\n` +
                        'Your WhatsApp account is now linked to SolvaX MD.\n\n' +
                        'Commands sent by this linked WhatsApp account can now control the bot.'
                    );
                }

                return;
            }

            if (connection !== 'close') {
                return;
            }

            session.connected = false;
            session.connecting = false;
            session.lastDisconnectAt =
                Date.now();

            const error =
                lastDisconnect?.error;

            const code =
                getDisconnectCode(update);

            const reason =
                getDisconnectMessage(error);

            session.lastError =
                reason;

            /*
             * ----------------------------------------------------
             * USER EXPLICITLY STOPPED SESSION
             * ----------------------------------------------------
             */

            if (session.stopping) {
                /*
                 * Do not reconnect.
                 */

                if (
                    getSession(key) === session
                ) {
                    deleteSession(
                        key,
                        session
                    );
                }

                return;
            }

            /*
             * ----------------------------------------------------
             * SESSION REPLACED
             * ----------------------------------------------------
             */

            if (
                code ===
                DisconnectReason.connectionReplaced
            ) {
                if (
                    getSession(key) === session
                ) {
                    deleteSession(
                        key,
                        session
                    );
                }

                await telegramSend(
                    key,
                    '⚠️ WhatsApp session was replaced by another connection.\n\n' +
                    'The current SolvaX session has been stopped.'
                );

                return;
            }

            /*
             * ----------------------------------------------------
             * LOGGED OUT / BAD SESSION
             * ----------------------------------------------------
             *
             * These are not normal temporary disconnects.
             * Reconnecting with the same credentials will not solve
             * a logged-out session.
             */

            if (
                code === DisconnectReason.loggedOut ||
                code === DisconnectReason.badSession
            ) {
                if (
                    getSession(key) === session
                ) {
                    deleteSession(
                        key,
                        session
                    );
                }

                /*
                 * Remove invalid authentication.
                 */

                removeDirectory(
                    getSessionDir(key)
                );

                clearPairingStateIfOwned(
                    key,
                    number
                );

                await telegramSend(
                    key,
                    '❌ WhatsApp session ended.\n\n' +
                    `${reason}\n\n` +
                    'The saved WhatsApp authentication was removed.\n\n' +
                    'Use /pair to link the account again.'
                );

                return;
            }

            /*
             * ----------------------------------------------------
             * RECONNECTABLE DISCONNECT
             * ----------------------------------------------------
             */

            if (
                getSession(key) !== session
            ) {
                return;
            }

            session.reconnecting = true;
            session.reconnectAttempts =
                Number(
                    session.reconnectAttempts || 0
                ) + 1;

            /*
             * Keep reconnecting attempts bounded.
             *
             * Exponential-ish delay prevents a dead connection from
             * hammering WhatsApp continuously.
             */

            const attempt =
                session.reconnectAttempts;

            const delay =
                Math.min(
                    30000,
                    2000 * attempt
                );

            await sleep(delay);

            /*
             * User may have called /stop while we were waiting.
             */

            if (
                session.stopping ||
                getSession(key) !== session
            ) {
                return;
            }

            try {
                await reconnectWhatsAppSession(
                    key,
                    session
                );
            } catch (reconnectError) {
                console.error(
                    '[WHATSAPP RECONNECT]',
                    reconnectError?.stack ||
                    reconnectError
                );

                if (
                    getSession(key) !== session
                ) {
                    return;
                }

                session.reconnecting = false;

                await telegramSend(
                    key,
                    '⚠️ WhatsApp connection could not be restored automatically.\n\n' +
                    'Use /status to check the session.\n' +
                    'Use /stop and /pair if a fresh pairing is required.'
                );
            }
        }
    );

    /*
     * ------------------------------------------------------------
     * MESSAGE HANDLER
     * ------------------------------------------------------------
     */

    sock.ev.on(
        'messages.upsert',
        async event => {
            if (
                getSession(key) !== session
            ) {
                return;
            }

            if (
                session.stopping
            ) {
                return;
            }

            const messages =
                Array.isArray(event?.messages)
                    ? event.messages
                    : [];

            for (
                const msg of messages
            ) {
                try {
                    /*
                     * Only process actual self-sent messages.
                     *
                     * This is the main protection against other
                     * people controlling the self-bot.
                     */

                    if (
                        msg?.key?.fromMe !== true
                    ) {
                        continue;
                    }

                    await enqueueCommand(
                        () =>
                            handleIncomingMessage(
                                key,
                                session,
                                msg
                            ),
                        `wa:${key}`
                    );

                } catch (error) {
                    console.error(
                        '[WHATSAPP MESSAGE]',
                        error?.stack || error
                    );
                }
            }
        }
    );

    /*
     * ------------------------------------------------------------
     * REQUEST PAIRING CODE
     * ------------------------------------------------------------
     */

    if (pairing) {
        /*
         * requestPairingCode should only be called when the account
         * is not already registered on this auth state.
         */

        if (!state.creds.registered) {
            try {
                const currentState =
                    getPairingState(key);

                /*
                 * /stop could have happened while the socket was
                 * being constructed.
                 */

                if (
                    !currentState ||
                    currentState.active !== true
                ) {
                    session.stopping = true;

                    closeSocket(
                        session,
                        'pairing cancelled'
                    );

                    deleteSession(
                        key,
                        session
                    );

                    return null;
                }

                updatePairingState(
                    key,
                    {
                        stage:
                            'requesting_code',
                        phoneNumber:
                            number
                    }
                );

                /*
                 * Baileys expects the phone number without +.
                 */

                const code =
                    await sock.requestPairingCode(
                        number
                    );

                /*
                 * Check again because /stop could have happened while
                 * WhatsApp was generating the code.
                 */

                if (
                    getSession(key) !== session ||
                    session.stopping
                ) {
                    return null;
                }

                session.pairingCode =
                    String(code || '');

                updatePairingState(
                    key,
                    {
                        stage:
                            'waiting_connection',
                        phoneNumber:
                            number,
                        pairingCode:
                            session.pairingCode
                    }
                );

            } catch (error) {
                session.lastError =
                    error?.message ||
                    String(error);

                /*
                 * Clean this session because pairing failed.
                 */

                session.stopping = true;

                closeSocket(
                    session,
                    'pairing failed'
                );

                deleteSession(
                    key,
                    session
                );

                throw error;
            }
        } else {
            /*
             * Existing registered credentials were found.
             *
             * This is not a fresh pairing-code flow.
             */

            session.pairingCode = null;

            updatePairingState(
                key,
                {
                    stage: 'waiting_connection',
                    phoneNumber: number,
                    pairingCode: null
                }
            );
        }
    }

    /*
     * Give the socket a short chance to initialize before returning
     * to pair.js.
     *
     * This is NOT a fake "wait until connected" timer. It only gives
     * Baileys enough time to emit its initial state and pairing code.
     */

    await sleep(250);

    if (
        getSession(key) !== session
    ) {
        return null;
    }

    return session;
}

/*
|--------------------------------------------------------------------------
| RECONNECT WHATSAPP SESSION
|--------------------------------------------------------------------------
*/

async function reconnectWhatsAppSession(
    userId,
    existingSession = null
) {
    const key = String(userId);

    const current =
        getSession(key);

    if (!current) {
        return null;
    }

    if (
        existingSession &&
        current !== existingSession
    ) {
        return null;
    }

    if (current.stopping) {
        return null;
    }

    /*
     * We do not delete the auth directory here.
     *
     * Reconnection should reuse the saved credentials.
     */

    const number =
        current.phoneNumber;

    if (!number) {
        throw new Error(
            'Cannot reconnect WhatsApp session without a phone number.'
        );
    }

    /*
     * Close the old socket first.
     */

    const oldSocket =
        current.socket;

    if (oldSocket) {
        try {
            if (
                typeof oldSocket.end === 'function'
            ) {
                oldSocket.end(
                    new Error(
                        'Reconnecting WhatsApp session'
                    )
                );
            }
        } catch (error) {
            console.error(
                '[WHATSAPP OLD SOCKET]',
                error?.stack || error
            );
        }
    }

    current.socket = null;
    current.connected = false;
    current.connecting = true;

    /*
     * createWhatsAppSession normally refuses an existing session.
     *
     * Temporarily remove it from the registry while preserving the
     * same session object as the expected owner.
     */

    deleteSession(
        key,
        current
    );

    try {
        const newSession =
            await createWhatsAppSession(
                key,
                number,
                null,
                {
                    pairing: false,
                    reconnect: true
                }
            );

        /*
         * The newly created session is now the active owner.
         */

        if (!newSession) {
            return null;
        }

        newSession.reconnecting =
            false;

        return newSession;

    } catch (error) {
        /*
         * Restore the old record only if another session has not
         * already replaced it.
         */

        if (!getSession(key)) {
            setSession(
                key,
                current
            );
        }

        current.reconnecting =
            false;

        current.lastError =
            error?.message ||
            String(error);

        throw error;
    }
}

/*
|--------------------------------------------------------------------------
| STOP WHATSAPP SESSION
|--------------------------------------------------------------------------
*/

async function stopWhatsAppSession(
    userId,
    options = {}
) {
    const key = String(userId);

    const {
        removeAuth = false
    } = options;

    const session =
        getSession(key);

    if (!session) {
        if (removeAuth) {
            removeDirectory(
                getSessionDir(key)
            );
        }

        return false;
    }

    /*
     * Mark stopping BEFORE closing the socket.
     *
     * Otherwise connection.update may see the close and immediately
     * start a reconnect.
     */

    session.stopping = true;
    session.reconnecting = false;

    closeSocket(
        session,
        'stopped by user'
    );

    /*
     * Only delete the session if it is still the same session.
     */

    deleteSession(
        key,
        session
    );

    /*
     * Clear pending pairing state as well.
     */

    clearPairingStateIfOwned(
        key,
        session.phoneNumber
    );

    if (removeAuth) {
        removeDirectory(
            getSessionDir(key)
        );
    }

    /*
     * Give Baileys a moment to finish closing its event loop.
     */

    await sleep(150);

    return true;
}

/*
|--------------------------------------------------------------------------
| GET SESSION
|--------------------------------------------------------------------------
*/

function getWhatsAppSession(userId) {
    return getSession(
        String(userId)
    );
}

/*
|--------------------------------------------------------------------------
| SESSION STATUS
|--------------------------------------------------------------------------
*/

function getWhatsAppStatus(userId) {
    const session =
        getSession(
            String(userId)
        );

    if (!session) {
        return {
            active: false,
            connected: false,
            connecting: false,
            phoneNumber: null,
            pairingCode: null,
            reconnecting: false,
            reconnectAttempts: 0,
            lastError: null,
            createdAt: null,
            connectedAt: null
        };
    }

    return {
        active: true,

        connected:
            Boolean(session.connected),

        connecting:
            Boolean(session.connecting),

        phoneNumber:
            session.phoneNumber || null,

        pairingCode:
            session.pairingCode || null,

        reconnecting:
            Boolean(session.reconnecting),

        reconnectAttempts:
            Number(
                session.reconnectAttempts || 0
            ),

        lastError:
            session.lastError || null,

        createdAt:
            session.createdAt || null,

        connectedAt:
            session.connectedAt || null,

        lastDisconnectAt:
            session.lastDisconnectAt || null
    };
}

/*
|--------------------------------------------------------------------------
| RESTORE SAVED SESSIONS
|--------------------------------------------------------------------------
*/

async function restoreSessions() {
    ensureDirectory(
        AUTH_ROOT
    );

    const sessions =
        getSessions();

    let entries = [];

    try {
        entries =
            fs.readdirSync(
                AUTH_ROOT,
                {
                    withFileTypes: true
                }
            );
    } catch (error) {
        console.error(
            '[WHATSAPP RESTORE READ]',
            error?.stack || error
        );

        return;
    }

    for (
        const entry of entries
    ) {
        if (
            !entry.isDirectory()
        ) {
            continue;
        }

        const prefix =
            'wa_';

        if (
            !entry.name.startsWith(prefix)
        ) {
            continue;
        }

        const userId =
            entry.name.slice(
                prefix.length
            );

        if (!userId) {
            continue;
        }

        /*
         * Never overwrite a session that was already created by a
         * current Telegram pairing operation.
         */

        if (
            sessions[userId]
        ) {
            continue;
        }

        try {
            const authDir =
                getSessionDir(userId);

            const credsFile =
                path.join(
                    authDir,
                    'creds.json'
                );

            if (
                !fs.existsSync(credsFile)
            ) {
                continue;
            }

            const authData =
                JSON.parse(
                    fs.readFileSync(
                        credsFile,
                        'utf8'
                    )
                );

            /*
             * Do not restore a directory that clearly has no
             * registered WhatsApp account.
             */

            if (
                authData?.registered === false
            ) {
                continue;
            }

            const phoneNumber =
                authData?.me?.id
                    ? jidNumber(
                        authData.me.id
                    )
                    : null;

            /*
             * We intentionally use createWhatsAppSession here.
             * It loads the same multi-file auth directory.
             */

            const session =
                await createWhatsAppSession(
                    userId,
                    phoneNumber || '0',
                    null,
                    {
                        pairing: false,
                        restore: true
                    }
                );

            if (
                !session
            ) {
                continue;
            }

            /*
             * If createWhatsAppSession was called with "0" because
             * the auth file did not expose me.id, try to recover the
             * real JID once Baileys connects.
             */

            console.log(
                `[WHATSAPP RESTORE] Session restored for Telegram user ${userId}`
            );

        } catch (error) {
            console.error(
                `[WHATSAPP RESTORE ${userId}]`,
                error?.stack || error
            );
        }
    }
}

/*
|--------------------------------------------------------------------------
| SHUTDOWN ALL SESSIONS
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
                `[WHATSAPP SHUTDOWN ${userId}]`,
                error?.stack || error
            );
        }
    }

    return true;
}

/*
|--------------------------------------------------------------------------
| EXPORTS
|--------------------------------------------------------------------------
*/

module.exports = {
    createWhatsAppSession,
    reconnectWhatsAppSession,
    stopWhatsAppSession,
    stopAllWhatsAppSessions,

    prepareFreshPairing,

    getWhatsAppSession,
    getWhatsAppStatus,

    restoreSessions,

    sendReply,

    getSessionDir,

    closeSocket,

    getDisconnectMessage
};
