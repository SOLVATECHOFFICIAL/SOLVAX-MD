// lib/whatsapp.js

const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers
} = require('@whiskeysockets/baileys');

const fs = require('fs');
const path = require('path');

const {
    sleep,
    isLoggedOut,
    jidNumber,
    getText
} = require('./helpers');

global.sessions ??= {};

const sessions = global.sessions;


/*
|--------------------------------------------------------------------------
| Session folder
|--------------------------------------------------------------------------
*/

function getSessionFolder(userId) {
    return path.join(
        process.cwd(),
        'sessions',
        String(userId)
    );
}


/*
|--------------------------------------------------------------------------
| Send message helper
|--------------------------------------------------------------------------
*/

async function sendReply(sock, jid, msg, text) {

    if (!sock || !jid) {
        return;
    }

    try {

        return await sock.sendMessage(
            jid,
            {
                text: String(text)
            },
            msg
                ? { quoted: msg }
                : undefined
        );

    } catch (error) {

        console.error(
            '[SEND ERROR]',
            error.message
        );

    }
}


/*
|--------------------------------------------------------------------------
| Create WhatsApp session
|--------------------------------------------------------------------------
*/

async function createWhatsAppSession(
    userId,
    number,
    ctx = null,
    options = {}
) {

    global.sessions ??= {};

    const sessions =
        global.sessions;


    /*
    |--------------------------------------------------------------------------
    | Don't create duplicate sockets
    |--------------------------------------------------------------------------
    */

    const oldSession =
        sessions[userId];

    if (
        oldSession &&
        oldSession.sock
    ) {

        return oldSession;

    }


    /*
    |--------------------------------------------------------------------------
    | Authentication folder
    |--------------------------------------------------------------------------
    */

    const sessionFolder =
        getSessionFolder(userId);

    fs.mkdirSync(
        sessionFolder,
        {
            recursive: true
        }
    );


    /*
    |--------------------------------------------------------------------------
    | Baileys authentication
    |--------------------------------------------------------------------------
    */

    const {
        state,
        saveCreds
    } =
        await useMultiFileAuthState(
            sessionFolder
        );


    /*
    |--------------------------------------------------------------------------
    | Create WhatsApp socket
    |--------------------------------------------------------------------------
    */

    const sock =
        makeWASocket({

            auth: state,

            /*
             * Use a normal supported browser identity.
             * Do not use:
             * ['SolvaX MD Bot', 'Chrome', '1.0.0']
             */

            browser:
                Browsers.ubuntu('Chrome'),

            printQRInTerminal:
                false,

            markOnlineOnConnect:
                false,

            syncFullHistory:
                false,

            generateHighQualityLinkPreview:
                false,

            connectTimeoutMs:
                60000,

            defaultQueryTimeoutMs:
                60000,

            keepAliveIntervalMs:
                25000

        });


    /*
    |--------------------------------------------------------------------------
    | Store session
    |--------------------------------------------------------------------------
    */

    const session = {

        userId,

        number,

        sock,

        saveCreds,

        connected:
            false,

        state:
            'connecting',

        stopped:
            false,

        reconnecting:
            false,

        pairing:
            false,

        pairingCode:
            null

    };


    sessions[userId] =
        session;


    /*
    |--------------------------------------------------------------------------
    | Save WhatsApp credentials
    |--------------------------------------------------------------------------
    */

    sock.ev.on(
        'creds.update',
        saveCreds
    );


    /*
    |--------------------------------------------------------------------------
    | CONNECTION EVENTS
    |--------------------------------------------------------------------------
    */

    sock.ev.on(
        'connection.update',
        async (update) => {

            try {

                const {
                    connection,
                    lastDisconnect
                } = update;


                const current =
                    sessions[userId];


                if (!current) {
                    return;
                }


                /*
                |--------------------------------------------------------------------------
                | CONNECTED
                |--------------------------------------------------------------------------
                */

                if (
                    connection === 'open'
                ) {

                    current.connected =
                        true;

                    current.state =
                        'connected';

                    current.reconnecting =
                        false;

                    current.pairing =
                        false;

                    current.pairingCode =
                        null;


                    console.log(
                        `✅ WhatsApp connected: ${number}`
                    );


                    /*
                    |--------------------------------------------------------------------------
                    | Notify Telegram owner
                    |--------------------------------------------------------------------------
                    */

                    if (global.bot) {

                        try {

                            await global.bot.telegram.sendMessage(

                                userId,

                                `✅ WhatsApp connected successfully!\n\n` +
                                `📱 Number: ${number}\n\n` +
                                `Your personal WhatsApp bot is now active.\n\n` +
                                `Only commands sent by this linked WhatsApp account will be processed.`

                            );

                        } catch {}

                    }

                    return;
                }


                /*
                |--------------------------------------------------------------------------
                | CONNECTION CLOSED
                |--------------------------------------------------------------------------
                */

                if (
                    connection === 'close'
                ) {

                    current.connected =
                        false;


                    const statusCode =
                        lastDisconnect
                            ?.error
                            ?.output
                            ?.statusCode;


                    const loggedOut =
                        statusCode ===
                        DisconnectReason.loggedOut;


                    /*
                    |--------------------------------------------------------------------------
                    | Logged out / manually stopped
                    |--------------------------------------------------------------------------
                    */

                    if (
                        loggedOut ||
                        current.stopped
                    ) {

                        delete sessions[userId];


                        console.log(
                            `🔴 WhatsApp disconnected: ${number}`
                        );


                        if (global.bot) {

                            try {

                                await global.bot.telegram.sendMessage(

                                    userId,

                                    `🔴 WhatsApp session ended.\n\n` +
                                    `📱 Number: ${number}\n\n` +
                                    `Use /pair to link it again.`

                                );

                            } catch {}

                        }

                        return;
                    }


                    /*
                    |--------------------------------------------------------------------------
                    | Prevent multiple reconnect loops
                    |--------------------------------------------------------------------------
                    */

                    if (
                        current.reconnecting
                    ) {

                        return;

                    }


                    current.reconnecting =
                        true;

                    current.state =
                        'reconnecting';


                    console.log(
                        `♻️ Reconnecting WhatsApp: ${number}`
                    );


                    /*
                    |--------------------------------------------------------------------------
                    | Reconnect after delay
                    |--------------------------------------------------------------------------
                    */

                    setTimeout(
                        async () => {

                            try {

                                const active =
                                    sessions[userId];


                                if (
                                    !active ||
                                    active.stopped
                                ) {

                                    return;

                                }


                                delete sessions[userId];


                                await createWhatsAppSession(

                                    userId,

                                    number,

                                    null,

                                    {
                                        pairing:
                                            false
                                    }

                                );

                            } catch (error) {

                                console.error(
                                    '[RECONNECT ERROR]',
                                    error.message
                                );

                            }

                        },

                        3000
                    );

                }

            } catch (error) {

                console.error(
                    '[CONNECTION ERROR]',
                    error.message
                );

            }

        }
    );


    /*
    |--------------------------------------------------------------------------
    | WHATSAPP MESSAGE HANDLER
    |--------------------------------------------------------------------------
    |
    | IMPORTANT:
    |
    | We ONLY process messages where:
    |
    |     msg.key.fromMe === true
    |
    | That means the command must be sent by
    | the WhatsApp account linked to this bot.
    |
    | Other people are completely ignored.
    |
    |--------------------------------------------------------------------------
    */

    sock.ev.on(
        'messages.upsert',
        async ({ messages }) => {

            try {

                for (
                    const msg of messages || []
                ) {


                    /*
                    |--------------------------------------------------------------------------
                    | Ignore invalid messages
                    |--------------------------------------------------------------------------
                    */

                    if (
                        !msg ||
                        !msg.message
                    ) {

                        continue;

                    }


                    /*
                    |--------------------------------------------------------------------------
                    | ONLY THE LINKED ACCOUNT
                    |--------------------------------------------------------------------------
                    |
                    | This is the most important line.
                    |
                    | If another person sends:
                    |
                    |     .menu
                    |
                    | fromMe will be false.
                    |
                    | We ignore it.
                    |
                    */

                    if (
                        msg.key?.fromMe !== true
                    ) {

                        continue;

                    }


                    /*
                    |--------------------------------------------------------------------------
                    | Get the chat
                    |--------------------------------------------------------------------------
                    */

                    const jid =
                        msg.key?.remoteJid;


                    if (!jid) {
                        continue;
                    }


                    /*
                    |--------------------------------------------------------------------------
                    | Ignore WhatsApp status
                    |--------------------------------------------------------------------------
                    */

                    if (
                        jid ===
                        'status@broadcast'
                    ) {

                        continue;

                    }


                    /*
                    |--------------------------------------------------------------------------
                    | Detect group
                    |--------------------------------------------------------------------------
                    */

                    const isGroup =
                        jid.endsWith('@g.us');


                    /*
                    |--------------------------------------------------------------------------
                    | Get command text
                    |--------------------------------------------------------------------------
                    */

                    let text =
                        getText(
                            msg.message
                        );


                    if (
                        !text
                    ) {

                        continue;

                    }


                    text =
                        String(text)
                            .trim();


                    if (
                        !text
                    ) {

                        continue;

                    }


                    /*
                    |--------------------------------------------------------------------------
                    | Allow:
                    |
                    | .menu
                    | menu
                    | .vv
                    | vv
                    | .play song
                    | play song
                    |
                    |--------------------------------------------------------------------------
                    */

                    const commandText =
                        text.startsWith('.')
                            ? text
                            : `.${text}`;


                    /*
                    |--------------------------------------------------------------------------
                    | Sender
                    |--------------------------------------------------------------------------
                    |
                    | Because this is a fromMe message,
                    | this is the linked WhatsApp account.
                    |
                    */

                    const senderNumber =
                        jidNumber(
                            number
                        );


                    console.log(
                        `[SELF COMMAND] ${commandText} | CHAT: ${jid} | GROUP: ${isGroup}`
                    );


                    /*
                    |--------------------------------------------------------------------------
                    | Make sure command handler exists
                    |--------------------------------------------------------------------------
                    */

                    if (
                        typeof global.handleWhatsAppCommand !==
                        'function'
                    ) {

                        console.error(
                            '[COMMAND ERROR] global.handleWhatsAppCommand is not defined'
                        );

                        continue;

                    }


                    /*
                    |--------------------------------------------------------------------------
                    | Put command into queue
                    |--------------------------------------------------------------------------
                    */

                    const queue =
                        require('./queue');


                    /*
                    |--------------------------------------------------------------------------
                    | Support both queue styles
                    |--------------------------------------------------------------------------
                    */

                    if (
                        typeof queue.enqueueCommand ===
                        'function'
                    ) {

                        queue.enqueueCommand(
                            async () => {

                                try {

                                    /*
                                    |--------------------------------------------------------------------------
                                    | IMPORTANT:
                                    |
                                    | jid is the SAME CHAT where
                                    | the command was typed.
                                    |
                                    | We do NOT reply to number.
                                    |
                                    |--------------------------------------------------------------------------
                                    */

                                    await global.handleWhatsAppCommand(

                                        sock,

                                        msg,

                                        jid,

                                        senderNumber,

                                        isGroup,

                                        commandText,

                                        userId

                                    );

                                } catch (error) {

                                    console.error(
                                        '[COMMAND ERROR]',
                                        error.message
                                    );

                                }

                            }
                        );

                    } else {

                        /*
                        |--------------------------------------------------------------------------
                        | Fallback if queue is unavailable
                        |--------------------------------------------------------------------------
                        */

                        await global.handleWhatsAppCommand(

                            sock,

                            msg,

                            jid,

                            senderNumber,

                            isGroup,

                            commandText,

                            userId

                        );

                    }

                }

            } catch (error) {

                console.error(
                    '[MESSAGE HANDLER ERROR]',
                    error.message
                );

            }

        }
    );


    /*
    |--------------------------------------------------------------------------
    | PAIRING CODE
    |--------------------------------------------------------------------------
    */

    if (
        options.pairing === true &&
        !state.creds.registered
    ) {

        session.pairing =
            true;


        /*
        |--------------------------------------------------------------------------
        | Give socket time to initialize
        |--------------------------------------------------------------------------
        */

        await sleep(2000);


        let code =
            null;

        let lastError =
            null;


        /*
        |--------------------------------------------------------------------------
        | Request pairing code
        |--------------------------------------------------------------------------
        */

        for (
            let attempt = 1;
            attempt <= 2;
            attempt++
        ) {

            try {

                if (
                    attempt > 1
                ) {

                    await sleep(3000);

                }


                console.log(
                    `[PAIR] Requesting pairing code for ${number}, attempt ${attempt}`
                );


                code =
                    await sock.requestPairingCode(
                        number
                    );


                if (
                    code
                ) {

                    break;

                }

            } catch (error) {

                lastError =
                    error;


                console.error(
                    `[PAIR] Attempt ${attempt} failed:`,
                    error.message
                );

            }

        }


        /*
        |--------------------------------------------------------------------------
        | Pairing failed
        |--------------------------------------------------------------------------
        */

        if (
            !code
        ) {

            delete sessions[userId];


            throw (
                lastError ||
                new Error(
                    'WhatsApp did not return a pairing code.'
                )
            );

        }


        /*
        |--------------------------------------------------------------------------
        | Save pairing code
        |--------------------------------------------------------------------------
        */

        session.pairingCode =
            code;

        session.state =
            'pairing';


        console.log(
            `[PAIR] Code generated for ${number}: ${code}`
        );


        /*
        |--------------------------------------------------------------------------
        | Send code to Telegram
        |--------------------------------------------------------------------------
        */

        if (
            ctx
        ) {

            await ctx.reply(

                `🔑 PAIRING CODE\n\n` +

                `${code}\n\n` +

                `Open WhatsApp → Linked Devices → ` +

                `Link a device → Link with phone number.\n\n` +

                `Enter the code above.\n\n` +

                `⚠️ The code is temporary.`

            );

        }

    }


    return session;
}


/*
|--------------------------------------------------------------------------
| Stop WhatsApp session
|--------------------------------------------------------------------------
*/

async function stopWhatsAppSession(
    userId
) {

    const session =
        sessions[userId];


    if (
        !session
    ) {

        return false;

    }


    session.stopped =
        true;


    try {

        await session.sock.logout();

    } catch {}


    try {

        session.sock.end(
            undefined
        );

    } catch {}


    delete sessions[userId];


    return true;
}


/*
|--------------------------------------------------------------------------
| Get session
|--------------------------------------------------------------------------
*/

function getWhatsAppSession(
    userId
) {

    return (
        sessions[userId] ||
        null
    );

}


/*
|--------------------------------------------------------------------------
| Export
|--------------------------------------------------------------------------
*/

module.exports = {

    createWhatsAppSession,

    stopWhatsAppSession,

    getWhatsAppSession,

    sendReply

};
