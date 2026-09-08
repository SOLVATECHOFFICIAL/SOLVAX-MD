'use strict';

/*
 * =========================================================
 * SOLVAX MD
 * index.js
 * =========================================================
 *
 * MAIN APPLICATION ENTRY POINT
 *
 * RESPONSIBILITIES
 * ---------------------------------------------------------
 * 1. Start Telegram bot
 * 2. Load WhatsApp commands
 * 3. Receive WhatsApp messages
 * 4. Allow ONLY the linked WhatsApp account to control
 *    the bot
 * 5. Dispatch .menu, .vv, .ping, etc.
 * 6. Handle Telegram pairing
 * 7. Handle Telegram status/help/stop
 * 8. Restore WhatsApp sessions
 *
 * =========================================================
 */

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


/* =========================================================
   CONFIG
========================================================= */

const configPath = path.join(
    process.cwd(),
    'config.json'
);

let config = {};


/* =========================================================
   LOAD CONFIG
========================================================= */

try {

    if (fs.existsSync(configPath)) {

        config = require(configPath);

    }

} catch (error) {

    console.error(
        '[CONFIG] Failed to load config.json:',
        error
    );

    config = {};
}


/* =========================================================
   TELEGRAM BOT TOKEN
========================================================= */

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


/* =========================================================
   TELEGRAM BOT
========================================================= */

const bot = new Telegraf(
    BOT_TOKEN
);


/*
 * Make bot available globally.
 */
global.bot = bot;


/*
 * Make session objects available globally.
 *
 * lib/whatsapp.js also initializes these, but keeping
 * the references here makes the application consistent.
 */
global.sessions =
    global.sessions || {};

global.pairingStates =
    global.pairingStates || {};


/* =========================================================
   WHATSAPP COMMAND REGISTRY
========================================================= */

const COMMANDS = new Map();


/* =========================================================
   COMMAND NAME NORMALIZER
========================================================= */

function normalizeCommandName(name) {

    if (!name) {
        return '';
    }

    return String(name)
        .trim()
        .toLowerCase()
        .replace(/^\./, '')
        .replace(/@\S+$/, '');
}


/* =========================================================
   REGISTER COMMAND
========================================================= */

function registerCommand(name, handler) {

    if (
        !name ||
        typeof handler !== 'function'
    ) {
        return;
    }

    const normalized =
        normalizeCommandName(name);

    if (!normalized) {
        return;
    }

    COMMANDS.set(
        normalized,
        handler
    );
}


/* =========================================================
   REGISTER ALIASES
========================================================= */

function registerCommandAliases(handler, names) {

    if (!Array.isArray(names)) {
        names = [names];
    }

    for (const name of names) {

        registerCommand(
            name,
            handler
        );
    }
}


/* =========================================================
   LOAD WHATSAPP COMMANDS
========================================================= */

function loadWhatsAppCommands() {

    const commandsDir = path.join(
        process.cwd(),
        'commands'
    );


    if (!fs.existsSync(commandsDir)) {

        console.warn(
            '[COMMANDS] commands directory does not exist.'
        );

        return;
    }


    const files = fs.readdirSync(
        commandsDir
    )
    .filter(
        (file) =>
            file.endsWith('.js')
    )
    .sort();


    console.log(
        `[COMMANDS] Found ${files.length} command files.`
    );


    for (const file of files) {

        const fullPath = path.join(
            commandsDir,
            file
        );


        try {

            /*
             * Clear require cache so commands are loaded
             * freshly when the application starts.
             */
            delete require.cache[
                require.resolve(fullPath)
            ];


            const commandModule =
                require(fullPath);


            /* ---------------------------------------------
               STYLE 1

               module.exports = async ctx => {}
            --------------------------------------------- */

            if (
                typeof commandModule ===
                'function'
            ) {

                const commandName =
                    path.basename(
                        file,
                        '.js'
                    );


                registerCommand(
                    commandName,
                    commandModule
                );


                console.log(
                    `[COMMANDS] Loaded .${commandName}`
                );


                continue;
            }


            /* ---------------------------------------------
               STYLE 2

               module.exports = {
                   name: 'menu',
                   aliases: [],
                   handler: async ctx => {}
               }
            --------------------------------------------- */

            if (
                commandModule &&
                typeof commandModule.handler ===
                'function'
            ) {

                const commandName =
                    commandModule.name ||
                    path.basename(
                        file,
                        '.js'
                    );


                registerCommand(
                    commandName,
                    commandModule.handler
                );


                if (
                    Array.isArray(
                        commandModule.aliases
                    )
                ) {

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


    console.log(
        `[COMMANDS] Total registered commands: ${COMMANDS.size}`
    );
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


    /*
     * Commands can be written as:
     *
     * .menu
     *
     * or:
     *
     * menu
     */
    if (value.startsWith('.')) {

        value =
            value
                .slice(1)
                .trim();
    }


    if (!value) {
        return null;
    }


    const parts =
        value.split(/\s+/);


    const command =
        normalizeCommandName(
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


    /*
     * Session must exist.
     */
    if (!session) {

        console.log(
            `[COMMAND] No WhatsApp session found for ${key}`
        );

        return;
    }


    /*
     * Deliberately stopped sessions cannot execute commands.
     */
    if (session.stopping) {

        console.log(
            `[COMMAND] Session ${key} is stopping.`
        );

        return;
    }


    /*
     * =====================================================
     * IMPORTANT SECURITY RULE
     * =====================================================
     *
     * ONLY messages sent by the linked WhatsApp account
     * can control this bot.
     *
     * isSelfMessage() checks message.key.fromMe.
     */
    if (!isSelfMessage(msg)) {

        /*
         * Silently ignore everybody else's messages.
         */
        return;
    }


    /*
     * Get the WhatsApp chat JID.
     */
    const jid =
        getRemoteJid(msg);


    if (
        !jid ||
        isIgnoredJid(jid)
    ) {

        return;
    }


    /*
     * Extract message text.
     */
    const text =
        getMessageText(
            msg.message
        );


    if (
        !text ||
        !text.trim()
    ) {

        return;
    }


    /*
     * Parse command.
     */
    const parsed =
        extractCommand(text);


    if (!parsed) {
        return;
    }


    const {
        command,
        args,
        raw
    } = parsed;


    /*
     * Find registered command.
     */
    const handler =
        COMMANDS.get(command);


    if (!handler) {

        console.log(
            `[COMMAND] Unknown command .${command} from linked account`
        );

        return;
    }


    console.log(
        `[COMMAND] user=${key} command=${command} jid=${jid}`
    );


    /* =====================================================
       GROUP DETECTION
    ===================================================== */

    const isGroup =
        typeof jid === 'string' &&
        jid.endsWith('@g.us');


    /* =====================================================
       SENDER INFORMATION
    ===================================================== */

    const senderJid =
        msg?.key?.participant ||
        msg?.participant ||
        msg?.key?.remoteJid ||
        jid;


    const senderNumber =
        String(senderJid || '')
            .split('@')[0]
            .replace(/\D/g, '');


    /* =====================================================
       OWNER
    ===================================================== */

    /*
     * Because we only accept fromMe messages, the linked
     * WhatsApp account is always treated as the owner.
     */
    const isOwner = () => true;


    /* =====================================================
       COMMAND CONTEXT
    ===================================================== */

    const context = {

        userId: key,

        session,

        socket:
            session.socket,

        sock:
            session.socket,

        msg,

        jid,

        remoteJid:
            jid,

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
         * sendReply() is:
         *
         * sendReply(userId, jid, text, options)
         *
         * Therefore we MUST pass `key`.
         */
        send: async (
            message,
            options = {}
        ) => {

            return sendReply(
                key,
                jid,
                message,
                options
            );
        },


        /*
         * ctx.reply() used by commands such as:
         *
         * module.exports = async ctx => {
         *     await ctx.reply('Hello');
         * }
         */
        reply: async (
            message,
            options = {}
        ) => {

            return sendReply(
                key,
                jid,
                message,
                options
            );
        }
    };


    /* =====================================================
       EXECUTE COMMAND
    ===================================================== */

    try {

        /*
         * New command style:
         *
         * module.exports = async ctx => {}
         */
        if (handler.length <= 1) {

            return await handler(
                context
            );
        }


        /*
         * Older command style:
         *
         * handler(
         *     sock,
         *     msg,
         *     args,
         *     userId,
         *     context
         * )
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
         * Try to tell the linked account that the command
         * failed.
         */
        try {

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


/*
 * Make the command handler available to lib/whatsapp.js.
 */
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
   TELEGRAM /START
========================================================= */

bot.start(async (ctx) => {

    try {

        await startCommand(ctx);

    } catch (error) {

        console.error(
            '[TELEGRAM] /start failed:',
            error
        );


        try {

            await ctx.reply(
                '❌ Failed to start the bot.'
            );

        } catch (replyError) {

            console.error(
                '[TELEGRAM] Failed sending /start error:',
                replyError
            );
        }
    }
});


/* =========================================================
   TELEGRAM /PAIR
========================================================= */

bot.command('pair', async (ctx) => {

    try {

        if (
            !pairCommand ||
            typeof pairCommand.beginPairing !==
            'function'
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


        try {

            await ctx.reply(
                '❌ Pairing command failed.\n\n' +
                'Please try /pair again.'
            );

        } catch (replyError) {

            console.error(
                '[TELEGRAM] Failed sending /pair error:',
                replyError
            );
        }
    }
});


/* =========================================================
   TELEGRAM /CANCEL
========================================================= */

bot.command('cancel', async (ctx) => {

    try {

        if (
            !pairCommand ||
            typeof pairCommand.cancelPairing !==
            'function'
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


        try {

            await ctx.reply(
                '❌ Failed to cancel the pairing request.'
            );

        } catch (replyError) {

            console.error(
                '[TELEGRAM] Failed sending /cancel error:',
                replyError
            );
        }
    }
});


/* =========================================================
   TELEGRAM /STOP
========================================================= */

bot.command('stop', async (ctx) => {

    try {

        await stopCommand(ctx);

    } catch (error) {

        console.error(
            '[TELEGRAM] /stop failed:',
            error
        );


        try {

            await ctx.reply(
                '⚠️ Stop failed unexpectedly.\n\n' +
                'A cleanup attempt may still have been performed.'
            );

        } catch (replyError) {

            console.error(
                '[TELEGRAM] Failed sending /stop error:',
                replyError
            );
        }
    }
});


/* =========================================================
   TELEGRAM /STATUS
========================================================= */

bot.command('status', async (ctx) => {

    try {

        await statusCommand(ctx);

    } catch (error) {

        console.error(
            '[TELEGRAM] /status failed:',
            error
        );


        try {

            await ctx.reply(
                '❌ Unable to read WhatsApp status.'
            );

        } catch (replyError) {

            console.error(
                '[TELEGRAM] Failed sending /status error:',
                replyError
            );
        }
    }
});


/* =========================================================
   TELEGRAM /HELP
========================================================= */

bot.command('help', async (ctx) => {

    try {

        await helpCommand(ctx);

    } catch (error) {

        console.error(
            '[TELEGRAM] /help failed:',
            error
        );


        try {

            await ctx.reply(
                '❌ Unable to show help.'
            );

        } catch (replyError) {

            console.error(
                '[TELEGRAM] Failed sending /help error:',
                replyError
            );
        }
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
         * pair.js uses:
         *
         * status: 'waiting_number'
         */
        if (
            pairingState.status !==
            'waiting_number'
        ) {

            return;
        }


        const text =
            String(
                ctx.message.text
            ).trim();


        /*
         * Do not consume Telegram commands.
         */
        if (
            !text ||
            text.startsWith('/')
        ) {

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
         * handlePairNumber() reads the number from
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

            /*
             * Ignore Telegram reply failure.
             */
        }
    }
});


/* =========================================================
   TELEGRAM ERROR HANDLER
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

let botStarted = false;


async function startBot() {

    console.log('');
    console.log(
        '========================================'
    );
    console.log(
        '          SOLVAX MD STARTING'
    );
    console.log(
        '========================================'
    );
    console.log('');


    console.log(
        `[SYSTEM] Node.js: ${process.version}`
    );


    console.log(
        `[SYSTEM] Loaded WhatsApp commands: ${COMMANDS.size}`
    );


    /*
     * Print registered commands so you can verify that
     * menu/vv/etc. actually loaded.
     */
    if (COMMANDS.size > 0) {

        console.log(
            `[COMMANDS] ${Array.from(COMMANDS.keys())
                .map((name) => '.' + name)
                .join(', ')}`
        );
    }


    /* =====================================================
       START TELEGRAM
    ===================================================== */

    if (!botStarted) {

        await bot.launch();

        botStarted = true;

        console.log(
            '✅ Telegram bot started.'
        );

    } else {

        console.log(
            'ℹ️ Telegram bot is already running.'
        );
    }


    /* =====================================================
       RESTORE WHATSAPP SESSIONS
    ===================================================== */

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
    console.log(
        '========================================'
    );
    console.log(
        '             SOLVAX MD READY'
    );
    console.log(
        '========================================'
    );
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
     * Do NOT remove WhatsApp authentication during normal
     * Railway/process shutdown.
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


    /* =====================================================
       STOP TELEGRAM
    ===================================================== */

    try {

        if (botStarted) {

            bot.stop(signal);

            botStarted = false;
        }


        console.log(
            '[SYSTEM] Telegram bot stopped.'
        );

    } catch (error) {

        console.error(
            '[SYSTEM] Failed stopping Telegram bot:',
            error
        );
    }


    /*
     * Give pending cleanup operations a moment to finish.
     */
    setTimeout(() => {
        process.exit(0);
    }, 100);
}


/* =========================================================
   PROCESS SIGNALS
========================================================= */

process.once(
    'SIGINT',
    () => shutdown('SIGINT')
);

process.once(
    'SIGTERM',
    () => shutdown('SIGTERM')
);


/* =========================================================
   UNHANDLED REJECTION
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


/* =========================================================
   UNCAUGHT EXCEPTION
========================================================= */

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
   START APPLICATION
========================================================= */

startBot()
    .catch(
        (error) => {

            console.error(
                '❌ Failed to start SolvaX MD:',
                error
            );

            process.exit(1);
        }
    );
