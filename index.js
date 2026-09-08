'use strict';

const fs = require('fs');
const path = require('path');

const { Telegraf } = require('telegraf');

const configPath = path.join(
    __dirname,
    'config.json'
);

if (!fs.existsSync(configPath)) {
    throw new Error(
        'config.json was not found.'
    );
}

const config = require(configPath);

/*
|--------------------------------------------------------------------------
| CONFIG
|--------------------------------------------------------------------------
*/

const BOT_TOKEN =
    String(
        config.telegramToken ||
        config.botToken ||
        config.token ||
        process.env.BOT_TOKEN ||
        process.env.TELEGRAM_BOT_TOKEN ||
        ''
    ).trim();

if (!BOT_TOKEN) {
    throw new Error(
        'Telegram bot token is missing. Put it in config.json or BOT_TOKEN.'
    );
}

/*
|--------------------------------------------------------------------------
| GLOBAL STATE
|--------------------------------------------------------------------------
*/

global.sessions =
    global.sessions || {};

global.pairingStates =
    global.pairingStates || {};

global.commands =
    global.commands || {};

global.bot =
    global.bot || null;

/*
|--------------------------------------------------------------------------
| MODULES
|--------------------------------------------------------------------------
*/

const {
    getText,
    commandParts,
    jidNumber
} = require('./lib/helpers');

const {
    getWhatsAppSession,
    getWhatsAppStatus,
    restoreSessions,
    stopAllWhatsAppSessions,
    sendReply
} = require('./lib/whatsapp');

const pairModule =
    require('./telegram/pair');

const pairCommand =
    pairModule;

const {
    handlePairNumber,
    cancelPairing,
    getPairingStatus
} = pairModule;

const stopCommand =
    require('./telegram/stop');

/*
|--------------------------------------------------------------------------
| TELEGRAM BOT
|--------------------------------------------------------------------------
*/

const bot =
    new Telegraf(
        BOT_TOKEN
    );

global.bot = bot;

/*
|--------------------------------------------------------------------------
| COMMAND LOADER
|--------------------------------------------------------------------------
*/

function loadWhatsAppCommands() {
    const commandsDir =
        path.join(
            __dirname,
            'commands'
        );

    if (!fs.existsSync(commandsDir)) {
        console.warn(
            '[COMMANDS] commands directory does not exist.'
        );

        return;
    }

    const files =
        fs.readdirSync(
            commandsDir
        );

    for (
        const file of files
    ) {
        if (
            !file.endsWith('.js')
        ) {
            continue;
        }

        const filePath =
            path.join(
                commandsDir,
                file
            );

        try {
            delete require.cache[
                require.resolve(filePath)
            ];

            const command =
                require(filePath);

            if (
                typeof command !== 'function'
            ) {
                console.warn(
                    `[COMMANDS] ${file} does not export a function.`
                );

                continue;
            }

            const name =
                path.basename(
                    file,
                    '.js'
                ).toLowerCase();

            global.commands[name] =
                command;

            console.log(
                `[COMMANDS] Loaded .${name}`
            );

        } catch (error) {
            console.error(
                `[COMMANDS] Failed to load ${file}`,
                error?.stack || error
            );
        }
    }
}

/*
|--------------------------------------------------------------------------
| COMMAND ALIASES
|--------------------------------------------------------------------------
*/

function registerCommandAliases() {
    const commands =
        global.commands;

    const aliases = {
        menu: [
            'help'
        ],

        sticker: [
            's'
        ],

        play: [
            'song',
            'music'
        ],

        video: [
            'ytvideo'
        ],

        groupinfo: [
            'ginfo'
        ],

        tagall: [
            'everyone'
        ],

        tagadmin: [
            'admins'
        ]
    };

    for (
        const [main, names]
        of Object.entries(aliases)
    ) {
        if (
            typeof commands[main] !== 'function'
        ) {
            continue;
        }

        for (
            const alias
            of names
        ) {
            commands[alias] =
                commands[main];
        }
    }
}

/*
|--------------------------------------------------------------------------
| COMMAND RESOLVER
|--------------------------------------------------------------------------
*/

function resolveCommand(name) {
    const commandName =
        String(
            name || ''
        )
            .trim()
            .toLowerCase();

    if (!commandName) {
        return null;
    }

    return (
        global.commands[commandName] ||
        null
    );
}

/*
|--------------------------------------------------------------------------
| WHATSAPP COMMAND CONTEXT
|--------------------------------------------------------------------------
*/

function buildWhatsAppContext(
    userId,
    session,
    msg,
    parsed,
    command
) {
    const remoteJid =
        msg?.key?.remoteJid || '';

    return {
        userId: String(userId),

        session,

        socket:
            session?.socket || null,

        bot:

            session?.socket || null,

        msg,

        message: msg,

        key:
            msg?.key || null,

        remoteJid,

        jid:
            remoteJid,

        isGroup:
            remoteJid.endsWith(
                '@g.us'
            ),

        isFromMe:
            msg?.key?.fromMe === true,

        command:
            parsed.command,

        args:
            parsed.args,

        text:
            parsed.text,

        body:
            parsed.text,

        prefix: '.',

        commandName:
            parsed.command,

        reply: async (
            text,
            options = {}
        ) => {
            if (
                !session?.socket
            ) {
                return null;
            }

            return sendReply(
                session,
                remoteJid,
                String(text || ''),
                options
            );
        },

        send: async (
            text,
            options = {}
        ) => {
            if (
                !session?.socket
            ) {
                return null;
            }

            return sendReply(
                session,
                remoteJid,
                String(text || ''),
                options
            );
        },

        sendMessage: async (
            jid,
            content,
            options = {}
        ) => {
            if (
                !session?.socket
            ) {
                return null;
            }

            return session.socket.sendMessage(
                jid || remoteJid,
                content,
                options
            );
        },

        react: async (
            emoji
        ) => {
            if (
                !session?.socket ||
                !msg?.key
            ) {
                return null;
            }

            return session.socket.sendMessage(
                remoteJid,
                {
                    react: {
                        text:
                            String(
                                emoji || ''
                            ),
                        key:
                            msg.key
                    }
                }
            );
        },

        downloadMedia: async () => {
            /*
             * Commands that need media should use Baileys directly
             * with the message object.
             *
             * This placeholder prevents a misleading fake download
             * implementation from silently doing the wrong thing.
             */

            throw new Error(
                'downloadMedia is not implemented in the command context.'
            );
        }
    };
}

/*
|--------------------------------------------------------------------------
| WHATSAPP COMMAND HANDLER
|--------------------------------------------------------------------------
|
| ONLY messages sent by the linked WhatsApp account itself are
| allowed to reach command files.
|
| This is checked twice:
|
| 1. lib/whatsapp.js checks msg.key.fromMe
| 2. This function checks it again
|
| Defense in depth is useful here because this is a self-bot.
|--------------------------------------------------------------------------
*/

async function handleWhatsAppCommand(
    userId,
    session,
    msg
) {
    const key =
        String(userId || '');

    if (!key) {
        return;
    }

    /*
     * ------------------------------------------------------------
     * SESSION OWNERSHIP
     * ------------------------------------------------------------
     */

    const currentSession =
        getWhatsAppSession(key);

    if (
        !currentSession ||
        currentSession !== session
    ) {
        return;
    }

    /*
     * ------------------------------------------------------------
     * STOPPED SESSION
     * ------------------------------------------------------------
     */

    if (
        session.stopping
    ) {
        return;
    }

    /*
     * ------------------------------------------------------------
     * ONLY SELF-SENT MESSAGES
     * ------------------------------------------------------------
     */

    if (
        msg?.key?.fromMe !== true
    ) {
        return;
    }

    /*
     * ------------------------------------------------------------
     * CHAT JID
     * ------------------------------------------------------------
     */

    const remoteJid =
        String(
            msg?.key?.remoteJid || ''
        );

    if (!remoteJid) {
        return;
    }

    /*
     * WhatsApp status/broadcast traffic is not a command chat.
     */

    if (
        remoteJid ===
            'status@broadcast' ||
        remoteJid.endsWith(
            '@broadcast'
        )
    ) {
        return;
    }

    /*
     * ------------------------------------------------------------
     * MESSAGE TEXT
     * ------------------------------------------------------------
     */

    const originalText =
        getText(
            msg?.message
        );

    if (!originalText) {
        return;
    }

    let text =
        originalText.trim();

    /*
     * ------------------------------------------------------------
     * SUPPORT:
     *
     * .menu
     * menu
     *
     * Both can work.
     *
     * A random person cannot trigger either because fromMe was
     * already required above.
     * ------------------------------------------------------------
     */

    if (
        !text.startsWith('.')
    ) {
        const firstWord =
            text
                .split(/\s+/)[0]
                .toLowerCase();

        const directCommand =
            resolveCommand(
                firstWord
            );

        if (!directCommand) {
            return;
        }

        text =
            `.${text}`;
    }

    /*
     * ------------------------------------------------------------
     * PARSE COMMAND
     * ------------------------------------------------------------
     */

    const parsed =
        commandParts(
            text,
            '.'
        );

    if (!parsed) {
        return;
    }

    const command =
        resolveCommand(
            parsed.command
        );

    if (
        typeof command !== 'function'
    ) {
        return;
    }

    /*
     * ------------------------------------------------------------
     * COMMAND CONTEXT
     * ------------------------------------------------------------
     */

    const ctx =
        buildWhatsAppContext(
            key,
            session,
            msg,
            parsed,
            command
        );

    /*
     * ------------------------------------------------------------
     * RUN COMMAND
     * ------------------------------------------------------------
     */

    try {
        await command(
            ctx
        );

    } catch (error) {
        console.error(
            `[WA COMMAND .${parsed.command}]`,
            error?.stack || error
        );

        /*
         * Do not expose raw stack traces to WhatsApp.
         */

        try {
            await ctx.reply(
                '❌ Command failed.\n\n' +
                'An internal error occurred while processing the command.'
            );
        } catch (replyError) {
            console.error(
                '[WA COMMAND ERROR REPLY]',
                replyError?.stack ||
                replyError
            );
        }
    }
}

global.handleWhatsAppCommand =
    handleWhatsAppCommand;

/*
|--------------------------------------------------------------------------
| TELEGRAM /START
|--------------------------------------------------------------------------
*/

bot.start(
    async ctx => {
        const userId =
            String(
                ctx?.from?.id || ''
            );

        await ctx.reply(
            '🤖 SOLVAX MD\n\n' +
            'Telegram-controlled WhatsApp self-bot.\n\n' +

            '📱 /pair\n' +
            'Link a WhatsApp account.\n\n' +

            '📊 /status\n' +
            'Check WhatsApp connection.\n\n' +

            '🛑 /stop\n' +
            'Completely stop and clear the WhatsApp session.\n\n' +

            'ℹ️ /help\n' +
            'Show available commands.'
        );

        console.log(
            `[TELEGRAM START] ${userId}`
        );
    }
);

/*
|--------------------------------------------------------------------------
| TELEGRAM /HELP
|--------------------------------------------------------------------------
*/

bot.help(
    async ctx => {
        await ctx.reply(
            '🤖 SOLVAX MD HELP\n\n' +

            '📱 WhatsApp pairing\n' +
            '/pair - Start fresh WhatsApp pairing\n\n' +

            '📊 Session\n' +
            '/status - Show current WhatsApp status\n' +
            '/stop - Completely clear the session\n\n' +

            '💡 Pairing flow\n' +
            '1. Send /pair\n' +
            '2. Send your WhatsApp number\n' +
            '3. Copy the pairing code\n' +
            '4. Enter it in WhatsApp Linked Devices\n\n' +

            '🔐 Only messages sent by the linked WhatsApp account itself are processed as bot commands.\n\n' +

            'Example WhatsApp commands:\n' +
            '.menu\n' +
            '.ping\n' +
            '.sticker\n' +
            '.play song name\n' +
            '.video video name\n' +
            '.groupinfo'
        );
    }
);

/*
|--------------------------------------------------------------------------
| TELEGRAM /PAIR
|--------------------------------------------------------------------------
*/

bot.command(
    'pair',
    async ctx => {
        try {
            await pairCommand(
                ctx
            );
        } catch (error) {
            console.error(
                '[TELEGRAM PAIR]',
                error?.stack || error
            );

            try {
                await ctx.reply(
                    '❌ Pairing could not be started.\n\n' +
                    'The pairing state has been reset.\n\n' +
                    'Use /pair to try again.'
                );
            } catch (_) {}
        }
    }
);

/*
|--------------------------------------------------------------------------
| TELEGRAM /STOP
|--------------------------------------------------------------------------
*/

bot.command(
    'stop',
    async ctx => {
        try {
            await stopCommand(
                ctx
            );
        } catch (error) {
            console.error(
                '[TELEGRAM STOP]',
                error?.stack || error
            );

            try {
                await ctx.reply(
                    '❌ The stop operation encountered an error.'
                );
            } catch (_) {}
        }
    }
);

/*
|--------------------------------------------------------------------------
| TELEGRAM /STATUS
|--------------------------------------------------------------------------
*/

bot.command(
    'status',
    async ctx => {
        const userId =
            String(
                ctx?.from?.id || ''
            );

        if (!userId) {
            return;
        }

        const sessionStatus =
            getWhatsAppStatus(
                userId
            );

        const pairingStatus =
            getPairingStatus(
                userId
            );

        /*
         * --------------------------------------------------------
         * NO SESSION
         * --------------------------------------------------------
         */

        if (
            !sessionStatus.active
        ) {
            if (
                pairingStatus?.active
            ) {
                let stage =
                    pairingStatus.stage ||
                    'unknown';

                await ctx.reply(
                    '🟡 Pairing is active.\n\n' +
                    `Stage: ${stage}\n` +
                    `Number: ${pairingStatus.phoneNumber || 'Unknown'}\n\n` +
                    'The WhatsApp session is not connected yet.'
                );

                return;
            }

            await ctx.reply(
                '🔴 No active WhatsApp session.\n\n' +
                'Use /pair to link a WhatsApp account.'
            );

            return;
        }

        /*
         * --------------------------------------------------------
         * ACTIVE SESSION
         * --------------------------------------------------------
         */

        const number =
            sessionStatus.phoneNumber
                ? jidNumber(
                    sessionStatus.phoneNumber
                )
                : 'Unknown';

        let stateText =
            '🔴 Disconnected';

        if (
            sessionStatus.connected
        ) {
            stateText =
                '🟢 Connected';
        } else if (
            sessionStatus.connecting
        ) {
            stateText =
                '🟡 Connecting';
        } else if (
            sessionStatus.reconnecting
        ) {
            stateText =
                '🟠 Reconnecting';
        }

        let message =
            '📊 SOLVAX MD STATUS\n\n' +

            `Status: ${stateText}\n` +
            `WhatsApp: ${number}\n`;

        if (
            sessionStatus.connectedAt
        ) {
            message +=
                `Connected at: ${new Date(
                    sessionStatus.connectedAt
                ).toLocaleString()}\n`;
        }

        if (
            sessionStatus.reconnectAttempts
        ) {
            message +=
                `Reconnect attempts: ${sessionStatus.reconnectAttempts}\n`;
        }

        if (
            sessionStatus.lastError
        ) {
            message +=
                `Last error: ${sessionStatus.lastError}\n`;
        }

        await ctx.reply(
            message
        );
    }
);

/*
|--------------------------------------------------------------------------
| TELEGRAM TEXT HANDLER
|--------------------------------------------------------------------------
|
| This catches a phone number after:
|
| /pair
|
| It deliberately does NOT intercept normal Telegram messages.
|--------------------------------------------------------------------------
*/

bot.on(
    'text',
    async ctx => {
        const userId =
            String(
                ctx?.from?.id || ''
            );

        if (!userId) {
            return;
        }

        const text =
            String(
                ctx?.message?.text || ''
            ).trim();

        if (!text) {
            return;
        }

        /*
         * Ignore Telegram bot commands.
         *
         * /pair and /stop are handled by their own handlers.
         */

        if (
            text.startsWith('/')
        ) {
            return;
        }

        const pairingStatus =
            getPairingStatus(
                userId
            );

        if (
            !pairingStatus?.active
        ) {
            return;
        }

        if (
            pairingStatus.stage !==
            'waiting_number'
        ) {
            return;
        }

        try {
            await handlePairNumber(
                ctx,
                text
            );
        } catch (error) {
            console.error(
                '[TELEGRAM PAIR NUMBER]',
                error?.stack || error
            );

            try {
                await ctx.reply(
                    '❌ Pairing failed unexpectedly.\n\n' +
                    'The pairing state has been reset.\n\n' +
                    'Use /pair to try again.'
                );
            } catch (_) {}

            cancelPairing(
                userId
            );
        }
    }
);

/*
|--------------------------------------------------------------------------
| TELEGRAM ERROR HANDLER
|--------------------------------------------------------------------------
*/

bot.catch(
    async (error, ctx) => {
        console.error(
            '[TELEGRAM ERROR]',
            error?.stack || error
        );

        try {
            await ctx.reply(
                '❌ An internal Telegram bot error occurred.'
            );
        } catch (_) {}
    }
);

/*
|--------------------------------------------------------------------------
| START BOT
|--------------------------------------------------------------------------
*/

let shuttingDown = false;

async function startBot() {
    /*
     * Load WhatsApp commands before Telegram starts receiving traffic.
     */

    loadWhatsAppCommands();

    registerCommandAliases();

    console.log(
        `[COMMANDS] ${Object.keys(
            global.commands
        ).length} commands loaded.`
    );

    /*
     * Start Telegram polling.
     */

    await bot.launch();

    console.log(
        '[TELEGRAM] SOLVAX MD is running.'
    );

    /*
     * Restore saved sessions, if any.
     *
     * NOTE:
     * /stop and automatic disconnect cleanup remove the user's
     * auth directory, so those users will not be resurrected.
     */

    try {
        await restoreSessions();

        console.log(
            '[WHATSAPP] Session restore completed.'
        );
    } catch (error) {
        console.error(
            '[WHATSAPP RESTORE]',
            error?.stack || error
        );
    }
}

/*
|--------------------------------------------------------------------------
| GRACEFUL SHUTDOWN
|--------------------------------------------------------------------------
*/

async function shutdown(
    signal
) {
    if (shuttingDown) {
        return;
    }

    shuttingDown = true;

    console.log(
        `[SYSTEM] Received ${signal}. Shutting down...`
    );

    /*
     * Stop Telegram polling.
     */

    try {
        bot.stop(
            signal
        );
    } catch (error) {
        console.error(
            '[TELEGRAM SHUTDOWN]',
            error?.stack || error
        );
    }

    /*
     * Cancel all pairing timers/states.
     *
     * We intentionally preserve WhatsApp authentication during
     * process shutdown so a server restart can restore a normal
     * established session.
     *
     * This is different from /stop.
     *
     * /stop = complete user reset.
     *
     * process shutdown = close sockets cleanly.
     */

    try {
        for (
            const state
            of Object.values(
                global.pairingStates
            )
        ) {
            if (
                state?.timeout
            ) {
                clearTimeout(
                    state.timeout
                );
            }
        }

        global.pairingStates = {};
    } catch (error) {
        console.error(
            '[PAIRING SHUTDOWN]',
            error?.stack || error
        );
    }

    /*
     * Stop active sockets while keeping auth files.
     */

    try {
        await stopAllWhatsAppSessions({
            removeAuth: false
        });
    } catch (error) {
        console.error(
            '[WHATSAPP SHUTDOWN]',
            error?.stack || error
        );
    }

    console.log(
        '[SYSTEM] Shutdown complete.'
    );

    process.exit(
        0
    );
}

/*
|--------------------------------------------------------------------------
| PROCESS SIGNALS
|--------------------------------------------------------------------------
*/

process.once(
    'SIGINT',
    () => {
        shutdown(
            'SIGINT'
        );
    }
);

process.once(
    'SIGTERM',
    () => {
        shutdown(
            'SIGTERM'
        );
    }
);

/*
|--------------------------------------------------------------------------
| UNHANDLED ERRORS
|--------------------------------------------------------------------------
*/

process.on(
    'unhandledRejection',
    error => {
        console.error(
            '[UNHANDLED REJECTION]',
            error?.stack || error
        );
    }
);

process.on(
    'uncaughtException',
    error => {
        console.error(
            '[UNCAUGHT EXCEPTION]',
            error?.stack || error
        );
    }
);

/*
|--------------------------------------------------------------------------
| START
|--------------------------------------------------------------------------
*/

startBot().catch(
    error => {
        console.error(
            '[STARTUP FAILED]',
            error?.stack || error
        );

        process.exit(
            1
        );
    }
);

/*
|--------------------------------------------------------------------------
| EXPORTS
|--------------------------------------------------------------------------
*/

module.exports = {
    bot,
    loadWhatsAppCommands,
    resolveCommand,
    handleWhatsAppCommand,
    startBot,
    shutdown
};
