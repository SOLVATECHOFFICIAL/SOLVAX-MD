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
    isWhatsAppConnected
} = require('./lib/whatsapp');

const {
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

function extractCommand(text) {
    if (!text) {
        return null;
    }

    let value = String(text).trim();

    if (!value) {
        return null;
    }

    /*
     * Supports:
     *
     * .menu
     * menu
     * .menu hello
     * menu hello
     *
     * The bot only executes a recognized command.
     */

    if (value.startsWith('.')) {
        value = value.slice(1).trim();
    }

    if (!value) {
        return null;
    }

    const parts = value.split(/\s+/);

    const command = normalizeCommandName(parts.shift());

    if (!command) {
        return null;
    }

    return {
        command,
        args: parts,
        raw: text
    };
}

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
     * SECURITY RULE:
     *
     * Only messages sent by the linked WhatsApp account
     * itself are allowed to control the bot.
     *
     * Messages from other people are ignored completely.
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
        return;
    }

    console.log(
        `[COMMAND] user=${key} command=${command} jid=${jid}`
    );

    /*
     * Command context.
     *
     * Every command gets the exact WhatsApp JID where
     * the command was sent.
     *
     * Therefore:
     *
     * Private chat  -> reply to that private chat
     * Group         -> reply inside that same group
     *
     * We do NOT reply to the Telegram user here.
     */

    const context = {
        userId: key,
        session,
        socket: session.socket,
        sock: session.socket,

        msg,

        jid,
        remoteJid: jid,

        text,
        raw,

        command,
        args,

        send: async (message, options = {}) => {
            return sendReply(
                session.socket,
                jid,
                message,
                options
            );
        },

        reply: async (message, options = {}) => {
            return sendReply(
                session.socket,
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
         * module(context)
         */

        if (handler.length <= 1) {
            return await handler(context);
        }

        /*
         * Compatibility with older command files that may expect:
         *
         * handler(sock, msg, args, userId)
         *
         * This prevents old command files from silently breaking
         * after the new session architecture.
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

        /*
         * Do not expose internal errors to group members.
         * A short error is enough.
         */

        try {
            await sendReply(
                session.socket,
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

/*
 * ---------------------------------------------------------
 * TELEGRAM COMMANDS
 * ---------------------------------------------------------
 */

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

bot.start(async (ctx) => {
    try {
        await startCommand(ctx);
    } catch (error) {
        console.error('[TELEGRAM] /start failed:', error);

        await ctx.reply(
            '❌ Failed to start the bot.'
        );
    }
});

bot.command('pair', async (ctx) => {
    try {
        await pairCommand(ctx);
    } catch (error) {
        console.error('[TELEGRAM] /pair failed:', error);

        await ctx.reply(
            '❌ Pairing command failed.\n\n' +
            'Use /stop and then /pair again.'
        );
    }
});

bot.command('stop', async (ctx) => {
    try {
        await stopCommand(ctx);
    } catch (error) {
        console.error('[TELEGRAM] /stop failed:', error);

        await ctx.reply(
            '⚠️ Stop failed unexpectedly.\n\n' +
            'A cleanup attempt may still have been performed.'
        );
    }
});

bot.command('status', async (ctx) => {
    try {
        await statusCommand(ctx);
    } catch (error) {
        console.error('[TELEGRAM] /status failed:', error);

        await ctx.reply(
            '❌ Unable to read WhatsApp status.'
        );
    }
});

bot.command('help', async (ctx) => {
    try {
        await helpCommand(ctx);
    } catch (error) {
        console.error('[TELEGRAM] /help failed:', error);

        await ctx.reply(
            '❌ Unable to show help.'
        );
    }
});

/*
 * ---------------------------------------------------------
 * TELEGRAM PAIRING NUMBER HANDLER
 * ---------------------------------------------------------
 *
 * When /pair is active, the next plain Telegram message
 * containing the phone number is handled by pair.js.
 *
 * Outside pairing mode, normal Telegram messages are ignored.
 */

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

        if (
            pairingState.stage !==
            'waiting_number'
        ) {
            return;
        }

        /*
         * Ignore Telegram commands here.
         *
         * /stop and /pair must remain handled by their
         * own command handlers.
         */

        const text =
            String(ctx.message.text).trim();

        if (!text || text.startsWith('/')) {
            return;
        }

        if (
            typeof pairCommand.handlePairNumber !==
            'function'
        ) {
            await ctx.reply(
                '❌ Pairing number handler is unavailable.'
            );
            return;
        }

        await pairCommand.handlePairNumber(
            ctx,
            text
        );
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

/*
 * ---------------------------------------------------------
 * TELEGRAM ERROR HANDLING
 * ---------------------------------------------------------
 */

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

/*
 * ---------------------------------------------------------
 * STARTUP
 * ---------------------------------------------------------
 */

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
     * Telegram must start before restoring WhatsApp sessions.
     *
     * This is important because a restored WhatsApp session can
     * immediately become "open" and send a Telegram notification.
     */

    await bot.launch();

    console.log(
        '✅ Telegram bot started.'
    );

    /*
     * Restore previously authenticated WhatsApp sessions.
     *
     * Auth is intentionally preserved across a normal process
     * restart. /stop uses completelyResetUser(), which deletes it.
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

async function shutdown(signal) {
    if (shuttingDown) {
        return;
    }

    shuttingDown = true;

    console.log(
        `\n[SYSTEM] Received ${signal}. Shutting down...`
    );

    /*
     * IMPORTANT:
     *
     * removeAuth:false
     *
     * A server restart must NOT destroy authenticated WhatsApp
     * sessions. Otherwise Railway restarts would force users
     * to pair every time.
     *
     * /stop is different and performs a complete deletion.
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

startBot().catch((error) => {
    console.error(
        '❌ Failed to start SolvaX MD:',
        error
    );

    process.exit(1);
});
