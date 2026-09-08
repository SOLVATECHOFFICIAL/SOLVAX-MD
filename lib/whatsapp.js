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
    jidNumber,
    sleep
} = require('./helpers');

const {
    enqueue
} = require('./queue');

const AUTH_ROOT = path.join(process.cwd(), 'sessions');

const logger = pino({
    level: process.env.LOG_LEVEL || 'info'
});

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

function ensureAuthRoot() {
    if (!fs.existsSync(AUTH_ROOT)) {
        fs.mkdirSync(AUTH_ROOT, {
            recursive: true
        });
    }
}

function getSessionDir(userId) {
    return path.join(
        AUTH_ROOT,
        `wa_${String(userId)}`
    );
}

function removeDirectory(directory) {
    try {
        if (fs.existsSync(directory)) {
            fs.rmSync(directory, {
                recursive: true,
                force: true
            });
        }
    } catch (error) {
        console.error(
            `[WHATSAPP] Failed to remove directory ${directory}:`,
            error
        );
    }
}

function getDisconnectCode(update) {
    return update?.lastDisconnect?.error?.output?.statusCode;
}

function getDisconnectMessage(error) {
    const code =
        error?.output?.statusCode ??
        error?.statusCode ??
        'unknown';

    if (code === DisconnectReason.loggedOut) {
        return 'WhatsApp logged out this session.';
    }

    if (code === DisconnectReason.connectionReplaced) {
        return 'This WhatsApp session was replaced by another linked session.';
    }

    if (code === DisconnectReason.badSession) {
        return 'The WhatsApp authentication session became invalid.';
    }

    if (code === DisconnectReason.multideviceMismatch) {
        return 'WhatsApp reported a device/session mismatch.';
    }

    if (code === DisconnectReason.forbidden) {
        return 'WhatsApp rejected this session.';
    }

    if (code === DisconnectReason.restartRequired) {
        return 'WhatsApp requested a session restart.';
    }

    return `WhatsApp connection closed (code: ${code}).`;
}

function getBrowserIdentity() {
    /*
     * IMPORTANT:
     *
     * Browsers.ubuntu is a function.
     * It must be CALLED.
     *
     * Do not use:
     *     browser: Browsers.ubuntu
     *
     * because Baileys expects the actual browser tuple.
     */
    return Browsers.ubuntu('Chrome');
}

async function telegramSend(userId, text) {
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

function isCurrentSession(userId, session) {
    const sessions = getSessions();

    return sessions[String(userId)] === session;
}

function clearPairingState(userId) {
    const pairingStates = getPairingStates();
    const key = String(userId);

    const state = pairingStates[key];

    if (state?.timeout) {
        clearTimeout(state.timeout);
    }

    delete pairingStates[key];
}

function setPairingState(userId, state) {
    const pairingStates = getPairingStates();
    const key = String(userId);

    const previous = pairingStates[key];

    if (previous?.timeout) {
        clearTimeout(previous.timeout);
    }

    pairingStates[key] = {
        ...state,
        userId: key
    };

    return pairingStates[key];
}

function getPairingState(userId) {
    return getPairingStates()[String(userId)] || null;
}

async function sendReply(sock, jid, text, options = {}) {
    if (!sock || !jid) {
        return null;
    }

    const message = String(text ?? '');

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

function getMessageText(message) {
    if (!message) {
        return '';
    }

    if (typeof message.conversation === 'string') {
        return message.conversation;
    }

    if (
        typeof message.extendedTextMessage?.text ===
        'string'
    ) {
        return message.extendedTextMessage.text;
    }

    if (
        typeof message.imageMessage?.caption ===
        'string'
    ) {
        return message.imageMessage.caption;
    }

    if (
        typeof message.videoMessage?.caption ===
        'string'
    ) {
        return message.videoMessage.caption;
    }

    if (
        typeof message.documentMessage?.caption ===
        'string'
    ) {
        return message.documentMessage.caption;
    }

    return '';
}

function getRemoteJid(msg) {
    return msg?.key?.remoteJid || '';
}

function isIgnoredJid(jid) {
    if (!jid) {
        return true;
    }

    if (jid === 'status@broadcast') {
        return true;
    }

    if (jid.endsWith('@broadcast')) {
        return true;
    }

    if (jid.endsWith('@newsletter')) {
        return true;
    }

    return false;
}

function isSelfMessage(msg) {
    /*
     * This is the critical self-bot check.
     *
     * Only messages sent by the linked WhatsApp account
     * itself are allowed to reach the command handler.
     *
     * Messages from other people are ignored.
     */
    return msg?.key?.fromMe === true;
}

async function handleIncomingMessage(userId, session, msg) {
    if (!msg) {
        return;
    }

    const key = String(userId);

    if (!isCurrentSession(key, session)) {
        return;
    }

    if (session.stopping) {
        return;
    }

    if (!isSelfMessage(msg)) {
        return;
    }

    const jid = getRemoteJid(msg);

    if (isIgnoredJid(jid)) {
        return;
    }

    const messageText = getMessageText(
        msg.message
    );

    if (!messageText.trim()) {
        return;
    }

    /*
     * The command must be answered in the exact same chat
     * where the linked account sent it.
     */
    try {
        if (typeof global.handleWhatsAppCommand !== 'function') {
            console.error(
                '[WHATSAPP] global.handleWhatsAppCommand is not available.'
            );

            return;
        }

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

async function completelyResetUser(userId, options = {}) {
    const key = String(userId || '');

    if (!key) {
        return false;
    }

    const {
        notify = false,
        reason = 'WhatsApp session ended.'
    } = options;

    const sessions = getSessions();

    const session = sessions[key];

    /*
     * Mark the socket as stopping BEFORE closing it.
     *
     * This prevents its own connection.update events from
     * attempting to resurrect the session.
     */
    if (session) {
        session.stopping = true;
        session.connected = false;
        session.connecting = false;
        session.reconnecting = false;

        if (session.reconnectTimer) {
            clearTimeout(session.reconnectTimer);
            session.reconnectTimer = null;
        }
    }

    /*
     * Clear all pairing information.
     */
    clearPairingState(key);

    /*
     * Close the old socket.
     *
     * We intentionally use end(), not logout().
     *
     * logout() can perform a WhatsApp-side logout operation,
     * whereas /stop is supposed to destroy our local state
     * and let /pair create a completely fresh session.
     */
    if (session?.socket) {
        const socket = session.socket;

        session.socket = null;

        try {
            if (typeof socket.end === 'function') {
                socket.end(
                    new Error(
                        'SolvaX MD session completely reset'
                    )
                );
            }
        } catch (error) {
            console.error(
                `[WHATSAPP] Socket close failed for ${key}:`,
                error
            );
        }
    }

    /*
     * Only delete the session if it is still the same
     * session we started cleaning.
     *
     * This prevents an old socket from accidentally deleting
     * a brand-new session that was created immediately after /stop.
     */
    if (!session || sessions[key] === session) {
        delete sessions[key];
    }

    /*
     * Delete all saved Baileys authentication files.
     *
     * This is what makes the next /pair a genuinely fresh
     * pairing instead of reusing an old auth state.
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

async function prepareFreshPairing(userId) {
    const key = String(userId);

    const sessions = getSessions();
    const existing = sessions[key];

    if (existing) {
        existing.stopping = true;
        existing.connected = false;
        existing.connecting = false;

        if (existing.reconnectTimer) {
            clearTimeout(existing.reconnectTimer);
            existing.reconnectTimer = null;
        }

        const socket = existing.socket;

        existing.socket = null;

        if (socket) {
            try {
                if (typeof socket.end === 'function') {
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

        if (sessions[key] === existing) {
            delete sessions[key];
        }
    }

    /*
     * Do NOT clear global.pairingStates here.
     *
     * telegram/pair.js creates the pairing state before
     * calling this function.
     *
     * Clearing it here would make the Telegram pairing flow
     * think the user cancelled their own request.
     */

    removeDirectory(
        getSessionDir(key)
    );

    ensureAuthRoot();

    /*
     * Give the old socket a small amount of time to finish
     * shutting down before creating another socket.
     *
     * Humanity has somehow survived without this 300 ms,
     * but Baileys sessions occasionally benefit from it.
     */
    await sleep(300);

    return true;
}

async function createWhatsAppSession(userId, options = {}) {
    const key = String(userId);

    const {
        pairing = false,
        phoneNumber = null
    } = options;

    const sessions = getSessions();

    /*
     * Never allow two sockets to be created for the same
     * Telegram user at the same time.
     */
    const existing = sessions[key];

    if (existing?.connecting) {
        throw new Error(
            'A WhatsApp connection is already being created for this user.'
        );
    }

    if (existing?.socket && !existing.stopping) {
        return existing;
    }

    ensureAuthRoot();

    const sessionDir = getSessionDir(key);

    fs.mkdirSync(sessionDir, {
        recursive: true
    });

    const {
        state,
        saveCreds
    } = await useMultiFileAuthState(
        sessionDir
    );

    /*
     * Check again after the async auth-state operation.
     *
     * /stop may have happened while the auth state was loading.
     */
    const latest = sessions[key];

    if (
        latest &&
        latest !== existing &&
        latest.socket &&
        !latest.stopping
    ) {
        return latest;
    }

    const session = {
        userId: key,
        socket: null,

        phoneNumber:
            phoneNumber ||
            null,

        connected: false,
        connecting: true,
        stopping: false,
        reconnecting: false,

        pairing: Boolean(pairing),

        reconnectTimer: null,

        createdAt: Date.now(),
        connectedAt: null
    };

    sessions[key] = session;

    let pairingCodeRequested = false;

    try {
        const sock = makeWASocket({
            auth: state,

            logger,

            browser: getBrowserIdentity(),

            /*
             * Do not call fetchLatestBaileysVersion().
             *
             * package.json pins Baileys to 6.7.24, so the socket
             * should use the version bundled with that package.
             */

            markOnlineOnConnect: false,

            syncFullHistory: false,

            generateHighQualityLinkPreview: false,

            shouldIgnoreJid: isIgnoredJid
        });

        session.socket = sock;

        /*
         * Save credentials whenever Baileys updates them.
         */
        sock.ev.on(
            'creds.update',
            saveCreds
        );

        /*
         * Connection lifecycle.
         */
        sock.ev.on(
            'connection.update',
            async (update) => {
                try {
                    if (!isCurrentSession(key, session)) {
                        return;
                    }

                    const {
                        connection,
                        lastDisconnect
                    } = update;

                    if (
                        connection === 'connecting'
                    ) {
                        session.connecting = true;

                        return;
                    }

                    if (
                        connection === 'open'
                    ) {
                        if (!isCurrentSession(key, session)) {
                            return;
                        }

                        if (session.stopping) {
                            return;
                        }

                        session.connected = true;
                        session.connecting = false;
                        session.reconnecting = false;
                        session.connectedAt = Date.now();

                        if (session.reconnectTimer) {
                            clearTimeout(
                                session.reconnectTimer
                            );

                            session.reconnectTimer = null;
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
                         * If this was a pairing flow, tell Telegram
                         * that the WhatsApp account is now connected.
                         */
                        const pairingState =
                            getPairingState(key);

                        if (
                            session.pairing ||
                            pairingState
                        ) {
                            clearPairingState(key);

                            session.pairing = false;

                            await telegramSend(
                                key,
                                '✅ WhatsApp connected successfully.\n\n' +
                                'Your WhatsApp account is now linked to SolvaX MD.\n\n' +
                                'Commands sent by this linked account will be handled by the bot.'
                            );
                        }

                        return;
                    }

                    if (
                        connection === 'close'
                    ) {
                        const code =
                            getDisconnectCode(update);

                        /*
                         * A stale socket must NEVER be allowed
                         * to touch a newer session.
                         */
                        if (!isCurrentSession(key, session)) {
                            return;
                        }

                        /*
                         * If /stop already marked this session as
                         * stopping, do not send another notification
                         * or perform another reset.
                         */
                        if (session.stopping) {
                            return;
                        }

                        console.error(
                            `[WHATSAPP] Connection closed for ${key}. Code: ${code}`
                        );

                        /*
                         * IMPORTANT:
                         *
                         * There is intentionally NO automatic reconnect.
                         *
                         * Any WhatsApp disconnect is treated as
                         * a complete stop.
                         *
                         * This means:
                         * - socket is closed
                         * - pairing state is removed
                         * - timers are removed
                         * - session is removed
                         * - auth files are deleted
                         * - no zombie reconnect occurs
                         *
                         * The user can then use /pair again.
                         */
                        await completelyResetUser(
                            key,
                            {
                                notify: true,

                                reason:
                                    '❌ WhatsApp session ended.\n\n' +
                                    `${getDisconnectMessage(lastDisconnect?.error)}\n\n` +
                                    '🧹 The WhatsApp session has been completely cleared.\n' +
                                    '🧹 Saved authentication was removed.\n' +
                                    '🧹 Reconnection was cancelled.\n\n' +
                                    'Use /pair to link the same number or another number.'
                            }
                        );
                    }
                } catch (error) {
                    console.error(
                        `[WHATSAPP] connection.update handler failed for ${key}:`,
                        error
                    );

                    /*
                     * If lifecycle handling itself crashes,
                     * fail closed and clean the session rather
                     * than leaving a zombie socket behind.
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
         * Incoming messages.
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

                if (session.stopping) {
                    return;
                }

                if (
                    !event ||
                    !Array.isArray(event.messages)
                ) {
                    return;
                }

                for (
                    const msg of event.messages
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
         * If this is an existing authenticated session,
         * no pairing code is necessary.
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
                cleanNumber(phoneNumber);

            if (!normalized) {
                throw new Error(
                    'Invalid WhatsApp phone number.'
                );
            }

            /*
             * Baileys expects digits only.
             *
             * Example:
             * 2348132538119
             *
             * NOT:
             * +2348132538119
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
             * Make sure Telegram pairing has not already
             * been cancelled before requesting the code.
             */
            const beforeRequest =
                getPairingState(key);

            if (!beforeRequest) {
                throw new Error(
                    'Pairing request was cancelled before the code was requested.'
                );
            }

            pairingCodeRequested = true;

            session.phoneNumber =
                normalized;

            session.pairing = true;

            console.log(
                `[WHATSAPP] Requesting pairing code for ${key}: ${normalized}`
            );

            /*
             * requestPairingCode must only happen once for this
             * socket. Multiple concurrent requests can corrupt
             * pairing state.
             */
            const code =
                await sock.requestPairingCode(
                    normalized
                );

            /*
             * /stop may have happened while WhatsApp was
             * processing the request.
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

            const currentPairingState =
                getPairingState(key);

            if (!currentPairingState) {
                /*
                 * Telegram user cancelled the pairing.
                 *
                 * Do not leave this socket alive.
                 */
                await completelyResetUser(
                    key,
                    {
                        notify: false
                    }
                );

                return null;
            }

            /*
             * Save the code in memory so telegram/pair.js
             * can retrieve it if needed.
             */
            currentPairingState.code =
                String(code);

            currentPairingState.phoneNumber =
                normalized;

            currentPairingState.codeGeneratedAt =
                Date.now();

            currentPairingState.stage =
                'waiting_connection';

            /*
             * Keep the code on the session too.
             */
            session.pairingCode =
                String(code);

            console.log(
                `[WHATSAPP] Pairing code generated for ${key}: ${code}`
            );
        }

        session.connecting = true;

        return session;
    } catch (error) {
        console.error(
            `[WHATSAPP] Failed to create session for ${key}:`,
            error
        );

        /*
         * Do not let a failed socket survive.
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

function getWhatsAppSession(userId) {
    return getSessions()[
        String(userId)
    ] || null;
}

function isWhatsAppConnected(userId) {
    const session =
        getWhatsAppSession(userId);

    return Boolean(
        session &&
        session.connected &&
        !session.stopping &&
        session.socket
    );
}

async function stopWhatsAppSession(
    userId,
    options = {}
) {
    const key = String(userId);

    const {
        removeAuth = false
    } = options;

    const sessions = getSessions();
    const session = sessions[key];

    if (!session) {
        /*
         * Even if no in-memory session exists,
         * optionally remove stale auth files.
         */
        if (removeAuth) {
            removeDirectory(
                getSessionDir(key)
            );
        }

        clearPairingState(key);

        return false;
    }

    session.stopping = true;
    session.connected = false;
    session.connecting = false;
    session.reconnecting = false;

    if (session.reconnectTimer) {
        clearTimeout(
            session.reconnectTimer
        );

        session.reconnectTimer = null;
    }

    clearPairingState(key);

    const socket = session.socket;

    session.socket = null;

    if (socket) {
        try {
            if (
                typeof socket.end ===
                'function'
            ) {
                socket.end(
                    new Error(
                        'SolvaX MD session stopped'
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
        sessions[key] === session
    ) {
        delete sessions[key];
    }

    if (removeAuth) {
        removeDirectory(
            getSessionDir(key)
        );
    }

    return true;
}

async function restoreSessions() {
    ensureAuthRoot();

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
            '[WHATSAPP] Failed reading sessions directory:',
            error
        );

        return;
    }

    for (
        const entry of entries
    ) {
        if (!entry.isDirectory()) {
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
         * A directory without creds.json is not a valid
         * saved WhatsApp session.
         */
        if (!fs.existsSync(credsFile)) {
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
             * Give Baileys a moment before moving on to the
             * next saved account.
             */
            await sleep(250);
        } catch (error) {
            console.error(
                `[WHATSAPP] Failed restoring session ${userId}:`,
                error
            );

            /*
             * A broken restored session should not remain
             * indefinitely.
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

async function stopAllWhatsAppSessions(
    options = {}
) {
    const {
        removeAuth = false
    } = options;

    const sessions =
        getSessions();

    const userIds =
        Object.keys(sessions);

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
     * Clear pairing states too.
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

    getDisconnectCode,

    getDisconnectMessage,

    jidNumber
};
