const { Telegraf } = require('telegraf');
const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason
} = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fs = require('fs');
const sharp = require('sharp');

// ============================================================
// CONFIGURATION
// ============================================================

const config = JSON.parse(
    fs.readFileSync('./config.json', 'utf8')
);

const BOT_TOKEN = process.env.BOT_TOKEN;

const OWNER_NUMBER = String(config.ownerNumber || '')
    .replace(/\D/g, '');

const BOT_NAME = config.botName || 'SolvaX MD';
const OWNER_NAME = config.ownerName || 'Owner';

const CO_OWNERS = Array.isArray(config.coOwners)
    ? config.coOwners.map(n => String(n).replace(/\D/g, ''))
    : [];

const AUTO_DELETE_LOADING =
    config.autoDeleteLoading !== undefined
        ? config.autoDeleteLoading
        : true;

const PLAY_SOURCES = config.playSources || 2;

if (!BOT_TOKEN) {
    console.error('❌ BOT_TOKEN environment variable is missing!');
    process.exit(1);
}

// ============================================================
// DATABASE (with write queue to prevent corruption)
// ============================================================

const DB_FILE = './database.json';

let db = {
    antilink: {},
    antimention: {},
    antiviewonce: {},
    antibot: {}
};

let dbWriteTimer = null;

function loadDatabase() {
    if (!fs.existsSync(DB_FILE)) return;

    try {
        const loaded = JSON.parse(
            fs.readFileSync(DB_FILE, 'utf8')
        );

        db = {
            ...db,
            ...loaded
        };
    } catch (error) {
        console.error('⚠️ Database could not be loaded.');
    }
}

loadDatabase();

function saveDatabase() {
    if (dbWriteTimer) {
        clearTimeout(dbWriteTimer);
    }

    dbWriteTimer = setTimeout(() => {
        try {
            fs.writeFileSync(
                DB_FILE,
                JSON.stringify(db, null, 2)
            );
        } catch (error) {
            console.error('❌ Database save failed:', error.message);
        }

        dbWriteTimer = null;
    }, 1000);
}

function getAntiSettings(groupId, type) {
    if (!db[type]) {
        db[type] = {};
    }

    if (!db[type][groupId]) {
        db[type][groupId] = {
            enabled: false,
            action: 'kick',
            adminAllowed: true,
            warns: 3,
            warnings: {}
        };
    }

    return db[type][groupId];
}

function updateAntiSettings(groupId, type, key, value) {
    const settings = getAntiSettings(groupId, type);

    settings[key] = value;

    saveDatabase();
}

// ============================================================
// TELEGRAM BOT
// ============================================================

const bot = new Telegraf(BOT_TOKEN);

const sessions = {};
const pairingStates = {};

// ============================================================
// GENERAL HELPERS
// ============================================================

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanNumber(number) {
    return String(number || '').replace(/\D/g, '');
}

function jidNumber(jid) {
    if (!jid) return '';

    return jid
        .split('@')[0]
        .split(':')[0]
        .replace(/\D/g, '');
}

function isLoggedOut(error) {
    try {
        return (
            error instanceof Boom &&
            error.output?.statusCode === DisconnectReason.loggedOut
        );
    } catch {
        return false;
    }
}

async function fetchBuffer(url) {
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(
            `HTTP ${response.status}`
        );
    }

    const arrayBuffer = await response.arrayBuffer();

    return Buffer.from(arrayBuffer);
}

// ============================================================
// COMMAND QUEUE (first‑come, first‑serve)
// ============================================================

let commandQueue = [];
let isProcessing = false;

function enqueueCommand(task) {
    commandQueue.push(task);
    processQueue();
}

async function processQueue() {
    if (isProcessing) return;
    if (commandQueue.length === 0) return;

    isProcessing = true;

    const task = commandQueue.shift();

    try {
        await task();
    } catch (error) {
        console.error(
            '❌ Command error:',
            error.message
        );
    }

    isProcessing = false;

    setImmediate(processQueue);
}

// ============================================================
// WHATSAPP CONNECTION
// ============================================================

async function createWhatsAppSession(userId, number, telegramContext) {
    const sessionFolder = `auth_tg_${userId}`;

    const {
        state,
        saveCreds
    } = await useMultiFileAuthState(sessionFolder);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: [
            'SolvaX MD',
            'Chrome',
            '1.0.0'
        ],
        markOnlineOnConnect: false,
        syncFullHistory: false
    });

    const session = {
        sock,
        saveCreds,
        number,
        connected: false,
        userId,
        state: 'connecting',
        reconnecting: false,
        stopped: false
    };

    sessions[userId] = session;

    sock.ev.on('creds.update', saveCreds);

    // --------------------------------------------------------
    // CONNECTION UPDATE
    // --------------------------------------------------------

    sock.ev.on('connection.update', async update => {
        const {
            connection,
            lastDisconnect
        } = update;

        const currentSession = sessions[userId];

        if (!currentSession) return;

        if (connection === 'open') {
            currentSession.connected = true;
            currentSession.state = 'connected';
            currentSession.reconnecting = false;

            console.log(
                `✅ WhatsApp connected: ${number}`
            );

            try {
                await bot.telegram.sendMessage(
                    userId,
                    `✅ *WhatsApp connected successfully!*\n\n` +
                    `📱 Number: ${number}\n\n` +
                    `Send .menu on WhatsApp to get started.`,
                    {
                        parse_mode: 'Markdown'
                    }
                );
            } catch (error) {}
        }

        if (connection === 'close') {
            currentSession.connected = false;

            const error =
                lastDisconnect?.error;

            const loggedOut =
                isLoggedOut(error);

            if (
                loggedOut ||
                currentSession.stopped
            ) {
                currentSession.state =
                    'disconnected';

                delete sessions[userId];

                console.log(
                    `🔴 WhatsApp logged out: ${number}`
                );

                try {
                    await bot.telegram.sendMessage(
                        userId,
                        '🔴 WhatsApp disconnected.\n\nUse /pair to link it again.'
                    );
                } catch (e) {}

                return;
            }

            // ------------------------------------------------
            // REAL RECONNECT
            // ------------------------------------------------

            if (currentSession.reconnecting) {
                return;
            }

            currentSession.reconnecting = true;
            currentSession.state = 'connecting';

            console.log(
                `♻️ WhatsApp connection closed. Reconnecting ${number}...`
            );

            try {
                await sleep(3000);

                if (
                    sessions[userId] &&
                    !sessions[userId].stopped
                ) {
                    await createWhatsAppSession(
                        userId,
                        number,
                        telegramContext
                    );
                }
            } catch (reconnectError) {
                console.error(
                    '❌ Reconnect failed:',
                    reconnectError.message
                );

                if (sessions[userId]) {
                    sessions[userId].reconnecting = false;
                    sessions[userId].state =
                        'disconnected';
                }
            }
        }
    });

    // --------------------------------------------------------
    // WHATSAPP MESSAGE HANDLER
    // --------------------------------------------------------

    sock.ev.on(
        'messages.upsert',
        async event => {
            try {
                const messages =
                    event.messages || [];

                for (const msg of messages) {
                    if (!msg?.message) continue;
                    if (msg.key?.fromMe) continue;

                    const sender =
                        msg.key?.remoteJid;

                    if (!sender) continue;

                    if (
                        sender === 'status@broadcast'
                    ) {
                        continue;
                    }

                    const isGroup =
                        sender.endsWith('@g.us');

                    const senderNumber =
                        msg.key?.participant
                            ? jidNumber(
                                  msg.key.participant
                              )
                            : jidNumber(sender);

                    const text = (
                        msg.message?.conversation ||
                        msg.message?.extendedTextMessage?.text ||
                        ''
                    ).trim();

                    if (!text) continue;

                    enqueueCommand(
                        async () => {
                            await handleWhatsAppCommand(
                                sock,
                                msg,
                                sender,
                                senderNumber,
                                isGroup,
                                text,
                                userId
                            );
                        }
                    );
                }
            } catch (error) {
                console.error(
                    '❌ Message handler error:',
                    error.message
                );
            }
        }
    );

    return sock;
}

// ============================================================
// TELEGRAM START
// ============================================================

bot.start(async ctx => {
    await ctx.reply(
        `⚔️ *${BOT_NAME} v11*\n\n` +
        `👑 Owner: ${OWNER_NAME}\n` +
        `📚 Built for Teaching & Group Management\n\n` +
        `Send /help for commands.\n` +
        `Send /pair to link WhatsApp.\n` +
        `Send /status to check connection.\n` +
        `Send /stop to disconnect.`,
        {
            parse_mode: 'Markdown'
        }
    );
});

// ============================================================
// TELEGRAM HELP
// ============================================================

bot.help(async ctx => {
    const helpText =
`⚔️ *${BOT_NAME} v11*

👑 Owner: ${OWNER_NAME}
📚 Teaching Web Devs

━━━━━━━━━━━━━━━━

📜 *EVERYONE*

.menu
.ping
.vv
.play [song]
.video [song]
.sticker
.lyrics [artist - title]
.groupinfo

━━━━━━━━━━━━━━━━

👑 *ADMIN*

.tagall
.tagadmin
.add [number]
.kick @tag
.promote @tag
.demote @tag
.mute on
.mute off
.lock
.unlock

━━━━━━━━━━━━━━━━

🛡️ *ANTI-SYSTEM*

.antilink
.antimention
.antiviewonce
.antibot

Options:

on
off
kick
delete
warn
admin on
admin off
warns <number>
resetwarns
clearwarns @tag

━━━━━━━━━━━━━━━━

📲 *TELEGRAM*

/start
/help
/pair
/status
/stop`;

    await ctx.reply(
        helpText,
        {
            parse_mode: 'Markdown'
        }
    );
});

// ============================================================
// TELEGRAM /PAIR
// ============================================================

bot.command('pair', async ctx => {
    const userId = ctx.from.id;

    const existing =
        sessions[userId];

    if (
        existing &&
        (
            existing.connected ||
            existing.state === 'connecting'
        )
    ) {
        return ctx.reply(
            '⚠️ You already have a WhatsApp session.\n\nUse /status to check it.'
        );
    }

    if (pairingStates[userId]) {
        return ctx.reply(
            '⏳ A pairing request is already waiting for your number.'
        );
    }

    await ctx.reply(
        `📱 Send your WhatsApp number with country code.\n\n` +
        `Example:\n` +
        `2349012345678\n\n` +
        `No + sign.\n` +
        `No leading zero.\n\n` +
        `⏳ You have 90 seconds.`
    );

    const timeoutId =
        setTimeout(() => {
            if (pairingStates[userId]) {
                delete pairingStates[userId];

                ctx.reply(
                    '⏳ Pairing request timed out.\n\nSend /pair again.'
                ).catch(() => {});
            }
        }, 90000);

    pairingStates[userId] = {
        step: 'awaiting_number',
        timeoutId
    };
});

// ============================================================
// TELEGRAM TEXT HANDLER (receives the number)
// ============================================================

bot.on('text', async ctx => {
    const userId = ctx.from.id;

    if (
        !pairingStates[userId] ||
        pairingStates[userId].step !== 'awaiting_number'
    ) {
        return;
    }

    const text =
        ctx.message.text.trim();

    const clean =
        cleanNumber(text);

    if (
        clean.length < 10 ||
        clean.length > 15
    ) {
        return ctx.reply(
            '❌ Invalid number.\n\nExample: 2349012345678'
        );
    }

    if (!clean.startsWith('234')) {
        return ctx.reply(
            '❌ This bot currently accepts Nigerian numbers only.\n\nExample: 2349012345678'
        );
    }

    clearTimeout(
        pairingStates[userId].timeoutId
    );

    delete pairingStates[userId];

    await ctx.reply(
        `⏳ Generating pairing code for ${clean}...`
    );

    try {
        // ----------------------------------------------------
        // CREATE WHATSAPP SOCKET
        // ----------------------------------------------------

        const sessionFolder = `auth_tg_${userId}`;

        const {
            state,
            saveCreds
        } = await useMultiFileAuthState(sessionFolder);

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: [
                'Mac OS',
                'Chrome',
                '10.15.7'
            ],
            markOnlineOnConnect: false,
            syncFullHistory: false
        });

        // Save credentials
        sock.ev.on('creds.update', saveCreds);

        // ----------------------------------------------------
        // REQUEST PAIRING CODE WHEN BAILEYS STARTS CONNECTING
        // ----------------------------------------------------

        let pairingCodeRequested = false;
        let pairingCodeResolve;
        let pairingCodeReject;

        const pairingCodePromise = new Promise((resolve, reject) => {
            pairingCodeResolve = resolve;
            pairingCodeReject = reject;
        });

        const pairingTimeout = setTimeout(() => {
            pairingCodeReject(
                new Error('Timed out waiting for WhatsApp to start connecting')
            );
        }, 20000);

        sock.ev.on('connection.update', async (update) => {

            const {
                connection,
                qr,
                lastDisconnect
            } = update;

            // ------------------------------------------------
            // BAILEYS HAS STARTED CONNECTING
            // ------------------------------------------------

            if (
                !pairingCodeRequested &&
                !state.creds.registered &&
                (connection === 'connecting' || qr)
            ) {

                pairingCodeRequested = true;

                try {

                    console.log(
                        `[PAIR] WhatsApp connecting for ${clean}`
                    );

                    const code =
                        await sock.requestPairingCode(clean);

                    clearTimeout(pairingTimeout);

                    console.log(
                        `[PAIR] Pairing code generated: ${code}`
                    );

                    pairingCodeResolve(code);

                } catch (err) {

                    clearTimeout(pairingTimeout);

                    console.error(
                        '[PAIR] Pairing code error:',
                        err
                    );

                    pairingCodeReject(err);
                }
            }

            // ------------------------------------------------
            // CONNECTION OPEN
            // ------------------------------------------------

            if (connection === 'open') {

                console.log(
                    `[WHATSAPP] Connected: ${clean}`
                );
            }

            // ------------------------------------------------
            // CONNECTION CLOSED
            // ------------------------------------------------

            if (connection === 'close') {

                const statusCode =
                    lastDisconnect?.error?.output?.statusCode;

                console.log(
                    `[WHATSAPP] Connection closed. Status: ${statusCode || 'unknown'}`
                );
            }
        });

        // ----------------------------------------------------
        // WAIT FOR THE ACTUAL PAIRING CODE
        // ----------------------------------------------------

        const code = await pairingCodePromise;

        // ----------------------------------------------------
        // STORE SESSION
        // ----------------------------------------------------

        sessions[userId] = {
            sock,
            saveCreds,
            number: clean,
            connected: false,
            userId,
            state: 'connecting',
            reconnecting: false,
            stopped: false
        };

        // ----------------------------------------------------
        // CONNECTION EVENTS (already attached above, but we keep them)
        // The connection.update listener is already defined.
        // We still need to forward the open/close to the session.
        // We'll just rely on the listener above.

        // ----------------------------------------------------
        // MESSAGE HANDLER (attached inside createWhatsAppSession? Actually we already have it above)
        // We'll attach it here as well – but we can reuse the existing one.
        // We'll add a new one to be safe.

        sock.ev.on(
            'messages.upsert',
            async event => {
                try {
                    for (
                        const msg of
                        event.messages || []
                    ) {
                        if (!msg?.message) continue;
                        if (msg.key?.fromMe) continue;

                        const sender =
                            msg.key?.remoteJid;

                        if (!sender) continue;

                        if (
                            sender === 'status@broadcast'
                        ) {
                            continue;
                        }

                        const isGroup =
                            sender.endsWith('@g.us');

                        const senderNumber =
                            msg.key?.participant
                                ? jidNumber(
                                      msg.key.participant
                                  )
                                : jidNumber(sender);

                        const messageText =
                            (
                                msg.message?.conversation ||
                                msg.message?.extendedTextMessage?.text ||
                                ''
                            ).trim();

                        if (!messageText) continue;

                        enqueueCommand(
                            async () => {
                                await handleWhatsAppCommand(
                                    sock,
                                    msg,
                                    sender,
                                    senderNumber,
                                    isGroup,
                                    messageText,
                                    userId
                                );
                            }
                        );
                    }
                } catch (error) {
                    console.error(
                        'Message error:',
                        error.message
                    );
                }
            }
        );

        // ----------------------------------------------------
        // SEND THE PAIRING CODE TO TELEGRAM
        // ----------------------------------------------------

        await ctx.reply(
            `🔑 *PAIRING CODE*\n\n` +
            `\`${code}\`\n\n` +
            `Open WhatsApp → Linked Devices → Link with phone number.\n\n` +
            `Enter the code above.\n\n` +
            `⏳ The code is temporary. Complete linking promptly.`,
            {
                parse_mode: 'Markdown'
            }
        );

    } catch (error) {
        console.error(
            '❌ Pairing error:',
            error
        );

        delete sessions[userId];

        await ctx.reply(
            `❌ Pairing failed.\n\n` +
            `${error.message || 'Unknown error'}\n\n` +
            `Send /pair and try again.`
        );
    }
});

// ============================================================
// /STATUS
// ============================================================

bot.command('status', async ctx => {
    const userId = ctx.from.id;

    const session =
        sessions[userId];

    if (!session) {
        return ctx.reply(
            '❌ No active WhatsApp session.\n\nUse /pair to link WhatsApp.'
        );
    }

    const number =
        session.number || 'Unknown';

    if (
        session.connected &&
        session.state === 'connected'
    ) {
        return ctx.reply(
            `✅ WhatsApp is ONLINE.\n\n📱 Number: ${number}`
        );
    }

    if (
        session.state === 'connecting'
    ) {
        return ctx.reply(
            `⏳ WhatsApp is CONNECTING.\n\n📱 Number: ${number}`
        );
    }

    return ctx.reply(
        `🔴 WhatsApp is not connected.\n\n📱 Number: ${number}\n\nUse /pair to reconnect.`
    );
});

// ============================================================
// /STOP
// ============================================================

bot.command('stop', async ctx => {
    const userId = ctx.from.id;

    const session =
        sessions[userId];

    if (!session) {
        return ctx.reply(
            '❌ No active WhatsApp session.'
        );
    }

    try {
        session.stopped = true;

        if (session.sock) {
            session.sock.end(
                undefined
            );
        }
    } catch (error) {}

    delete sessions[userId];

    await ctx.reply(
        '✅ WhatsApp disconnected.'
    );
});

// ============================================================
// WHATSAPP COMMAND HANDLER
// ============================================================

async function handleWhatsAppCommand(
    sock,
    msg,
    sender,
    senderNumber,
    isGroup,
    rawText,
    userId
) {
    const text =
        rawText.toLowerCase();

    // --------------------------------------------------------
    // HELPERS
    // --------------------------------------------------------

    const isOwner =
        senderNumber === OWNER_NUMBER ||
        CO_OWNERS.includes(senderNumber);

    async function getGroup() {
        if (!isGroup) return null;

        try {
            return await sock.groupMetadata(
                sender
            );
        } catch {
            return null;
        }
    }

    async function isAdmin() {
        if (!isGroup) return true;

        const group =
            await getGroup();

        if (!group) return false;

        const participant =
            group.participants.find(
                p => p.id === senderNumber + '@s.whatsapp.net'
            ) ||
            group.participants.find(
                p =>
                    jidNumber(p.id) ===
                    senderNumber
            );

        return Boolean(
            participant?.admin ||
            isOwner
        );
    }

    async function getGroupAdmins() {
        const group =
            await getGroup();

        if (!group) return [];

        return group.participants
            .filter(p => p.admin)
            .map(p => p.id);
    }

    async function getBotAdminStatus() {
        const group =
            await getGroup();

        if (!group) return false;

        const botJid =
            sock.user?.id;

        if (!botJid) return false;

        const botNumber =
            jidNumber(botJid);

        const participant =
            group.participants.find(
                p =>
                    jidNumber(p.id) ===
                    botNumber
            );

        return Boolean(
            participant?.admin
        );
    }

    async function sendLoading(
        loadingText
    ) {
        if (!AUTO_DELETE_LOADING) {
            return sock.sendMessage(
                sender,
                {
                    text: loadingText
                }
            );
        }

        const loading =
            await sock.sendMessage(
                sender,
                {
                    text: loadingText
                }
            );

        setTimeout(
            async () => {
                try {
                    await sock.sendMessage(
                        sender,
                        {
                            delete: {
                                remoteJid: sender,
                                fromMe: true,
                                id: loading.key.id
                            }
                        }
                    );
                } catch (e) {}
            },
            2000
        );

        return loading;
    }

    // ========================================================
    // .MENU
    // ========================================================

    if (text === '.menu') {
        const menu =
`╭┈〔 ✦ ${BOT_NAME} ✦ 〕┈┈┈
┊ 👑 Owner: ${OWNER_NAME}
┊ 📚 Teaching Web Devs
├┈┈┈┈┈┈┈┈┈┈
┊ 📜 Everyone:
┊ .menu
┊ .ping
┊ .vv
┊ .play
┊ .video
┊ .sticker
┊ .lyrics
┊ .groupinfo
├┈┈┈┈┈┈┈┈┈┈
┊ 👑 Admin:
┊ .tagall
┊ .tagadmin
┊ .add
┊ .kick
┊ .promote
┊ .demote
┊ .mute
├┈┈┈┈┈┈┈┈┈┈
┊ 🛡️ Anti-System:
┊ .antilink
┊ .antimention
┊ .antiviewonce
┊ .antibot
╰┈┈〔 v11 │ SolvaX MD 〕┈┈╯`;

        await sock.sendMessage(
            sender,
            { text: menu }
        );

        return;
    }

    // ========================================================
    // .PING
    // ========================================================

    if (text === '.ping') {
        await sock.sendMessage(
            sender,
            {
                text:
                    '🏓 Pong!\n\nBot is alive.'
            }
        );

        return;
    }

    // ========================================================
    // .VV – VIEW ONCE (5 METHODS)
    // ========================================================

    if (text === '.vv') {
        await sendLoading('⏳ Attempting to decrypt view-once...');

        let success = false;
        const methods = 5;

        for (let method = 1; method <= methods; method++) {
            try {
                let media = null;

                // ----------------------------------------------------
                // METHOD 1: Baileys downloadMediaMessage()
                // ----------------------------------------------------
                if (method === 1) {
                    media = await sock.downloadMediaMessage(msg);
                }

                // ----------------------------------------------------
                // METHOD 2: Extract URL from message
                // ----------------------------------------------------
                if (method === 2 && !media) {
                    const msgObj = msg.message?.viewOnceMessage?.message || msg.message;
                    if (msgObj?.imageMessage?.url) {
                        const url = msgObj.imageMessage.url;
                        const response = await fetch(url);
                        media = await response.buffer();
                    } else if (msgObj?.videoMessage?.url) {
                        const url = msgObj.videoMessage.url;
                        const response = await fetch(url);
                        media = await response.buffer();
                    }
                }

                // ----------------------------------------------------
                // METHOD 3: Extract with mediaKey
                // ----------------------------------------------------
                if (method === 3 && !media) {
                    const msgObj = msg.message?.viewOnceMessage?.message || msg.message;
                    if (msgObj?.imageMessage?.mediaKey || msgObj?.videoMessage?.mediaKey) {
                        media = await sock.downloadMediaMessage(msg);
                    }
                }

                // ----------------------------------------------------
                // METHOD 4: Force download via Baileys internal
                // ----------------------------------------------------
                if (method === 4 && !media) {
                    try {
                        const msgObj = msg.message?.viewOnceMessage?.message || msg.message;
                        if (msgObj?.imageMessage || msgObj?.videoMessage) {
                            const mediaKey = msgObj.imageMessage?.mediaKey || msgObj.videoMessage?.mediaKey;
                            if (mediaKey) {
                                const directPath = msgObj.imageMessage?.directPath || msgObj.videoMessage?.directPath;
                                const url = msgObj.imageMessage?.url || msgObj.videoMessage?.url;
                                if (url) {
                                    const response = await fetch(url);
                                    const buffer = await response.buffer();
                                    media = buffer;
                                }
                            }
                        }
                    } catch (e) {}
                }

                // ----------------------------------------------------
                // METHOD 5: Last resort – use Baileys again
                // ----------------------------------------------------
                if (method === 5 && !media) {
                    media = await sock.downloadMediaMessage(msg);
                }

                // ----------------------------------------------------
                // If we got media, send it
                // ----------------------------------------------------
                if (media) {
                    const msgObj = msg.message?.viewOnceMessage?.message || msg.message;
                    if (msgObj?.imageMessage) {
                        await sock.sendMessage(sender, {
                            image: media,
                            caption: '🔓 View-once decrypted!'
                        });
                    } else if (msgObj?.videoMessage) {
                        await sock.sendMessage(sender, {
                            video: media,
                            caption: '🔓 View-once decrypted!'
                        });
                    } else {
                        await sock.sendMessage(sender, {
                            image: media,
                            caption: '🔓 View-once decrypted!'
                        });
                    }
                    success = true;
                    break;
                }

            } catch (error) {
                console.log(`Method ${method} failed:`, error.message);
            }
        }

        if (!success) {
            await sock.sendMessage(sender, {
                text: '❌ Could not decrypt view-once.\n\nThis is a WhatsApp limitation.\nTry asking the sender to send normally.'
            });
        }

        return;
    }

    // ========================================================
    // .PLAY (MUSIC)
    // ========================================================

    if (text.startsWith('.play ')) {
        const song =
            rawText
                .slice(6)
                .trim();

        if (!song) {
            return sock.sendMessage(
                sender,
                {
                    text:
                        '❌ Usage: .play song name'
                }
            );
        }

        await sendLoading(
            `⏳ Searching for: ${song}`
        );

        let success = false;
        let attempts = 0;

        // Source 1: Ryzendesu API
        if (
            !success &&
            attempts < PLAY_SOURCES
        ) {
            attempts++;

            try {
                const apiUrl =
                    `https://api.ryzendesu.vip/api/download/ytmp3?text=${encodeURIComponent(song)}`;

                const response =
                    await fetch(apiUrl);

                const data =
                    await response.json();

                if (data?.url) {
                    const buffer =
                        await fetchBuffer(
                            data.url
                        );

                    await sock.sendMessage(
                        sender,
                        {
                            audio: buffer,
                            mimetype:
                                'audio/mpeg',
                            fileName:
                                `${song}.mp3`
                        }
                    );

                    success = true;
                }
            } catch (error) {
                console.log(
                    'Play source 1 failed:',
                    error.message
                );
            }
        }

        // Source 2: Vevioz API
        if (
            !success &&
            attempts < PLAY_SOURCES
        ) {
            attempts++;

            try {
                const apiUrl =
                    `https://api.vevioz.com/api/button/mp3/${encodeURIComponent(song)}`;

                const response =
                    await fetch(apiUrl);

                const data =
                    await response.json();

                if (data?.download) {
                    const buffer =
                        await fetchBuffer(
                            data.download
                        );

                    await sock.sendMessage(
                        sender,
                        {
                            audio: buffer,
                            mimetype:
                                'audio/mpeg',
                            fileName:
                                `${song}.mp3`
                        }
                    );

                    success = true;
                }
            } catch (error) {
                console.log(
                    'Play source 2 failed:',
                    error.message
                );
            }
        }

        if (!success) {
            await sock.sendMessage(
                sender,
                {
                    text:
                        '⚠️ Music source unavailable right now.\n\nTry again later.'
                }
            );
        }

        return;
    }

    // ========================================================
    // .VIDEO
    // ========================================================

    if (text.startsWith('.video ')) {
        const video =
            rawText
                .slice(7)
                .trim();

        if (!video) {
            return sock.sendMessage(
                sender,
                {
                    text:
                        '❌ Usage: .video video name'
                }
            );
        }

        await sendLoading(
            `⏳ Searching for video: ${video}`
        );

        let success = false;
        let attempts = 0;

        // Source 1: Ryzendesu API
        if (
            !success &&
            attempts < PLAY_SOURCES
        ) {
            attempts++;

            try {
                const apiUrl =
                    `https://api.ryzendesu.vip/api/download/ytmp4?text=${encodeURIComponent(video)}`;

                const response =
                    await fetch(apiUrl);

                const data =
                    await response.json();

                if (data?.url) {
                    const buffer =
                        await fetchBuffer(
                            data.url
                        );

                    await sock.sendMessage(
                        sender,
                        {
                            video: buffer,
                            mimetype:
                                'video/mp4',
                            fileName:
                                `${video}.mp4`
                        }
                    );

                    success = true;
                }
            } catch (error) {
                console.log(
                    'Video source 1 failed:',
                    error.message
                );
            }
        }

        // Source 2: Vevioz API
        if (
            !success &&
            attempts < PLAY_SOURCES
        ) {
            attempts++;

            try {
                const apiUrl =
                    `https://api.vevioz.com/api/button/mp4/${encodeURIComponent(video)}`;

                const response =
                    await fetch(apiUrl);

                const data =
                    await response.json();

                if (data?.download) {
                    const buffer =
                        await fetchBuffer(
                            data.download
                        );

                    await sock.sendMessage(
                        sender,
                        {
                            video: buffer,
                            mimetype:
                                'video/mp4',
                            fileName:
                                `${video}.mp4`
                        }
                    );

                    success = true;
                }
            } catch (error) {
                console.log(
                    'Video source 2 failed:',
                    error.message
                );
            }
        }

        if (!success) {
            await sock.sendMessage(
                sender,
                {
                    text:
                        '⚠️ Video source unavailable right now.\n\nTry again later.'
                }
            );
        }

        return;
    }

    // ========================================================
    // .STICKER
    // ========================================================

    if (text === '.sticker') {
        await sendLoading(
            '⏳ Creating sticker...'
        );

        try {
            const media =
                await sock.downloadMediaMessage(
                    msg
                );

            if (!media) {
                return sock.sendMessage(
                    sender,
                    {
                        text:
                            '❌ Reply to an image with .sticker'
                    }
                );
            }

            const webp =
                await sharp(media)
                    .webp()
                    .toBuffer();

            await sock.sendMessage(
                sender,
                {
                    sticker: webp
                }
            );
        } catch (error) {
            await sock.sendMessage(
                sender,
                {
                    text:
                        '❌ Could not create sticker.'
                }
            );
        }

        return;
    }

    // ========================================================
    // .LYRICS
    // ========================================================

    if (text.startsWith('.lyrics ')) {
        const song =
            rawText
                .slice(8)
                .trim();

        if (!song) {
            return sock.sendMessage(
                sender,
                {
                    text:
                        '❌ Usage: .lyrics artist - song'
                }
            );
        }

        await sendLoading(
            `⏳ Searching lyrics for: ${song}`
        );

        try {
            const parts =
                song.split(' - ');

            const artist =
                parts.length > 1
                    ? parts[0].trim()
                    : '';

            const title =
                parts.length > 1
                    ? parts.slice(1).join(' - ').trim()
                    : song;

            if (!artist) {
                return sock.sendMessage(
                    sender,
                    {
                        text:
                            '❌ Use this format:\n.lyrics Artist - Song'
                    }
                );
            }

            const url =
                `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;

            const response =
                await fetch(url);

            const data =
                await response.json();

            if (!data?.lyrics) {
                return sock.sendMessage(
                    sender,
                    {
                        text:
                            '⚠️ Lyrics not found.'
                    }
                );
            }

            const lyrics =
                String(data.lyrics);

            // Avoid sending an absurdly large Telegram/WhatsApp message.
            const limitedLyrics =
                lyrics.length > 6000
                    ? lyrics.slice(0, 6000) +
                      '\n\n[lyrics truncated]'
                    : lyrics;

            await sock.sendMessage(
                sender,
                {
                    text:
                        `📜 ${song}\n\n${limitedLyrics}`
                }
            );

        } catch (error) {
            await sock.sendMessage(
                sender,
                {
                    text:
                        '⚠️ Lyrics could not be found.'
                }
            );
        }

        return;
    }

    // ========================================================
    // .GROUPINFO
    // ========================================================

    if (text === '.groupinfo') {
        if (!isGroup) {
            return sock.sendMessage(
                sender,
                {
                    text:
                        '❌ Use this command inside a group.'
                }
            );
        }

        await sendLoading(
            '⏳ Fetching group information...'
        );

        try {
            const group =
                await sock.groupMetadata(
                    sender
                );

            const admins =
                group.participants
                    .filter(
                        p => p.admin
                    )
                    .map(
                        p => jidNumber(p.id)
                    );

            const memberCount =
                group.participants.length;

            const created =
                group.creation
                    ? new Date(
                          group.creation * 1000
                      ).toLocaleDateString()
                    : 'Unknown';

            const info =
`📊 GROUP INFO

Name: ${group.subject || 'Unknown'}
Description: ${group.desc || 'None'}
Admins: ${admins.length}
Members: ${memberCount}
Created: ${created}

👑 Admins:
${admins.join('\n') || 'None'}`;

            await sock.sendMessage(
                sender,
                {
                    text: info
                }
            );

        } catch (error) {
            await sock.sendMessage(
                sender,
                {
                    text:
                        '⚠️ Could not fetch group information.'
                }
            );
        }

        return;
    }

    // ========================================================
    // ADMIN CHECK
    // ========================================================

    const admin =
        await isAdmin();

    if (!admin) {
        return;
    }

    // ========================================================
    // .TAGALL
    // ========================================================

    if (text === '.tagall') {
        if (!isGroup) {
            return sock.sendMessage(
                sender,
                {
                    text:
                        '❌ Group only.'
                }
            );
        }

        await sendLoading(
            '⏳ Fetching members...'
        );

        try {
            const group =
                await sock.groupMetadata(
                    sender
                );

            const mentions =
                group.participants.map(
                    p => p.id
                );

            const message =
                '📢 Everyone\n\n' +
                mentions
                    .map(
                        jid =>
                            `@${jidNumber(jid)}`
                    )
                    .join(' ');

            await sock.sendMessage(
                sender,
                {
                    text: message,
                    mentions
                }
            );

        } catch (error) {
            await sock.sendMessage(
                sender,
                {
                    text:
                        '⚠️ Could not tag members.'
                }
            );
        }

        return;
    }

    // ========================================================
    // .TAGADMIN
    // ========================================================

    if (text === '.tagadmin') {
        if (!isGroup) {
            return sock.sendMessage(
                sender,
                {
                    text:
                        '❌ Group only.'
                }
            );
        }

        try {
            const admins =
                await getGroupAdmins();

            if (!admins.length) {
                return sock.sendMessage(
                    sender,
                    {
                        text:
                            '❌ No admins found.'
                    }
                );
            }

            const message =
                '👑 Admins:\n\n' +
                admins
                    .map(
                        jid =>
                            `@${jidNumber(jid)}`
                    )
                    .join(' ');

            await sock.sendMessage(
                sender,
                {
                    text: message,
                    mentions: admins
                }
            );

        } catch (error) {
            await sock.sendMessage(
                sender,
                {
                    text:
                        '⚠️ Could not fetch admins.'
                }
            );
        }

        return;
    }

    // ========================================================
    // .ADD
    // ========================================================

    if (text.startsWith('.add ')) {
        if (!isGroup) {
            return sock.sendMessage(
                sender,
                {
                    text:
                        '❌ Group only.'
                }
            );
        }

        const number =
            cleanNumber(
                rawText.slice(5)
            );

        if (!number) {
            return sock.sendMessage(
                sender,
                {
                    text:
                        '❌ Usage: .add 2349012345678'
                }
            );
        }

        const target =
            `${number}@s.whatsapp.net`;

        try {
            await sock.groupParticipantsUpdate(
                sender,
                [target],
                'add'
            );

            await sock.sendMessage(
                sender,
                {
                    text:
                        `✅ ${number} processed.`
                }
            );

        } catch (error) {
            await sock.sendMessage(
                sender,
                {
                    text:
                        `❌ Failed: ${error.message}`
                }
            );
        }

        return;
    }

    // ========================================================
    // MENTION HELPER
    // ========================================================

    function getMentioned() {
        return (
            msg.message
                ?.extendedTextMessage
                ?.contextInfo
                ?.mentionedJid ||
            []
        );
    }

    // ========================================================
    // .KICK
    // ========================================================

    if (text.startsWith('.kick ')) {
        if (!isGroup) {
            return sock.sendMessage(
                sender,
                {
                    text:
                        '❌ Group only.'
                }
            );
        }

        const mentioned =
            getMentioned();

        if (!mentioned.length) {
            return sock.sendMessage(
                sender,
                {
                    text:
                        '❌ Tag the person to remove.'
                }
            );
        }

        const target =
            mentioned[0];

        const targetNumber =
            jidNumber(target);

        if (
            targetNumber ===
                OWNER_NUMBER ||
            CO_OWNERS.includes(
                targetNumber
            )
        ) {
            return sock.sendMessage(
                sender,
                {
                    text:
                        '❌ Cannot remove the owner.'
                }
            );
        }

        const admins =
            await getGroupAdmins();

        if (
            admins.some(
                jid =>
                    jidNumber(jid) ===
                    targetNumber
            )
        ) {
            return sock.sendMessage(
                sender,
                {
                    text:
                        '❌ Cannot remove an admin.'
                }
            );
        }

        try {
            await sock.groupParticipantsUpdate(
                sender,
                [target],
                'remove'
            );

            await sock.sendMessage(
                sender,
                {
                    text:
                        '✅ User removed.'
                }
            );

        } catch (error) {
            await sock.sendMessage(
                sender,
                {
                    text:
                        `❌ Failed: ${error.message}`
                }
            );
        }

        return;
    }

    // ========================================================
    // .PROMOTE
    // ========================================================

    if (text.startsWith('.promote ')) {
        if (!isGroup) {
            return sock.sendMessage(
                sender,
                {
                    text:
                        '❌ Group only.'
                }
            );
        }

        const mentioned =
            getMentioned();

        if (!mentioned.length) {
            return sock.sendMessage(
                sender,
                {
                    text:
                        '❌ Tag the person to promote.'
                }
            );
        }

        try {
            await sock.groupParticipantsUpdate(
                sender,
                [mentioned[0]],
                'promote'
            );

            await sock.sendMessage(
                sender,
                {
                    text:
                        '✅ User promoted.'
                }
            );

        } catch (error) {
            await sock.sendMessage(
                sender,
                {
                    text:
                        `❌ Failed: ${error.message}`
                }
            );
        }

        return;
    }

    // ========================================================
    // .DEMOTE
    // ========================================================

    if (text.startsWith('.demote ')) {
        if (!isGroup) {
            return sock.sendMessage(
                sender,
                {
                    text:
                        '❌ Group only.'
                }
            );
        }

        const mentioned =
            getMentioned();

        if (!mentioned.length) {
            return sock.sendMessage(
                sender,
                {
                    text:
                        '❌ Tag the person to demote.'
                }
            );
        }

        const target =
            mentioned[0];

        const targetNumber =
            jidNumber(target);

        if (
            targetNumber ===
                OWNER_NUMBER ||
            CO_OWNERS.includes(
                targetNumber
            )
        ) {
            return sock.sendMessage(
                sender,
                {
                    text:
                        '❌ Cannot demote the owner.'
                }
            );
        }

        try {
            await sock.groupParticipantsUpdate(
                sender,
                [target],
                'demote'
            );

            await sock.sendMessage(
                sender,
                {
                    text:
                        '✅ User demoted.'
                }
            );

        } catch (error) {
            await sock.sendMessage(
                sender,
                {
                    text:
                        `❌ Failed: ${error.message}`
                }
            );
        }

        return;
    }

    // ========================================================
    // .MUTE ON / .LOCK
    // ========================================================

    if (
        text === '.mute on' ||
        text === '.lock'
    ) {
        if (!isGroup) {
            return sock.sendMessage(
                sender,
                {
                    text:
                        '❌ Group only.'
                }
            );
        }

        const botAdmin =
            await getBotAdminStatus();

        if (!botAdmin) {
            return sock.sendMessage(
                sender,
                {
                    text:
                        '❌ Make the bot an admin first.'
                }
            );
        }

        try {
            await sock.groupSettingUpdate(
                sender,
                'announcement'
            );

            await sock.sendMessage(
                sender,
                {
                    text:
                        '🔒 Chat closed. Only admins can send messages.'
                }
            );

        } catch (error) {
            await sock.sendMessage(
                sender,
                {
                    text:
                        `❌ Failed: ${error.message}`
                }
            );
        }

        return;
    }

    // ========================================================
    // .MUTE OFF / .UNLOCK
    // ========================================================

    if (
        text === '.mute off' ||
        text === '.unlock'
    ) {
        if (!isGroup) {
            return sock.sendMessage(
                sender,
                {
                    text:
                        '❌ Group only.'
                }
            );
        }

        const botAdmin =
            await getBotAdminStatus();

        if (!botAdmin) {
            return sock.sendMessage(
                sender,
                {
                    text:
                        '❌ Make the bot an admin first.'
                }
            );
        }

        try {
            await sock.groupSettingUpdate(
                sender,
                'not_announcement'
            );

            await sock.sendMessage(
                sender,
                {
                    text:
                        '🔓 Chat opened. Everyone can send messages.'
                }
            );

        } catch (error) {
            await sock.sendMessage(
                sender,
                {
                    text:
                        `❌ Failed: ${error.message}`
                }
            );
        }

        return;
    }

    // ========================================================
    // ANTI COMMAND FUNCTION
    // ========================================================

    async function antiPanel(
        type,
        title
    ) {
        const groupId =
            isGroup
                ? sender.split('@')[0]
                : 'private';

        const settings =
            getAntiSettings(
                groupId,
                type
            );

        const status =
            settings.enabled
                ? '🟢 ON'
                : '🔴 OFF';

        const action =
            settings.action
                .toUpperCase();

        const panel =
`╭─⚔ ${title} ⚔
┊
◆ Enabled      : ${status}
◆ Action       : ${action}
◆ Allow Admins : ${settings.adminAllowed ? '✅ Yes' : '❌ No'}
◆ Max Warns    : ${settings.warns}
┊
◆ Commands:
◆ ${type} on
◆ ${type} off
◆ ${type} kick
◆ ${type} delete
◆ ${type} warn
◆ ${type} admin on
◆ ${type} admin off
◆ ${type} warns 3
◆ ${type} resetwarns
╰─⚔`;

        await sock.sendMessage(
            sender,
            {
                text: panel
            }
        );
    }

    async function antiCommand(
        type,
        title
    ) {
        if (
            text === `.${type}`
        ) {
            await antiPanel(
                type,
                title
            );

            return true;
        }

        if (
            !text.startsWith(
                `.${type} `
            )
        ) {
            return false;
        }

        const groupId =
            isGroup
                ? sender.split('@')[0]
                : 'private';

        const settings =
            getAntiSettings(
                groupId,
                type
            );

        const args =
            text
                .slice(
                    type.length + 2
                )
                .trim()
                .split(/\s+/);

        const option =
            args[0];

        const value =
            args[1];

        if (option === 'on') {
            updateAntiSettings(
                groupId,
                type,
                'enabled',
                true
            );
        }

        else if (option === 'off') {
            updateAntiSettings(
                groupId,
                type,
                'enabled',
                false
            );
        }

        else if (
            [
                'kick',
                'delete',
                'warn'
            ].includes(option)
        ) {
            updateAntiSettings(
                groupId,
                type,
                'action',
                option
            );
        }

        else if (
            option === 'admin' &&
            value === 'on'
        ) {
            updateAntiSettings(
                groupId,
                type,
                'adminAllowed',
                true
            );
        }

        else if (
            option === 'admin' &&
            value === 'off'
        ) {
            updateAntiSettings(
                groupId,
                type,
                'adminAllowed',
                false
            );
        }

        else if (
            option === 'warns'
        ) {
            const count =
                parseInt(value);

            if (
                !Number.isInteger(count) ||
                count < 1 ||
                count > 100
            ) {
                return sock.sendMessage(
                    sender,
                    {
                        text:
                            '❌ Warns must be between 1 and 100.'
                    }
                );
            }

            updateAntiSettings(
                groupId,
                type,
                'warns',
                count
            );
        }

        else if (
            option ===
            'resetwarns'
        ) {
            updateAntiSettings(
                groupId,
                type,
                'warnings',
                {}
            );
        }

        else if (
            option ===
            'clearwarns'
        ) {
            const mentioned =
                getMentioned();

            if (!mentioned.length) {
                return sock.sendMessage(
                    sender,
                    {
                        text:
                            `❌ Tag a user.\n\n.${type} clearwarns @tag`
                    }
                );
            }

            const updated =
                {
                    ...settings.warnings
                };

            delete updated[
                mentioned[0]
            ];

            updateAntiSettings(
                groupId,
                type,
                'warnings',
                updated
            );
        }

        else {
            return sock.sendMessage(
                sender,
                {
                    text:
                        `❌ Invalid ${type} option.`
                }
            );
        }

        await sock.sendMessage(
            sender,
            {
                text:
                    `✅ ${title} settings updated.`
            }
        );

        return true;
    }

    // ========================================================
    // ANTI SYSTEM
    // ========================================================

    if (
        await antiCommand(
            'antilink',
            'ANTILINK'
        )
    ) return;

    if (
        await antiCommand(
            'antimention',
            'ANTIMENTION'
        )
    ) return;

    if (
        await antiCommand(
            'antiviewonce',
            'ANTIVIEWONCE'
        )
    ) return;

    if (
        await antiCommand(
            'antibot',
            'ANTIBOT'
        )
    ) return;
}

// ============================================================
// START TELEGRAM BOT
// ============================================================

bot.launch({
    dropPendingUpdates: true
})
.then(() => {
    console.log(
        '🤖 SolvaX MD Telegram bot running...'
    );

    console.log(
        '⚔️ SolvaX MD v11 is ready!'
    );

    console.log(
        `📱 Owner: ${OWNER_NUMBER}`
    );

    console.log(
        `📚 Bot: ${BOT_NAME}`
    );

    console.log(
        '🌐 Telegram bot connected.'
    );
})
.catch(error => {
    console.error(
        '❌ Telegram bot failed to start:',
        error
    );
});

// ============================================================
// SHUTDOWN
// ============================================================

process.once(
    'SIGINT',
    () => {
        bot.stop('SIGINT');
    }
);

process.once(
    'SIGTERM',
    () => {
        bot.stop('SIGTERM');
    }
);
