'use strict';

/*
|--------------------------------------------------------------------------
| SOLVAX MD
| Telegram-controlled WhatsApp self-bot
|--------------------------------------------------------------------------
|
| Main application entry point.
|
| Responsibilities:
|   - Start Telegram bot
|   - Load WhatsApp command files
|   - Maintain global session state
|   - Handle /pair, /stop, /status, /help, /start
|   - Route WhatsApp messages to command handlers
|   - Restore authenticated WhatsApp sessions
|
|--------------------------------------------------------------------------
*/

const fs = require('fs');
const path = require('path');

const {
    Telegraf
} = require('telegraf');

const {
    enqueueCommand
} = require('./lib/queue');

const {
    getText,
    isGroupJid
} = require('./lib/helpers');

const {
    restoreSessions,
    sendReply,
    getWhatsAppSession
} = require('./lib/whatsapp');

/*
|--------------------------------------------------------------------------
| Configuration
|--------------------------------------------------------------------------
*/

const configPath = path.join(
    process.cwd(),
    'config.json'
);

let config = {};

try {
    if (fs.existsSync(configPath)) {
        config = JSON.parse(
            fs.readFileSync(
                configPath,
                'utf8'
            )
        );
    }
} catch (error) {
    console.error(
        '[CONFIG] Failed to read config.json:',
        error?.stack || error
    );

    config = {};
}

/*
|--------------------------------------------------------------------------
| Environment / configuration values
|--------------------------------------------------------------------------
*/

const BOT_TOKEN =
    process.env.BOT_TOKEN ||
    process.env.TELEGRAM_BOT_TOKEN ||
    config.botToken ||
    config.telegramToken ||
    '';

const PREFIX =
    config.prefix ||
    '.';

const BOT_NAME =
    config.botName ||
    'SOLVAX MD';

/*
|--------------------------------------------------------------------------
| Validate Telegram token
|--------------------------------------------------------------------------
*/

if (!BOT_TOKEN) {
    console.error(
        '\n❌ Telegram bot token is missing.\n\n' +
        'Set BOT_TOKEN in your environment variables or put your token in config.json.\n'
    );

    process.exit(1);
}

/*
|--------------------------------------------------------------------------
| Create Telegram bot
|--------------------------------------------------------------------------
*/

const bot = new Telegraf(
    BOT_TOKEN
);

/*
 * Make the bot available to modules such as telegram/pair.js.
 */
global.bot = bot;

/*
|--------------------------------------------------------------------------
| Global application state
|--------------------------------------------------------------------------
*/

global.sessions =
    global.sessions || {};

global.pairingStates =
    global.pairingStates || {};

global.commands =
    global.commands || {};

/*
 * Prevent accidental duplicate initialization.
 */
global.solvaxStarted =
    global.solvaxStarted || false;

/*
|--------------------------------------------------------------------------
| Command loading
|--------------------------------------------------------------------------
*/

const commandsDir =
    path.join(
        process.cwd(),
        'commands'
    );

function loadCommands() {
    global.commands = {};

    if (
        !fs.existsSync(commandsDir)
    ) {
        console.warn(
            '[COMMANDS] commands directory does not exist.'
        );

        return;
    }

    const files =
        fs.readdirSync(
            commandsDir
        )
        .filter(
            file =>
                file.endsWith('.js')
        );

    for (const file of files) {
        const fullPath =
            path.join(
                commandsDir,
                file
            );

        try {
            /*
             * Delete require cache so this loader always loads
             * the current command file.
             */
            delete require.cache[
                require.resolve(fullPath)
            ];

            const command =
                require(fullPath);

            /*
             * Command filename becomes command name.
             *
             * menu.js -> menu
             * ping.js -> ping
             * groupinfo.js -> groupinfo
             */
            const name =
                path.basename(
                    file,
                    '.js'
                ).toLowerCase();

            if (
                typeof command !==
                'function'
            ) {
                console.warn(
                    `[COMMANDS] Skipping ${file}: module does not export a function.`
                );

                continue;
            }

            global.commands[name] =
                command;

            console.log(
                `[COMMANDS] Loaded: ${name}`
            );
        } catch (error) {
            console.error(
                `[COMMANDS] Failed to load ${file}:`,
                error?.stack || error
            );
        }
    }

    console.log(
        `[COMMANDS] ${Object.keys(global.commands).length} command(s) loaded.`
    );
}

loadCommands();

/*
|--------------------------------------------------------------------------
| Telegram command modules
|--------------------------------------------------------------------------
*/

function loadTelegramModule(
    filename
) {
    const fullPath =
        path.join(
            process.cwd(),
            'telegram',
            filename
        );

    if (
        !fs.existsSync(fullPath)
    ) {
        throw new Error(
            `Telegram module not found: ${filename}`
        );
    }

    delete require.cache[
        require.resolve(fullPath)
    ];

    return require(fullPath);
}

let pairCommand;
let stopCommand;
let statusCommand;
let helpCommand;
let startCommand;

try {
    pairCommand =
        loadTelegramModule(
            'pair.js'
        );

    stopCommand =
        loadTelegramModule(
            'stop.js'
        );

    statusCommand =
        loadTelegramModule(
            'status.js'
        );

    helpCommand =
        loadTelegramModule(
            'help.js'
        );

    startCommand =
        loadTelegramModule(
            'start.js'
        );
} catch (error) {
    console.error(
        '[TELEGRAM] Failed to load Telegram modules:',
        error?.stack || error
    );

    process.exit(1);
}

/*
|--------------------------------------------------------------------------
| Utility functions
|--------------------------------------------------------------------------
*/

function telegramUserId(ctx) {
    return String(
        ctx?.from?.id || ''
    );
}

function getPrefix() {
    return PREFIX;
}

function normalizeCommand(
    text
) {
    const value =
        String(text || '')
            .trim();

    if (!value) {
        return null;
    }

    /*
     * WhatsApp self-bot supports:
     *
     * .menu
     * menu
     *
     * Internally everything becomes .menu.
     */
    if (
        value.startsWith(PREFIX)
    ) {
        return value;
    }

    return `${PREFIX}${value}`;
}

/*
|--------------------------------------------------------------------------
| WhatsApp command parser
|--------------------------------------------------------------------------
*/

function parseWhatsAppCommand(
    text
) {
    const normalized =
        normalizeCommand(text);

    if (!normalized) {
        return null;
    }

    if (
        !normalized.startsWith(PREFIX)
    ) {
        return null;
    }

    const body =
        normalized
            .slice(PREFIX.length)
            .trim();

    if (!body) {
        return null;
    }

    const parts =
        body.split(/\s+/);

    const command =
        String(
            parts.shift() || ''
        )
            .toLowerCase();

    if (!command) {
        return null;
    }

    return {
        command,
        args: parts,
        text: parts.join(' '),
        raw: normalized
    };
}

/*
|--------------------------------------------------------------------------
| WhatsApp reply wrapper
|--------------------------------------------------------------------------
*/

async function replyWhatsApp(
    sock,
    msg,
    jid,
    text
) {
    return sendReply(
        sock,
        jid,
        text,
        msg
    );
}

/*
|--------------------------------------------------------------------------
| Global WhatsApp command handler
|--------------------------------------------------------------------------
|
| lib/whatsapp.js calls this function when:
|
|     msg.key.fromMe === true
|
| That means the linked WhatsApp account itself sent the message.
|
| Messages from other people never reach command execution.
|
|--------------------------------------------------------------------------
*/

global.handleWhatsAppCommand =
    async function handleWhatsAppCommand(
        sock,
        msg,
        jid,
        senderNumber,
        isGroup,
        text,
        userId
    ) {
        /*
         * Validate session ownership.
         */
        const session =
            getWhatsAppSession(
                userId
            );

        if (!session) {
            return;
        }

        /*
         * Never process messages from a socket that is no longer
         * the active session.
         */
        if (
            session.sock !== sock
        ) {
            return;
        }

        /*
         * SELF-BOT SAFETY CHECK.
         *
         * This is intentionally repeated here even though
         * whatsapp.js already filters fromMe.
         *
         * Defense in depth is useful when humans inevitably
         * modify one file and forget what another file does.
         */
        if (
            msg?.key?.fromMe !== true
        ) {
            return;
        }

        /*
         * Never respond to WhatsApp status broadcasts.
         */
        if (
            jid ===
            'status@broadcast'
        ) {
            return;
        }

        /*
         * Parse command.
         */
        const parsed =
            parseWhatsAppCommand(
                text
            );

        if (!parsed) {
            return;
        }

        const {
            command,
            args
        } = parsed;

        /*
         * Find command implementation.
         */
        const handler =
            global.commands[
                command
            ];

        if (
            typeof handler !==
            'function'
        ) {
            /*
             * Unknown commands are silently ignored.
             *
             * This keeps the self-bot from replying to every
             * random piece of text the linked account sends.
             */
            return;
        }

        /*
         * Basic command context.
         *
         * Existing command files can use these properties.
         */
        const commandContext = {
            sock,

            msg,

            jid,

            senderNumber,

            userId,

            isGroup,

            args,

            text: parsed.text,

            command,

            prefix: PREFIX,

            reply: async (
                response
            ) => {
                return replyWhatsApp(
                    sock,
                    msg,
                    jid,
                    response
                );
            },

            send: async (
                response,
                options = {}
            ) => {
                if (
                    options &&
                    options.raw
                ) {
                    return sock.sendMessage(
                        jid,
                        response
                    );
                }

                return sendReply(
                    sock,
                    jid,
                    response,
                    options.quoted === false
                        ? null
                        : msg
                );
            }
        };

        /*
         * Some of the existing command files may expect a
         * different calling convention.
         *
         * The primary convention is:
         *
         *     handler(ctx)
         *
         * The command receives everything through ctx.
         */
        try {
            await handler(
                commandContext
            );
        } catch (error) {
            console.error(
                `[COMMAND:${command}]`,
                error?.stack || error
            );

            /*
             * Don't expose internal stack traces to WhatsApp.
             */
            try {
                await replyWhatsApp(
                    sock,
                    msg,
                    jid,
                    '❌ Command failed. Please try again.'
                );
            } catch {}
        }
    };

/*
|--------------------------------------------------------------------------
| Telegram /start
|--------------------------------------------------------------------------
*/

bot.start(
    async (ctx) => {
        try {
            await startCommand(ctx);
        } catch (error) {
            console.error(
                '[/start]',
                error?.stack || error
            );

            await ctx.reply(
                '❌ Failed to start the bot.'
            );
        }
    }
);

/*
|--------------------------------------------------------------------------
| Telegram /help
|--------------------------------------------------------------------------
*/

bot.command(
    'help',
    async (ctx) => {
        try {
            await helpCommand(ctx);
        } catch (error) {
            console.error(
                '[/help]',
                error?.stack || error
            );

            await ctx.reply(
                '❌ Failed to load help.'
            );
        }
    }
);

/*
|--------------------------------------------------------------------------
| Telegram /pair
|--------------------------------------------------------------------------
*/

bot.command(
    'pair',
    async (ctx) => {
        const userId =
            telegramUserId(ctx);

        /*
         * Do not let Telegram create multiple simultaneous
         * pairing sessions for one user.
         */
        const pairing =
            global.pairingStates[userId];

        if (
            pairing?.active
        ) {
            await ctx.reply(
                '⏳ A pairing operation is already running.\n\n' +
                'Wait for it to finish before using /pair again.'
            );

            return;
        }

        try {
            await pairCommand(ctx);
        } catch (error) {
            console.error(
                '[/pair]',
                error?.stack || error
            );

            /*
             * Always clean pairing state after an unexpected
             * exception.
             */
            delete global.pairingStates[
                userId
            ];

            await ctx.reply(
                '❌ Pairing failed.\n\n' +
                'The pairing system encountered an unexpected error.\n\n' +
                'Use /pair to try again.'
            );
        }
    }
);

/*
|--------------------------------------------------------------------------
| Telegram /stop
|--------------------------------------------------------------------------
*/

bot.command(
    'stop',
    async (ctx) => {
        const userId =
            telegramUserId(ctx);

        try {
            await stopCommand(ctx);
        } catch (error) {
            console.error(
                '[/stop]',
                error?.stack || error
            );

            /*
             * Do not leave stale Telegram-side pairing state.
             */
            delete global.pairingStates[
                userId
            ];

            /*
             * Also remove stale in-memory session reference.
             *
             * stop.js performs proper socket shutdown itself.
             * This is only the final safety cleanup.
             */
            delete global.sessions[
                userId
            ];

            await ctx.reply(
                '⚠️ WhatsApp session cleanup completed with an error.\n\n' +
                'You can use /pair to create a fresh connection.'
            );
        }
    }
);

/*
|--------------------------------------------------------------------------
| Telegram /status
|--------------------------------------------------------------------------
*/

bot.command(
    'status',
    async (ctx) => {
        try {
            await statusCommand(ctx);
        } catch (error) {
            console.error(
                '[/status]',
                error?.stack || error
            );

            const userId =
                telegramUserId(ctx);

            const session =
                getWhatsAppSession(
                    userId
                );

            if (!session) {
                await ctx.reply(
                    '🔴 WhatsApp: disconnected.'
                );

                return;
            }

            await ctx.reply(
                '📊 WhatsApp status\n\n' +
                `📱 Number: ${session.number || 'Unknown'}\n` +
                `🔌 Connection: ${session.connection || 'unknown'}\n` +
                `🔐 Pairing: ${session.pairing ? 'yes' : 'no'}`
            );
        }
    }
);

/*
|--------------------------------------------------------------------------
| Telegram unknown commands
|--------------------------------------------------------------------------
*/

bot.on(
    'text',
    async (ctx, next) => {
        const text =
            String(
                ctx.message?.text || ''
            ).trim();

        /*
         * Leave Telegram commands such as /pair to Telegraf's
         * command handlers.
         */
        if (
            text.startsWith('/')
        ) {
            return next();
        }

        /*
         * If a pairing state is active, pair.js owns this text.
         *
         * This listener deliberately does nothing.
         */
        const userId =
            telegramUserId(ctx);

        if (
            global.pairingStates[userId]
        ) {
            return next();
        }

        /*
         * Normal Telegram chat messages are not WhatsApp commands.
         */
        return next();
    }
);

/*
|--------------------------------------------------------------------------
| Telegram errors
|--------------------------------------------------------------------------
*/

bot.catch(
    async (error, ctx) => {
        console.error(
            '[TELEGRAM ERROR]',
            error?.stack || error
        );

        try {
            if (
                ctx?.chat?.id
            ) {
                await ctx.reply(
                    '❌ An unexpected bot error occurred.'
                );
            }
        } catch {}
    }
);

/*
|--------------------------------------------------------------------------
| Telegram graceful shutdown
|--------------------------------------------------------------------------
*/

let shuttingDown = false;

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
     * Stop accepting Telegram updates.
     */
    try {
        bot.stop(
            signal
        );
    } catch {}

    /*
     * Close all active WhatsApp sockets.
     *
     * We deliberately do NOT delete authentication files here.
     * That allows sessions to be restored after the process
     * restarts.
     */
    const activeSessions =
        Object.entries(
            global.sessions
        );

    for (
        const [userId, session]
        of activeSessions
    ) {
        try {
            session.intentionalStop =
                true;

            if (
                session.sock &&
                typeof session.sock.end ===
                    'function'
            ) {
                session.sock.end(
                    new Error(
                        `Application shutdown: ${signal}`
                    )
                );
            }
        } catch (error) {
            console.error(
                `[SYSTEM] Failed to close WhatsApp session ${userId}:`,
                error?.message || error
            );
        }
    }

    /*
     * Give sockets a brief moment to close cleanly.
     */
    await new Promise(
        resolve =>
            setTimeout(
                resolve,
                500
            )
    );

    process.exit(0);
}

process.once(
    'SIGINT',
    () => shutdown('SIGINT')
);

process.once(
    'SIGTERM',
    () => shutdown('SIGTERM')
);

/*
|--------------------------------------------------------------------------
| Unhandled errors
|--------------------------------------------------------------------------
*/

process.on(
    'unhandledRejection',
    (reason) => {
        console.error(
            '[UNHANDLED REJECTION]',
            reason?.stack ||
                reason
        );
    }
);

process.on(
    'uncaughtException',
    (error) => {
        console.error(
            '[UNCAUGHT EXCEPTION]',
            error?.stack ||
                error
        );
    }
);

/*
|--------------------------------------------------------------------------
| Startup
|--------------------------------------------------------------------------
*/

async function startApplication() {
    if (
        global.solvaxStarted
    ) {
        console.warn(
            '[SYSTEM] Application already started.'
        );

        return;
    }

    global.solvaxStarted =
        true;

    console.log(
        '\n' +
        '========================================\n' +
        `        ${BOT_NAME}\n` +
        '========================================\n'
    );

    console.log(
        `[SYSTEM] Prefix: ${PREFIX}`
    );

    console.log(
        `[SYSTEM] Commands loaded: ${Object.keys(global.commands).length}`
    );

    /*
     * Start Telegram polling first.
     */
    try {
        await bot.launch();

        console.log(
            '[TELEGRAM] Bot started successfully.'
        );
    } catch (error) {
        console.error(
            '[TELEGRAM] Failed to start:',
            error?.stack || error
        );

        process.exit(1);
    }

    /*
     * Restore WhatsApp sessions after Telegram is available.
     *
     * If a saved authenticated session exists, whatsapp.js will
     * reconnect it.
     */
    try {
        await restoreSessions();

        console.log(
            '[WHATSAPP] Session restoration completed.'
        );
    } catch (error) {
        console.error(
            '[WHATSAPP] Session restoration failed:',
            error?.stack || error
        );
    }

    console.log(
        '\n[SYSTEM] SOLVAX MD is online.\n'
    );
}

/*
|--------------------------------------------------------------------------
| Start
|--------------------------------------------------------------------------
*/

startApplication().catch(
    (error) => {
        console.error(
            '[FATAL]',
            error?.stack || error
        );

        process.exit(1);
    }
);

/*
|--------------------------------------------------------------------------
| Export
|--------------------------------------------------------------------------
*/

module.exports = {
    bot,
    config,
    getPrefix
};
