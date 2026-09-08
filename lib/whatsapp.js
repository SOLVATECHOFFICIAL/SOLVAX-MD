const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers
} = require('@whiskeysockets/baileys');

const fs = require('fs');
const path = require('path');

global.sessions ??= {};

const sessions = global.sessions;


function getSessionFolder(userId) {
    return path.join(
        process.cwd(),
        'sessions',
        String(userId)
    );
}


async function createWhatsAppSession(
    userId,
    number,
    ctx = null,
    options = {}
) {

    if (sessions[userId]?.sock) {
        return sessions[userId];
    }

    const sessionFolder = getSessionFolder(userId);

    fs.mkdirSync(sessionFolder, {
        recursive: true
    });

    const {
        state,
        saveCreds
    } = await useMultiFileAuthState(sessionFolder);


    const sock = makeWASocket({

        auth: state,

        browser: Browsers.ubuntu('Chrome'),

        printQRInTerminal: false,

        markOnlineOnConnect: false,

        syncFullHistory: false,

        generateHighQualityLinkPreview: false,

        connectTimeoutMs: 60000,

        defaultQueryTimeoutMs: 60000,

        keepAliveIntervalMs: 25000

    });


    const session = {

        userId,

        number,

        sock,

        saveCreds,

        connected: false,

        state: 'connecting',

        stopped: false,

        reconnecting: false,

        pairingCode: null

    };


    sessions[userId] = session;


    sock.ev.on(
        'creds.update',
        saveCreds
    );


    sock.ev.on(
        'connection.update',
        async (update) => {

            const {
                connection,
                lastDisconnect
            } = update;

            const current =
                sessions[userId];

            if (!current) return;


            if (connection === 'open') {

                current.connected = true;
                current.state = 'connected';
                current.reconnecting = false;
                current.pairingCode = null;

                console.log(
                    `✅ WhatsApp connected: ${number}`
                );

                if (global.bot) {

                    try {

                        await global.bot.telegram.sendMessage(
                            userId,

                            `✅ WhatsApp connected successfully!\n\n` +
                            `📱 Number: ${number}\n\n` +
                            `Send .menu on WhatsApp to get started.`
                        );

                    } catch {}
                }

                return;
            }


            if (connection === 'close') {

                current.connected = false;


                const statusCode =
                    lastDisconnect?.error?.output?.statusCode;


                if (
                    statusCode ===
                    DisconnectReason.loggedOut
                    ||
                    current.stopped
                ) {

                    delete sessions[userId];

                    console.log(
                        `🔴 WhatsApp logged out: ${number}`
                    );

                    if (global.bot) {

                        try {

                            await global.bot.telegram.sendMessage(
                                userId,

                                `🔴 WhatsApp was unlinked.\n\n` +
                                `📱 Number: ${number}\n\n` +
                                `Use /pair to link again.`
                            );

                        } catch {}
                    }

                    return;
                }


                if (current.reconnecting) {
                    return;
                }


                current.reconnecting = true;
                current.state = 'reconnecting';

                console.log(
                    `♻️ Reconnecting WhatsApp: ${number}`
                );


                setTimeout(async () => {

                    try {

                        if (
                            !sessions[userId] ||
                            sessions[userId].stopped
                        ) {
                            return;
                        }

                        delete sessions[userId];

                        await createWhatsAppSession(
                            userId,
                            number,
                            null,
                            { pairing: false }
                        );

                    } catch (error) {

                        console.error(
                            '[RECONNECT ERROR]',
                            error.message
                        );

                    }

                }, 3000);
            }
        }
    );


    sock.ev.on(
        'messages.upsert',
        async (event) => {

            try {

                const messages =
                    event.messages || [];


                for (const msg of messages) {

                    if (
                        !msg?.message ||
                        msg.key?.fromMe
                    ) {
                        continue;
                    }


                    const sender =
                        msg.key?.remoteJid;


                    if (
                        !sender ||
                        sender === 'status@broadcast'
                    ) {
                        continue;
                    }


                    const isGroup =
                        sender.endsWith('@g.us');


                    const participant =
                        msg.key?.participant ||
                        sender;


                    const senderNumber =
                        participant
                            .split('@')[0]
                            .split(':')[0];


                    const messageText =
                        (
                            msg.message?.conversation ||
                            msg.message?.extendedTextMessage?.text ||
                            ''
                        ).trim();


                    if (!messageText) {
                        continue;
                    }


                    console.log(
                        `[MSG] ${messageText} from ${senderNumber}`
                    );


                    if (
                        typeof global.handleWhatsAppCommand ===
                        'function'
                    ) {

                        if (
                            global.enqueueCommand
                        ) {

                            global.enqueueCommand(
                                async () => {

                                    await global.handleWhatsAppCommand(
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

                        } else {

                            await global.handleWhatsAppCommand(
                                sock,
                                msg,
                                sender,
                                senderNumber,
                                isGroup,
                                messageText,
                                userId
                            );
                        }
                    }
                }

            } catch (error) {

                console.error(
                    '[MESSAGE ERROR]',
                    error.message
                );
            }
        }
    );


    if (
        options.pairing &&
        !state.creds.registered
    ) {

        await new Promise(
            resolve => setTimeout(resolve, 2000)
        );


        let code = null;
        let lastError = null;


        for (
            let attempt = 1;
            attempt <= 2;
            attempt++
        ) {

            try {

                if (attempt > 1) {

                    await new Promise(
                        resolve =>
                            setTimeout(resolve, 3000)
                    );
                }


                console.log(
                    `[PAIR] Requesting code for ${number}, attempt ${attempt}`
                );


                code =
                    await sock.requestPairingCode(
                        number
                    );


                if (code) {
                    break;
                }

            } catch (error) {

                lastError = error;

                console.error(
                    `[PAIR] Attempt ${attempt} failed:`,
                    error.message
                );
            }
        }


        if (!code) {

            delete sessions[userId];

            throw (
                lastError ||
                new Error(
                    'WhatsApp did not return a pairing code.'
                )
            );
        }


        session.pairingCode = code;
        session.state = 'pairing';


        if (ctx) {

            await ctx.reply(
                `🔑 PAIRING CODE\n\n` +
                `${code}\n\n` +
                `WhatsApp → Linked Devices → ` +
                `Link a device → Link with phone number.\n\n` +
                `Enter this code on your WhatsApp phone.\n\n` +
                `⚠️ The code is temporary.`
            );
        }
    }


    return session;
}


async function stopWhatsAppSession(userId) {

    const session =
        sessions[userId];

    if (!session) {
        return false;
    }


    session.stopped = true;


    try {
        await session.sock.logout();
    } catch {}


    try {
        session.sock.end();
    } catch {}


    delete sessions[userId];


    return true;
}


function getWhatsAppSession(userId) {
    return sessions[userId] || null;
}


module.exports = {
    createWhatsAppSession,
    stopWhatsAppSession,
    getWhatsAppSession
};
