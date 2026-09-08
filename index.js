const { Telegraf } = require('telegraf');
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const fetch = require('node-fetch');
const fs = require('fs');
const sharp = require('sharp');

// ============================================================
//  CONFIGURATION
// ============================================================
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
const BOT_TOKEN = process.env.BOT_TOKEN;
const OWNER_NUMBER = config.ownerNumber.replace(/\D/g, '');
const BOT_NAME = config.botName;
const OWNER_NAME = config.ownerName;
const CO_OWNERS = config.coOwners.map(n => n.replace(/\D/g, ''));
const AUTO_DELETE_LOADING = config.autoDeleteLoading !== undefined ? config.autoDeleteLoading : true;
const VV_METHODS = config.vvMethods || 5;
const PLAY_SOURCES = config.playSources || 3;

if (!BOT_TOKEN) {
    console.error('❌ BOT_TOKEN environment variable is missing!');
    process.exit(1);
}

// ============================================================
//  DATABASE WITH WRITE QUEUE
// ============================================================
const DB_FILE = './database.json';
let db = { antilink: {}, antimention: {}, antiviewonce: {}, antibot: {} };
let dbWriteQueue = [];
let dbWriteTimer = null;

function loadDatabase() {
    if (fs.existsSync(DB_FILE)) {
        try {
            db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        } catch (e) {
            db = { antilink: {}, antimention: {}, antiviewonce: {}, antibot: {} };
        }
    }
}
loadDatabase();

function saveDatabase() {
    dbWriteQueue.push(Date.now());
    if (dbWriteTimer) clearTimeout(dbWriteTimer);
    dbWriteTimer = setTimeout(() => {
        try {
            fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
        } catch (e) {}
        dbWriteQueue = [];
        dbWriteTimer = null;
    }, 5000);
}

function getAntiSettings(groupId, type) {
    if (!db[type]) db[type] = {};
    if (!db[type][groupId]) {
        db[type][groupId] = { enabled: false, action: 'kick', adminAllowed: true, warns: 3, warnings: {} };
    }
    return db[type][groupId];
}

function updateAntiSettings(groupId, type, key, value) {
    if (!db[type]) db[type] = {};
    if (!db[type][groupId]) {
        db[type][groupId] = { enabled: false, action: 'kick', adminAllowed: true, warns: 3, warnings: {} };
    }
    db[type][groupId][key] = value;
    saveDatabase();
}

// ============================================================
//  TELEGRAM BOT
// ============================================================
const bot = new Telegraf(BOT_TOKEN);
const sessions = {};
const pairingStates = {}; // { userId: { step, timestamp, timeoutId } }

// Command queue - first come first serve
let commandQueue = [];
let isProcessing = false;

function processQueue() {
    if (isProcessing || commandQueue.length === 0) return;
    isProcessing = true;
    const task = commandQueue.shift();
    task().then(() => {
        isProcessing = false;
        processQueue();
    }).catch(() => {
        isProcessing = false;
        processQueue();
    });
}

function enqueueCommand(task) {
    commandQueue.push(task);
    if (!isProcessing) processQueue();
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================
//  TELEGRAM COMMANDS
// ============================================================

bot.start((ctx) => {
    ctx.reply(
        `⚔️ *${BOT_NAME} v11*\n` +
        `👑 Owner: ${OWNER_NAME}\n` +
        `📚 Built for Teaching & Group Management\n\n` +
        `Send /help for full command list\n` +
        `Send /pair to link your WhatsApp\n` +
        `Send /status to check connection\n` +
        `Send /stop to disconnect`,
        { parse_mode: 'Markdown' }
    );
});

bot.help((ctx) => {
    const helpText = 
`⚔️ *${BOT_NAME} v11 – Full Command List*

👑 Owner: ${OWNER_NAME}
📚 Built for Teaching & Group Management

───────────
📜 *EVERYONE (8 commands)*
───────────
.menu          → Shows this menu
.ping          → Check if bot is alive
.vv            → View view-once media
.play [song]   → Download MP3 (YouTube)
.video [song]  → Download MP4 (YouTube)
.sticker       → Convert image/video to sticker
.lyrics [song] → Get song lyrics
.groupinfo     → See group stats (private reply)

───────────
👑 *ADMIN FORCE (7 commands)*
───────────
.tagall        → Mention everyone
.tagadmin      → Mention all admins
.add [number]  → Add person to group
.kick @tag     → Remove tagged person
.promote @tag  → Make admin (any admin can use)
.demote @tag   → Remove admin (any admin can use)
.mute on/off   → Close/open chat (admins only)
.lock/.unlock  → Aliases for mute on/off

───────────
🛡️ *ANTI-SYSTEM (4 commands)*
───────────
.antilink      → Block links in group
.antimention   → Block @all spam
.antiviewonce  → Block view-once messages
.antibot       → Block other bots

All anti commands have 6 options:
on/off | kick/delete|warn | admin on/off | warns <n> | resetwarns | clearwarns @tag

───────────
📲 *TELEGRAM COMMANDS*
───────────
/start   → Welcome message
/help    → This full list
/pair    → Link WhatsApp (asks for number)
/status  → Check connection
/stop    → Disconnect WhatsApp

───────────
💡 *Private vs Public:*
Music, video, lyrics, admin commands → Public (group sees).
Menu, ping, vv, sticker, groupinfo, anti warnings → Private (only you see).`;
    ctx.reply(helpText, { parse_mode: 'Markdown' });
});

// ---------- /pair (Conversational) ----------
bot.command('pair', async (ctx) => {
    const userId = ctx.from.id;

    if (sessions[userId] && sessions[userId].connected) {
        return ctx.reply('⚠️ You already have an active WhatsApp session. Use /status to check.');
    }

    if (pairingStates[userId]) {
        return ctx.reply('⏳ You already have a pending pairing request. Send your number now.');
    }

    await ctx.reply(
        `📱 Please send your WhatsApp number with country code.\n` +
        `Example: 2349012345678 (Nigeria)\n` +
        `(No + sign, no leading zero)\n\n` +
        `⏳ Send your number in the next 90 seconds.`
    );

    // Set timeout to auto-cancel after 90 seconds
    const timeoutId = setTimeout(() => {
        if (pairingStates[userId]) {
            delete pairingStates[userId];
            ctx.reply('⏳ Pairing request timed out. Send /pair again to start over.');
        }
    }, 90000); // 90 seconds

    pairingStates[userId] = {
        step: 'awaiting_number',
        timestamp: Date.now(),
        timeoutId: timeoutId
    };
});

// ---------- Handle number input (for /pair) ----------
bot.on('text', async (ctx) => {
    const userId = ctx.from.id;
    const text = ctx.message.text.trim();

    if (pairingStates[userId] && pairingStates[userId].step === 'awaiting_number') {
        // Clear the timeout so it doesn't fire after we've received the number
        if (pairingStates[userId].timeoutId) {
            clearTimeout(pairingStates[userId].timeoutId);
        }

        const cleanNumber = text.replace(/\D/g, '');
        if (cleanNumber.length < 10 || cleanNumber.length > 15) {
            return ctx.reply('❌ Invalid number. Use format: 2349012345678 (country code + number)');
        }

        if (!cleanNumber.startsWith('234')) {
            return ctx.reply('❌ Please include Nigeria country code (234) before your number.\nExample: 2349012345678');
        }

        delete pairingStates[userId];

        await ctx.reply(`⏳ Generating pairing code for ${cleanNumber}...\nPlease wait 5-10 seconds while I connect...`);

        try {
            const sessionFolder = `auth_tg_${userId}`;
            const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);

            const sock = makeWASocket({
                auth: state,
                printQRInTerminal: false,
                browser: ['SolvaX MD', 'Chrome', '1.0.0'],
            });

            // Wait for socket to be ready with timeout
            let socketReady = false;
            let attempts = 0;
            const maxAttempts = 10;

            while (attempts < maxAttempts && !socketReady) {
                await sleep(1000);
                attempts++;
                try {
                    if (sock.ws?.readyState === 1) {
                        socketReady = true;
                    }
                } catch (e) {}
            }

            if (!socketReady) {
                await ctx.reply('⚠️ Connection timed out. Please send /pair to try again.');
                return;
            }

            const code = await sock.requestPairingCode(cleanNumber);

            sessions[userId] = {
                sock,
                saveCreds,
                number: cleanNumber,
                connected: false,
                userId: userId,
                state: 'connecting'
            };

            // ---------- WHATSAPP EVENT HANDLERS ----------
            sock.ev.on('connection.update', (update) => {
                const { connection, lastDisconnect } = update;
                if (connection === 'open') {
                    sessions[userId].connected = true;
                    sessions[userId].state = 'connected';
                    bot.telegram.sendMessage(
                        userId,
                        `✅ *WhatsApp connected successfully!*\nNumber: ${cleanNumber}\nSend .menu to get started.`,
                        { parse_mode: 'Markdown' }
                    );
                } else if (connection === 'close') {
                    const shouldReconnect = (lastDisconnect?.error instanceof Boom)?.output?.statusCode !== DisconnectReason.loggedOut;
                    if (!shouldReconnect) {
                        sessions[userId].connected = false;
                        sessions[userId].state = 'disconnected';
                        delete sessions[userId];
                        bot.telegram.sendMessage(
                            userId,
                            '🔴 WhatsApp disconnected. Use /pair to reconnect.'
                        );
                    } else {
                        sessions[userId].state = 'connecting';
                        sessions[userId].connected = false;
                    }
                }
            });

            sock.ev.on('creds.update', saveCreds);

            // ---------- WHATSAPP MESSAGE HANDLER ----------
            sock.ev.on('messages.upsert', async (m) => {
                const msg = m.messages[0];
                if (!msg.message || msg.key.fromMe) return;

                const sender = msg.key.remoteJid;
                const senderNumber = msg.key.participant ? msg.key.participant.split('@')[0] : sender.split('@')[0];
                const isGroup = sender.endsWith('@g.us');
                const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || '').toLowerCase();

                const isPairedUser = senderNumber === cleanNumber || sender === cleanNumber + '@s.whatsapp.net';
                if (!isPairedUser) return;

                enqueueCommand(async () => {
                    await handleWhatsAppCommand(sock, msg, sender, senderNumber, isGroup, text, userId);
                });
            });

            await ctx.reply(
                `🔑 *Pairing Code:* \`${code}\`\n\n` +
                `Open WhatsApp → Linked Devices → Link with phone number\n` +
                `Type this code.\n\n` +
                `⏳ This code expires in 5 minutes.\n` +
                `If it expires, send /pair again.`,
                { parse_mode: 'Markdown' }
            );

        } catch (error) {
            console.error('Pairing error:', error);
            await ctx.reply(`❌ Error: ${error.message || 'Connection failed. Please try again.'}`);
        }
    }
});

// ---------- /status ----------
bot.command('status', (ctx) => {
    const userId = ctx.from.id;
    const session = sessions[userId];

    if (!session) {
        return ctx.reply('❌ No active session. Use /pair to link your WhatsApp.');
    }

    const state = session.state || 'disconnected';
    const number = session.number || 'Unknown';

    if (state === 'connected' && session.connected) {
        ctx.reply(`✅ WhatsApp is ONLINE and ready to use.\nNumber: ${number}`);
    } else if (state === 'connecting') {
        ctx.reply('⏳ Connecting to WhatsApp... Please wait 5-10 seconds.');
    } else if (state === 'expired') {
        ctx.reply('⚠️ Your WhatsApp session has expired. Send /pair to reconnect.');
    } else if (state === 'disconnected') {
        ctx.reply('🔴 WhatsApp is disconnected. Send /pair to reconnect.');
    } else {
        ctx.reply(`⚠️ Status: ${state}\nIf this persists, send /stop and try /pair again.`);
    }
});

// ---------- /stop ----------
bot.command('stop', (ctx) => {
    const userId = ctx.from.id;
    const session = sessions[userId];

    if (!session) {
        return ctx.reply('❌ No active session to disconnect.');
    }

    try {
        session.sock?.end();
    } catch (e) {}

    delete sessions[userId];
    ctx.reply('✅ WhatsApp disconnected successfully.');
});

// ============================================================
//  WHATSAPP COMMAND HANDLER
// ============================================================
async function handleWhatsAppCommand(sock, msg, sender, senderNumber, isGroup, text, userId) {
    // Helper functions
    const isOwner = senderNumber === OWNER_NUMBER || CO_OWNERS.includes(senderNumber);

    const isAdmin = async () => {
        if (!isGroup) return true;
        try {
            const group = await sock.groupMetadata(sender);
            const participant = group.participants.find(p => p.id === sender);
            return participant?.admin === 'admin' || participant?.admin === 'superadmin' || isOwner;
        } catch (e) { return false; }
    };

    const getGroupAdmins = async () => {
        if (!isGroup) return [];
        try {
            const group = await sock.groupMetadata(sender);
            return group.participants.filter(p => p.admin).map(p => p.id);
        } catch (e) { return []; }
    };

    const getBotAdminStatus = async () => {
        if (!isGroup) return false;
        try {
            const group = await sock.groupMetadata(sender);
            const botId = sock.user?.id || (await sock.getMe())?.id;
            const participant = group.participants.find(p => p.id === botId);
            return participant?.admin === 'admin' || participant?.admin === 'superadmin';
        } catch (e) { return false; }
    };

    async function sendLoading(loadingText) {
        if (!AUTO_DELETE_LOADING) {
            return await sock.sendMessage(sender, { text: loadingText });
        }
        const loading = await sock.sendMessage(sender, { text: loadingText });
        setTimeout(async () => {
            try {
                await sock.sendMessage(sender, { delete: { remoteJid: sender, fromMe: true, id: loading.key.id } });
            } catch (e) {}
        }, 2000);
        return loading;
    }

    // ---------- .menu ----------
    if (text === '.menu') {
        const menu = 
`╭┈〔 ✦ ${BOT_NAME} ✦ 〕┈┈┈
┊ 👑 Owner: ${OWNER_NAME}
┊ 📚 Teaching Web Devs
├┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈
┊ 📜 Everyone (8):
┊ .menu .ping .vv .play .video .sticker .lyrics .groupinfo
├┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈
┊ 👑 Admin Force (7):
┊ .tagall .tagadmin .add .kick .promote .demote .mute
├┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈┈
┊ 🛡️ Anti-System (4):
┊ .antilink .antimention .antiviewonce .antibot
╰┈┈〔 v11 │ No Spam 〕┈┈╯`;
        await sock.sendMessage(sender, { text: menu });
        return;
    }

    // ---------- .ping ----------
    if (text === '.ping') {
        await sock.sendMessage(sender, { text: '🏓 Pong! Bot is alive.' });
        return;
    }

    // ---------- .vv (View Once - 5 Methods) ----------
    if (text === '.vv') {
        await sendLoading('⏳ Attempting to decrypt view-once...');

        let success = false;
        for (let method = 1; method <= VV_METHODS; method++) {
            try {
                if (method === 1) {
                    const media = await sock.downloadMediaMessage(msg);
                    if (media) {
                        await sock.sendMessage(sender, { image: media, caption: '🔓 View-once decrypted!' });
                        success = true;
                        break;
                    }
                }
                if (method === 2) {
                    const msgObj = msg.message?.viewOnceMessage?.message || msg.message;
                    if (msgObj?.imageMessage || msgObj?.videoMessage) {
                        const url = msgObj.imageMessage?.url || msgObj.videoMessage?.url;
                        if (url) {
                            const response = await fetch(url);
                            const buffer = await response.buffer();
                            if (msgObj.imageMessage) {
                                await sock.sendMessage(sender, { image: buffer, caption: '🔓 View-once decrypted!' });
                            } else {
                                await sock.sendMessage(sender, { video: buffer, caption: '🔓 View-once decrypted!' });
                            }
                            success = true;
                            break;
                        }
                    }
                }
                if (method === 3) {
                    const msgObj = msg.message?.viewOnceMessage?.message || msg.message;
                    if (msgObj?.imageMessage || msgObj?.videoMessage) {
                        const mediaKey = msgObj.imageMessage?.mediaKey || msgObj.videoMessage?.mediaKey;
                        if (mediaKey) {
                            const media = await sock.downloadMediaMessage(msg);
                            if (media) {
                                await sock.sendMessage(sender, { image: media, caption: '🔓 View-once decrypted!' });
                                success = true;
                                break;
                            }
                        }
                    }
                }
                if (method === 4) {
                    const media = await sock.downloadMediaMessage(msg);
                    if (media) {
                        await sock.sendMessage(sender, { image: media, caption: '🔓 View-once decrypted!' });
                        success = true;
                        break;
                    }
                }
                if (method === 5) {
                    const media = await sock.downloadMediaMessage(msg);
                    if (media) {
                        await sock.sendMessage(sender, { image: media, caption: '🔓 View-once decrypted!' });
                        success = true;
                        break;
                    }
                }
            } catch (e) {}
        }

        if (!success) {
            await sock.sendMessage(sender, {
                text: '❌ Could not decrypt view-once.\nThis is a WhatsApp limitation, not a bot bug.\nTry asking sender to send normally.'
            });
        }
        return;
    }

    // ---------- .play (Music - API only) ----------
    if (text.startsWith('.play ')) {
        const song = text.replace('.play ', '');
        await sendLoading(`⏳ Searching for: ${song}`);

        let success = false;
        let attempts = 0;
        const maxAttempts = PLAY_SOURCES;

        // Source 1: Ryzendesu API
        if (!success && attempts < maxAttempts) {
            attempts++;
            try {
                const apiUrl = `https://api.ryzendesu.vip/api/download/ytmp3?text=${encodeURIComponent(song)}`;
                const response = await fetch(apiUrl);
                const data = await response.json();
                if (data.url) {
                    const audioResponse = await fetch(data.url);
                    const buffer = await audioResponse.buffer();
                    await sock.sendMessage(sender, {
                        audio: buffer,
                        mimetype: 'audio/mpeg',
                        fileName: `${song}.mp3`
                    });
                    success = true;
                }
            } catch (e) {}
        }

        // Source 2: Vevioz API
        if (!success && attempts < maxAttempts) {
            attempts++;
            try {
                const apiUrl = `https://api.vevioz.com/api/button/mp3/${encodeURIComponent(song)}`;
                const response = await fetch(apiUrl);
                const data = await response.json();
                if (data.download) {
                    const audioResponse = await fetch(data.download);
                    const buffer = await audioResponse.buffer();
                    await sock.sendMessage(sender, {
                        audio: buffer,
                        mimetype: 'audio/mpeg',
                        fileName: `${song}.mp3`
                    });
                    success = true;
                }
            } catch (e) {}
        }

        // Source 3: Alternative (add another)
        if (!success && attempts < maxAttempts) {
            attempts++;
            try {
                const apiUrl = `https://api.someother.com/ytmp3?q=${encodeURIComponent(song)}`;
                const response = await fetch(apiUrl);
                const data = await response.json();
                if (data.url) {
                    const audioResponse = await fetch(data.url);
                    const buffer = await audioResponse.buffer();
                    await sock.sendMessage(sender, {
                        audio: buffer,
                        mimetype: 'audio/mpeg',
                        fileName: `${song}.mp3`
                    });
                    success = true;
                }
            } catch (e) {}
        }

        if (!success) {
            await sock.sendMessage(sender, { text: '⚠️ All music sources are busy.\nTry again in 5 minutes.' });
        }
        return;
    }

    // ---------- .video (Video - API only) ----------
    if (text.startsWith('.video ')) {
        const video = text.replace('.video ', '');
        await sendLoading(`⏳ Searching for video: ${video}`);

        let success = false;
        let attempts = 0;
        const maxAttempts = PLAY_SOURCES;

        // Source 1: Ryzendesu API
        if (!success && attempts < maxAttempts) {
            attempts++;
            try {
                const apiUrl = `https://api.ryzendesu.vip/api/download/ytmp4?text=${encodeURIComponent(video)}`;
                const response = await fetch(apiUrl);
                const data = await response.json();
                if (data.url) {
                    const videoResponse = await fetch(data.url);
                    const buffer = await videoResponse.buffer();
                    await sock.sendMessage(sender, {
                        video: buffer,
                        mimetype: 'video/mp4',
                        fileName: `${video}.mp4`
                    });
                    success = true;
                }
            } catch (e) {}
        }

        // Source 2: Vevioz API
        if (!success && attempts < maxAttempts) {
            attempts++;
            try {
                const apiUrl = `https://api.vevioz.com/api/button/mp4/${encodeURIComponent(video)}`;
                const response = await fetch(apiUrl);
                const data = await response.json();
                if (data.download) {
                    const videoResponse = await fetch(data.download);
                    const buffer = await videoResponse.buffer();
                    await sock.sendMessage(sender, {
                        video: buffer,
                        mimetype: 'video/mp4',
                        fileName: `${video}.mp4`
                    });
                    success = true;
                }
            } catch (e) {}
        }

        // Source 3: Alternative
        if (!success && attempts < maxAttempts) {
            attempts++;
            try {
                const apiUrl = `https://api.someother.com/ytmp4?q=${encodeURIComponent(video)}`;
                const response = await fetch(apiUrl);
                const data = await response.json();
                if (data.url) {
                    const videoResponse = await fetch(data.url);
                    const buffer = await videoResponse.buffer();
                    await sock.sendMessage(sender, {
                        video: buffer,
                        mimetype: 'video/mp4',
                        fileName: `${video}.mp4`
                    });
                    success = true;
                }
            } catch (e) {}
        }

        if (!success) {
            await sock.sendMessage(sender, { text: '⚠️ All video sources are busy.\nTry again in 5 minutes.' });
        }
        return;
    }

    // ---------- .sticker ----------
    if (text === '.sticker') {
        await sendLoading('⏳ Creating sticker...');
        try {
            const media = await sock.downloadMediaMessage(msg);
            if (media) {
                const webp = await sharp(media).webp().toBuffer();
                await sock.sendMessage(sender, { sticker: webp });
            } else {
                await sock.sendMessage(sender, { text: '❌ Reply to an image/video/GIF with .sticker' });
            }
        } catch (e) {
            await sock.sendMessage(sender, { text: '❌ Could not create sticker.\nTry another image or video.' });
        }
        return;
    }

    // ---------- .lyrics ----------
    if (text.startsWith('.lyrics ')) {
        const song = text.replace('.lyrics ', '');
        await sendLoading(`⏳ Fetching lyrics for: ${song}`);

        try {
            const [artist, title] = song.split(' - ').map(s => s.trim());
            let lyricText = '';

            try {
                const response = await fetch(`https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`);
                const data = await response.json();
                if (data.lyrics) lyricText = data.lyrics;
            } catch (e) {}

            if (!lyricText) {
                try {
                    const response = await fetch(`https://some-lyrics-api.com/search?q=${encodeURIComponent(song)}`);
                    const data = await response.json();
                    if (data.lyrics) lyricText = data.lyrics;
                } catch (e) {}
            }

            if (lyricText) {
                await sock.sendMessage(sender, { text: `📜 LYRICS: ${song}\n\n${lyricText}` });
            } else {
                await sock.sendMessage(sender, { text: '⚠️ Lyrics not found.\nTry another song or check spelling.' });
            }
        } catch (e) {
            await sock.sendMessage(sender, { text: '⚠️ Lyrics not found.\nTry another song or check spelling.' });
        }
        return;
    }

    // ---------- .groupinfo ----------
    if (text === '.groupinfo') {
        if (!isGroup) {
            return await sock.sendMessage(sender, { text: '❌ Use this command in a group.' });
        }
        await sendLoading('⏳ Fetching group info...');
        try {
            const group = await sock.groupMetadata(sender);
            const admins = group.participants.filter(p => p.admin).map(p => p.id.split('@')[0]);
            const creator = group.owner || group.creator || 'Unknown';
            const memberCount = group.participants.length;

            let info = 
`📊 GROUP INFO

Name: ${group.subject}
Description: ${group.desc || 'None'}
Owner: ${creator.split('@')[0] || 'Unknown'}
Admins: ${admins.length}
Total Members: ${memberCount}
Created: ${new Date(group.creation * 1000).toLocaleDateString()}

👑 Admins:
${admins.map(a => a).join('\n')}`;

            await sock.sendMessage(sender, { text: info });
        } catch (e) {
            await sock.sendMessage(sender, { text: '⚠️ Could not fetch group info.' });
        }
        return;
    }

    // ---------- ADMIN COMMANDS ----------
    const isAdminUser = await isAdmin();
    if (!isAdminUser) return;

    // ---------- .tagall ----------
    if (text === '.tagall') {
        if (!isGroup) return await sock.sendMessage(sender, { text: '❌ Group only.' });
        await sendLoading('⏳ Fetching members...');
        try {
            const group = await sock.groupMetadata(sender);
            const mentions = group.participants.map(p => p.id);
            const msgText = '📢 @everyone\n' + mentions.map(m => `@${m.split('@')[0]}`).join(' ');
            await sock.sendMessage(sender, { text: msgText, mentions: mentions });
        } catch (e) {
            await sock.sendMessage(sender, { text: '⚠️ Could not tag all members.' });
        }
        return;
    }

    // ---------- .tagadmin ----------
    if (text === '.tagadmin') {
        if (!isGroup) return await sock.sendMessage(sender, { text: '❌ Group only.' });
        await sendLoading('⏳ Fetching admins...');
        try {
            const admins = await getGroupAdmins();
            if (admins.length === 0) return await sock.sendMessage(sender, { text: 'No admins found.' });
            const msgText = '👑 Admins:\n' + admins.map(m => `@${m.split('@')[0]}`).join(' ');
            await sock.sendMessage(sender, { text: msgText, mentions: admins });
        } catch (e) {
            await sock.sendMessage(sender, { text: '⚠️ Could not fetch admins.' });
        }
        return;
    }

    // ---------- .add ----------
    if (text.startsWith('.add ')) {
        if (!isGroup) return await sock.sendMessage(sender, { text: '❌ Group only.' });
        const num = text.replace('.add ', '').replace(/\D/g, '') + '@s.whatsapp.net';
        await sendLoading(`⏳ Adding ${num}...`);
        try {
            await sock.groupParticipantsUpdate(sender, [num], 'add');
            await sock.sendMessage(sender, { text: `✅ ${num} added to group!` });
        } catch (e) {
            const err = e.message.toLowerCase();
            if (err.includes('declined')) {
                await sock.sendMessage(sender, { text: '❌ User declined the add request.' });
            } else if (err.includes('not on whatsapp')) {
                await sock.sendMessage(sender, { text: '❌ Number not registered on WhatsApp.' });
            } else {
                await sock.sendMessage(sender, { text: `❌ Failed: ${e.message}` });
            }
        }
        return;
    }

    // ---------- .kick ----------
    if (text.startsWith('.kick ')) {
        if (!isGroup) return await sock.sendMessage(sender, { text: '❌ Group only.' });
        const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
        if (!mentioned || mentioned.length === 0) {
            return await sock.sendMessage(sender, { text: '❌ Tag someone to kick: .kick @tag' });
        }
        const target = mentioned[0];
        const admins = await getGroupAdmins();
        if (target === OWNER_NUMBER + '@s.whatsapp.net' || CO_OWNERS.includes(target.split('@')[0])) {
            return await sock.sendMessage(sender, { text: '❌ Cannot kick Owner.' });
        }
        if (admins.includes(target)) {
            return await sock.sendMessage(sender, { text: '❌ Cannot kick an admin.' });
        }
        await sendLoading(`⏳ Removing user...`);
        try {
            await sock.groupParticipantsUpdate(sender, [target], 'remove');
            await sock.sendMessage(sender, { text: `✅ User removed from group.` });
        } catch (e) {
            await sock.sendMessage(sender, { text: `❌ Failed: ${e.message}` });
        }
        return;
    }

    // ---------- .promote ----------
    if (text.startsWith('.promote ')) {
        if (!isGroup) return await sock.sendMessage(sender, { text: '❌ Group only.' });
        const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
        if (!mentioned || mentioned.length === 0) {
            return await sock.sendMessage(sender, { text: '❌ Tag someone to promote: .promote @tag' });
        }
        await sendLoading(`⏳ Promoting user...`);
        try {
            await sock.groupParticipantsUpdate(sender, [mentioned[0]], 'promote');
            await sock.sendMessage(sender, { text: `✅ User promoted to admin.` });
        } catch (e) {
            await sock.sendMessage(sender, { text: `❌ Failed: ${e.message}` });
        }
        return;
    }

    // ---------- .demote ----------
    if (text.startsWith('.demote ')) {
        if (!isGroup) return await sock.sendMessage(sender, { text: '❌ Group only.' });
        const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
        if (!mentioned || mentioned.length === 0) {
            return await sock.sendMessage(sender, { text: '❌ Tag someone to demote: .demote @tag' });
        }
        const target = mentioned[0];
        const admins = await getGroupAdmins();
        if (target === OWNER_NUMBER + '@s.whatsapp.net' || CO_OWNERS.includes(target.split('@')[0])) {
            return await sock.sendMessage(sender, { text: '❌ Cannot demote Owner.' });
        }
        if (!admins.includes(target)) {
            return await sock.sendMessage(sender, { text: '❌ User is not an admin.' });
        }
        await sendLoading(`⏳ Demoting user...`);
        try {
            await sock.groupParticipantsUpdate(sender, [target], 'demote');
            await sock.sendMessage(sender, { text: `✅ User demoted from admin.` });
        } catch (e) {
            await sock.sendMessage(sender, { text: `❌ Failed: ${e.message}` });
        }
        return;
    }

    // ---------- .mute on / .lock ----------
    if (text === '.mute on' || text === '.lock') {
        if (!isGroup) return await sock.sendMessage(sender, { text: '❌ Group only.' });
        const isBotAdmin = await getBotAdminStatus();
        if (!isBotAdmin) return await sock.sendMessage(sender, { text: '❌ Make me an admin first, then try again.' });
        await sendLoading(`⏳ Closing chat...`);
        try {
            await sock.groupSettingUpdate(sender, 'announcement');
            await sock.sendMessage(sender, { text: '✅ Chat closed. Only admins can send messages.' });
        } catch (e) {
            await sock.sendMessage(sender, { text: `❌ Failed: ${e.message}` });
        }
        return;
    }

    // ---------- .mute off / .unlock ----------
    if (text === '.mute off' || text === '.unlock') {
        if (!isGroup) return await sock.sendMessage(sender, { text: '❌ Group only.' });
        const isBotAdmin = await getBotAdminStatus();
        if (!isBotAdmin) return await sock.sendMessage(sender, { text: '❌ Make me an admin first, then try again.' });
        await sendLoading(`⏳ Opening chat...`);
        try {
            await sock.groupSettingUpdate(sender, 'not_announcement');
            await sock.sendMessage(sender, { text: '✅ Chat opened. Everyone can send messages.' });
        } catch (e) {
            await sock.sendMessage(sender, { text: `❌ Failed: ${e.message}` });
        }
        return;
    }

    // ============================================================
    //  ANTI-SYSTEM COMMANDS
    // ============================================================

    // ---------- .antilink ----------
    if (text === '.antilink') {
        const groupId = isGroup ? sender.split('@')[0] : 'private';
        const settings = getAntiSettings(groupId, 'antilink');
        const status = settings.enabled ? '🟢 ON' : '🔴 OFF';
        const actionEmoji = settings.action === 'kick' ? '👢' : settings.action === 'delete' ? '🗑️' : '⚠️';
        const panel = 
`╭─⚔ ⚔ ANTILINK ⚔
┊ ✧ STATUS
╰─⚔
◆ Enabled     : ${status}
◆ Action      : ${actionEmoji} ${settings.action.toUpperCase()}
◆ Allow Admins: ${settings.adminAllowed ? '✅ Yes' : '❌ No'}
◆ Max Warns   : ${settings.warns}
◆ Commands: .antilink on|off kick|delete|warn admin on|off warns <n> resetwarns @ clearwarns @tag`;
        await sock.sendMessage(sender, { text: panel });
        return;
    }

    if (text.startsWith('.antilink ')) {
        const args = text.replace('.antilink ', '').split(' ');
        const opt = args[0];
        const val = args[1];
        const groupId = isGroup ? sender.split('@')[0] : 'private';
        const settings = getAntiSettings(groupId, 'antilink');

        if (opt === 'on') { settings.enabled = true; updateAntiSettings(groupId, 'antilink', 'enabled', true); }
        else if (opt === 'off') { settings.enabled = false; updateAntiSettings(groupId, 'antilink', 'enabled', false); }
        else if (opt === 'kick') { settings.action = 'kick'; updateAntiSettings(groupId, 'antilink', 'action', 'kick'); }
        else if (opt === 'delete') { settings.action = 'delete'; updateAntiSettings(groupId, 'antilink', 'action', 'delete'); }
        else if (opt === 'warn') { settings.action = 'warn'; updateAntiSettings(groupId, 'antilink', 'action', 'warn'); }
        else if (opt === 'admin' && val === 'on') { settings.adminAllowed = true; updateAntiSettings(groupId, 'antilink', 'adminAllowed', true); }
        else if (opt === 'admin' && val === 'off') { settings.adminAllowed = false; updateAntiSettings(groupId, 'antilink', 'adminAllowed', false); }
        else if (opt === 'warns') { settings.warns = parseInt(val) || 3; updateAntiSettings(groupId, 'antilink', 'warns', parseInt(val) || 3); }
        else if (opt === 'resetwarns') { settings.warnings = {}; updateAntiSettings(groupId, 'antilink', 'warnings', {}); }
        else if (opt === 'clearwarns') {
            const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
            if (mentioned && mentioned.length > 0) {
                delete settings.warnings[mentioned[0]];
                updateAntiSettings(groupId, 'antilink', 'warnings', settings.warnings);
            } else {
                return await sock.sendMessage(sender, { text: '❌ Tag the user: .antilink clearwarns @tag' });
            }
        } else {
            return await sock.sendMessage(sender, { text: '❌ Invalid option. Use: on|off kick|delete|warn admin on|off warns <n> resetwarns @ clearwarns @tag' });
        }
        await sock.sendMessage(sender, { text: `✅ Antilink updated.` });
        return;
    }

    // ---------- .antimention ----------
    if (text === '.antimention') {
        const groupId = isGroup ? sender.split('@')[0] : 'private';
        const settings = getAntiSettings(groupId, 'antimention');
        const status = settings.enabled ? '🟢 ON' : '🔴 OFF';
        const actionEmoji = settings.action === 'kick' ? '👢' : settings.action === 'delete' ? '🗑️' : '⚠️';
        const panel = 
`╭─⚔ ⚔ ANTIMENTION ⚔
┊ ✧ STATUS
╰─⚔
◆ Enabled     : ${status}
◆ Action      : ${actionEmoji} ${settings.action.toUpperCase()}
◆ Allow Admins: ${settings.adminAllowed ? '✅ Yes' : '❌ No'}
◆ Max Warns   : ${settings.warns}
◆ Commands: .antimention on|off kick|delete|warn admin on|off warns <n> resetwarns @ clearwarns @tag`;
        await sock.sendMessage(sender, { text: panel });
        return;
    }

    if (text.startsWith('.antimention ')) {
        const args = text.replace('.antimention ', '').split(' ');
        const opt = args[0];
        const val = args[1];
        const groupId = isGroup ? sender.split('@')[0] : 'private';
        const settings = getAntiSettings(groupId, 'antimention');

        if (opt === 'on') { settings.enabled = true; updateAntiSettings(groupId, 'antimention', 'enabled', true); }
        else if (opt === 'off') { settings.enabled = false; updateAntiSettings(groupId, 'antimention', 'enabled', false); }
        else if (opt === 'kick') { settings.action = 'kick'; updateAntiSettings(groupId, 'antimention', 'action', 'kick'); }
        else if (opt === 'delete') { settings.action = 'delete'; updateAntiSettings(groupId, 'antimention', 'action', 'delete'); }
        else if (opt === 'warn') { settings.action = 'warn'; updateAntiSettings(groupId, 'antimention', 'action', 'warn'); }
        else if (opt === 'admin' && val === 'on') { settings.adminAllowed = true; updateAntiSettings(groupId, 'antimention', 'adminAllowed', true); }
        else if (opt === 'admin' && val === 'off') { settings.adminAllowed = false; updateAntiSettings(groupId, 'antimention', 'adminAllowed', false); }
        else if (opt === 'warns') { settings.warns = parseInt(val) || 3; updateAntiSettings(groupId, 'antimention', 'warns', parseInt(val) || 3); }
        else if (opt === 'resetwarns') { settings.warnings = {}; updateAntiSettings(groupId, 'antimention', 'warnings', {}); }
        else if (opt === 'clearwarns') {
            const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
            if (mentioned && mentioned.length > 0) {
                delete settings.warnings[mentioned[0]];
                updateAntiSettings(groupId, 'antimention', 'warnings', settings.warnings);
            } else {
                return await sock.sendMessage(sender, { text: '❌ Tag the user: .antimention clearwarns @tag' });
            }
        } else {
            return await sock.sendMessage(sender, { text: '❌ Invalid option. Use: on|off kick|delete|warn admin on|off warns <n> resetwarns @ clearwarns @tag' });
        }
        await sock.sendMessage(sender, { text: `✅ Antimention updated.` });
        return;
    }

    // ---------- .antiviewonce ----------
    if (text === '.antiviewonce') {
        const groupId = isGroup ? sender.split('@')[0] : 'private';
        const settings = getAntiSettings(groupId, 'antiviewonce');
        const status = settings.enabled ? '🟢 ON' : '🔴 OFF';
        const actionEmoji = settings.action === 'kick' ? '👢' : settings.action === 'delete' ? '🗑️' : '⚠️';
        const panel = 
`╭─⚔ ⚔ ANTIVIEWONCE ⚔
┊ ✧ STATUS
╰─⚔
◆ Enabled     : ${status}
◆ Action      : ${actionEmoji} ${settings.action.toUpperCase()}
◆ Allow Admins: ${settings.adminAllowed ? '✅ Yes' : '❌ No'}
◆ Max Warns   : ${settings.warns}
◆ Commands: .antiviewonce on|off kick|delete|warn admin on|off warns <n> resetwarns @ clearwarns @tag`;
        await sock.sendMessage(sender, { text: panel });
        return;
    }

    if (text.startsWith('.antiviewonce ')) {
        const args = text.replace('.antiviewonce ', '').split(' ');
        const opt = args[0];
        const val = args[1];
        const groupId = isGroup ? sender.split('@')[0] : 'private';
        const settings = getAntiSettings(groupId, 'antiviewonce');

        if (opt === 'on') { settings.enabled = true; updateAntiSettings(groupId, 'antiviewonce', 'enabled', true); }
        else if (opt === 'off') { settings.enabled = false; updateAntiSettings(groupId, 'antiviewonce', 'enabled', false); }
        else if (opt === 'kick') { settings.action = 'kick'; updateAntiSettings(groupId, 'antiviewonce', 'action', 'kick'); }
        else if (opt === 'delete') { settings.action = 'delete'; updateAntiSettings(groupId, 'antiviewonce', 'action', 'delete'); }
        else if (opt === 'warn') { settings.action = 'warn'; updateAntiSettings(groupId, 'antiviewonce', 'action', 'warn'); }
        else if (opt === 'admin' && val === 'on') { settings.adminAllowed = true; updateAntiSettings(groupId, 'antiviewonce', 'adminAllowed', true); }
        else if (opt === 'admin' && val === 'off') { settings.adminAllowed = false; updateAntiSettings(groupId, 'antiviewonce', 'adminAllowed', false); }
        else if (opt === 'warns') { settings.warns = parseInt(val) || 3; updateAntiSettings(groupId, 'antiviewonce', 'warns', parseInt(val) || 3); }
        else if (opt === 'resetwarns') { settings.warnings = {}; updateAntiSettings(groupId, 'antiviewonce', 'warnings', {}); }
        else if (opt === 'clearwarns') {
            const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
            if (mentioned && mentioned.length > 0) {
                delete settings.warnings[mentioned[0]];
                updateAntiSettings(groupId, 'antiviewonce', 'warnings', settings.warnings);
            } else {
                return await sock.sendMessage(sender, { text: '❌ Tag the user: .antiviewonce clearwarns @tag' });
            }
        } else {
            return await sock.sendMessage(sender, { text: '❌ Invalid option. Use: on|off kick|delete|warn admin on|off warns <n> resetwarns @ clearwarns @tag' });
        }
        await sock.sendMessage(sender, { text: `✅ Antiviewonce updated.` });
        return;
    }

    // ---------- .antibot ----------
    if (text === '.antibot') {
        const groupId = isGroup ? sender.split('@')[0] : 'private';
        const settings = getAntiSettings(groupId, 'antibot');
        const status = settings.enabled ? '🟢 ON' : '🔴 OFF';
        const actionEmoji = settings.action === 'kick' ? '👢' : settings.action === 'delete' ? '🗑️' : '⚠️';
        const panel = 
`╭─⚔ ⚔ ANTIBOT ⚔
┊ ✧ STATUS
╰─⚔
◆ Enabled     : ${status}
◆ Action      : ${actionEmoji} ${settings.action.toUpperCase()}
◆ Allow Admins: ${settings.adminAllowed ? '✅ Yes' : '❌ No'}
◆ Max Warns   : ${settings.warns}
◆ Commands: .antibot on|off kick|delete|warn admin on|off warns <n> resetwarns @ clearwarns @tag`;
        await sock.sendMessage(sender, { text: panel });
        return;
    }

    if (text.startsWith('.antibot ')) {
        const args = text.replace('.antibot ', '').split(' ');
        const opt = args[0];
        const val = args[1];
        const groupId = isGroup ? sender.split('@')[0] : 'private';
        const settings = getAntiSettings(groupId, 'antibot');

        if (opt === 'on') { settings.enabled = true; updateAntiSettings(groupId, 'antibot', 'enabled', true); }
        else if (opt === 'off') { settings.enabled = false; updateAntiSettings(groupId, 'antibot', 'enabled', false); }
        else if (opt === 'kick') { settings.action = 'kick'; updateAntiSettings(groupId, 'antibot', 'action', 'kick'); }
        else if (opt === 'delete') { settings.action = 'delete'; updateAntiSettings(groupId, 'antibot', 'action', 'delete'); }
        else if (opt === 'warn') { settings.action = 'warn'; updateAntiSettings(groupId, 'antibot', 'action', 'warn'); }
        else if (opt === 'admin' && val === 'on') { settings.adminAllowed = true; updateAntiSettings(groupId, 'antibot', 'adminAllowed', true); }
        else if (opt === 'admin' && val === 'off') { settings.adminAllowed = false; updateAntiSettings(groupId, 'antibot', 'adminAllowed', false); }
        else if (opt === 'warns') { settings.warns = parseInt(val) || 3; updateAntiSettings(groupId, 'antibot', 'warns', parseInt(val) || 3); }
        else if (opt === 'resetwarns') { settings.warnings = {}; updateAntiSettings(groupId, 'antibot', 'warnings', {}); }
        else if (opt === 'clearwarns') {
            const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
            if (mentioned && mentioned.length > 0) {
                delete settings.warnings[mentioned[0]];
                updateAntiSettings(groupId, 'antibot', 'warnings', settings.warnings);
            } else {
                return await sock.sendMessage(sender, { text: '❌ Tag the user: .antibot clearwarns @tag' });
            }
        } else {
            return await sock.sendMessage(sender, { text: '❌ Invalid option. Use: on|off kick|delete|warn admin on|off warns <n> resetwarns @ clearwarns @tag' });
        }
        await sock.sendMessage(sender, { text: `✅ Antibot updated.` });
        return;
    }
}

// ============================================================
//  START BOT
// ============================================================
bot.launch().then(() => {
    console.log('🤖 SolvaX MD Telegram bot running...');
    console.log('⚔️ SolvaX MD v11 is ready!');
    console.log(`📱 Owner: ${OWNER_NUMBER}`);
    console.log(`📚 Bot: ${BOT_NAME}`);
    console.log(`🌐 Telegram: @solvax_mdbot`);
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
