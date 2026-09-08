const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const { sleep, isLoggedOut, jidNumber, log } = require('./helpers');
const { enqueueCommand } = require('./queue');

async function createWhatsAppSession(userId, number, telegramContext) {
    const sessionFolder = `auth_tg_${userId}`;
    const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: false,
        browser: ['SolvaX MD Bot', 'Chrome', '1.0.0'],
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

    global.sessions[userId] = session;
    sock.ev.on('creds.update', saveCreds);

    // Connection events
    sock.ev.on('connection.update', async update => {
        const { connection, lastDisconnect } = update;
        const currentSession = global.sessions[userId];
        if (!currentSession) return;

        if (connection === 'open') {
            currentSession.connected = true;
            currentSession.state = 'connected';
            currentSession.reconnecting = false;
            log(`✅ WhatsApp connected: ${number}`);
            try {
                await global.bot.telegram.sendMessage(userId,
                    `✅ *WhatsApp connected successfully!*\n\n📱 Number: ${number}\n\nSend .menu on WhatsApp to get started.`,
                    { parse_mode: 'Markdown' }
                );
            } catch (e) {}
        }

        if (connection === 'close') {
            currentSession.connected = false;
            const loggedOut = isLoggedOut(lastDisconnect?.error);
            if (loggedOut || currentSession.stopped) {
                delete global.sessions[userId];
                log(`🔴 WhatsApp logged out: ${number}`);
                try {
                    await global.bot.telegram.sendMessage(userId,
                        `🔴 Your WhatsApp was unlinked.\n\nDevice: ${number}\nUse /pair to re‑link.`
                    );
                } catch (e) {}
                return;
            }
            if (currentSession.reconnecting) return;
            currentSession.reconnecting = true;
            currentSession.state = 'connecting';
            log(`♻️ Reconnecting ${number}...`);
            try {
                await sleep(3000);
                if (global.sessions[userId] && !global.sessions[userId].stopped) {
                    await createWhatsAppSession(userId, number, telegramContext);
                }
            } catch (error) {
                log(`❌ Reconnect failed: ${error.message}`, 'error');
                if (global.sessions[userId]) {
                    global.sessions[userId].reconnecting = false;
                    global.sessions[userId].state = 'disconnected';
                }
            }
        }
    });

    // Message handler
    sock.ev.on('messages.upsert', async event => {
        try {
            const messages = event.messages || [];
            for (const msg of messages) {
                if (!msg?.message || msg.key?.fromMe) continue;
                const sender = msg.key?.remoteJid;
                if (!sender || sender === 'status@broadcast') continue;
                const isGroup = sender.endsWith('@g.us');
                const senderNumber = msg.key?.participant ? jidNumber(msg.key.participant) : jidNumber(sender);
                const text = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();
                if (!text) continue;
                log(`[MSG] ${text} from ${senderNumber}`);
                enqueueCommand(async () => {
                    await global.handleWhatsAppCommand(sock, msg, sender, senderNumber, isGroup, text, userId);
                });
            }
        } catch (error) {
            log(`❌ Message handler error: ${error.message}`, 'error');
        }
    });

    return sock;
}

function attachMessageHandler(sock, userId) {
    // Already handled inside createWhatsAppSession
}

module.exports = { createWhatsAppSession, attachMessageHandler };