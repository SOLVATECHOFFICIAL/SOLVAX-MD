'use strict';

const fs = require('fs');
const path = require('path');

const { Telegraf } = require('telegraf');

const {
    getMessageText,
    getRemoteJid,
    isSelfMessage,
    isIgnoredJid,
    sendReply,
    restoreSessions,
    stopAllWhatsAppSessions,
    isWhatsAppConnected,
    getPairingState
} = require('./lib/whatsapp');

const configPath = path.join(process.cwd(), 'config.json');

let config = {};

try {
    if (fs.existsSync(configPath)) {
        config = require(configPath);
    }
} catch (error) {
    console.error('[CONFIG] Failed to load config.json:', error);
    config = {};
}

const BOT_TOKEN =
    process.env.BOT_TOKEN ||
    process.env.TELEGRAM_BOT_TOKEN ||
    config.botToken ||
    config.telegramBotToken ||
    '';

if (!BOT_TOKEN) {
    console.error(
        '❌ Telegram bot token is missing.\n\n' +
        'Set BOT_TOKEN in Railway environment variables or config.json.'
    );

    process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);

global.bot = bot;
global.sessions = global.sessions || {};
global.pairingStates = global.pairingStates || {};

const COMMANDS = new Map();

/* =========================================================
   COMMAND REGISTRATION
========================================================= */

function normalizeCommandName(name) {
    if (!name) return '';

    return String(name)
        .trim()
        .toLowerCase()
        .replace(/^\./, '')
        .replace(/@\S+$/, '');
}

function registerCommand(name, handler) {
    if (!name || typeof handler !== 'function') {
        return;
    }

    const normalized = normalizeCommandName(name);

    if (!normalized) {
        return;
    }

    COMMANDS.set(normalized, handler);
}

function registerCommandAliases(handler, names) {
    if (!Array.isArray(names)) {
        names = [names];
    }

    for (const name of names) {
        registerCommand(name, handler);
    }
}

function loadWhatsAppCommands() {
    const commandsDir = path.join(process.cwd(), 'commands');

    if (!fs.existsSync(commandsDir)) {
        console.warn(
            '[COMMANDS] commands directory does not exist.'
        );
        return;
    }

    const files = fs.readdirSync(commandsDir)
        .filter((file) => file.endsWith('.js'))
        .sort();

    for (const file of files) {
        const fullPath = path.join(commandsDir, file);

        try {
            delete require.cache[require.resolve(fullPath)];

            const commandModule = require(fullPath);

            if (typeof commandModule === 'function') {
                const commandName =
                    path.basename(file, '.js');

                registerCommand(
                    commandName,
                    commandModule
                );

                console.log(
                    `[COMMANDS] Loaded .${commandName}`
                );

                continue;
            }

            if (
                commandModule &&
                typeof commandModule.handler === 'function'
            ) {
                const commandName =
                    commandModule.name ||
                    path.basename(file, '.js');

                registerCommand(
                    commandName,
                    commandModule.handler
                );

                if (Array.isArray(commandModule.aliases)) {
                    registerCommandAliases(
                        commandModule.handler,
                        commandModule.aliases
                    );
                }

                console.log(
                    `[COMMANDS] Loaded .${commandName}`
                );

                continue;
            }

            console.warn(
                `[COMMANDS] Ignored ${file}: no usable handler.`
            );
        } catch (error) {
            console.error(
                `[COMMANDS] Failed loading ${file}:`,
                error
            );
        }
    }
}

loadWhatsAppCommands();

/* =========================================================
   COMMAND PARSER
========================================================= */

function extractCommand(text) {
    if (!text) {
        return null;
    }

    let value = String(text).trim();

    if (!value) {
        return null;
    }

    if (value.startsWith('.')) {
        value = value.slice(1).trim();
    }

    if (!value) {
        return null;
    }

    const parts = value.split(/\s+/);

    const command = normalizeCommandName(
        parts.shift()
    );

    if (!command) {
        return null;
    }

    return {
        command,
        args: parts,
        raw: text
    };
}

/* =========================================================
   WHATSAPP COMMAND HANDLER
========================================================= */

async function handleWhatsAppCommand(
    userId,
    session,
    msg
) {
    const key = String(userId);

    if (!session) {
        return;
    }

    if (session.stopping) {
        return;
    }

    /*
     * Only messages sent by the linked WhatsApp account
     * itself can control the bot.
     */
    if (!isSelfMessage(msg)) {
        return;
    }

    const jid = getRemoteJid(msg);

    if (!jid || isIgnoredJid(jid)) {
        return;
    }

    const text = getMessageText(msg.message);

    if (!text || !text.trim()) {
        return;
    }

    const parsed = extractCommand(text);

    if (!parsed) {
        return;
    }

    const {
        command,
        args,
        raw
    } = parsed;

    const handler = COMMANDS.get(command);

    if (!handler) {
        console.log(
            `[COMMAND] Unknown command .${command} for ${key}`
        );
        return;
    }

    console.log(
        `[COMMAND] user=${key} command=${command} jid=${jid}`
    );

    /*
     * Determine group/private context.
     */
    const isGroup =
        typeof jid === 'string' &&
        jid.endsWith('@g.us');

    /*
     * Extract sender information.
     *
     * For a self message, the sender is normally the
     * linked account itself. Fall back to the remote JID.
     */
    const senderJid =
        msg?.key?.participant ||
        msg?.participant ||
        msg?.key?.remoteJid ||
        jid;

    const senderNumber =
        String(senderJid || '')
            .split('@')[0]
            .replace(/\D/g, '');

    /*
     * Owner check.
     *
     * The linked WhatsApp account is the owner/controller
     * of this WhatsApp session.
     */
    const isOwner = () => true;

    const context = {
        userId: key,

        session,

        socket: session.socket,
        sock: session.socket,

        msg,

        jid,
        remoteJid: jid,

        senderJid,
        senderNumber,

        isGroup,
        isSelf: true,

        text,
        raw,

        command,
        args,

        isOwner,

        /*
         * IMPORTANT:
         *
         * sendReply() expects:
         *
         * sendReply(userId, jid, text, options)
         *
         * Therefore we pass `key`, not `session.socket`.
         */
        send: async (message, options = {}) => {
            return sendReply(
                key,
                jid,
                message,
                options
            );
        },

        reply: async (message, options = {}) => {
            return sendReply(
                key,
                jid,
                message,
                options
            );
        }
    };

    try {
        /*
         * New-style command:
         *
         * handler(context)
         */
        if (handler.length <= 1) {
            return await handler(context);
        }

        /*
         * Compatibility with older command handlers:
         *
         * handler(sock, msg, args, userId, context)
         */
        return await handler(
            session.socket,
            msg,
            args,
            key,
            context
        );
    } catch (error) {
        console.error(
            `[COMMAND] .${command} failed for ${key}:`,
            error
        );

        try {
            /*
             * IMPORTANT:
             * sendReply() expects userId first.
             */
            await sendReply(
                key,
                jid,
                '❌ Command failed. Please try again.'
            );
        } catch (replyError) {
            console.error(
                `[COMMAND] Failed sending error reply for ${key}:`,
                replyError
            );
        }
    }
}

global.handleWhatsAppCommand =
    handleWhatsAppCommand;

/* =========================================================
   TELEGRAM COMMAND MODULES
========================================================= */

const pairCommand =
    require('./telegram/pair');

const stopCommand =
    require('./telegram/stop');

const statusCommand =
    require('./telegram/status');

const helpCommand =
    require('./telegram/help');

const startCommand =
    require('./telegram/start');

/* =========================================================
   /START
========================================================= */

bot.start(async (ctx) => {
    try {
        await startCommand(ctx);
    } catch (error) {
        console.error(
            '[TELEGRAM] /start failed:',
            error
        );

        await ctx.reply(
            '❌ Failed to start the bot.'
        );
    }
});

/* =========================================================
   /PAIR
========================================================= */

bot.command('pair', async (ctx) => {
    try {
        /*
         * pair.js exports an object.
         *
         * The correct function is:
         * pairCommand.beginPairing(ctx)
         */
        if (
            !pairCommand ||
            typeof pairCommand.beginPairing !== 'function'
        ) {
            throw new Error(
                'Pairing module does not export beginPairing().'
            );
        }

        await pairCommand.beginPairing(ctx);

    } catch (error) {
        console.error(
            '[TELEGRAM] /pair failed:',
            error
        );

        await ctx.reply(
            '❌ Pairing command failed.\n\n' +
            'Please try /pair again.'
        );
    }
});

/* =========================================================
   /CANCEL
========================================================= */

bot.command('cancel', async (ctx) => {
    try {
        if (
            !pairCommand ||
            typeof pairCommand.cancelPairing !== 'function'
        ) {
            throw new Error(
                'Pairing module does not export cancelPairing().'
            );
        }

        await pairCommand.cancelPairing(ctx);

    } catch (error) {
        console.error(
            '[TELEGRAM] /cancel failed:',
            error
        );

        await ctx.reply(
            '❌ Failed to cancel the pairing request.'
        );
    }
});

/* =========================================================
   /STOP
========================================================= */

bot.command('stop', async (ctx) => {
    try {
        await stopCommand(ctx);
    } catch (error) {
        console.error(
            '[TELEGRAM] /stop failed:',
            error
        );

        await ctx.reply(
            '⚠️ Stop failed unexpectedly.\n\n' +
            'A cleanup attempt may still have been performed.'
        );
    }
});

/* =========================================================
   /STATUS
========================================================= */

bot.command('status', async (ctx) => {
    try {
        await statusCommand(ctx);
    } catch (error) {
        console.error(
            '[TELEGRAM] /status failed:',
            error
        );

        await ctx.reply(
            '❌ Unable to read WhatsApp status.'
        );
    }
});

/* =========================================================
   /HELP
========================================================= */

bot.command('help', async (ctx) => {
    try {
        await helpCommand(ctx);
    } catch (error) {
        console.error(
            '[TELEGRAM] /help failed:',
            error
        );

        await ctx.reply(
            '❌ Unable to show help.'
        );
    }
});

/* =========================================================
   TELEGRAM PAIRING NUMBER HANDLER
========================================================= */

bot.on('text', async (ctx) => {
    try {
        if (!ctx.message?.text) {
            return;
        }

        const userId =
            String(ctx.from.id);

        const pairingState =
            getPairingState(userId);

        if (!pairingState) {
            return;
        }

        /*
         * pair.js uses `status`, not `stage`.
         */
        if (
            pairingState.status !==
            'waiting_number'
        ) {
            return;
        }

        const text =
            String(ctx.message.text).trim();

        /*
         * Do not consume Telegram commands here.
         */
        if (!text || text.startsWith('/')) {
            return;
        }

        if (
            !pairCommand ||
            typeof pairCommand.handlePairNumber !==
            'function'
        ) {
            await ctx.reply(
                '❌ Pairing number handler is unavailable.'
            );
            return;
        }

        /*
         * handlePairNumber reads the number from
         * ctx.message.text.
         */
        await pairCommand.handlePairNumber(ctx);

    } catch (error) {
        console.error(
            '[TELEGRAM] Pairing number handler failed:',
            error
        );

        try {
            await ctx.reply(
                '❌ I could not process that phone number.'
            );
        } catch (_) {
            // Ignore Telegram reply failure.
        }
    }
});

/* =========================================================
   TELEGRAM ERROR HANDLING
========================================================= */

bot.catch(async (error, ctx) => {
    console.error(
        '[TELEGRAM] Unhandled bot error:',
        error
    );

    try {
        if (ctx?.chat?.id) {
            await ctx.telegram.sendMessage(
                String(ctx.chat.id),
                '⚠️ An unexpected bot error occurred.'
            );
        }
    } catch (replyError) {
        console.error(
            '[TELEGRAM] Failed sending error message:',
            replyError
        );
    }
});

/* =========================================================
   STARTUP
========================================================= */

let shuttingDown = false;

async function startBot() {
    console.log('');
    console.log('========================================');
    console.log('          SOLVAX MD STARTING');
    console.log('========================================');
    console.log('');

    console.log(
        `[SYSTEM] Node.js: ${process.version}`
    );

    console.log(
        `[SYSTEM] Loaded WhatsApp commands: ${COMMANDS.size}`
    );

    /*
     * Start Telegram first.
     */
    await bot.launch();

    console.log(
        '✅ Telegram bot started.'
    );

    /*
     * Restore authenticated WhatsApp sessions.
     */
    try {
        await restoreSessions();

        console.log(
            '✅ WhatsApp session restore completed.'
        );
    } catch (error) {
        console.error(
            '❌ WhatsApp session restore failed:',
            error
        );
    }

    console.log('');
    console.log('========================================');
    console.log('             SOLVAX MD READY');
    console.log('========================================');
    console.log('');
}

/* =========================================================
   SHUTDOWN
========================================================= */

async function shutdown(signal) {
    if (shuttingDown) {
        return;
    }

    shuttingDown = true;

    console.log(
        `\n[SYSTEM] Received ${signal}. Shutting down...`
    );

    /*
     * Do not remove WhatsApp authentication on process
     * shutdown. /stop performs permanent session cleanup.
     */
    try {
        await stopAllWhatsAppSessions({
            removeAuth: false
        });

        console.log(
            '[SYSTEM] WhatsApp sessions stopped.'
        );
    } catch (error) {
        console.error(
            '[SYSTEM] Failed stopping WhatsApp sessions:',
            error
        );
    }

    try {
        bot.stop(signal);

        console.log(
            '[SYSTEM] Telegram bot stopped.'
        );
    } catch (error) {
        console.error(
            '[SYSTEM] Failed stopping Telegram bot:',
            error
        );
    }

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

/* =========================================================
   PROCESS ERROR HANDLING
========================================================= */

process.on(
    'unhandledRejection',
    (reason) => {
        console.error(
            '[SYSTEM] Unhandled promise rejection:',
            reason
        );
    }
);

process.on(
    'uncaughtException',
    (error) => {
        console.error(
            '[SYSTEM] Uncaught exception:',
            error
        );
    }
);

/* =========================================================
   START
========================================================= */

startBot().catch((error) => {
    console.error(
        '❌ Failed to start SolvaX MD:',
        error
    );

    process.exit(1);
});
