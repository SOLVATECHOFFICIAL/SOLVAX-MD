const { sleep, cleanNumber } = require('../lib/helpers');
const { createWhatsAppSession } = require('../lib/whatsapp');

module.exports = async (ctx) => {
    const userId = ctx.from.id;
    const sessions = global.sessions;
    const pairingStates = global.pairingStates;

    const existing = sessions[userId];
    if (existing && (existing.connected || existing.state === 'connecting')) {
        return ctx.reply('⚠️ You already have a WhatsApp session.\n\nUse /status to check it.');
    }

    if (pairingStates[userId]) {
        clearTimeout(pairingStates[userId].timeoutId);
        delete pairingStates[userId];
    }

    await ctx.reply(
        `📱 Send your WhatsApp number with country code.\n\n` +
        `Example:\n2349012345678\n\n` +
        `No + sign.\nNo leading zero.\n\n` +
        `⏳ You have 90 seconds.`
    );

    const timeoutId = setTimeout(() => {
        if (pairingStates[userId]) {
            delete pairingStates[userId];
            ctx.reply('⏳ Pairing request timed out.\n\nSend /pair again.').catch(() => {});
        }
    }, 90000);

    pairingStates[userId] = { step: 'awaiting_number', timeoutId };
};

// Handle number input after /pair
async function handlePairText(ctx) {
    const userId = ctx.from.id;
    const sessions = global.sessions;
    const pairingStates = global.pairingStates;

    const text = ctx.message.text.trim();
    const clean = cleanNumber(text);

    if (clean.length < 10 || clean.length > 15) {
        return ctx.reply('❌ Invalid number.\n\nExample: 2349012345678');
    }

    if (!clean.startsWith('234')) {
        return ctx.reply('❌ This bot currently accepts Nigerian numbers only.\n\nExample: 2349012345678');
    }

    clearTimeout(pairingStates[userId].timeoutId);
    delete pairingStates[userId];

    await ctx.reply(`⏳ Generating pairing code for ${clean}...`);

    try {
        const { default: makeWASocket, useMultiFileAuthState } = require('@whiskeysockets/baileys');
        const fs = require('fs');

        const sessionFolder = `auth_tg_${userId}`;
        const { state, saveCreds } = await useMultiFileAuthState(sessionFolder);

        const sock = makeWASocket({
            auth: state,
            printQRInTerminal: false,
            browser: ['SolvaX MD Bot', 'Chrome', '1.0.0'],
            markOnlineOnConnect: false,
            syncFullHistory: false,
            patchMessageBeforeSending: true
        });

        sock.ev.on('creds.update', saveCreds);

        let code;
        await sleep(1500);

        try {
            code = await sock.requestPairingCode(clean);
            console.log(`[PAIR] Code generated: ${code}`);
        } catch (err) {
            console.log('[PAIR] First attempt failed, retrying...', err.message);
            await sleep(2000);
            try {
                code = await sock.requestPairingCode(clean);
                console.log(`[PAIR] Code generated on retry: ${code}`);
            } catch (err2) {
                console.error('[PAIR] Both attempts failed:', err2);
                throw new Error('Could not get pairing code after two attempts.');
            }
        }

        if (!code) throw new Error('No pairing code received.');

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

        // Attach connection and message handlers (reuse from whatsapp.js)
        const { isLoggedOut } = require('../lib/helpers');

        sock.ev.on('connection.update', async update => {
            const { connection, lastDisconnect } = update;
            const session = sessions[userId];
            if (!session) return;

            if (connection === 'open') {
                session.connected = true;
                session.state = 'connected';
                session.reconnecting = false;
                console.log(`✅ WhatsApp connected: ${clean}`);
                try {
                    await global.bot.telegram.sendMessage(userId,
                        `✅ *WhatsApp connected successfully!*\n\n📱 Number: ${clean}\n\nSend .menu on WhatsApp to get started.`,
                        { parse_mode: 'Markdown' }
                    );
                } catch (e) {}
            }

            if (connection === 'close') {
                session.connected = false;
                const loggedOut = isLoggedOut(lastDisconnect?.error);
                if (loggedOut || session.stopped) {
                    delete sessions[userId];
                    try {
                        await global.bot.telegram.sendMessage(userId,
                            `🔴 Your WhatsApp was unlinked.\n\nDevice: ${clean}\nUse /pair to re‑link.`
                        );
                    } catch (e) {}
                    return;
                }
                if (session.reconnecting) return;
                session.reconnecting = true;
                session.state = 'connecting';
                console.log(`♻️ Reconnecting ${clean}...`);
                try {
                    await sleep(3000);
                    if (sessions[userId] && !sessions[userId].stopped) {
                        await createWhatsAppSession(userId, clean, ctx);
                    }
                } catch (error) {
                    console.error('Reconnect error:', error.message);
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
                    const senderNumber = msg.key?.participant ? require('../lib/helpers').jidNumber(msg.key.participant) : require('../lib/helpers').jidNumber(sender);
                    const messageText = (msg.message?.conversation || msg.message?.extendedTextMessage?.text || '').trim();
                    if (!messageText) continue;
                    console.log(`[MSG] ${messageText} from ${senderNumber}`);
                    require('../lib/queue').enqueueCommand(async () => {
                        await global.handleWhatsAppCommand(sock, msg, sender, senderNumber, isGroup, messageText, userId);
                    });
                }
            } catch (error) {
                console.error('Message error:', error.message);
            }
        });

        await ctx.reply(
            `🔑 *PAIRING CODE*\n\n` +
            `\`${code}\`\n\n` +
            `Open WhatsApp → Linked Devices → Link with phone number.\n\n` +
            `Enter the code above.\n\n` +
            `⏳ The code is temporary. Complete linking promptly.`,
            { parse_mode: 'Markdown' }
        );

    } catch (error) {
        console.error('❌ Pairing error:', error);
        delete sessions[userId];
        await ctx.reply(`❌ Pairing failed.\n\n${error.message || 'Unknown error'}\n\nSend /pair and try again.`);
    }
}

module.exports.handlePairText = handlePairText;