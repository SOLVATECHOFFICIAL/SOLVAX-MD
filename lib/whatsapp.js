'use strict';

/*
 * ============================================================
 * SOLVAX MD
 * lib/whatsapp.js
 * ============================================================
 *
 * CENTRAL WHATSAPP SESSION MANAGER
 *
 * Baileys:
 *     @whiskeysockets/baileys 6.7.24
 *
 * Node:
 *     >= 20
 *
 * RESPONSIBILITIES
 * ------------------------------------------------------------
 * 1. Create WhatsApp sockets
 * 2. Generate pairing codes
 * 3. Save authentication credentials
 * 4. Restore authenticated sessions
 * 5. Handle connection events
 * 6. Reconnect temporary disconnects
 * 7. Stop sessions
 * 8. Reset sessions
 * 9. Prevent duplicate sockets
 * 10. Receive WhatsApp messages
 * 11. Dispatch WhatsApp commands
 * 12. Send WhatsApp messages
 * 13. Expose session status
 *
 * IMPORTANT
 * ------------------------------------------------------------
 * This is the ONLY file that creates a Baileys socket.
 *
 * /pair must NOT call makeWASocket().
 *
 * /pair should call:
 *
 * createWhatsAppSession(
 *     userId,
 *     phoneNumber,
 *     { fresh: true }
 * );
 *
 * ============================================================
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
    cleanNumber,
    getText,
    jidNumber,
    isGroupJid
} = require('./helpers');

const {
    getGroup
} = require('./database');

const {
    enqueueCommand,
    clearQueue
} = require('./queue');


/* ============================================================
 * CONFIGURATION
 * ============================================================
 */

const BASE_SESSION_DIR =
    path.resolve(
        process.env.WA_SESSION_DIR ||
        path.join(
            process.cwd(),
            'sessions'
        )
    );

const PAIR_TIMEOUT =
    5 * 60 * 1000;

const RECONNECT_DELAY =
    5000;

const MAX_RECONNECT_DELAY =
    30000;

const CONNECTION_LOCK_TIMEOUT =
    30 * 1000;

const PAIRING_INITIAL_DELAY =
    2000;


/* ============================================================
 * GLOBAL STATE
 * ============================================================
 */

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


/*
 * Command handler holder.
 *
 * Your command/index file can register the WhatsApp command
 * handler through:
 *
 * setWhatsAppCommandHandler(handler)
 *
 * We ALSO support the older:
 *
 * global.handleWhatsAppCommand
 *
 * so existing code does not break.
 */
if (!global.waCommandHandler) {
    global.waCommandHandler = null;
}


/* ============================================================
 * LOGGER
 * ============================================================
 */

const logger =
    P({
        level:
            process.env.WA_LOG_LEVEL ||
            'silent'
    });


/* ============================================================
 * COMMAND HANDLER REGISTRATION
 * ============================================================
 */

function setWhatsAppCommandHandler(
    handler
) {
    if (
        typeof handler !== 'function'
    ) {
        throw new TypeError(
            'WhatsApp command handler must be a function.'
        );
    }

    global.waCommandHandler =
        handler;

    /*
     * Compatibility with older projects.
     */
    global.handleWhatsAppCommand =
        handler;

    console.log(
        '[WhatsApp] Command handler registered.'
    );

    return true;
}


function getWhatsAppCommandHandler() {
    if (
        typeof global.waCommandHandler ===
        'function'
    ) {
        return global.waCommandHandler;
    }

    if (
        typeof global.handleWhatsAppCommand ===
        'function'
    ) {
        return global.handleWhatsAppCommand;
    }

    return null;
}


/* ============================================================
 * DIRECTORY HELPERS
 * ============================================================
 */

function ensureSessionDirectory() {
    if (
        !fs.existsSync(
            BASE_SESSION_DIR
        )
    ) {
        fs.mkdirSync(
            BASE_SESSION_DIR,
            {
                recursive: true
            }
        );
    }
}


function getSessionDirectory(
    userId
) {
    ensureSessionDirectory();

    return path.join(
        BASE_SESSION_DIR,
        `wa_${String(userId)}`
    );
}


function sessionDirectoryExists(
    userId
) {
    return fs.existsSync(
        getSessionDirectory(userId)
    );
}


/* ============================================================
 * SAFE DIRECTORY REMOVAL
 * ============================================================
 */

function removeDirectory(
    directory
) {
    try {

        if (!directory) {
            return;
        }

        if (
            !fs.existsSync(
                directory
            )
        ) {
            return;
        }

        fs.rmSync(
            directory,
            {
                recursive: true,
                force: true
            }
        );

        console.log(
            `[WhatsApp] Removed directory: ${directory}`
        );

    } catch (error) {

        console.error(
            '[WhatsApp] Failed to remove directory:',
            error
        );
    }
}


/* ============================================================
 * PHONE NUMBER NORMALIZATION
 * ============================================================
 */

function normalizePhoneNumber(
    number
) {
    if (
        number === undefined ||
        number === null
    ) {
        return null;
    }

    try {

        let cleaned =
            cleanNumber(
                String(number)
            );

        cleaned =
            cleaned.replace(
                /\D/g,
                ''
            );

        if (!cleaned) {
            return null;
        }

        return cleaned;

    } catch (error) {

        const fallback =
            String(number)
                .replace(
                    /\D/g,
                    ''
                );

        return fallback || null;
    }
}


/* ============================================================
 * SESSION LOOKUP
 * ============================================================
 */

function getWhatsAppSession(
    userId
) {
    return (
        global.sessions[
            String(userId)
        ] || null
    );
}


function hasWhatsAppSession(
    userId
) {
    return Boolean(
        getWhatsAppSession(userId)
    );
}


/* ============================================================
 * PAIRING STATE
 * ============================================================
 */

function getPairingState(
    userId
) {
    return (
        global.pairingStates[
            String(userId)
        ] || null
    );
}


function isPairing(
    userId
) {
    const state =
        getPairingState(userId);

    return Boolean(
        state &&
        state.active === true
    );
}


/* ============================================================
 * CREATE PAIRING STATE
 * ============================================================
 */

function createPairingState(
    userId,
    phoneNumber
) {
    const id =
        String(userId);

    const now =
        Date.now();

    const state = {

        active:
            true,

        userId:
            id,

        phoneNumber:
            phoneNumber,

        pairingCode:
            null,

        startedAt:
            now,

        expiresAt:
            now + PAIR_TIMEOUT,

        cancelled:
            false,

        completed:
            false,

        socket:
            null,

        timeout:
            null,

        /*
         * Optional metadata used by the command layer.
         * For example, Telegram can store its chat ID here.
         */
        chatId:
            null
    };

    global.pairingStates[id] =
        state;

    return state;
}


/* ============================================================
 * CLEAR PAIRING TIMER
 * ============================================================
 */

function clearPairingTimer(
    userId
) {
    const id =
        String(userId);

    const state =
        global.pairingStates[id];

    if (!state) {
        return;
    }

    if (state.timeout) {

        clearTimeout(
            state.timeout
        );

        state.timeout =
            null;
    }
}


/* ============================================================
 * START PAIRING TIMER
 * ============================================================
 */

function startPairingTimer(
    userId
) {
    const id =
        String(userId);

    const state =
        global.pairingStates[id];

    if (!state) {
        return;
    }

    clearPairingTimer(id);

    state.timeout =
        setTimeout(
            async () => {

                const currentPairing =
                    global.pairingStates[id];

                if (
                    !currentPairing ||
                    !currentPairing.active
                ) {
                    return;
                }

                console.log(
                    `[WhatsApp] Pairing expired for ${id}`
                );

                currentPairing.active =
                    false;

                currentPairing.cancelled =
                    true;

                try {

                    await stopWhatsAppSession(
                        id,
                        {
                            deleteAuth:
                                true,

                            disableReconnect:
                                true,

                            clearPairing:
                                true
                        }
                    );

                } catch (error) {

                    console.error(
                        `[WhatsApp] Failed cleaning expired pairing ${id}:`,
                        error
                    );
                }

            },
            PAIR_TIMEOUT
        );
}


/* ============================================================
 * CLEAR RECONNECT TIMER
 * ============================================================
 */

function clearReconnectTimer(
    userId
) {
    const id =
        String(userId);

    const timer =
        global.waReconnectTimers[id];

    if (timer) {

        clearTimeout(timer);

        delete global.waReconnectTimers[id];
    }
}


/* ============================================================
 * CONNECTION LOCK
 * ============================================================
 */

function acquireConnectionLock(
    userId
) {
    const id =
        String(userId);

    const existing =
        global.waConnectionLocks[id];

    if (existing) {

        if (
            Date.now() -
            existing <
            CONNECTION_LOCK_TIMEOUT
        ) {
            return false;
        }

        delete global.waConnectionLocks[id];
    }

    global.waConnectionLocks[id] =
        Date.now();

    return true;
}


function releaseConnectionLock(
    userId
) {
    delete global.waConnectionLocks[
        String(userId)
    ];
}


/* ============================================================
 * CLOSE SOCKET
 * ============================================================
 */

async function closeSocket(
    socket
) {
    if (!socket) {
        return;
    }

    try {

        if (
            socket.ws &&
            typeof socket.ws.close ===
                'function'
        ) {

            try {
                socket.ws.close();
            } catch (_) {}

        }

    } catch (error) {

        console.error(
            '[WhatsApp] Socket close error:',
            error
        );
    }
}


/* ============================================================
 * BUILD SOCKET OPTIONS
 * ============================================================
 */

async function buildSocketOptions(
    state
) {
    let version =
        null;

    try {

        const latest =
            await fetchLatestBaileysVersion();

        if (
            latest &&
            Array.isArray(
                latest.version
            )
        ) {
            version =
                latest.version;
        }

    } catch (error) {

        console.log(
            '[WhatsApp] Could not fetch latest Baileys version.'
        );

        console.log(
            `[WhatsApp] Version fetch reason: ${error?.message || error}`
        );
    }

    const socketOptions = {

        auth: {

            creds:
                state.creds,

            keys:
                makeCacheableSignalKeyStore(
                    state.keys,
                    logger
                )
        },

        logger,

        printQRInTerminal:
            false,

        browser:
            Browsers.ubuntu(
                'Chrome'
            ),

        markOnlineOnConnect:
            false,

        syncFullHistory:
            false,

        generateHighQualityLinkPreview:
            false
    };

    if (version) {
        socketOptions.version =
            version;
    }

    return socketOptions;
}


/* ============================================================
 * CREATE SESSION OBJECT
 * ============================================================
 */

function createSessionObject(
    userId,
    socket,
    phoneNumber,
    reconnectAttempts = 0
) {
    const id =
        String(userId);

    return {

        userId:
            id,

        socket:
            socket,

        phoneNumber:
            phoneNumber,

        status:
            'connecting',

        connected:
            false,

        reconnectEnabled:
            true,

        stopping:
            false,

        createdAt:
            Date.now(),

        lastConnectedAt:
            null,

        lastDisconnectAt:
            null,

        lastError:
            null,

        reconnectAttempts:
            reconnectAttempts,

        pairingCode:
            null
    };
}


/* ============================================================
 * ATTACH SOCKET EVENTS
 * ============================================================
 *
 * IMPORTANT:
 *
 * Every event handler remembers the exact socket it belongs to.
 *
 * This prevents an OLD socket's delayed "close" event from
 * accidentally disconnecting a NEW socket for the same user.
 * ============================================================
 */

function attachSocketEvents(
    userId,
    socket,
    saveCreds
) {
    const id =
        String(userId);

    socket.ev.on(
        'creds.update',
        async (creds) => {

            try {

                await saveCreds(
                    creds
                );

            } catch (error) {

                console.error(
                    `[WhatsApp] Failed saving credentials for ${id}:`,
                    error?.stack ||
                    error
                );
            }
        }
    );


    socket.ev.on(
        'connection.update',
        async (update) => {

            try {

                await handleConnectionUpdate(
                    id,
                    socket,
                    update
                );

            } catch (error) {

                console.error(
                    `[WhatsApp] Connection handler error for ${id}:`,
                    error?.stack ||
                    error
                );
            }
        }
    );


    socket.ev.on(
        'messages.upsert',
        async (messageUpdate) => {

            try {

                await handleIncomingMessages(
                    id,
                    socket,
                    messageUpdate
                );

            } catch (error) {

                console.error(
                    `[WhatsApp] Message handler error for ${id}:`,
                    error?.stack ||
                    error
                );
            }
        }
    );
}


/* ============================================================
 * STOP WHATSAPP SESSION
 * ============================================================
 */

async function stopWhatsAppSession(
    userId,
    options = {}
) {
    const id =
        String(userId);

    const {
        deleteAuth = false,
        disableReconnect = true,
        clearPairing = true
    } = options;

    console.log(
        `[WhatsApp] Stopping session for ${id}`
    );

    if (disableReconnect) {
        clearReconnectTimer(id);
    }

    const session =
        global.sessions[id];

    if (session) {

        session.stopping =
            true;

        session.reconnectEnabled =
            false;

        session.status =
            'stopping';

        try {

            await closeSocket(
                session.socket
            );

        } catch (error) {

            console.error(
                `[WhatsApp] Error closing ${id}:`,
                error
            );
        }
    }

    /*
     * Remove the session immediately.
     *
     * Any late event from the old socket will now be ignored.
     */
    delete global.sessions[id];

    if (clearPairing) {

        const pairing =
            global.pairingStates[id];

        if (pairing) {

            pairing.cancelled =
                true;

            pairing.active =
                false;

            clearPairingTimer(id);
        }

        delete global.pairingStates[id];
    }

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


/* ============================================================
 * COMPLETE USER RESET
 * ============================================================
 */

async function completelyResetUser(
    userId
) {
    const id =
        String(userId);

    console.log(
        `[WhatsApp] Completely resetting ${id}`
    );

    await stopWhatsAppSession(
        id,
        {
            deleteAuth:
                true,

            disableReconnect:
                true,

            clearPairing:
                true
        }
    );

    clearReconnectTimer(id);

    delete global.waConnectionLocks[id];

    try {

        clearQueue(id);

    } catch (error) {

        console.error(
            `[WhatsApp] Failed clearing command queue for ${id}:`,
            error?.message ||
            error
        );
    }

    delete global.sessions[id];

    delete global.pairingStates[id];

    removeDirectory(
        getSessionDirectory(id)
    );

    console.log(
        `[WhatsApp] Complete reset finished for ${id}`
    );

    return true;
}


/* ============================================================
 * PREPARE FRESH PAIRING
 * ============================================================
 */

async function prepareFreshPairing(
    userId,
    phoneNumber
) {
    const id =
        String(userId);

    const number =
        normalizePhoneNumber(
            phoneNumber
        );

    if (!number) {
        throw new Error(
            'Invalid WhatsApp phone number.'
        );
    }

    await completelyResetUser(
        id
    );

    const sessionDir =
        getSessionDirectory(id);

    fs.mkdirSync(
        sessionDir,
        {
            recursive:
                true
        }
    );

    return {
        userId:
            id,

        phoneNumber:
            number,

        sessionDir:
            sessionDir
    };
}


/* ============================================================
 * CREATE WHATSAPP SESSION
 * ============================================================
 */

async function createWhatsAppSession(
    userId,
    phoneNumber,
    options = {}
) {
    const id =
        String(userId);

    const number =
        normalizePhoneNumber(
            phoneNumber
        );

    if (!number) {

        throw new Error(
            'A valid WhatsApp phone number is required.'
        );
    }

    if (
        !acquireConnectionLock(id)
    ) {

        throw new Error(
            'A WhatsApp connection is already being prepared.'
        );
    }

    let socket =
        null;

    try {

        /* ====================================================
         * FRESH MODE
         * ====================================================
         */

        if (
            options.fresh === true
        ) {

            console.log(
                `[WhatsApp] Fresh pairing requested for ${id}`
            );

            const oldSession =
                global.sessions[id];

            if (oldSession) {

                oldSession.stopping =
                    true;

                oldSession.reconnectEnabled =
                    false;

                await closeSocket(
                    oldSession.socket
                );

                delete global.sessions[id];
            }

            clearReconnectTimer(id);

            /*
             * Delete old authentication.
             */
            removeDirectory(
                getSessionDirectory(id)
            );

            /*
             * Recreate authentication directory.
             */
            fs.mkdirSync(
                getSessionDirectory(id),
                {
                    recursive:
                        true
                }
            );

        } else {

            /*
             * NORMAL MODE
             */

            if (
                global.sessions[id]
            ) {

                await stopWhatsAppSession(
                    id,
                    {
                        deleteAuth:
                            false,

                        disableReconnect:
                            true,

                        clearPairing:
                            true
                    }
                );
            }

            clearReconnectTimer(id);
        }


        /* ====================================================
         * AUTH STATE
         * ====================================================
         */

        const sessionDir =
            getSessionDirectory(id);

        fs.mkdirSync(
            sessionDir,
            {
                recursive:
                    true
            }
        );

        const {
            state,
            saveCreds
        } =
            await useMultiFileAuthState(
                sessionDir
            );


        /* ====================================================
         * PAIRING STATE
         * ====================================================
         */

        let pairingState =
            null;

        if (
            !state.creds.registered
        ) {

            pairingState =
                createPairingState(
                    id,
                    number
                );

            startPairingTimer(
                id
            );
        }


        /* ====================================================
         * BAILEYS OPTIONS
         * ====================================================
         */

        const socketOptions =
            await buildSocketOptions(
                state
            );


        /* ====================================================
         * CREATE SOCKET
         * ====================================================
         */

        console.log(
            `[WhatsApp] Creating Baileys socket for ${id}`
        );

        socket =
            makeWASocket(
                socketOptions
            );


        /* ====================================================
         * CREATE SESSION
         * ====================================================
         */

        const session =
            createSessionObject(
                id,
                socket,
                number
            );

        global.sessions[id] =
            session;

        if (pairingState) {
            pairingState.socket =
                socket;
        }


        /* ====================================================
         * EVENTS
         * ====================================================
         */

        attachSocketEvents(
            id,
            socket,
            saveCreds
        );


        /* ====================================================
         * PAIRING CODE
         * ====================================================
 */

        if (
            !state.creds.registered
        ) {

            /*
             * Give Baileys time to initialize.
             */
            await sleep(
                PAIRING_INITIAL_DELAY
            );

            const currentSession =
                global.sessions[id];

            /*
             * Make sure this is still the same socket.
             */
            if (
                !currentSession ||
                currentSession.socket !==
                    socket
            ) {

                throw new Error(
                    'WhatsApp session was replaced before pairing code generation.'
                );
            }

            if (
                currentSession.stopping
            ) {

                throw new Error(
                    'WhatsApp session was stopped before pairing code generation.'
                );
            }

            const currentPairing =
                global.pairingStates[id];

            if (
                !currentPairing ||
                currentPairing.cancelled ||
                !currentPairing.active
            ) {

                throw new Error(
                    'WhatsApp pairing was cancelled or expired.'
                );
            }

            console.log(
                `[WhatsApp] Requesting pairing code for ${number}`
            );

            const pairingCode =
                await socket.requestPairingCode(
                    number
                );

            if (!pairingCode) {

                throw new Error(
                    'WhatsApp returned an empty pairing code.'
                );
            }

            const formattedCode =
                formatPairingCode(
                    pairingCode
                );

            if (!formattedCode) {

                throw new Error(
                    'WhatsApp returned an invalid pairing code.'
                );
            }

            const latestPairing =
                global.pairingStates[id];

            if (
                latestPairing &&
                latestPairing.socket === socket
            ) {

                latestPairing.pairingCode =
                    formattedCode;

                latestPairing.active =
                    true;
            }

            const latestSession =
                global.sessions[id];

            if (
                latestSession &&
                latestSession.socket === socket
            ) {

                latestSession.pairingCode =
                    formattedCode;
            }

            console.log(
                `[WhatsApp] Pairing code generated for ${id}: ${formattedCode}`
            );

            return {

                socket:
                    socket,

                pairingCode:
                    formattedCode,

                phoneNumber:
                    number,

                userId:
                    id
            };
        }


        /* ====================================================
         * ALREADY REGISTERED
         * ====================================================
         */

        const registeredPairing =
            global.pairingStates[id];

        if (registeredPairing) {

            registeredPairing.active =
                false;

            registeredPairing.completed =
                true;

            clearPairingTimer(id);
        }

        return {

            socket:
                socket,

            pairingCode:
                null,

            phoneNumber:
                number,

            userId:
                id
        };

    } catch (error) {

        if (socket) {

            try {
                await closeSocket(
                    socket
                );
            } catch (_) {}
        }

        clearReconnectTimer(id);

        const currentSession =
            global.sessions[id];

        /*
         * Only remove the session if it still belongs to
         * the socket that failed.
         */
        if (
            currentSession &&
            currentSession.socket === socket
        ) {

            currentSession.stopping =
                true;

            currentSession.reconnectEnabled =
                false;

            delete global.sessions[id];
        }

        const pairing =
            global.pairingStates[id];

        if (
            pairing &&
            (!socket ||
                pairing.socket === socket)
        ) {

            pairing.cancelled =
                true;

            pairing.active =
                false;

            clearPairingTimer(id);

            delete global.pairingStates[id];
        }

        if (
            options.fresh === true
        ) {

            removeDirectory(
                getSessionDirectory(id)
            );
        }

        console.error(
            `[WhatsApp] createWhatsAppSession failed for ${id}:`,
            error?.stack ||
            error
        );

        throw error;

    } finally {

        releaseConnectionLock(id);
    }
}


/* ============================================================
 * FORMAT PAIRING CODE
 * ============================================================
 */

function formatPairingCode(
    code
) {
    if (!code) {
        return null;
    }

    const cleaned =
        String(code)
            .replace(
                /[^A-Z0-9]/gi,
                ''
            )
            .toUpperCase();

    if (!cleaned) {
        return null;
    }

    if (
        cleaned.length <= 4
    ) {
        return cleaned;
    }

    return (
        cleaned.slice(0, 4) +
        '-' +
        cleaned.slice(4)
    );
}


/* ============================================================
 * CONNECTION UPDATE HANDLER
 * ============================================================
 */

async function handleConnectionUpdate(
    userId,
    socket,
    update
) {
    const id =
        String(userId);

    if (!update) {
        return;
    }

    const {
        connection,
        lastDisconnect
    } = update;

    const session =
        global.sessions[id];

    /*
     * Ignore events if this socket is no longer the active
     * socket for this user.
     */
    if (
        !session ||
        session.socket !== socket
    ) {
        return;
    }

    const pairing =
        global.pairingStates[id];


    /* ========================================================
     * CONNECTING
     * ========================================================
     */

    if (
        connection ===
        'connecting'
    ) {

        session.status =
            'connecting';

        session.connected =
            false;

        console.log(
            `[WhatsApp] ${id}: connecting`
        );

        return;
    }


    /* ========================================================
     * OPEN
     * ========================================================
     */

    if (
        connection ===
        'open'
    ) {

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

        session.lastError =
            null;

        session.reconnectAttempts =
            0;

        clearReconnectTimer(id);


        /*
         * Pairing is complete.
         */
        if (
            pairing &&
            pairing.socket === socket
        ) {

            pairing.active =
                false;

            pairing.completed =
                true;

            clearPairingTimer(id);


            /*
             * Notify Telegram only if the pairing flow supplied
             * a Telegram chat ID.
             */
            const chatId =
                pairing.chatId;

            if (
                chatId &&
                global.bot?.telegram
            ) {

                try {

                    await global.bot.telegram.sendMessage(
                        chatId,
                        `✅ WhatsApp connected successfully.\n\n📱 ${session.phoneNumber || 'Unknown'}\n🟢 Your session is ready.\n\nUse .menu on WhatsApp to see commands.`
                    );

                } catch (error) {

                    console.error(
                        `[WhatsApp] Telegram connection notification failed for ${id}:`,
                        error?.message ||
                        error
                    );
                }
            }

            pairing.socket =
                socketSafe(
                    session.socket
                );
        }

        console.log(
            `[WhatsApp] ${id}: connected`
        );

        return;
    }


    /* ========================================================
     * CLOSE
     * ========================================================
     */

    if (
        connection ===
        'close'
    ) {

        /*
         * CRITICAL:
         *
         * Ignore a close event from an old socket.
         */
        const activeSession =
            global.sessions[id];

        if (
            !activeSession ||
            activeSession.socket !== socket
        ) {
            return;
        }

        session.connected =
            false;

        session.status =
            'disconnected';

        session.lastDisconnectAt =
            Date.now();

        const error =
            lastDisconnect?.error;

        session.lastError =
            error ||
            null;

        const statusCode =
            getDisconnectStatusCode(
                lastDisconnect
            );

        console.log(
            `[WhatsApp] ${id}: connection closed. Code: ${statusCode}`
        );


        /* ====================================================
         * DELIBERATE STOP
         * ====================================================
         */

        if (
            session.stopping ||
            session.reconnectEnabled ===
                false
        ) {

            console.log(
                `[WhatsApp] ${id}: reconnect disabled`
            );

            delete global.sessions[id];

            return;
        }


        /* ====================================================
         * LOGGED OUT
         * ====================================================
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

            removeDirectory(
                getSessionDirectory(id)
            );

            return;
        }


        /* ====================================================
         * BAD SESSION
         * ====================================================
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

            const pairingState =
                global.pairingStates[id];

            if (pairingState) {
                clearPairingTimer(id);
                delete global.pairingStates[id];
            }

            return;
        }


        /* ====================================================
         * RESTART REQUIRED
         * ====================================================
         */

        if (
            statusCode ===
            DisconnectReason.restartRequired
        ) {

            console.log(
                `[WhatsApp] ${id}: restart required`
            );

            scheduleReconnect(
                id
            );

            return;
        }


        /* ====================================================
         * TEMPORARY DISCONNECT
         * ====================================================
         */

        scheduleReconnect(
            id
        );

        return;
    }
}


/* ============================================================
 * SOCKET SAFE REFERENCE
 * ============================================================
 */

function socketSafe(
    socket
) {
    return socket || null;
}


/* ============================================================
 * GET DISCONNECT STATUS CODE
 * ============================================================
 */

function getDisconnectStatusCode(
    lastDisconnect
) {
    try {

        return (
            lastDisconnect?.error?.output?.statusCode ??
            lastDisconnect?.error?.statusCode ??
            lastDisconnect?.error?.data?.statusCode ??
            null
        );

    } catch (_) {

        return null;
    }
}


/* ============================================================
 * RECONNECT SCHEDULER
 * ============================================================
 */

function scheduleReconnect(
    userId
) {
    const id =
        String(userId);

    const session =
        global.sessions[id];

    if (!session) {
        return;
    }

    if (
        session.stopping ||
        session.reconnectEnabled ===
            false
    ) {
        return;
    }

    if (
        global.waReconnectTimers[id]
    ) {
        return;
    }

    session.reconnectAttempts =
        (
            session.reconnectAttempts ||
            0
        ) + 1;

    const attempt =
        session.reconnectAttempts;

    const delay =
        Math.min(
            RECONNECT_DELAY *
                attempt,
            MAX_RECONNECT_DELAY
        );

    session.status =
        'reconnecting';

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
                    current.reconnectEnabled ===
                        false
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
                        error?.message ||
                        error
                    );

                    const stillActive =
                        global.sessions[id];

                    if (
                        stillActive &&
                        !stillActive.stopping &&
                        stillActive.reconnectEnabled !==
                            false
                    ) {

                        scheduleReconnect(
                            id
                        );
                    }
                }

            },
            delay
        );
}


/* ============================================================
 * RECONNECT EXISTING SESSION
 * ============================================================
 */

async function reconnectWhatsAppSession(
    userId
) {
    const id =
        String(userId);

    const oldSession =
        global.sessions[id];

    if (!oldSession) {
        return null;
    }

    if (
        oldSession.stopping ||
        oldSession.reconnectEnabled ===
            false
    ) {
        return null;
    }

    const phoneNumber =
        oldSession.phoneNumber;

    const reconnectAttempts =
        oldSession.reconnectAttempts ||
        0;

    if (
        !acquireConnectionLock(id)
    ) {

        throw new Error(
            'A WhatsApp connection is already being prepared.'
        );
    }

    let socket =
        null;

    try {

        /*
         * Close the old socket first.
         */
        await closeSocket(
            oldSession.socket
        );

        /*
         * Remove it from active sessions.
         *
         * Its late events will be ignored because its socket
         * will no longer match the new active socket.
         */
        delete global.sessions[id];


        /* ====================================================
         * AUTH DIRECTORY
         * ====================================================
         */

        const sessionDir =
            getSessionDirectory(id);

        if (
            !fs.existsSync(
                sessionDir
            )
        ) {

            throw new Error(
                'WhatsApp authentication directory does not exist.'
            );
        }


        /* ====================================================
         * AUTH STATE
         * ====================================================
         */

        const {
            state,
            saveCreds
        } =
            await useMultiFileAuthState(
                sessionDir
            );


        if (
            !state.creds.registered
        ) {

            throw new Error(
                'WhatsApp authentication is no longer registered.'
            );
        }


        /* ====================================================
         * SOCKET OPTIONS
         * ====================================================
         */

        const socketOptions =
            await buildSocketOptions(
                state
            );


        /* ====================================================
         * CREATE NEW SOCKET
         * ====================================================
         */

        console.log(
            `[WhatsApp] Recreating socket for ${id}`
        );

        socket =
            makeWASocket(
                socketOptions
            );


        /* ====================================================
         * CREATE NEW SESSION
         * ====================================================
         */

        global.sessions[id] =
            createSessionObject(
                id,
                socket,
                phoneNumber,
                reconnectAttempts
            );


        /* ====================================================
         * EVENTS
         * ====================================================
         */

        attachSocketEvents(
            id,
            socket,
            saveCreds
        );


        return socket;

    } catch (error) {

        if (socket) {

            try {
                await closeSocket(
                    socket
                );
            } catch (_) {}
        }

        /*
         * Restore a reconnecting placeholder if there is no
         * newer session already occupying this user.
         */
        const current =
            global.sessions[id];

        if (
            !current &&
            oldSession &&
            !oldSession.stopping &&
            oldSession.reconnectEnabled !==
                false
        ) {

            global.sessions[id] = {

                ...oldSession,

                socket:
                    null,

                connected:
                    false,

                status:
                    'reconnecting',

                lastError:
                    error,

                reconnectAttempts:
                    reconnectAttempts
            };
        }

        console.error(
            `[WhatsApp] Failed recreating session ${id}:`,
            error?.stack ||
            error
        );

        throw error;

    } finally {

        releaseConnectionLock(id);
    }
}


/* ============================================================
 * LINK DETECTION
 * ============================================================
 */

function hasLink(
    text
) {
    return /(?:https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|co|ng|uk|me|xyz)\b)/i
        .test(
            String(text || '')
        );
}


/* ============================================================
 * SENDER JID
 * ============================================================
 */

function getSenderJid(
    message,
    session
) {
    const remoteJid =
        message?.key?.remoteJid ||
        '';

    return (
        message?.key?.participant ||

        (
            message?.key?.fromMe
                ? session?.socket?.user?.id
                : remoteJid
        ) ||

        ''
    );
}


/* ============================================================
 * GROUP SETTINGS
 * ============================================================
 */

async function enforceGroupSettings(
    message,
    session,
    remoteJid,
    text
) {
    if (
        !isGroupJid(remoteJid)
    ) {
        return false;
    }

    let settings;

    try {

        settings =
            getGroup(
                remoteJid
            );

    } catch (error) {

        console.error(
            `[WhatsApp] Failed reading group settings for ${remoteJid}:`,
            error?.message ||
            error
        );

        settings = null;
    }

    if (!settings) {
        return false;
    }

    if (
        !settings.antiLink &&
        !settings.muted
    ) {
        return false;
    }

    if (
        !session?.socket
    ) {
        return false;
    }

    let meta =
        null;

    try {

        meta =
            await session.socket.groupMetadata(
                remoteJid
            );

    } catch (error) {

        console.error(
            `[WhatsApp] Failed loading group metadata for ${remoteJid}:`,
            error?.message ||
            error
        );

        return false;
    }

    const senderJid =
        getSenderJid(
            message,
            session
        );

    const senderNumber =
        jidNumber(
            senderJid
        );

    const botNumber =
        jidNumber(
            session.socket?.user?.id ||
            ''
        );

    const fromMe =
        message?.key?.fromMe === true;

    const senderIsAdmin =
        fromMe ||
        Boolean(
            meta.participants?.some(
                participant =>
                    participant?.admin &&
                    jidNumber(
                        participant.id
                    ) === senderNumber
            )
        );

    const botIsAdmin =
        Boolean(
            meta.participants?.some(
                participant =>
                    participant?.admin &&
                    jidNumber(
                        participant.id
                    ) === botNumber
            )
        );


    /* ========================================================
     * ANTI-LINK
     * ========================================================
     */

    if (
        settings.antiLink &&
        !fromMe &&
        !senderIsAdmin &&
        botIsAdmin &&
        hasLink(text)
    ) {

        try {

            await session.socket.sendMessage(
                remoteJid,
                {
                    delete:
                        message.key
                }
            );

        } catch (error) {

            console.error(
                `[WhatsApp] Failed deleting link message in ${remoteJid}:`,
                error?.message ||
                error
            );
        }

        try {

            await session.socket.sendMessage(
                remoteJid,
                {
                    text:
                        '🛡️ Link removed. Links are not allowed in this group.'
                }
            );

        } catch (error) {

            console.error(
                `[WhatsApp] Failed sending anti-link notice in ${remoteJid}:`,
                error?.message ||
                error
            );
        }

        return true;
    }


    /* ========================================================
     * MUTE
     * ========================================================
     */

    if (
        settings.muted &&
        !fromMe &&
        !senderIsAdmin &&
        String(text || '')
            .trim()
            .startsWith('.')
    ) {

        return true;
    }

    return false;
}


/* ============================================================
 * NORMALIZE MESSAGE TEXT
 * ============================================================
 */

function extractMessageText(
    message
) {
    try {

        if (!message?.message) {
            return '';
        }

        const text =
            getText(
                message.message
            );

        return String(
            text || ''
        ).trim();

    } catch (error) {

        console.error(
            '[WhatsApp] Failed extracting message text:',
            error
        );

        return '';
    }
}


/* ============================================================
 * INCOMING MESSAGES
 * ============================================================
 */

async function handleIncomingMessages(
    userId,
    socket,
    messageUpdate
) {
    const id =
        String(userId);

    const session =
        getWhatsAppSession(id);

    /*
     * Ignore messages from an old socket.
     */
    if (
        !session ||
        session.socket !== socket
    ) {
        return;
    }

    if (
        !messageUpdate ||
        !Array.isArray(
            messageUpdate.messages
        ) ||
        !messageUpdate.messages.length
    ) {
        return;
    }


    for (
        const message
        of messageUpdate.messages
    ) {

        try {

            if (
                !message?.message
            ) {
                continue;
            }

            const remoteJid =
                message.key?.remoteJid;

            if (
                !remoteJid
            ) {
                continue;
            }

            /*
             * Ignore status/broadcast traffic.
             */
            if (
                isIgnoredJid(
                    remoteJid
                )
            ) {
                continue;
            }

            /*
             * Ignore protocol-style messages without actual
             * message content.
             */
            const text =
                extractMessageText(
                    message
                );


            /* =================================================
             * GROUP ANTI SYSTEM
             * =================================================
             */

            if (
                await enforceGroupSettings(
                    message,
                    session,
                    remoteJid,
                    text
                )
            ) {
                continue;
            }


            /*
             * Commands are NOT restricted here.
             *
             * Permission-sensitive commands such as:
             *
             * .kick
             * .promote
             * .demote
             * .mute
             *
             * should handle their own permissions in the
             * command layer.
             */
            await dispatchWhatsAppMessage(
                id,
                message
            );

        } catch (error) {

            console.error(
                `[WhatsApp] Failed processing message for ${id}:`,
                error?.stack ||
                error
            );
        }
    }
}


/* ============================================================
 * MESSAGE DISPATCHER
 * ============================================================
 */

async function dispatchWhatsAppMessage(
    userId,
    message
) {
    const id =
        String(userId);

    return enqueueCommand(
        id,
        async () => {

            const session =
                getWhatsAppSession(
                    id
                );

            if (
                !session
            ) {

                console.log(
                    `[WhatsApp] Ignoring message: session ${id} no longer exists.`
                );

                return;
            }

            if (
                session.stopping
            ) {
                return;
            }

            if (
                !session.connected
            ) {

                console.log(
                    `[WhatsApp] Ignoring message: session ${id} is not connected.`
                );

                return;
            }


            const handler =
                getWhatsAppCommandHandler();


            if (
                typeof handler !==
                'function'
            ) {

                console.error(
                    '[WhatsApp] No WhatsApp command handler is registered.'
                );

                console.error(
                    '[WhatsApp] Register one with setWhatsAppCommandHandler(handler).'
                );

                return;
            }


            try {

                await handler(
                    id,
                    session,
                    message
                );

            } catch (error) {

                console.error(
                    `[WhatsApp] Command handler failed for ${id}:`,
                    error?.stack ||
                    error
                );


                /*
                 * Never allow one command to crash the socket.
                 */
                try {

                    const remoteJid =
                        message?.key?.remoteJid;

                    if (
                        remoteJid &&
                        session.socket &&
                        session.connected
                    ) {

                        await session.socket.sendMessage(
                            remoteJid,
                            {
                                text:
                                    '❌ Command failed. Check the bot console for the error.'
                            }
                        );
                    }

                } catch (sendError) {

                    console.error(
                        '[WhatsApp] Failed sending command error:',
                        sendError?.message ||
                        sendError
                    );
                }
            }
        }
    );
}


/* ============================================================
 * SEND MESSAGE
 * ============================================================
 */

async function sendMessage(
    userId,
    jid,
    content,
    options = {}
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

    if (!session.socket) {

        throw new Error(
            'WhatsApp socket not available.'
        );
    }

    if (!session.connected) {

        throw new Error(
            'WhatsApp is not connected.'
        );
    }

    if (!jid) {

        throw new Error(
            'WhatsApp JID is required.'
        );
    }

    if (
        !content
    ) {

        throw new Error(
            'Message content is required.'
        );
    }

    return session.socket.sendMessage(
        jid,
        content,
        options
    );
}


/* ============================================================
 * SEND TEXT
 * ============================================================
 */

async function sendText(
    userId,
    jid,
    text,
    options = {}
) {
    if (
        text === undefined ||
        text === null ||
        String(text).length === 0
    ) {

        throw new Error(
            'Text message cannot be empty.'
        );
    }

    return sendMessage(
        userId,
        jid,
        {
            text:
                String(text)
        },
        options
    );
}


/* ============================================================
 * SEND REPLY
 * ============================================================
 */

async function sendReply(
    userId,
    jid,
    text,
    options = {}
) {
    if (!jid) {

        throw new Error(
            'Unable to determine reply JID.'
        );
    }

    return sendText(
        userId,
        jid,
        text,
        options
    );
}


/* ============================================================
 * CONNECTION CHECK
 * ============================================================
 */

function isWhatsAppConnected(
    userId
) {
    return Boolean(
        global.sessions[
            String(userId)
        ]?.connected
    );
}


/* ============================================================
 * GET WHATSAPP STATUS
 * ============================================================
 */

function getWhatsAppStatus(
    userId
) {
    const id =
        String(userId);

    const session =
        global.sessions[id];

    const pairing =
        global.pairingStates[id];

    if (!session) {

        return {

            exists:
                false,

            connected:
                false,

            status:
                'offline',

            phoneNumber:
                null,

            pairing:
                Boolean(
                    pairing
                )
        };
    }

    return {

        exists:
            true,

        connected:
            session.connected ===
            true,

        status:
            session.status ||
            'unknown',

        phoneNumber:
            session.phoneNumber ||
            null,

        pairing:
            Boolean(
                pairing &&
                pairing.active
            ),

        pairingCode:
            pairing?.pairingCode ||
            session.pairingCode ||
            null,

        reconnectEnabled:
            session.reconnectEnabled !==
            false,

        reconnectAttempts:
            session.reconnectAttempts ||
            0,

        createdAt:
            session.createdAt ||
            null,

        lastConnectedAt:
            session.lastConnectedAt ||
            null,

        lastDisconnectAt:
            session.lastDisconnectAt ||
            null,

        lastError:
            session.lastError ||
            null
    };
}


/* ============================================================
 * GET PAIRING CODE
 * ============================================================
 */

function getPairingCode(
    userId
) {
    const id =
        String(userId);

    const state =
        global.pairingStates[id];

    if (!state) {

        const session =
            global.sessions[id];

        return (
            session?.pairingCode ||
            null
        );
    }

    return (
        state.pairingCode ||
        global.sessions[id]
            ?.pairingCode ||
        null
    );
}


/* ============================================================
 * CANCEL PAIRING
 * ============================================================
 */

async function cancelPairing(
    userId
) {
    const id =
        String(userId);

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
            deleteAuth:
                true,

            disableReconnect:
                true,

            clearPairing:
                true
        }
    );

    return true;
}


/* ============================================================
 * RESTORE ALL EXISTING SESSIONS
 * ============================================================
 */

async function restoreSessions() {
    ensureSessionDirectory();

    let entries =
        [];

    try {

        entries =
            fs.readdirSync(
                BASE_SESSION_DIR,
                {
                    withFileTypes:
                        true
                }
            );

    } catch (error) {

        console.error(
            '[WhatsApp] Failed reading sessions:',
            error
        );

        return;
    }


    for (
        const entry
        of entries
    ) {

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
            entry.name.substring(
                3
            );

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

            await sleep(
                1000
            );

        } catch (error) {

            console.error(
                `[WhatsApp] Failed restoring ${userId}:`,
                error?.stack ||
                error
            );
        }
    }
}


/* ============================================================
 * RESTORE ONE WHATSAPP SESSION
 * ============================================================
 */

async function restoreWhatsAppSession(
    userId
) {
    const id =
        String(userId);

    /*
     * Prevent duplicate sessions.
     */
    if (
        global.sessions[id]
    ) {

        return global.sessions[id]
            .socket;
    }

    const sessionDir =
        getSessionDirectory(id);

    if (
        !fs.existsSync(
            sessionDir
        )
    ) {

        return null;
    }

    const {
        state,
        saveCreds
    } =
        await useMultiFileAuthState(
            sessionDir
        );


    /*
     * Only restore registered accounts.
     */
    if (
        !state.creds.registered
    ) {

        console.log(
            `[WhatsApp] ${id}: auth not registered, deleting incomplete session`
        );

        removeDirectory(
            sessionDir
        );

        return null;
    }


    const socketOptions =
        await buildSocketOptions(
            state
        );


    const socket =
        makeWASocket(
            socketOptions
        );


    global.sessions[id] =
        createSessionObject(
            id,
            socket,
            state.creds.me?.id
                ?.split(':')[0]
                ?.replace(
                    /\D/g,
                    ''
                ) ||
            null
        );


    attachSocketEvents(
        id,
        socket,
        saveCreds
    );


    return socket;
}


/* ============================================================
 * STOP ALL WHATSAPP SESSIONS
 * ============================================================
 */

async function stopAllWhatsAppSessions(
    options = {}
) {
    const deleteAuth =
        options.deleteAuth ??
        options.removeAuth ??
        false;

    const ids =
        Object.keys(
            global.sessions
        );

    for (
        const id
        of ids
    ) {

        try {

            await stopWhatsAppSession(
                id,
                {
                    deleteAuth:
                        deleteAuth,

                    disableReconnect:
                        true,

                    clearPairing:
                        true
                }
            );

        } catch (error) {

            console.error(
                `[WhatsApp] Failed stopping ${id}:`,
                error?.stack ||
                error
            );
        }
    }
}


/* ============================================================
 * GET ALL SESSION SUMMARIES
 * ============================================================
 */

function getAllWhatsAppSessions() {

    return Object.keys(
        global.sessions
    ).map(
        userId =>
            getWhatsAppStatus(
                userId
            )
    );
}


/* ============================================================
 * CLEAN SHUTDOWN
 * ============================================================
 */

async function shutdownWhatsApp() {

    console.log(
        '[WhatsApp] Shutting down all sessions...'
    );

    await stopAllWhatsAppSessions(
        {
            deleteAuth:
                false
        }
    );

    console.log(
        '[WhatsApp] Shutdown complete.'
    );
}


/* ============================================================
 * EXTRA MESSAGE HELPERS
 * ============================================================
 */

function getRemoteJid(
    message
) {
    return (
        message?.key?.remoteJid ||
        null
    );
}


function isSelfMessage(
    message
) {
    return (
        message?.key?.fromMe ===
        true
    );
}


function isIgnoredJid(
    jid
) {
    const value =
        String(
            jid || ''
        );

    return (
        value ===
            'status@broadcast' ||
        value.endsWith(
            '@broadcast'
        )
    );
}


/* ============================================================
 * GET CONNECTED WHATSAPP NUMBER
 * ============================================================
 */

function getConnectedWhatsAppNumber(
    userId
) {
    const session =
        getWhatsAppSession(
            userId
        );

    if (
        !session
    ) {
        return null;
    }

    return (
        session.phoneNumber ||
        session.socket?.user?.id
            ?.split(':')[0]
            ?.replace(
                /\D/g,
                ''
            ) ||
        null
    );
}


/* ============================================================
 * GET BOT JID
 * ============================================================
 */

function getBotJid(
    userId
) {
    const session =
        getWhatsAppSession(
            userId
        );

    return (
        session?.socket?.user?.id ||
        null
    );
}


/* ============================================================
 * CHECK BOT GROUP ADMIN
 * ============================================================
 */

async function isBotGroupAdmin(
    userId,
    groupJid
) {
    const session =
        getWhatsAppSession(
            userId
        );

    if (
        !session?.socket
    ) {
        return false;
    }

    if (
        !isGroupJid(
            groupJid
        )
    ) {
        return false;
    }

    try {

        const metadata =
            await session.socket.groupMetadata(
                groupJid
            );

        const botJid =
            session.socket.user?.id ||
            '';

        const botNumber =
            jidNumber(
                botJid
            );

        return Boolean(
            metadata?.participants?.some(
                participant =>
                    participant?.admin &&
                    jidNumber(
                        participant.id
                    ) === botNumber
            )
        );

    } catch (error) {

        console.error(
            `[WhatsApp] Failed checking bot admin status in ${groupJid}:`,
            error?.message ||
            error
        );

        return false;
    }
}


/* ============================================================
 * GET GROUP METADATA SAFELY
 * ============================================================
 */

async function getWhatsAppGroupMetadata(
    userId,
    groupJid
) {
    const session =
        getWhatsAppSession(
            userId
        );

    if (
        !session?.socket
    ) {
        return null;
    }

    if (
        !isGroupJid(
            groupJid
        )
    ) {
        return null;
    }

    try {

        return await session.socket.groupMetadata(
            groupJid
        );

    } catch (error) {

        console.error(
            `[WhatsApp] Failed getting metadata for ${groupJid}:`,
            error?.message ||
            error
        );

        return null;
    }
}


/* ============================================================
 * EXPORTS
 * ============================================================
 */

module.exports = {

    /* --------------------------------------------------------
     * Main session management
     * --------------------------------------------------------
     */

    createWhatsAppSession,

    reconnectWhatsAppSession,

    restoreWhatsAppSession,


    /* --------------------------------------------------------
     * Pairing
     * --------------------------------------------------------
 */

    prepareFreshPairing,

    cancelPairing,

    getPairingCode,

    getPairingState,

    isPairing,


    /* --------------------------------------------------------
     * Session control
     * --------------------------------------------------------
     */

    stopWhatsAppSession,

    completelyResetUser,

    stopAllWhatsAppSessions,


    /* --------------------------------------------------------
     * Session information
     * --------------------------------------------------------
 */

    getWhatsAppSession,

    hasWhatsAppSession,

    getWhatsAppStatus,

    getAllWhatsAppSessions,

    isWhatsAppConnected,

    getConnectedWhatsAppNumber,

    getBotJid,


    /* --------------------------------------------------------
     * Messaging
     * --------------------------------------------------------
     */

    sendMessage,

    sendText,

    sendReply,


    /* --------------------------------------------------------
     * WhatsApp command handler
     * --------------------------------------------------------
     */

    setWhatsAppCommandHandler,

    getWhatsAppCommandHandler,

    dispatchWhatsAppMessage,


    /* --------------------------------------------------------
     * Message utilities
     * --------------------------------------------------------
     */

    getMessageText:
        getText,

    getRemoteJid,

    isSelfMessage,

    isIgnoredJid,


    /* --------------------------------------------------------
     * Group utilities
     * --------------------------------------------------------
     */

    isBotGroupAdmin,

    getWhatsAppGroupMetadata,


    /* --------------------------------------------------------
     * Utilities
     * --------------------------------------------------------
     */

    normalizePhoneNumber,

    formatPairingCode,


    /* --------------------------------------------------------
     * Startup / shutdown
     * --------------------------------------------------------
     */

    restoreSessions,

    shutdownWhatsApp
};
