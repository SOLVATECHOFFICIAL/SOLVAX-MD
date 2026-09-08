'use strict';

/*
 * SOLVAX MD
 * lib/whatsapp.js
 *
 * Central WhatsApp session manager.
 *
 * Responsibilities:
 * - Create WhatsApp sessions
 * - Generate pairing codes
 * - Save authentication state
 * - Restore sessions
 * - Handle connection updates
 * - Handle incoming messages
 * - Prevent duplicate sockets
 * - Stop/reset sessions cleanly
 * - Control automatic reconnects
 * - Expose session/status helpers
 *
 * IMPORTANT:
 * Your pair command should use:
 *
 *     createWhatsAppSession(userId, phoneNumber)
 *
 * Do not create another Baileys socket inside the pair command.
 */

const fs = require('fs');
const path = require('path');

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
    makeCacheableSignalKeyStore,
    fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');

const P = require('pino');

const {
    sleep,
    cleanNumber
} = require('./helpers');


/* =========================================================
 * CONFIGURATION
 * ========================================================= */

const BASE_SESSION_DIR = path.join(process.cwd(), 'sessions');

const PAIR_TIMEOUT = 5 * 60 * 1000;

// Small delay before reconnecting.
// We do NOT reconnect immediately in a tight loop.
const RECONNECT_DELAY = 5000;

// Prevent accidental duplicate connection attempts.
const CONNECTION_LOCK_TIMEOUT = 30 * 1000;


/* =========================================================
 * GLOBAL STATE
 * ========================================================= */

if (!global.sessions) {
    global.sessions = {};
}

if (!global.pairingStates) {
    global.pairingStates = {};
}

if (!global.waReconnectTimers) {
    global.waReconnectTimers = {};
}

if (!global.waConnectionLocks) {
    global.waConnectionLocks = {};
}

if (!global.waCommandQueues) {
    global.waCommandQueues = {};
}


/* =========================================================
 * LOGGER
 * ========================================================= */

const logger = P({
    level: process.env.WA_LOG_LEVEL || 'silent'
});


/* =========================================================
 * DIRECTORY HELPERS
 * ========================================================= */

function ensureSessionDirectory() {
    if (!fs.existsSync(BASE_SESSION_DIR)) {
        fs.mkdirSync(BASE_SESSION_DIR, {
            recursive: true
        });
    }
}

function getSessionDirectory(userId) {
    ensureSessionDirectory();

    return path.join(
        BASE_SESSION_DIR,
        `wa_${String(userId)}`
    );
}

function sessionDirectoryExists(userId) {
    return fs.existsSync(
        getSessionDirectory(userId)
    );
}


/* =========================================================
 * SAFE DELETE
 * ========================================================= */

function removeDirectory(directory) {
    try {
        if (!directory) {
            return;
        }

        if (!fs.existsSync(directory)) {
            return;
        }

        fs.rmSync(directory, {
            recursive: true,
            force: true
        });
    } catch (error) {
        console.error(
            '[WhatsApp] Failed to remove directory:',
            error.message
        );
    }
}


/* =========================================================
 * PHONE NUMBER
 * ========================================================= */

function normalizePhoneNumber(number) {
    if (!number) {
        return null;
    }

    try {
        let cleaned = cleanNumber(String(number));

        cleaned = cleaned.replace(/\D/g, '');

        if (!cleaned) {
            return null;
        }

        return cleaned;
    } catch (error) {
        return String(number)
            .replace(/\D/g, '');
    }
}


/* =========================================================
 * SESSION LOOKUP
 * ========================================================= */

function getWhatsAppSession(userId) {
    return global.sessions[String(userId)] || null;
}

function hasWhatsAppSession(userId) {
    return !!getWhatsAppSession(userId);
}


/* =========================================================
 * PAIRING STATE
 * ========================================================= */

function getPairingState(userId) {
    return global.pairingStates[String(userId)] || null;
}

function isPairing(userId) {
    const state = getPairingState(userId);

    return !!(
        state &&
        state.active === true
    );
}


/* =========================================================
 * INTERNAL STATE CREATION
 * ========================================================= */

function createPairingState(userId, phoneNumber) {
    const id = String(userId);

    const state = {
        active: true,
        userId: id,
        phoneNumber,
        pairingCode: null,
        startedAt: Date.now(),
        expiresAt: Date.now() + PAIR_TIMEOUT,

        cancelled: false,
        completed: false,

        socket: null,
        timeout: null
    };

    global.pairingStates[id] = state;

    return state;
}


/* =========================================================
 * CLEAR PAIRING TIMER
 * ========================================================= */

function clearPairingTimer(userId) {
    const id = String(userId);
    const state = global.pairingStates[id];

    if (!state) {
        return;
    }

    if (state.timeout) {
        clearTimeout(state.timeout);
        state.timeout = null;
    }
}


/* =========================================================
 * CLEAR RECONNECT TIMER
 * ========================================================= */

function clearReconnectTimer(userId) {
    const id = String(userId);

    if (global.waReconnectTimers[id]) {
        clearTimeout(
            global.waReconnectTimers[id]
        );

        delete global.waReconnectTimers[id];
    }
}


/* =========================================================
 * CONNECTION LOCK
 * ========================================================= */

function acquireConnectionLock(userId) {
    const id = String(userId);

    const existing = global.waConnectionLocks[id];

    if (existing) {
        if (
            Date.now() - existing < CONNECTION_LOCK_TIMEOUT
        ) {
            return false;
        }

        delete global.waConnectionLocks[id];
    }

    global.waConnectionLocks[id] = Date.now();

    return true;
}

function releaseConnectionLock(userId) {
    delete global.waConnectionLocks[
        String(userId)
    ];
}


/* =========================================================
 * DESTROY SOCKET
 * ========================================================= */

async function closeSocket(socket) {
    if (!socket) {
        return;
    }

    try {
        /*
         * Baileys sockets do not always expose a universal
         * "destroy" method, so logout is deliberately NOT
         * performed here.
         *
         * We simply close the underlying websocket when
         * available.
         */

        if (
            socket.ws &&
            typeof socket.ws.close === 'function'
        ) {
            try {
                socket.ws.close();
            } catch (_) {}
        }

    } catch (error) {
        console.error(
            '[WhatsApp] Socket close error:',
            error.message
        );
    }
}


/* =========================================================
 * STOP SESSION
 * ========================================================= */

async function stopWhatsAppSession(
    userId,
    options = {}
) {
    const id = String(userId);

    const {
        deleteAuth = false,
        disableReconnect = true,
        clearPairing = true
    } = options;

    console.log(
        `[WhatsApp] Stopping session for ${id}`
    );

    /*
     * Disable reconnect FIRST.
     *
     * This is important.
     * Otherwise connection.update may schedule another
     * connection while we are trying to shut this one down.
     */

    if (disableReconnect) {
        clearReconnectTimer(id);
    }

    const session = global.sessions[id];

    if (session) {
        session.stopping = true;
        session.reconnectEnabled = false;

        await closeSocket(
            session.socket
        );
    }

    /*
     * Clear global session.
     */

    delete global.sessions[id];

    /*
     * Clear pairing state.
     */

    if (clearPairing) {
        const pairing = global.pairingStates[id];

        if (pairing) {
            pairing.cancelled = true;
            pairing.active = false;

            clearPairingTimer(id);
        }

        delete global.pairingStates[id];
    }

    /*
     * Delete authentication files if requested.
     */

    if (deleteAuth) {
        removeDirectory(
            getSessionDirectory(id)
        );
    }

    releaseConnectionLock(id);

    console.log(
        `[WhatsApp] Session stopped for ${id}`
    );

    return true;
}


/* =========================================================
 * COMPLETE RESET
 * ========================================================= */

async function completelyResetUser(userId) {
    const id = String(userId);

    console.log(
        `[WhatsApp] Completely resetting ${id}`
    );

    await stopWhatsAppSession(id, {
        deleteAuth: true,
        disableReconnect: true,
        clearPairing: true
    });

    clearReconnectTimer(id);

    delete global.waConnectionLocks[id];

    delete global.waCommandQueues[id];

    /*
     * Extra safety:
     */

    delete global.sessions[id];
    delete global.pairingStates[id];

    console.log(
        `[WhatsApp] Complete reset finished for ${id}`
    );

    return true;
}


/* =========================================================
 * PREPARE FRESH PAIRING
 * ========================================================= */

async function prepareFreshPairing(
    userId,
    phoneNumber
) {
    const id = String(userId);

    const number = normalizePhoneNumber(
        phoneNumber
    );

    if (!number) {
        throw new Error(
            'Invalid WhatsApp phone number.'
        );
    }

    console.log(
        `[WhatsApp] Preparing fresh pairing for ${id}`
    );

    /*
     * IMPORTANT:
     * Existing session/auth must be removed before a
     * completely new pairing request.
     */

    await completelyResetUser(id);

    const sessionDir =
        getSessionDirectory(id);

    /*
     * Make sure the directory does not contain stale data.
     */

    removeDirectory(sessionDir);

    fs.mkdirSync(sessionDir, {
        recursive: true
    });

    return {
        userId: id,
        phoneNumber: number,
        sessionDir
    };
}


/* =========================================================
 * CREATE WHATSAPP SESSION
 * ========================================================= */

async function createWhatsAppSession(
    userId,
    phoneNumber,
    options = {}
) {
    const id = String(userId);

    const number = normalizePhoneNumber(
        phoneNumber
    );

    if (!number) {
        throw new Error(
            'A valid WhatsApp number is required.'
        );
    }

    /*
     * Prevent duplicate sockets.
     */

    if (!acquireConnectionLock(id)) {
        throw new Error(
            'A WhatsApp connection is already being prepared.'
        );
    }

    try {
        /*
         * If explicitly requesting a fresh pairing,
         * wipe everything first.
         */

        if (options.fresh === true) {
            await prepareFreshPairing(
                id,
                number
            );
        } else {
            /*
             * If another session exists, stop it.
             * Do not create two sockets for the same user.
             */

            if (global.sessions[id]) {
                await stopWhatsAppSession(
                    id,
                    {
                        deleteAuth: false,
                        disableReconnect: true,
                        clearPairing: true
                    }
                );
            }
        }

        clearReconnectTimer(id);

        /*
         * Load authentication state.
         */

        const sessionDir =
            getSessionDirectory(id);

        fs.mkdirSync(sessionDir, {
            recursive: true
        });

        const {
            state,
            saveCreds
        } = await useMultiFileAuthState(
            sessionDir
        );

        let version;

        try {
            const latest =
                await fetchLatestBaileysVersion();

            version = latest.version;
        } catch (error) {
            console.log(
                '[WhatsApp] Could not fetch latest Baileys version. Using library default.'
            );
        }

        /*
         * Create pairing state BEFORE socket creation.
         */

        const pairingState =
            createPairingState(
                id,
                number
            );

        /*
         * Create socket.
         */

        const socketOptions = {
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(
                    state.keys,
                    logger
                )
            },

            logger,

            printQRInTerminal: false,

            browser: Browsers.ubuntu(
                'Chrome'
            ),

            markOnlineOnConnect: false,

            syncFullHistory: false,

            generateHighQualityLinkPreview: false
        };

        if (version) {
            socketOptions.version = version;
        }

        const socket =
            makeWASocket(
                socketOptions
            );

        /*
         * Save session in global state.
         */

        global.sessions[id] = {
            userId: id,

            socket,

            phoneNumber: number,

            status: 'connecting',

            connected: false,

            reconnectEnabled: true,

            stopping: false,

            createdAt: Date.now(),

            lastConnectedAt: null,

            lastDisconnectAt: null,

            lastError: null,

            reconnectAttempts: 0
        };

        pairingState.socket = socket;

        /*
         * Credentials must always be saved.
         */

        socket.ev.on(
            'creds.update',
            saveCreds
        );


        /* =================================================
         * CONNECTION UPDATE
         * ================================================= */

        socket.ev.on(
            'connection.update',
            async (update) => {
                await handleConnectionUpdate(
                    id,
                    update
                );
            }
        );


        /* =================================================
         * INCOMING MESSAGES
         * ================================================= */

        socket.ev.on(
            'messages.upsert',
            async (messageUpdate) => {
                try {
                    await handleIncomingMessages(
                        id,
                        messageUpdate
                    );
                } catch (error) {
                    console.error(
                        `[WhatsApp] Message handler error for ${id}:`,
                        error.message
                    );
                }
            }
        );


        /*
         * Pairing timeout.
         */

        pairingState.timeout =
            setTimeout(
                async () => {
                    const current =
                        global.pairingStates[id];

                    if (
                        !current ||
                        current.completed ||
                        current.cancelled
                    ) {
                        return;
                    }

                    console.log(
                        `[WhatsApp] Pairing timed out for ${id}`
                    );

                    current.active = false;

                    await stopWhatsAppSession(
                        id,
                        {
                            deleteAuth: true,
                            disableReconnect: true,
                            clearPairing: true
                        }
                    );
                },
                PAIR_TIMEOUT
            );


        /*
         * Request pairing code when appropriate.
         */

        if (
            !state.creds.registered
        ) {
            /*
             * Small delay gives the socket time to initialise.
             */

            await sleep(2000);

            const current =
                global.sessions[id];

            if (
                !current ||
                current.stopping
            ) {
                throw new Error(
                    'WhatsApp session was stopped before pairing.'
                );
            }

            console.log(
                `[WhatsApp] Requesting pairing code for ${number}`
            );

            const pairingCode =
                await socket.requestPairingCode(
                    number
                );

            /*
             * Format code in groups of four.
             */

            const formattedCode =
                formatPairingCode(
                    pairingCode
                );

            const currentPairing =
                global.pairingStates[id];

            if (currentPairing) {
                currentPairing.pairingCode =
                    formattedCode;

                currentPairing.active = true;
            }

            console.log(
                `[WhatsApp] Pairing code for ${id}: ${formattedCode}`
            );

            return {
                socket,

                pairingCode:
                    formattedCode,

                phoneNumber:
                    number,

                userId:
                    id
            };
        }

        /*
         * Already registered.
         */

        const currentPairing =
            global.pairingStates[id];

        if (currentPairing) {
            currentPairing.active = false;
            currentPairing.completed = true;

            clearPairingTimer(id);
        }

        return {
            socket,

            pairingCode: null,

            phoneNumber:
                number,

            userId:
                id
        };

    } catch (error) {
        releaseConnectionLock(id);

        /*
         * Clean partially created session.
         */

        delete global.sessions[id];

        const pairing =
            global.pairingStates[id];

        if (pairing) {
            clearPairingTimer(id);
            delete global.pairingStates[id];
        }

        throw error;
    } finally {
        /*
         * The socket itself now owns the connection lifecycle.
         * Release the creation lock.
         */

        releaseConnectionLock(id);
    }
}


/* =========================================================
 * FORMAT PAIRING CODE
 * ========================================================= */

function formatPairingCode(code) {
    if (!code) {
        return null;
    }

    const cleaned =
        String(code)
            .replace(/[^A-Z0-9]/gi, '')
            .toUpperCase();

    /*
     * WhatsApp pairing codes are generally eight
     * characters. Formatting is only visual.
     */

    if (cleaned.length <= 4) {
        return cleaned;
    }

    return (
        cleaned.slice(0, 4) +
        '-' +
        cleaned.slice(4)
    );
}


/* =========================================================
 * CONNECTION UPDATE HANDLER
 * ========================================================= */

async function handleConnectionUpdate(
    userId,
    update
) {
    const id = String(userId);

    const {
        connection,
        lastDisconnect
    } = update;

    const session =
        global.sessions[id];

    const pairing =
        global.pairingStates[id];

    if (!session) {
        return;
    }


    /* -----------------------------------------------------
     * CONNECTING
     * ----------------------------------------------------- */

    if (connection === 'connecting') {
        session.status =
            'connecting';

        session.connected =
            false;

        console.log(
            `[WhatsApp] ${id}: connecting`
        );

        return;
    }


    /* -----------------------------------------------------
     * OPEN
     * ----------------------------------------------------- */

    if (connection === 'open') {
        session.status =
            'connected';

        session.connected =
            true;

        session.stopping =
            false;

        session.reconnectEnabled =
            true;

        session.lastConnectedAt =
            Date.now();

        session.reconnectAttempts = 0;

        /*
         * Pairing is complete.
         */

        if (pairing) {
            pairing.active =
                false;

            pairing.completed =
                true;

            clearPairingTimer(id);
        }

        console.log(
            `[WhatsApp] ${id}: connected`
        );

        return;
    }


    /* -----------------------------------------------------
     * CLOSED
     * ----------------------------------------------------- */

    if (connection === 'close') {
        session.connected =
            false;

        session.status =
            'disconnected';

        session.lastDisconnectAt =
            Date.now();

        const error =
            lastDisconnect?.error;

        session.lastError =
            error || null;

        const statusCode =
            getDisconnectStatusCode(
                lastDisconnect
            );

        console.log(
            `[WhatsApp] ${id}: connection closed. Code: ${statusCode}`
        );

        /*
         * If the user explicitly stopped the session,
         * NEVER reconnect.
         */

        if (
            session.stopping ||
            session.reconnectEnabled === false
        ) {
            console.log(
                `[WhatsApp] ${id}: reconnect disabled`
            );

            delete global.sessions[id];

            return;
        }


        /*
         * Logged out.
         *
         * This means WhatsApp authentication is no longer
         * valid. Automatic reconnecting is pointless.
         */

        if (
            statusCode ===
            DisconnectReason.loggedOut
        ) {
            console.log(
                `[WhatsApp] ${id}: logged out`
            );

            session.reconnectEnabled =
                false;

            clearReconnectTimer(id);

            delete global.sessions[id];

            const pairingState =
                global.pairingStates[id];

            if (pairingState) {
                clearPairingTimer(id);
                delete global.pairingStates[id];
            }

            /*
             * Remove auth so next /pair starts fresh.
             */

            removeDirectory(
                getSessionDirectory(id)
            );

            return;
        }


        /*
         * Bad session.
         *
         * Delete broken auth and force fresh pairing
         * next time.
         */

        if (
            statusCode ===
            DisconnectReason.badSession
        ) {
            console.log(
                `[WhatsApp] ${id}: bad session`
            );

            session.reconnectEnabled =
                false;

            clearReconnectTimer(id);

            removeDirectory(
                getSessionDirectory(id)
            );

            delete global.sessions[id];

            return;
        }


        /*
         * Restart required.
         */

        if (
            statusCode ===
            DisconnectReason.restartRequired
        ) {
            console.log(
                `[WhatsApp] ${id}: restart required`
            );

            scheduleReconnect(id);

            return;
        }


        /*
         * Temporary network/server disconnect.
         */

        scheduleReconnect(id);

        return;
    }
}


/* =========================================================
 * DISCONNECT STATUS
 * ========================================================= */

function getDisconnectStatusCode(
    lastDisconnect
) {
    try {
        return (
            lastDisconnect
                ?.error
                ?.output
                ?.statusCode
        );
    } catch (_) {
        return undefined;
    }
}


/* =========================================================
 * RECONNECT
 * ========================================================= */

function scheduleReconnect(userId) {
    const id = String(userId);

    const session =
        global.sessions[id];

    if (!session) {
        return;
    }

    if (
        session.stopping ||
        session.reconnectEnabled === false
    ) {
        return;
    }

    /*
     * Don't schedule multiple reconnects.
     */

    if (global.waReconnectTimers[id]) {
        return;
    }

    session.reconnectAttempts =
        (session.reconnectAttempts || 0) + 1;

    const attempt =
        session.reconnectAttempts;

    /*
     * Exponential backoff with a reasonable maximum.
     */

    const delay =
        Math.min(
            RECONNECT_DELAY * attempt,
            30000
        );

    console.log(
        `[WhatsApp] ${id}: reconnecting in ${delay}ms`
    );

    global.waReconnectTimers[id] =
        setTimeout(
            async () => {
                delete global.waReconnectTimers[id];

                const current =
                    global.sessions[id];

                if (
                    !current ||
                    current.stopping ||
                    current.reconnectEnabled === false
                ) {
                    return;
                }

                try {
                    await reconnectWhatsAppSession(
                        id
                    );
                } catch (error) {
                    console.error(
                        `[WhatsApp] ${id}: reconnect failed:`,
                        error.message
                    );

                    scheduleReconnect(id);
                }
            },
            delay
        );
}


/* =========================================================
 * RECONNECT EXISTING SESSION
 * ========================================================= */

async function reconnectWhatsAppSession(
    userId
) {
    const id = String(userId);

    const oldSession =
        global.sessions[id];

    if (!oldSession) {
        return null;
    }

    if (
        oldSession.stopping ||
        oldSession.reconnectEnabled === false
    ) {
        return null;
    }

    const phoneNumber =
        oldSession.phoneNumber;

    /*
     * Save reconnect counter before destroying old
     * global state.
     */

    const reconnectAttempts =
        oldSession.reconnectAttempts || 0;

    await closeSocket(
        oldSession.socket
    );

    delete global.sessions[id];

    /*
     * Recreate socket without deleting auth.
     */

    if (!acquireConnectionLock(id)) {
        return null;
    }

    try {
        const sessionDir =
            getSessionDirectory(id);

        if (
            !fs.existsSync(sessionDir)
        ) {
            throw new Error(
                'WhatsApp authentication directory does not exist.'
            );
        }

        const {
            state,
            saveCreds
        } = await useMultiFileAuthState(
            sessionDir
        );

        let version;

        try {
            const latest =
                await fetchLatestBaileysVersion();

            version =
                latest.version;
        } catch (_) {}

        const socketOptions = {
            auth: {
                creds: state.creds,
                keys: makeCacheableSignalKeyStore(
                    state.keys,
                    logger
                )
            },

            logger,

            printQRInTerminal: false,

            browser: Browsers.ubuntu(
                'Chrome'
            ),

            markOnlineOnConnect: false,

            syncFullHistory: false
        };

        if (version) {
            socketOptions.version =
                version;
        }

        const socket =
            makeWASocket(
                socketOptions
            );

        global.sessions[id] = {
            userId: id,

            socket,

            phoneNumber,

            status: 'connecting',

            connected: false,

            reconnectEnabled: true,

            stopping: false,

            createdAt: Date.now(),

            lastConnectedAt: null,

            lastDisconnectAt: null,

            lastError: null,

            reconnectAttempts
        };

        socket.ev.on(
            'creds.update',
            saveCreds
        );

        socket.ev.on(
            'connection.update',
            async (update) => {
                await handleConnectionUpdate(
                    id,
                    update
                );
            }
        );

        socket.ev.on(
            'messages.upsert',
            async (messageUpdate) => {
                try {
                    await handleIncomingMessages(
                        id,
                        messageUpdate
                    );
                } catch (error) {
                    console.error(
                        `[WhatsApp] Message handler error for ${id}:`,
                        error.message
                    );
                }
            }
        );

        return socket;

    } finally {
        releaseConnectionLock(id);
    }
}


/* =========================================================
 * INCOMING MESSAGES
 * ========================================================= */

async function handleIncomingMessages(
    userId,
    messageUpdate
) {
    const id = String(userId);

    if (!messageUpdate) {
        return;
    }

    const messages =
        messageUpdate.messages || [];

    for (const message of messages) {
        try {
            if (!message) {
                continue;
            }

            /*
             * Ignore messages sent by this WhatsApp account.
             */

            if (
                message.key &&
                message.key.fromMe
            ) {
                continue;
            }

            /*
             * Ignore protocol/status messages.
             */

            const remoteJid =
                message.key?.remoteJid;

            if (!remoteJid) {
                continue;
            }

            if (
                remoteJid ===
                'status@broadcast'
            ) {
                continue;
            }

            /*
             * Pass the message to your bot layer.
             *
             * We deliberately keep this generic so this
             * file does not become coupled to a specific
             * command-handler filename.
             */

            await dispatchWhatsAppMessage(
                id,
                message
            );

        } catch (error) {
            console.error(
                `[WhatsApp] Failed processing message for ${id}:`,
                error.message
            );
        }
    }
}


/* =========================================================
 * MESSAGE DISPATCHER
 * ========================================================= */

async function dispatchWhatsAppMessage(
    userId,
    message
) {
    /*
     * This function intentionally checks several possible
     * handler locations so the WhatsApp core doesn't break
     * merely because your project uses a different handler
     * filename.
     */

    const possibleHandlers = [
        path.join(
            __dirname,
            'whatsapp-handler.js'
        ),

        path.join(
            __dirname,
            'whatsappHandler.js'
        ),

        path.join(
            __dirname,
            'messageHandler.js'
        ),

        path.join(
            process.cwd(),
            'whatsapp-handler.js'
        )
    ];

    for (
        const handlerPath
        of possibleHandlers
    ) {
        if (
            !fs.existsSync(handlerPath)
        ) {
            continue;
        }

        try {
            const handler =
                require(handlerPath);

            if (
                typeof handler ===
                'function'
            ) {
                await enqueueCommand(
                    userId,
                    async () => {
                        await handler(
                            message,
                            {
                                userId,
                                socket:
                                    getWhatsAppSession(
                                        userId
                                    )?.socket
                            }
                        );
                    }
                );

                return;
            }
        } catch (error) {
            console.error(
                `[WhatsApp] Handler error:`,
                error.message
            );

            return;
        }
    }

    /*
     * No handler file found.
     *
     * This is not treated as a fatal WhatsApp error.
     */

    return;
}


/* =========================================================
 * COMMAND QUEUE
 * ========================================================= */

function enqueueCommand(
    userId,
    task
) {
    const id = String(userId);

    if (
        !global.waCommandQueues[id]
    ) {
        global.waCommandQueues[id] =
            Promise.resolve();
    }

    const queue =
        global.waCommandQueues[id]
            .catch(() => {})
            .then(task);

    global.waCommandQueues[id] =
        queue.catch(() => {});

    return queue;
}


/* =========================================================
 * SEND MESSAGE
 * ========================================================= */

async function sendMessage(
    userId,
    jid,
    content
) {
    const session =
        getWhatsAppSession(
            userId
        );

    if (!session) {
        throw new Error(
            'WhatsApp session not found.'
        );
    }

    if (
        !session.socket
    ) {
        throw new Error(
            'WhatsApp socket not available.'
        );
    }

    if (
        !session.connected
    ) {
        throw new Error(
            'WhatsApp is not connected.'
        );
    }

    if (!jid) {
        throw new Error(
            'WhatsApp JID is required.'
        );
    }

    if (!content) {
        throw new Error(
            'Message content is required.'
        );
    }

    return session.socket.sendMessage(
        jid,
        content
    );
}


/* =========================================================
 * SEND TEXT
 * ========================================================= */

async function sendText(
    userId,
    jid,
    text
) {
    if (!text) {
        throw new Error(
            'Text message cannot be empty.'
        );
    }

    return sendMessage(
        userId,
        jid,
        {
            text: String(text)
        }
    );
}


/* =========================================================
 * SEND REPLY
 * ========================================================= */

async function sendReply(
    userId,
    message,
    text
) {
    const jid =
        message?.key?.remoteJid;

    if (!jid) {
        throw new Error(
            'Unable to determine reply JID.'
        );
    }

    return sendText(
        userId,
        jid,
        text
    );
}


/* =========================================================
 * GET STATUS
 * ========================================================= */

function getWhatsAppStatus(
    userId
) {
    const id = String(userId);

    const session =
        global.sessions[id];

    const pairing =
        global.pairingStates[id];

    if (!session) {
        return {
            exists: false,

            connected: false,

            status: 'offline',

            phoneNumber: null,

            pairing: !!pairing
        };
    }

    return {
        exists: true,

        connected:
            session.connected === true,

        status:
            session.status || 'unknown',

        phoneNumber:
            session.phoneNumber || null,

        pairing:
            !!(
                pairing &&
                pairing.active
            ),

        pairingCode:
            pairing?.pairingCode || null,

        reconnectEnabled:
            session.reconnectEnabled !== false,

        reconnectAttempts:
            session.reconnectAttempts || 0,

        createdAt:
            session.createdAt || null,

        lastConnectedAt:
            session.lastConnectedAt || null,

        lastDisconnectAt:
            session.lastDisconnectAt || null
    };
}


/* =========================================================
 * GET PAIRING CODE
 * ========================================================= */

function getPairingCode(
    userId
) {
    const state =
        global.pairingStates[
            String(userId)
        ];

    if (!state) {
        return null;
    }

    return state.pairingCode || null;
}


/* =========================================================
 * CANCEL PAIRING
 * ========================================================= */

async function cancelPairing(
    userId
) {
    const id = String(userId);

    const pairing =
        global.pairingStates[id];

    if (pairing) {
        pairing.cancelled =
            true;

        pairing.active =
            false;

        clearPairingTimer(id);
    }

    await stopWhatsAppSession(
        id,
        {
            deleteAuth: true,
            disableReconnect: true,
            clearPairing: true
        }
    );

    return true;
}


/* =========================================================
 * RESTORE EXISTING SESSIONS
 * ========================================================= */

async function restoreSessions() {
    ensureSessionDirectory();

    let entries = [];

    try {
        entries =
            fs.readdirSync(
                BASE_SESSION_DIR,
                {
                    withFileTypes: true
                }
            );
    } catch (error) {
        console.error(
            '[WhatsApp] Failed reading sessions:',
            error.message
        );

        return;
    }

    for (const entry of entries) {
        if (
            !entry.isDirectory()
        ) {
            continue;
        }

        if (
            !entry.name.startsWith(
                'wa_'
            )
        ) {
            continue;
        }

        const userId =
            entry.name.substring(3);

        if (!userId) {
            continue;
        }

        try {
            console.log(
                `[WhatsApp] Restoring session ${userId}`
            );

            await restoreWhatsAppSession(
                userId
            );

            /*
             * Don't hammer WhatsApp with many connections
             * simultaneously.
             */

            await sleep(1000);

        } catch (error) {
            console.error(
                `[WhatsApp] Failed restoring ${userId}:`,
                error.message
            );
        }
    }
}


/* =========================================================
 * RESTORE ONE SESSION
 * ========================================================= */

async function restoreWhatsAppSession(
    userId
) {
    const id = String(userId);

    if (
        global.sessions[id]
    ) {
        return global.sessions[id].socket;
    }

    const sessionDir =
        getSessionDirectory(id);

    if (
        !fs.existsSync(sessionDir)
    ) {
        return null;
    }

    const {
        state,
        saveCreds
    } = await useMultiFileAuthState(
        sessionDir
    );

    /*
     * Do not restore incomplete pairing data.
     */

    if (
        !state.creds.registered
    ) {
        console.log(
            `[WhatsApp] ${id}: auth not registered, skipping restore`
        );

        return null;
    }

    let version;

    try {
        const latest =
            await fetchLatestBaileysVersion();

        version =
            latest.version;
    } catch (_) {}

    const socketOptions = {
        auth: {
            creds: state.creds,

            keys: makeCacheableSignalKeyStore(
                state.keys,
                logger
            )
        },

        logger,

        printQRInTerminal: false,

        browser: Browsers.ubuntu(
            'Chrome'
        ),

        markOnlineOnConnect: false,

        syncFullHistory: false
    };

    if (version) {
        socketOptions.version =
            version;
    }

    const socket =
        makeWASocket(
            socketOptions
        );

    global.sessions[id] = {
        userId: id,

        socket,

        phoneNumber:
            state.creds.me?.id
                ?.split(':')[0]
                ?.replace(/\D/g, '') ||
            null,

        status: 'connecting',

        connected: false,

        reconnectEnabled: true,

        stopping: false,

        createdAt: Date.now(),

        lastConnectedAt: null,

        lastDisconnectAt: null,

        lastError: null,

        reconnectAttempts: 0
    };

    socket.ev.on(
        'creds.update',
        saveCreds
    );

    socket.ev.on(
        'connection.update',
        async (update) => {
            await handleConnectionUpdate(
                id,
                update
            );
        }
    );

    socket.ev.on(
        'messages.upsert',
        async (messageUpdate) => {
            try {
                await handleIncomingMessages(
                    id,
                    messageUpdate
                );
            } catch (error) {
                console.error(
                    `[WhatsApp] Restore message error for ${id}:`,
                    error.message
                );
            }
        }
    );

    return socket;
}


/* =========================================================
 * STOP ALL SESSIONS
 * ========================================================= */

async function stopAllWhatsAppSessions(
    options = {}
) {
    const {
        deleteAuth = false
    } = options;

    const ids =
        Object.keys(
            global.sessions
        );

    for (const id of ids) {
        try {
            await stopWhatsAppSession(
                id,
                {
                    deleteAuth,
                    disableReconnect: true,
                    clearPairing: true
                }
            );
        } catch (error) {
            console.error(
                `[WhatsApp] Failed stopping ${id}:`,
                error.message
            );
        }
    }
}


/* =========================================================
 * SESSION SUMMARY
 * ========================================================= */

function getAllWhatsAppSessions() {
    return Object.keys(
        global.sessions
    ).map((userId) => {
        return getWhatsAppStatus(
            userId
        );
    });
}


/* =========================================================
 * CLEAN SHUTDOWN
 * ========================================================= */

async function shutdownWhatsApp() {
    console.log(
        '[WhatsApp] Shutting down all sessions...'
    );

    await stopAllWhatsAppSessions({
        deleteAuth: false
    });

    console.log(
        '[WhatsApp] Shutdown complete.'
    );
}


/* =========================================================
 * PROCESS EVENTS
 * ========================================================= */

let shutdownStarted = false;

async function handleProcessShutdown(
    signal
) {
    if (shutdownStarted) {
        return;
    }

    shutdownStarted = true;

    console.log(
        `[WhatsApp] Received ${signal}`
    );

    try {
        await shutdownWhatsApp();
    } catch (error) {
        console.error(
            '[WhatsApp] Shutdown error:',
            error.message
        );
    }
}


/*
 * Do not register duplicate listeners if this module
 * gets required from multiple files.
 */

if (
    !global.__SOLVAX_WHATSAPP_SHUTDOWN_HOOK__
) {
    global.__SOLVAX_WHATSAPP_SHUTDOWN_HOOK__ =
        true;

    process.once(
        'SIGINT',
        () => {
            handleProcessShutdown(
                'SIGINT'
            );
        }
    );

    process.once(
        'SIGTERM',
        () => {
            handleProcessShutdown(
                'SIGTERM'
            );
        }
    );
}


/* =========================================================
 * EXPORTS
 * ========================================================= */

module.exports = {

    // Main session functions
    createWhatsAppSession,
    reconnectWhatsAppSession,
    restoreWhatsAppSession,

    // Pairing
    prepareFreshPairing,
    cancelPairing,
    getPairingCode,
    getPairingState,
    isPairing,

    // Session control
    stopWhatsAppSession,
    completelyResetUser,
    stopAllWhatsAppSessions,

    // Session information
    getWhatsAppSession,
    hasWhatsAppSession,
    getWhatsAppStatus,
    getAllWhatsAppSessions,

    // Messaging
    sendMessage,
    sendText,
    sendReply,

    // Utilities
    normalizePhoneNumber,
    formatPairingCode,

    // Startup/shutdown
    restoreSessions,
    shutdownWhatsApp
};
