'use strict';

/*
 * ============================================================
 * SOLVAX MD
 * lib/whatsapp.js
 * ============================================================
 *
 * CENTRAL WHATSAPP SESSION MANAGER
 *
 * Baileys version:
 *     @whiskeysockets/baileys 6.7.24
 *
 * Node:
 *     >= 20
 *
 * RESPONSIBILITIES
 * ------------------------------------------------------------
 * 1. Create WhatsApp sockets
 * 2. Generate pairing codes
 * 3. Save Baileys authentication credentials
 * 4. Restore existing authenticated sessions
 * 5. Handle WhatsApp connection events
 * 6. Automatically reconnect temporary disconnects
 * 7. Completely stop sessions
 * 8. Completely reset sessions
 * 9. Prevent duplicate sockets
 * 10. Handle incoming WhatsApp messages
 * 11. Send WhatsApp messages
 * 12. Expose session status
 *
 * IMPORTANT
 * ------------------------------------------------------------
 * This file is the ONLY place that should create a Baileys
 * socket for SolvaX MD.
 *
 * The /pair command should NOT call makeWASocket().
 *
 * The /pair command should use:
 *
 *     createWhatsAppSession(
 *         userId,
 *         phoneNumber,
 *         { fresh: true }
 *     );
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

const { getGroup } = require('./database');
const { enqueueCommand, clearQueue } = require('./queue');


/* ============================================================
 * CONFIGURATION
 * ============================================================
 */

const BASE_SESSION_DIR =
    path.resolve(
        process.env.WA_SESSION_DIR ||
        path.join(process.cwd(), 'sessions')
    );

/*
 * How long an unfinished pairing request is allowed
 * to remain alive.
 *
 * Five minutes is long enough for a user to open WhatsApp
 * and complete the linking process.
 */
const PAIR_TIMEOUT =
    5 * 60 * 1000;

/*
 * Initial reconnect delay.
 */
const RECONNECT_DELAY =
    5000;

/*
 * Maximum time a connection creation lock may remain
 * before being considered stale.
 */
const CONNECTION_LOCK_TIMEOUT =
    30 * 1000;


/* ============================================================
 * GLOBAL STATE
 * ============================================================
 *
 * These objects live globally because other command files
 * such as /pair and /stop need to access the same sessions.
 *
 * Structure:
 *
 * global.sessions[userId]
 * global.pairingStates[userId]
 * global.waReconnectTimers[userId]
 * global.waConnectionLocks[userId]
 * lib/queue.js manages per-user command queues
 *
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



/* ============================================================
 * LOGGER
 * ============================================================
 *
 * Use:
 *
 * WA_LOG_LEVEL=info
 *
 * if you want more Baileys logging.
 *
 * Default is silent so Telegram users do not get spammed
 * with internal protocol messages.
 *
 * ============================================================
 */

const logger =
    P({
        level:
            process.env.WA_LOG_LEVEL ||
            'silent'
    });


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
 *
 * Baileys pairing expects a phone number containing digits.
 *
 * Examples:
 *
 * +2348132538119
 * 2348132538119
 *
 * both become:
 *
 * 2348132538119
 *
 * Nigerian local numbers are also supported by the helper
 * because the /pair command already normalizes them.
 *
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

        /*
         * Baileys pairing numbers are expected to be
         * international numbers without the + sign.
         */
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
 * CREATE INTERNAL PAIRING STATE
 * ============================================================
 */

function createPairingState(
    userId,
    phoneNumber
) {
    const id =
        String(userId);

    /*
     * Reuse the existing pairing state/timer when the
     * Telegram pairing flow already created one.
     */
    const previous =
        global.pairingStates[id] || null;

    const now =
        Date.now();

    const state = {
        ...(previous || {}),
        active: true,
        userId: id,
        phoneNumber,
        pairingCode: null,
        startedAt: previous?.startedAt || now,
        expiresAt: now + PAIR_TIMEOUT,
        cancelled: false,
        completed: false,
        socket: null,
        timeout: previous?.timeout || null
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

        state.timeout = null;
    }
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
 *
 * Prevents:
 *
 * /pair
 * /pair
 *
 * from creating two sockets simultaneously.
 *
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

        /*
         * If the lock is still fresh,
         * another connection is being prepared.
         */
        if (
            Date.now() -
            existing <
            CONNECTION_LOCK_TIMEOUT
        ) {
            return false;
        }

        /*
         * Stale lock.
         */
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
 *
 * We deliberately do NOT call logout here.
 *
 * logout() would invalidate the WhatsApp authentication.
 *
 * We only close the websocket when possible.
 *
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


    /*
     * FIRST:
     * Disable automatic reconnection.
     *
     * This is deliberately done before closing the socket.
     */
    if (disableReconnect) {
        clearReconnectTimer(id);
    }


    /*
     * Get the current session.
     */
    const session =
        global.sessions[id];


    /*
     * Tell the session it is being deliberately stopped.
     *
     * This prevents connection.update from interpreting
     * the close as an accidental network failure.
     */
    if (session) {

        session.stopping = true;

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
     * Remove the global session reference.
     */
    delete global.sessions[id];


    /*
     * Remove pairing state.
     */
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


    /*
     * Delete saved Baileys authentication when requested.
     */
    if (deleteAuth) {

        removeDirectory(
            getSessionDirectory(id)
        );
    }


    /*
     * Release the connection lock.
     */
    releaseConnectionLock(id);


    console.log(
        `[WhatsApp] Session stopped for ${id}`
    );

    return true;
}


/* ============================================================
 * COMPLETE USER RESET
 * ============================================================
 *
 * This is the nuclear cleanup function.
 *
 * It removes:
 *
 * - active socket
 * - session object
 * - pairing state
 * - reconnect timer
 * - connection lock
 * - command queue
 * - authentication files
 *
 * It is used when:
 *
 * /stop
 *
 * pairing failure
 *
 * pairing timeout
 *
 * logged-out account
 *
 * fresh pairing
 *
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


    /*
     * Stop current session.
     */
    await stopWhatsAppSession(
        id,
        {
            deleteAuth: true,

            disableReconnect: true,

            clearPairing: true
        }
    );


    /*
     * Extra timer cleanup.
     */
    clearReconnectTimer(id);


    /*
     * Extra lock cleanup.
     */
    delete global.waConnectionLocks[id];


    /*
     * Remove command queue.
     *
     * New WhatsApp commands will receive a new queue.
     */
    clearQueue(id);


    /*
     * Extra safety.
     */
    delete global.sessions[id];

    delete global.pairingStates[id];


    /*
     * Authentication directory should now be gone.
     *
     * Remove it one more time in case another operation
     * recreated it during shutdown.
     */
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
 *
 * IMPORTANT:
 *
 * This function is intentionally simple.
 *
 * It only removes old WhatsApp data.
 *
 * The actual creation of the new pairing session is handled
 * by createWhatsAppSession().
 *
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

    console.log(
        `[WhatsApp] Preparing fresh pairing for ${id}`
    );


    /*
     * Reset existing session/auth.
     */
    await completelyResetUser(id);


    /*
     * Recreate the authentication directory.
     *
     * useMultiFileAuthState() can then initialize its
     * credential files there.
     */
    const sessionDir =
        getSessionDirectory(id);

    fs.mkdirSync(
        sessionDir,
        {
            recursive: true
        }
    );


    return {
        userId: id,

        phoneNumber: number,

        sessionDir
    };
}


/* ============================================================
 * CREATE WHATSAPP SESSION
 * ============================================================
 *
 * MAIN FUNCTION
 *
 * Correct usage:
 *
 * createWhatsAppSession(
 *     userId,
 *     phoneNumber,
 *     {
 *         fresh: true
 *     }
 * );
 *
 * ============================================================
 */

async function createWhatsAppSession(
    userId,
    phoneNumber,
    options = {}
) {
    const id =
        String(userId);

    /*
     * Normalize ONLY the actual phoneNumber argument.
     *
     * This is the important contract that the old /pair
     * command violated.
     */
    const number =
        normalizePhoneNumber(
            phoneNumber
        );

    if (!number) {

        throw new Error(
            'A valid WhatsApp phone number is required.'
        );
    }


    /*
     * Acquire the connection lock BEFORE doing anything.
     */
    if (
        !acquireConnectionLock(id)
    ) {

        throw new Error(
            'A WhatsApp connection is already being prepared.'
        );
    }


    let socket = null;



    try {

        /* ====================================================
         * FRESH MODE
         * ====================================================
         *
         * We perform the reset directly here instead of
         * calling prepareFreshPairing(), because that function
         * would release the same connection lock we just
         * acquired.
         *
         * This fixes the lock bug from the previous version.
         * ====================================================
         */

        if (
            options.fresh === true
        ) {

            console.log(
                `[WhatsApp] Fresh pairing requested for ${id}`
            );


            /*
             * Stop any current socket without releasing our
             * creation lock prematurely.
             */
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


            /*
             * Cancel old reconnect timer.
             */
            clearReconnectTimer(id);


            /*
             * Keep the active Telegram pairing state. The /pair
             * flow owns its timer and will be reused by the new
             * socket's pairing state.
             *
             * If a caller created a stale state without a socket,
             * createPairingState() will refresh its lifecycle below.
             */


            /*
             * Delete old authentication.
             */
            removeDirectory(
                getSessionDirectory(id)
            );


            /*
             * Recreate session directory.
             */
            fs.mkdirSync(
                getSessionDirectory(id),
                {
                    recursive: true
                }
            );

        } else {

            /* =================================================
             * NORMAL MODE
             * =================================================
             */

            /*
             * If another session exists, stop it.
             */
            if (
                global.sessions[id]
            ) {

                await stopWhatsAppSession(
                    id,
                    {
                        deleteAuth: false,

                        disableReconnect: true,

                        clearPairing: true
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
                recursive: true
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
         * BAILEYS VERSION
         * ====================================================
         *
         * We attempt to obtain the latest compatible version.
         *
         * If the request fails, we simply allow Baileys to use
         * its own default.
         * ====================================================
         */

        let version = null;

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
                '[WhatsApp] Could not fetch latest Baileys version. Using library default.'
            );

            console.log(
                `[WhatsApp] Version fetch reason: ${error.message}`
            );
        }


        /* ====================================================
         * CREATE PAIRING STATE
         * ====================================================
         */

        const pairingState =
            createPairingState(
                id,
                number
            );


        /* ====================================================
         * SOCKET OPTIONS
         * ====================================================
         */

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

            /*
             * We use pairing codes, not terminal QR output.
             */
            printQRInTerminal: false,

            /*
             * Stable browser identity.
             */
            browser:
                Browsers.ubuntu(
                    'Chrome'
                ),

            /*
             * Do not force the account online merely because
             * the socket connects.
             */
            markOnlineOnConnect: false,

            /*
             * We do not need complete history synchronization
             * for this bot.
             */
            syncFullHistory: false,

            /*
             * Link previews are not required by the core.
             */
            generateHighQualityLinkPreview: false
        };


        if (version) {

            socketOptions.version =
                version;
        }


        /* ====================================================
         * CREATE BAILEYS SOCKET
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
         * SAVE SESSION
         * ====================================================
         */

        const session = {

            userId: id,

            socket,

            phoneNumber: number,

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
                0,

            pairingCode:
                null
        };


        global.sessions[id] =
            session;


        /*
         * Give pairing state the socket.
         */
        pairingState.socket =
            socket;


        /* ====================================================
         * CREDENTIAL EVENT
         * ====================================================
         */

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
                        error
                    );
                }
            }
        );


        /* ====================================================
         * CONNECTION EVENT
         * ====================================================
         */

        socket.ev.on(
            'connection.update',
            async (update) => {

                try {

                    await handleConnectionUpdate(
                        id,
                        update
                    );

                } catch (error) {

                    console.error(
                        `[WhatsApp] Connection handler error for ${id}:`,
                        error
                    );
                }
            }
        );


        /* ====================================================
         * INCOMING MESSAGE EVENT
         * ====================================================
         */

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
                        error
                    );
                }
            }
        );


        /*
         * Pairing timeout is owned by telegram/pair.js while a
         * Telegram pairing request is active. This avoids two
         * independent timers controlling the same lifecycle.
         */

        /* ====================================================
         * REQUEST PAIRING CODE
         * ====================================================
         */

        if (
            !state.creds.registered
        ) {

            /*
             * Give the socket a short moment to initialize.
             */
            await sleep(2000);


            /*
             * Verify that the session still exists.
             */
            const currentSession =
                global.sessions[id];

            if (
                !currentSession
            ) {

                throw new Error(
                    'WhatsApp session disappeared before pairing code generation.'
                );
            }


            if (
                currentSession.stopping
            ) {

                throw new Error(
                    'WhatsApp session was stopped before pairing code generation.'
                );
            }


            /*
             * Verify pairing was not cancelled.
             */
            const currentPairing =
                global.pairingStates[id];

            if (
                !currentPairing ||
                currentPairing.cancelled
            ) {

                throw new Error(
                    'WhatsApp pairing was cancelled.'
                );
            }


            console.log(
                `[WhatsApp] Requesting pairing code for ${number}`
            );


            /*
             * IMPORTANT:
             *
             * Baileys 6.7.24 expects the international
             * number without +.
             */
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


            /*
             * Store in the pairing state.
             */
            const latestPairing =
                global.pairingStates[id];

            if (
                latestPairing
            ) {

                latestPairing.pairingCode =
                    formattedCode;

                latestPairing.active =
                    true;
            }


            /*
             * ALSO store on the session.
             *
             * This makes it compatible with callers that want
             * session.pairingCode.
             */
            const latestSession =
                global.sessions[id];

            if (
                latestSession
            ) {

                latestSession.pairingCode =
                    formattedCode;
            }


            console.log(
                `[WhatsApp] Pairing code generated for ${id}: ${formattedCode}`
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


        /* ====================================================
         * ALREADY REGISTERED
         * ====================================================
         */

        const registeredPairing =
            global.pairingStates[id];

        if (
            registeredPairing
        ) {

            registeredPairing.active =
                false;

            registeredPairing.completed =
                true;

            clearPairingTimer(id);
        }


        return {

            socket,

            pairingCode:
                null,

            phoneNumber:
                number,

            userId:
                id
        };


    } catch (error) {

        /*
         * ALWAYS close a partially-created socket.
         *
         * This fixes the socket-leak problem from the old
         * implementation.
         */

        if (socket) {

            try {

                await closeSocket(
                    socket
                );

            } catch (_) {}
        }


        /*
         * Disable reconnect.
         */
        clearReconnectTimer(id);


        /*
         * Remove partially-created session.
         */
        const currentSession =
            global.sessions[id];

        if (
            currentSession
        ) {

            currentSession.stopping =
                true;

            currentSession.reconnectEnabled =
                false;
        }

        delete global.sessions[id];


        /*
         * Clear pairing state.
         */
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


        /*
         * Fresh pairing failures should not leave broken
         * authentication files behind.
         */
        if (
            options.fresh === true
        ) {

            removeDirectory(
                getSessionDirectory(id)
            );
        }


        /*
         * IMPORTANT:
         *
         * Print the REAL error to the server console.
         *
         * The Telegram command can then display a cleaner
         * user-facing message.
         */
        console.error(
            `[WhatsApp] createWhatsAppSession failed for ${id}:`,
            error
        );


        throw error;


    } finally {

        /*
         * Creation is finished.
         *
         * The socket lifecycle itself is controlled by
         * connection.update, not by this lock.
         */
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

    /*
     * WhatsApp pairing codes are normally 8 characters.
     *
     * Formatting is purely visual.
     */
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

    const pairing =
        global.pairingStates[id];


    /*
     * Session may already have been deliberately removed
     * by /stop or a reset.
     *
     * In that case we ignore late events from the old socket.
     */
    if (!session) {
        return;
    }


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


        /*
         * Pairing is now complete.
         */
        if (pairing) {
            pairing.active = false;
            pairing.completed = true;
            clearPairingTimer(id);

            const chatId = pairing.chatId;
            if (chatId && global.bot?.telegram) {
                try {
                    await global.bot.telegram.sendMessage(
                        chatId,
                        `✅ WhatsApp connected successfully.\n\n📱 ${session.phoneNumber || 'Unknown'}\n🟢 Your session is ready. Use .menu on WhatsApp.`
                    );
                } catch (error) {
                    console.error(`[WhatsApp] Telegram connection notification failed for ${id}:`, error?.message || error);
                }
            }

            delete global.pairingStates[id];
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
         * ----------------------------------------------------
         * DELIBERATE STOP
         * ----------------------------------------------------
         *
         * /stop, pairing cancellation, shutdown, etc.
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
         * ----------------------------------------------------
         * LOGGED OUT
         * ----------------------------------------------------
         *
         * Authentication is no longer valid.
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


            /*
             * Delete session.
             */
            delete global.sessions[id];


            /*
             * Delete pairing state.
             */
            const pairingState =
                global.pairingStates[id];

            if (
                pairingState
            ) {

                clearPairingTimer(id);

                delete global.pairingStates[id];
            }


            /*
             * Authentication is invalid,
             * so remove it.
             */
            removeDirectory(
                getSessionDirectory(id)
            );


            return;
        }


        /*
         * ----------------------------------------------------
         * BAD SESSION
         * ----------------------------------------------------
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
         * ----------------------------------------------------
         * RESTART REQUIRED
         * ----------------------------------------------------
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
         * ----------------------------------------------------
         * CONNECTION CLOSED / TEMPORARY ERROR
         * ----------------------------------------------------
         *
         * Network problems, server disconnects, etc.
         */
        scheduleReconnect(id);

        return;
    }
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

        return undefined;
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
        session.reconnectEnabled === false
    ) {
        return;
    }


    /*
     * Prevent duplicate timers.
     */
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


    /*
     * Exponential-ish backoff.
     *
     * 5 sec
     * 10 sec
     * 15 sec
     * 20 sec
     * 25 sec
     * 30 sec max
     */
    const delay =
        Math.min(
            RECONNECT_DELAY *
                attempt,
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
                        error
                    );


                    /*
                     * Only retry if the session still exists
                     * and has not been deliberately stopped.
                     */
                    const stillActive =
                        global.sessions[id];


                    if (
                        stillActive &&
                        !stillActive.stopping &&
                        stillActive.reconnectEnabled !== false
                    ) {

                        scheduleReconnect(id);
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
        oldSession.reconnectEnabled === false
    ) {
        return null;
    }


    const phoneNumber =
        oldSession.phoneNumber;


    const reconnectAttempts =
        oldSession.reconnectAttempts ||
        0;


    /*
     * Acquire the connection lock before replacing the old socket.
     * If another connection operation is already running, throw so
     * the scheduler can retry without losing the current session.
     */
    if (!acquireConnectionLock(id)) {
        throw new Error('A WhatsApp connection is already being prepared.');
    }

    /*
     * Close old socket and remove its active reference only after
     * the replacement operation owns the lock.
     */
    await closeSocket(oldSession.socket);
    delete global.sessions[id];

    let socket = null;


    try {

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


        const {
            state,
            saveCreds
        } =
            await useMultiFileAuthState(
                sessionDir
            );


        /*
         * If authentication somehow became unregistered,
         * don't attempt a normal reconnect.
         */
        if (
            !state.creds.registered
        ) {

            throw new Error(
                'WhatsApp authentication is no longer registered.'
            );
        }


        let version = null;


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

        } catch (_) {}


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
                false
        };


        if (version) {

            socketOptions.version =
                version;
        }


        socket =
            makeWASocket(
                socketOptions
            );


        global.sessions[id] = {

            userId: id,

            socket,

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

            reconnectAttempts
        };


        /*
         * Save credentials.
         */
        socket.ev.on(
            'creds.update',
            async (creds) => {

                try {

                    await saveCreds(
                        creds
                    );

                } catch (error) {

                    console.error(
                        `[WhatsApp] Failed saving reconnect credentials for ${id}:`,
                        error
                    );
                }
            }
        );


        /*
         * Connection events.
         */
        socket.ev.on(
            'connection.update',
            async (update) => {

                try {

                    await handleConnectionUpdate(
                        id,
                        update
                    );

                } catch (error) {

                    console.error(
                        `[WhatsApp] Reconnect connection handler error for ${id}:`,
                        error
                    );
                }
            }
        );


        /*
         * Incoming messages.
         */
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
                        `[WhatsApp] Reconnect message handler error for ${id}:`,
                        error
                    );
                }
            }
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


        if (oldSession && !oldSession.stopping && oldSession.reconnectEnabled !== false) {
            global.sessions[id] = {
                ...oldSession,
                socket: null,
                connected: false,
                status: 'reconnecting',
                lastError: error,
                reconnectAttempts
            };
        } else {
            delete global.sessions[id];
        }

        console.error(
            `[WhatsApp] Failed recreating session ${id}:`,
            error?.stack || error
        );

        throw error;


    } finally {

        releaseConnectionLock(id);
    }
}


/* ============================================================
 * INCOMING MESSAGES
 * ============================================================
 */

function hasLink(text) {
    return /(?:https?:\/\/|www\.|\b[a-z0-9-]+\.(?:com|net|org|io|co|ng|uk|me|xyz)\b)/i.test(String(text || ''));
}

function getSenderJid(message, session) {
    const remoteJid = message?.key?.remoteJid || '';
    return message?.key?.participant ||
        (message?.key?.fromMe ? session?.socket?.user?.id : remoteJid) ||
        '';
}


async function enforceGroupSettings(message, session, remoteJid, text) {
    if (!isGroupJid(remoteJid)) return false;

    const settings = getGroup(remoteJid);
    if (!settings.antiLink && !settings.muted) return false;

    let meta = null;
    try {
        meta = await session.socket.groupMetadata(remoteJid);
    } catch (error) {
        console.error(`[WhatsApp] Failed loading group settings metadata for ${remoteJid}:`, error?.message || error);
        return false;
    }

    const senderJid = getSenderJid(message, session);
    const senderNumber = jidNumber(senderJid);
    const botNumber = jidNumber(session.socket?.user?.id || '');
    const fromMe = message?.key?.fromMe === true;
    const senderIsAdmin = fromMe || Boolean(meta.participants?.some(p => p?.admin && jidNumber(p.id) === senderNumber));
    const botIsAdmin = Boolean(meta.participants?.some(p => p?.admin && jidNumber(p.id) === botNumber));

    // Anti-link is enforced for non-admin members only when the bot can delete messages.
    if (settings.antiLink && !fromMe && !senderIsAdmin && botIsAdmin && hasLink(text)) {
        try {
            await session.socket.sendMessage(remoteJid, { delete: message.key });
        } catch (error) {
            console.error(`[WhatsApp] Failed deleting link message in ${remoteJid}:`, error?.message || error);
        }
        try {
            await session.socket.sendMessage(remoteJid, {
                text: '🛡 Link removed. Links are not allowed in this group.'
            });
        } catch (error) {
            console.error(`[WhatsApp] Failed sending anti-link notice in ${remoteJid}:`, error?.message || error);
        }
        return true;
    }

    // When muted, only the linked account and group admins may invoke commands.
    if (settings.muted && !fromMe && !senderIsAdmin && text.trim().startsWith('.')) {
        return true;
    }

    return false;
}

async function handleIncomingMessages(userId, messageUpdate) {
    const id = String(userId);
    const session = getWhatsAppSession(id);
    if (!session || !messageUpdate?.messages?.length) return;

    for (const message of messageUpdate.messages) {
        try {
            if (!message?.message) continue;

            const remoteJid = message.key?.remoteJid;
            if (!remoteJid || remoteJid === 'status@broadcast' || remoteJid.endsWith('@broadcast')) continue;

            const text = getText(message.message);

            if (await enforceGroupSettings(message, session, remoteJid, text)) {
                continue;
            }

            // Only the linked WhatsApp account can control the bot in private chats.
            // In groups, normal commands are available to members unless .mute is enabled;
            // admin-only commands perform their own permission checks.
            await dispatchWhatsAppMessage(id, message);
        } catch (error) {
            console.error(`[WhatsApp] Failed processing message for ${id}:`, error?.stack || error);
        }
    }
}

/* ============================================================
 * MESSAGE DISPATCHER
 * ============================================================
 */

async function dispatchWhatsAppMessage(userId, message) {
    const id = String(userId);
    return enqueueCommand(id, async () => {
        const session = getWhatsAppSession(id);
        if (!session || session.stopping || !session.connected) return;

        if (typeof global.handleWhatsAppCommand !== 'function') {
            console.error('[WhatsApp] Command handler is not registered yet.');
            return;
        }

        await global.handleWhatsAppCommand(id, session, message);
    });
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


    if (!content) {

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
    if (!text) {

        throw new Error(
            'Text message cannot be empty.'
        );
    }


    return sendMessage(
        userId,
        jid,
        { text: String(text) },
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
    if (!jid) throw new Error('Unable to determine reply JID.');
    return sendText(userId, jid, text, options);
}


/* ============================================================
 * CONNECTION CHECK
 * ============================================================
 */

function isWhatsAppConnected(userId) {
    return Boolean(global.sessions[String(userId)]?.connected);
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
                Boolean(pairing)
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
            deleteAuth: true,

            disableReconnect: true,

            clearPairing: true
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


    let entries = [];


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


            /*
             * Avoid opening many WhatsApp connections
             * simultaneously during startup.
             */
            await sleep(1000);


        } catch (error) {

            console.error(
                `[WhatsApp] Failed restoring ${userId}:`,
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
     * Do not create duplicate session.
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
     * Only restore authenticated sessions.
     *
     * An unfinished pairing directory should not be
     * automatically restored after a process restart.
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


    let version = null;


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

    } catch (_) {}


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
            false
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
                ?.replace(
                    /\D/g,
                    ''
                ) ||
            null,

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
            0,

        pairingCode:
            null
    };


    socket.ev.on(
        'creds.update',
        async (creds) => {

            try {

                await saveCreds(
                    creds
                );

            } catch (error) {

                console.error(
                    `[WhatsApp] Failed saving restored credentials for ${id}:`,
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
                    update
                );

            } catch (error) {

                console.error(
                    `[WhatsApp] Restore connection handler error for ${id}:`,
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
                    messageUpdate
                );

            } catch (error) {

                console.error(
                    `[WhatsApp] Restore message handler error for ${id}:`,
                    error
                );
            }
        }
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
        (userId) => {

            return getWhatsAppStatus(
                userId
            );
        }
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
 * EXPORTS
 * ============================================================
 */

module.exports = {

    /*
     * Main session management.
     */
    createWhatsAppSession,

    reconnectWhatsAppSession,

    restoreWhatsAppSession,


    /*
     * Pairing.
     */
    prepareFreshPairing,

    cancelPairing,

    getPairingCode,

    getPairingState,

    isPairing,


    /*
     * Session control.
     */
    stopWhatsAppSession,

    completelyResetUser,

    stopAllWhatsAppSessions,


    /*
     * Session information.
     */
    getWhatsAppSession,

    hasWhatsAppSession,

    getWhatsAppStatus,

    getAllWhatsAppSessions,


    /*
     * Messaging.
     */
    sendMessage,

    sendText,

    sendReply,

    getMessageText: getText,
    getRemoteJid: (message) => message?.key?.remoteJid || null,
    isSelfMessage: (message) => message?.key?.fromMe === true,
    isIgnoredJid: (jid) => {
        const value = String(jid || '');
        return value === 'status@broadcast' || value.endsWith('@broadcast');
    },
    isWhatsAppConnected,

    /*
     * Utilities.
     */
    normalizePhoneNumber,

    formatPairingCode,


    /*
     * Startup/shutdown.
     */
    restoreSessions,

    shutdownWhatsApp
};
