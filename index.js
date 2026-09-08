'use strict';

/*
|--------------------------------------------------------------------------
| SOLVAX MD
| Telegram-controlled WhatsApp Management Bot
|--------------------------------------------------------------------------
|
| Main responsibilities:
|
| 1. Start the Telegram bot.
| 2. Load WhatsApp command modules.
| 3. Route Telegram commands.
| 4. Receive phone numbers for /pair.
| 5. Restore WhatsApp sessions.
| 6. Route WhatsApp messages to commands.
| 7. Ensure only the linked WhatsApp account itself can control
|    its own bot session.
| 8. Handle shutdown cleanly.
|
|--------------------------------------------------------------------------
*/

const fs = require('fs');
const path = require('path');

const { Telegraf } = require('telegraf');

const config = require('./config.json');

const {
    getText,
    commandParts,
    jidNumber,
    isGroupJid
} = require('./lib/helpers');

const {
    createWhatsAppSession,
    stopWhatsAppSession,
    getWhatsAppSession,
    sendReply,
    restoreSessions
} = require('./lib/whatsapp');

const {
    handlePairNumber
} = require('./telegram/pair');

/*
|--------------------------------------------------------------------------
| CONFIGURATION
|--------------------------------------------------------------------------
*/

const TELEGRAM_TOKEN = String(
    config.telegramToken ||
    config.botToken ||
    config.token ||
    process.env.BOT_TOKEN ||
    process.env.TELEGRAM_BOT_TOKEN ||
    ''
).trim();

const PREFIX = String(
    config.prefix ||
    '.'
).trim() || '.';

/*
 * Telegram polling is the simplest deployment method for Railway,
 * Render, VPS, etc.
 */
const BOT_NAME = 'SOLVAX MD';

/*
|--------------------------------------------------------------------------
| BASIC VALIDATION
|--------------------------------------------------------------------------
*/

if (!TELEGRAM_TOKEN) {
    console.error(
        '❌ Telegram bot token is missing.'
    );

    console.error(
        'Add "telegramToken" to config.json or set TELEGRAM_BOT_TOKEN.'
    );

    process.exit(1);
}

/*
|--------------------------------------------------------------------------
| GLOBAL STATE
|--------------------------------------------------------------------------
|
| These objects are deliberately created once.
|
| Other modules such as pair.js and whatsapp.js use these references.
|
|--------------------------------------------------------------------------
*/

global.sessions =
    global.sessions ||
    {};

global.pairingStates =
    global.pairingStates ||
    {};

global.commands =
    global.commands ||
    {};

global.bot = null;

/*
 * Used to prevent shutdown from being executed multiple times.
 */
let shuttingDown = false;

/*
|--------------------------------------------------------------------------
| TELEGRAM BOT
|--------------------------------------------------------------------------
*/

const bot = new Telegraf(
    TELEGRAM_TOKEN
);

global.bot = bot;

/*
|--------------------------------------------------------------------------
| COMMAND LOADER
|--------------------------------------------------------------------------
*/

function loadWhatsAppCommands() {
    const commandsDir =
        path.join(__dirname, 'commands');

    if (!fs.existsSync(commandsDir)) {
        console.warn(
            '[COMMANDS] commands directory does not exist.'
        );

        return;
    }

    const files =
        fs.readdirSync(commandsDir)
            .filter(file => file.endsWith('.js'))
            .sort();

    let loaded = 0;

    for (const file of files) {
        const fullPath =
            path.join(commandsDir, file);

        try {
            /*
             * Delete cached copy so a restart/reload does not retain
             * an old module.
             */
            delete require.cache[
                require.resolve(fullPath)
            ];

            const commandModule =
                require(fullPath);

            if (
                typeof commandModule !== 'function'
            ) {
                console.warn(
                    `[COMMANDS] Skipping ${file}: module does not export a function.`
                );

                continue;
            }

            const commandName =
                path.basename(
                    file,
                    '.js'
                ).toLowerCase();

            global.commands[commandName] =
                commandModule;

            loaded++;

            console.log(
                `[COMMANDS] Loaded .${commandName}`
            );
        } catch (error) {
            console.error(
                `[COMMANDS] Failed to load ${file}`,
                error?.stack || error
            );
        }
    }

    console.log(
        `[COMMANDS] ${loaded} command(s) loaded.`
    );
}

/*
|--------------------------------------------------------------------------
| COMMAND ALIASES
|--------------------------------------------------------------------------
|
| This allows command files to have one canonical name while users
| can still use common aliases.
|--------------------------------------------------------------------------
*/

function resolveCommand(command) {
    const normalized =
        String(command || '')
            .trim()
            .toLowerCase();

    if (!normalized) {
        return null;
    }

    /*
     * Direct command.
     */
    if (
        typeof global.commands[normalized] === 'function'
    ) {
        return {
            name: normalized,
            handler: global.commands[normalized]
        };
    }

    /*
     * Optional aliases.
     */
    const aliases = {
        menu: 'menu',
        help: 'menu',

        p: 'ping',

        group: 'groupinfo',
        info: 'groupinfo',

        admins: 'tagadmin',
        tagadmins: 'tagadmin',

        tag: 'tagall',

        addmember: 'add',
        remove: 'kick',

        ban: 'kick',

        promoteadmin: 'promote',
        demoteadmin: 'demote'
    };

    const mapped =
        aliases[normalized];

    if (
        mapped &&
        typeof global.commands[mapped] === 'function'
    ) {
        return {
            name: mapped,
            handler: global.commands[mapped]
        };
    }

    return null;
}

/*
|--------------------------------------------------------------------------
| TELEGRAM USER ID
|--------------------------------------------------------------------------
*/

function telegramUserId(ctx) {
    return String(
        ctx?.from?.id || ''
    );
}

/*
|--------------------------------------------------------------------------
| TELEGRAM COMMAND TEXT
|--------------------------------------------------------------------------
*/

function telegramText(ctx) {
    return String(
        ctx?.message?.text ||
        ''
    ).trim();
}

/*
|--------------------------------------------------------------------------
| SAFE TELEGRAM REPLY
|--------------------------------------------------------------------------
*/

async function telegramReply(ctx, text, extra = {}) {
    try {
        return await ctx.reply(
            String(text || ''),
            extra
        );
    } catch (error) {
        console.error(
            '[TELEGRAM REPLY]',
            error?.stack || error
        );

        return null;
    }
}

/*
|--------------------------------------------------------------------------
| /START
|--------------------------------------------------------------------------
*/

bot.start(async ctx => {
    const userId =
        telegramUserId(ctx);

    const session =
        getWhatsAppSession(userId);

    const pairing =
        global.pairingStates[userId];

    let status =
        '🔴 WhatsApp: Not paired';

    if (session) {
        const connected =
            session.connection === 'open';

        status =
            connected
                ? '🟢 WhatsApp: Connected'
                : '🟡 WhatsApp: Session exists but is not currently connected';
    } else if (
        pairing?.active
    ) {
        status =
            '🟡 WhatsApp: Pairing in progress';
    }

    await telegramReply(
        ctx,
        `🤖 ${BOT_NAME}\n\n` +
        'Telegram control panel for your linked WhatsApp account.\n\n' +
        `${status}\n\n` +
        'Commands:\n' +
        '/pair - Link a WhatsApp account\n' +
        '/status - Check connection\n' +
        '/stop - Stop the WhatsApp session\n' +
        '/help - Show help'
    );
});

/*
|--------------------------------------------------------------------------
| /HELP
|--------------------------------------------------------------------------
*/

bot.help(async ctx => {
    await telegramReply(
        ctx,
        `🤖 ${BOT_NAME} HELP\n\n` +
        'WhatsApp pairing:\n' +
        '/pair\n' +
        'Start a new WhatsApp pairing operation.\n\n' +

        'Session:\n' +
        '/status\n' +
        'Show your WhatsApp connection status.\n\n' +

        '/stop\n' +
        'Stop the current WhatsApp session or cancel pending pairing.\n\n' +

        'WhatsApp commands:\n' +
        `${PREFIX}menu\n` +
        `${PREFIX}ping\n` +
        `${PREFIX}groupinfo\n` +
        `${PREFIX}tagall\n` +
        `${PREFIX}tagadmin\n` +
        `${PREFIX}sticker\n` +
        `${PREFIX}play\n` +
        `${PREFIX}video\n` +
        `${PREFIX}lyrics\n` +
        `${PREFIX}add\n` +
        `${PREFIX}kick\n` +
        `${PREFIX}promote\n` +
        `${PREFIX}demote\n` +
        `${PREFIX}mute\n` +
        `${PREFIX}anti\n\n` +

        'Only commands sent by the linked WhatsApp account itself are processed.'
    );
});

/*
|--------------------------------------------------------------------------
| /PAIR
|--------------------------------------------------------------------------
*/

bot.command(
    'pair',
    async ctx => {
        try {
            const pairCommand =
                require('./telegram/pair');

            await pairCommand(ctx);
        } catch (error) {
            console.error(
                '[PAIR COMMAND]',
                error?.stack || error
            );

            const userId =
                telegramUserId(ctx);

            /*
             * If pair.js crashed before creating a usable operation,
             * don't leave the user permanently locked.
             */
            delete global.pairingStates[userId];

            await telegramReply(
                ctx,
                '❌ Could not start the pairing operation.\n\n' +
                'The pairing state has been reset.\n\n' +
                'Use /pair again.'
            );
        }
    }
);

/*
|--------------------------------------------------------------------------
| /STATUS
|--------------------------------------------------------------------------
*/

bot.command(
    'status',
    async ctx => {
        const userId =
            telegramUserId(ctx);

        const session =
            getWhatsAppSession(userId);

        const pairing =
            global.pairingStates[userId];

        if (!session) {
            if (
                pairing?.active
            ) {
                const stage =
                    pairing.stage ||
                    'unknown';

                await telegramReply(
                    ctx,
                    '🟡 WhatsApp pairing is in progress.\n\n' +
                    `Stage: ${stage}\n` +
                    `Number: ${pairing.phoneNumber || 'Not supplied'}`
                );

                return;
            }

            await telegramReply(
                ctx,
                '🔴 No active WhatsApp session.\n\n' +
                'Use /pair to link a WhatsApp account.'
            );

            return;
        }

        const connection =
            String(
                session.connection ||
                'unknown'
            );

        const connected =
            connection === 'open';

        const number =
            session.phoneNumber ||
            session.user?.id
                ? jidNumber(
                    session.phoneNumber ||
                    session.user?.id
                )
                : 'Unknown';

        let message =
            connected
                ? '🟢 WhatsApp is connected.'
                : '🟡 WhatsApp session exists but is not connected.';

        message +=
            `\n\n📱 Number: ${number}`;

        message +=
            `\n🔌 Connection: ${connection}`;

        if (
            session.pairingCode
        ) {
            message +=
                `\n🔐 Pairing code: ${session.pairingCode}`;
        }

        if (
            session.lastDisconnectReason
        ) {
            message +=
                `\n⚠️ Last disconnect: ${session.lastDisconnectReason}`;
        }

        await telegramReply(
            ctx,
            message
        );
    }
);

/*
|--------------------------------------------------------------------------
| /STOP
|--------------------------------------------------------------------------
|
| This handler deliberately imports stop.js rather than duplicating
| its implementation.
|--------------------------------------------------------------------------
*/

bot.command(
    'stop',
    async ctx => {
        try {
            const stopCommand =
                require('./telegram/stop');

            await stopCommand(ctx);
        } catch (error) {
            console.error(
                '[STOP COMMAND]',
                error?.stack || error
            );

            await telegramReply(
                ctx,
                '❌ Failed to stop the WhatsApp operation.\n\n' +
                'Check the server console for details.'
            );
        }
    }
);

/*
|--------------------------------------------------------------------------
| WHATSAPP COMMAND ROUTER
|--------------------------------------------------------------------------
|
| This function is called by lib/whatsapp.js when a WhatsApp message
| arrives.
|
| SECURITY RULE:
|
| Only msg.key.fromMe === true is accepted.
|
| This means:
|
| Random person -> ignored
| Group member -> ignored
| Admin -> ignored
| Stranger -> ignored
| Linked account itself -> processed
|
|--------------------------------------------------------------------------
*/

async function handleWhatsAppCommand(
    userId,
    sock,
    msg
) {
    userId =
        String(userId || '');

    if (
        !userId ||
        !sock ||
        !msg
    ) {
        return false;
    }

    /*
     * Session ownership check.
     */
    const session =
        getWhatsAppSession(userId);

    if (!session) {
        return false;
    }

    /*
     * IMPORTANT:
     *
     * Do not remove this.
     *
     * fromMe means the message was sent by the linked WhatsApp
     * account itself.
     */
    if (
        msg.key?.fromMe !== true
    ) {
        return false;
    }

    /*
     * Ignore status broadcasts.
     */
    const jid =
        String(
            msg.key?.remoteJid ||
            ''
        );

    if (!jid) {
        return false;
    }

    if (
        jid === 'status@broadcast'
    ) {
        return false;
    }

    /*
     * Ignore protocol/system messages.
     */
    if (
        msg.messageStubType
    ) {
        return false;
    }

    const message =
        msg.message;

    if (!message) {
        return false;
    }

    /*
     * Extract text from normal messages, captions, etc.
     */
    const originalText =
        getText(message);

    if (!originalText) {
        return false;
    }

    /*
     * Ignore whitespace-only messages.
     */
    const raw =
        originalText.trim();

    if (!raw) {
        return false;
    }

    /*
     * Commands normally use ".".
     *
     * For convenience we also allow:
     *
     * menu
     * ping
     *
     * to behave like:
     *
     * .menu
     * .ping
     *
     * Only recognized commands are accepted in this no-prefix mode.
     */
    let parsed =
        commandParts(
            raw,
            PREFIX
        );

    if (!parsed) {
        /*
         * No prefix.
         *
         * Don't blindly treat every message as a command.
         */
        const noPrefixParts =
            raw
                .split(/\s+/);

        const possibleCommand =
            String(
                noPrefixParts.shift() ||
                ''
            )
                .toLowerCase();

        const resolved =
            resolveCommand(
                possibleCommand
            );

        if (!resolved) {
            return false;
        }

        parsed = {
            command: possibleCommand,
            args: noPrefixParts,
            text: noPrefixParts.join(' ')
        };
    }

    const resolved =
        resolveCommand(
            parsed.command
        );

    /*
     * Unknown commands are silently ignored.
     *
     * This prevents the bot from replying to every random
     * ".something" command.
     */
    if (!resolved) {
        return false;
    }

    /*
     * Prevent old socket instances from controlling a newly created
     * session.
     *
     * whatsapp.js also performs this check at event level, but doing
     * it here gives us another protection layer.
     */
    if (
        session.sock &&
        session.sock !== sock
    ) {
        return false;
    }

    /*
     * Sender number here is the actual linked account because
     * fromMe === true.
     */
    const senderNumber =
        jidNumber(
            msg.key?.participant ||
            session.phoneNumber ||
            session.user?.id
        );

    const isGroup =
        isGroupJid(jid);

    /*
     * Command context.
     *
     * Individual command files receive this object.
     */
    const commandContext = {
        sock,

        msg,

        jid,

        senderNumber,

        userId,

        isGroup,

        args:
            Array.isArray(parsed.args)
                ? parsed.args
                : [],

        text:
            String(
                parsed.text || ''
            ),

        command:
            resolved.name,

        prefix:
            PREFIX,

        /*
         * Reply to exactly the same WhatsApp chat where the command
         * was received.
         */
        reply: async response => {
            return sendReply(
                sock,
                jid,
                response,
                msg
            );
        },

        /*
         * General send helper.
         */
        send: async (
            response,
            options = {}
        ) => {
            return sock.sendMessage(
                jid,
                response,
                {
                    quoted:
                        options.quoted === false
                            ? undefined
                            : msg,

                    ...options
                }
            );
        }
    };

    try {
        await resolved.handler(
            commandContext
        );

        return true;
    } catch (error) {
        console.error(
            `[WHATSAPP COMMAND .${resolved.name}]`,
            error?.stack || error
        );

        /*
         * Don't expose stack traces or internal errors to WhatsApp.
         */
        try {
            await sendReply(
                sock,
                jid,
                '❌ An error occurred while running this command.',
                msg
            );
        } catch (replyError) {
            console.error(
                '[COMMAND ERROR REPLY]',
                replyError?.stack || replyError
            );
        }

        return false;
    }
}

/*
|--------------------------------------------------------------------------
| MAKE ROUTER AVAILABLE TO WHATSAPP MODULE
|--------------------------------------------------------------------------
*/

global.handleWhatsAppCommand =
    handleWhatsAppCommand;

/*
|--------------------------------------------------------------------------
| GLOBAL TELEGRAM TEXT HANDLER
|--------------------------------------------------------------------------
|
| THIS IS THE IMPORTANT FIX.
|
| When the user does:
|
| /pair
|
| pair.js creates:
|
| pairingStates[userId].stage = "waiting_number"
|
| Then the next ordinary Telegram text:
|
| 2349063285877
|
| reaches THIS handler.
|
| It is passed to handlePairNumber().
|
| No dynamic bot.on('text') listener is required.
|
|--------------------------------------------------------------------------
*/

bot.on(
    'text',
    async ctx => {
        const userId =
            telegramUserId(ctx);

        if (!userId) {
            return;
        }

        const text =
            telegramText(ctx);

        if (!text) {
            return;
        }

        /*
         * Telegraf command handlers should handle /pair, /stop,
         * /status, etc.
         *
         * Do not treat a Telegram command itself as a phone number.
         */
        if (
            text.startsWith('/')
        ) {
            return;
        }

        const state =
            global.pairingStates[userId];

        /*
         * No pairing operation waiting for input.
         */
        if (
            !state ||
            !state.active
        ) {
            return;
        }

        /*
         * Only consume text while specifically waiting for a number.
         *
         * Once pairing has progressed, ordinary Telegram messages
         * should not restart the pairing operation.
         */
        if (
            state.stage !== 'waiting_number'
        ) {
            return telegramReply(
                ctx,
                '⏳ Your pairing operation is already running.\n\n' +
                `Current stage: ${state.stage || 'unknown'}\n\n` +
                'Use /stop to cancel it.'
            );
        }

        try {
            /*
             * handlePairNumber returns true when this message belongs
             * to the pairing flow.
             */
            const consumed =
                await handlePairNumber(
                    ctx,
                    text
                );

            if (consumed) {
                return;
            }
        } catch (error) {
            console.error(
                '[PAIR NUMBER HANDLER]',
                error?.stack || error
            );

            /*
             * Reset the state so a failed number handler can never
             * permanently lock /pair.
             */
            delete global.pairingStates[userId];

            await telegramReply(
                ctx,
                '❌ Could not process that phone number.\n\n' +
                'The pairing state has been reset.\n\n' +
                'Use /pair to try again.'
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
                '❌ Telegram bot error.\n\n' +
                'Please try the command again.'
            );
        } catch (replyError) {
            console.error(
                '[TELEGRAM ERROR REPLY]',
                replyError?.stack || replyError
            );
        }
    }
);

/*
|--------------------------------------------------------------------------
| BOT STARTUP
|--------------------------------------------------------------------------
*/

async function startBot() {
    /*
     * Load WhatsApp commands before accepting traffic.
     */
    loadWhatsAppCommands();

    console.log(
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
    );

    console.log(
        `🤖 Starting ${BOT_NAME}...`
    );

    console.log(
        `⚙️ Prefix: ${PREFIX}`
    );

    console.log(
        `📦 Commands: ${Object.keys(global.commands).length}`
    );

    /*
     * Launch Telegram polling.
     */
    await bot.launch();

    console.log(
        '🟢 Telegram bot is running.'
    );

    /*
     * Restore saved WhatsApp sessions after Telegram is ready.
     *
     * restoreSessions() should safely ignore users whose auth
     * directories do not exist.
     */
    try {
        await restoreSessions();
    } catch (error) {
        console.error(
            '[RESTORE SESSIONS]',
            error?.stack || error
        );
    }

    console.log(
        '🟢 SOLVAX MD is ready.'
    );

    console.log(
        '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━'
    );
}

/*
|--------------------------------------------------------------------------
| GRACEFUL SHUTDOWN
|--------------------------------------------------------------------------
*/

async function shutdown(signal) {
    if (shuttingDown) {
        return;
    }

    shuttingDown = true;

    console.log(
        `\n🛑 Received ${signal}. Shutting down...`
    );

    /*
     * Stop Telegram polling/webhook.
     */
    try {
        bot.stop(signal);

        console.log(
            '🔴 Telegram bot stopped.'
        );
    } catch (error) {
        console.error(
            '[TELEGRAM STOP]',
            error?.stack || error
        );
    }

    /*
     * Stop all active WhatsApp sockets.
     *
     * IMPORTANT:
     * stopWhatsAppSession() should close the socket without deleting
     * authentication unless explicitly requested.
     */
    const userIds =
        Object.keys(
            global.sessions
        );

    for (const userId of userIds) {
        try {
            await stopWhatsAppSession(
                userId,
                {
                    removeAuth: false
                }
            );

            console.log(
                `[SHUTDOWN] WhatsApp session stopped: ${userId}`
            );
        } catch (error) {
            console.error(
                `[SHUTDOWN] Failed for ${userId}`,
                error?.stack || error
            );
        }
    }

    /*
     * Clear pending pairing timers/states.
     */
    for (
        const userId of Object.keys(
            global.pairingStates
        )
    ) {
        const state =
            global.pairingStates[userId];

        if (
            state?.timeout
        ) {
            clearTimeout(
                state.timeout
            );
        }

        delete global.pairingStates[
            userId
        ];
    }

    console.log(
        '🟢 SOLVAX MD shutdown complete.'
    );

    process.exit(0);
}

/*
|--------------------------------------------------------------------------
| PROCESS SIGNALS
|--------------------------------------------------------------------------
*/

process.once(
    'SIGINT',
    () => {
        shutdown('SIGINT');
    }
);

process.once(
    'SIGTERM',
    () => {
        shutdown('SIGTERM');
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

startBot()
    .catch(error => {
        console.error(
            '❌ SOLVAX MD failed to start:',
            error?.stack || error
        );

        process.exit(1);
    });

/*
|--------------------------------------------------------------------------
| EXPORTS
|--------------------------------------------------------------------------
|
| Exporting these makes the router usable in tests or by another
| module without starting another Telegram bot instance.
|--------------------------------------------------------------------------
*/

module.exports = {
    bot,
    handleWhatsAppCommand,
    loadWhatsAppCommands,
    resolveCommand
};
