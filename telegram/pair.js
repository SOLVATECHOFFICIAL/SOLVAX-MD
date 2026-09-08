const { cleanNumber, sleep } = require('../lib/helpers');
const {
    createWhatsAppSession,
    getWhatsAppSession
} = require('../lib/whatsapp');

const PAIR_TIMEOUT = 90 * 1000;

function getPairingState(userId) {
    global.pairingStates = global.pairingStates || {};
    return global.pairingStates[userId];
}

function setPairingState(userId, state) {
    global.pairingStates = global.pairingStates || {};
    global.pairingStates[userId] = state;
}

function clearPairingState(userId) {
    if (global.pairingStates) {
        delete global.pairingStates[userId];
    }
}

function normalizePhoneNumber(input) {
    let number = cleanNumber(input);

    // Nigerian local format:
    // 08132538119 -> 2348132538119
    if (number.startsWith('0')) {
        number = '234' + number.slice(1);
    }

    return number;
}

function isValidPhoneNumber(number) {
    /*
     * WhatsApp pairing requires the international number.
     *
     * We mainly expect:
     * 234xxxxxxxxxx
     *
     * But we don't hard-code a single country so the bot
     * can still be used with other international numbers.
     */
    return /^\d{8,15}$/.test(number);
}

function maskNumber(number) {
    const value = String(number || '');

    if (value.length <= 7) {
        return value;
    }

    return (
        value.slice(0, 3) +
        '****' +
        value.slice(-4)
    );
}

async function safeEdit(ctx, messageId, text) {
    try {
        await ctx.telegram.editMessageText(
            ctx.chat.id,
            messageId,
            undefined,
            text
        );
    } catch {
        // The message may already have been edited/deleted.
    }
}

async function safeDelete(ctx, messageId) {
    try {
        await ctx.telegram.deleteMessage(
            ctx.chat.id,
            messageId
        );
    } catch {
        // Ignore Telegram deletion errors.
    }
}

async function stopExistingSession(userId) {
    const sessions = global.sessions || {};
    const existing = sessions[userId];

    if (!existing) {
        return;
    }

    try {
        /*
         * Do not call the Telegram /stop handler here.
         * Pairing needs its own cleanup and should not create
         * another Telegram conversation flow.
         */
        if (existing.sock) {
            try {
                existing.intentionalStop = true;

                if (typeof existing.sock.end === 'function') {
                    existing.sock.end(
                        new Error('Replaced by a new pairing attempt')
                    );
                }
            } catch {
                // Socket may already be closed.
            }
        }
    } catch {
        // Nothing else to do.
    }

    delete sessions[userId];

    /*
     * Give Baileys a tiny amount of time to finish its
     * asynchronous close handlers before another socket
     * is created.
     */
    await sleep(500);
}

async function waitForPairingCode(userId, number) {
    const started = Date.now();

    while (Date.now() - started < PAIR_TIMEOUT) {
        const session = getWhatsAppSession(userId);

        if (!session) {
            throw new Error('WhatsApp session disappeared.');
        }

        if (session.pairingCode) {
            return session.pairingCode;
        }

        if (session.pairingError) {
            throw session.pairingError;
        }

        if (session.connection === 'open') {
            /*
             * This can happen when the account was already
             * authenticated and no pairing code is necessary.
             */
            return null;
        }

        if (
            session.connection === 'close' &&
            !session.pairingCode
        ) {
            throw new Error(
                session.lastDisconnectReason ||
                'Connection closed before pairing code was generated.'
            );
        }

        await sleep(500);
    }

    throw new Error(
        'Timed out while waiting for WhatsApp pairing code.'
    );
}

async function pairCommand(ctx) {
    const userId = ctx.from.id;

    global.sessions = global.sessions || {};
    global.pairingStates = global.pairingStates || {};

    /*
     * Never allow two /pair operations from the same
     * Telegram account at the same time.
     */
    const existingPairing = getPairingState(userId);

    if (existingPairing?.active) {
        await ctx.reply(
            '⏳ A WhatsApp pairing is already in progress.\n\n' +
            'Please wait for it to finish before starting another one.'
        );
        return;
    }

    const existingSession = getWhatsAppSession(userId);

    if (existingSession?.connection === 'open') {
        await ctx.reply(
            '🟢 Your WhatsApp account is already connected.\n\n' +
            `📱 Number: ${maskNumber(existingSession.number)}\n\n` +
            'Use /stop first if you want to disconnect it and pair another number.'
        );
        return;
    }

    const prompt = await ctx.reply(
        '📱 Send the WhatsApp phone number you want to pair.\n\n' +
        'Use international format without +.\n\n' +
        'Example:\n' +
        '`2348132538119`\n\n' +
        'For a Nigerian number like `08132538119`, you can also send the local format.',
        {
            parse_mode: 'Markdown'
        }
    );

    setPairingState(userId, {
        active: true,
        stage: 'waiting_number',
        promptMessageId: prompt.message_id,
        startedAt: Date.now()
    });

    /*
     * Remove the old "waiting for number" handler after one
     * successful number is received.
     *
     * Telegraf does not give each command its own state machine,
     * so we use a temporary text handler and remove it when done.
     */
    const handler = async (messageCtx) => {
        if (!messageCtx.message?.text) {
            return;
        }

        /*
         * Only accept the next text message from the same
         * Telegram user and chat.
         */
        if (messageCtx.from?.id !== userId) {
            return;
        }

        if (messageCtx.chat?.id !== ctx.chat?.id) {
            return;
        }

        const state = getPairingState(userId);

        if (!state?.active || state.stage !== 'waiting_number') {
            return;
        }

        const input = messageCtx.message.text.trim();

        /*
         * Don't treat another bot command as a phone number.
         */
        if (input.startsWith('/')) {
            await messageCtx.reply(
                '❌ Pairing cancelled.\n\n' +
                'Send /pair again when you are ready.'
            );

            clearPairingState(userId);

            try {
                bot.off('text', handler);
            } catch {}

            return;
        }

        const number = normalizePhoneNumber(input);

        if (!isValidPhoneNumber(number)) {
            await messageCtx.reply(
                '❌ Invalid phone number.\n\n' +
                'Send the WhatsApp number in international format without `+`.\n\n' +
                'Example:\n' +
                '`2348132538119`'
            );

            return;
        }

        /*
         * Mark the state as processing immediately.
         * This prevents another message from starting a
         * second socket while the first one is being created.
         */
        setPairingState(userId, {
            ...state,
            active: true,
            stage: 'creating_session',
            number
        });

        try {
            /*
             * Delete the original prompt to keep Telegram clean.
             */
            await safeDelete(ctx, state.promptMessageId);

            const preparingMessage = await messageCtx.reply(
                '⏳ Preparing WhatsApp pairing...\n\n' +
                `📱 Number: ${maskNumber(number)}\n\n` +
                'Please wait while the pairing session is created.'
            );

            /*
             * If a stale session exists, close it before creating
             * the new one.
             */
            await stopExistingSession(userId);

            /*
             * Clear any stale pairing state that could have been
             * left by a previous failed attempt, then immediately
             * recreate the current state.
             */
            setPairingState(userId, {
                active: true,
                stage: 'requesting_code',
                number,
                startedAt: Date.now(),
                messageId: preparingMessage.message_id
            });

            /*
             * IMPORTANT:
             *
             * "number" is the WhatsApp account being linked.
             * It is NOT the chat JID where commands should later
             * be sent.
             *
             * lib/whatsapp.js will use the actual incoming
             * message's remoteJid when processing commands.
             */
            let session;

            try {
                session = await createWhatsAppSession(
                    userId,
                    number,
                    messageCtx,
                    {
                        pairing: true
                    }
                );
            } catch (error) {
                throw error;
            }

            if (!session) {
                throw new Error(
                    'WhatsApp session could not be created.'
                );
            }

            /*
             * Wait for lib/whatsapp.js to expose the pairing code.
             */
            const pairingCode = await waitForPairingCode(
                userId,
                number
            );

            /*
             * If the session became authenticated without
             * needing a code, tell the user it connected.
             */
            if (!pairingCode) {
                const current = getWhatsAppSession(userId);

                if (current?.connection === 'open') {
                    clearPairingState(userId);

                    await safeEdit(
                        messageCtx,
                        preparingMessage.message_id,
                        '✅ WhatsApp connected successfully.\n\n' +
                        `📱 Number: ${maskNumber(number)}\n\n` +
                        'Your WhatsApp self-bot is now active.'
                    );

                    return;
                }

                throw new Error(
                    'WhatsApp connected without returning a pairing code.'
                );
            }

            /*
             * Format the code visibly. Do not modify the actual
             * code, because WhatsApp expects the exact characters.
             */
            const formattedCode = String(pairingCode)
                .replace(/\s+/g, '')
                .toUpperCase();

            await safeEdit(
                messageCtx,
                preparingMessage.message_id,
                '🔐 WhatsApp pairing code ready.\n\n' +
                `📱 Number: ${maskNumber(number)}\n\n` +
                `🔑 Code: \`${formattedCode}\`\n\n` +
                'Open WhatsApp on the phone you are linking and enter this code from the Linked Devices pairing option.\n\n' +
                '⏳ The code expires. Complete the linking now.'
            );

            setPairingState(userId, {
                active: true,
                stage: 'waiting_for_link',
                number,
                code: formattedCode,
                startedAt: Date.now(),
                messageId: preparingMessage.message_id
            });

            /*
             * Give the WhatsApp connection handler time to report
             * the result. We do not blindly declare success just
             * because a code was generated.
             */
            const verificationStarted = Date.now();
            let connected = false;

            while (
                Date.now() - verificationStarted <
                PAIR_TIMEOUT
            ) {
                const current = getWhatsAppSession(userId);

                if (!current) {
                    break;
                }

                if (current.connection === 'open') {
                    connected = true;
                    break;
                }

                if (current.pairingError) {
                    throw current.pairingError;
                }

                if (
                    current.connection === 'close' &&
                    current.intentionalStop !== true
                ) {
                    throw new Error(
                        current.lastDisconnectReason ||
                        'Connection closed while waiting for WhatsApp to link.'
                    );
                }

                await sleep(1000);
            }

            if (connected) {
                clearPairingState(userId);

                await safeEdit(
                    messageCtx,
                    preparingMessage.message_id,
                    '✅ WhatsApp connected successfully.\n\n' +
                    `📱 Number: ${maskNumber(number)}\n\n` +
                    '🤖 Your WhatsApp self-bot is now active.\n\n' +
                    'Only messages sent by the linked WhatsApp account itself will trigger bot commands.'
                );

                return;
            }

            /*
             * Pairing code was generated but the user did not
             * finish linking within the allowed time.
             */
            throw new Error(
                'Pairing timed out. The WhatsApp account was not connected.'
            );
        } catch (error) {
            console.error(
                '[PAIR ERROR]',
                error?.stack || error
            );

            const reason =
                error?.message ||
                'Connection Closed';

            /*
             * Clean up the failed socket so the NEXT /pair can
             * create a completely fresh connection.
             */
            const failedSession = getWhatsAppSession(userId);

            if (failedSession) {
                try {
                    failedSession.intentionalStop = true;

                    if (
                        failedSession.sock &&
                        typeof failedSession.sock.end === 'function'
                    ) {
                        failedSession.sock.end(
                            new Error(
                                'Pairing attempt failed; cleaning session.'
                            )
                        );
                    }
                } catch {}
            }

            if (global.sessions) {
                delete global.sessions[userId];
            }

            clearPairingState(userId);

            await messageCtx.reply(
                '❌ Pairing failed.\n\n' +
                `${reason}\n\n` +
                'Check that the number belongs to the WhatsApp account you are linking, then use /pair to try again.'
            );
        } finally {
            /*
             * Remove the temporary handler.
             *
             * If "bot" is unavailable in this scope, the main
             * index.js handler can still manage the conversation.
             */
            try {
                bot.off('text', handler);
            } catch {}
        }
    };

    /*
     * The project normally exposes the Telegraf bot as global.bot.
     * Supporting both makes this file less dependent on one exact
     * index.js implementation.
     */
    const bot =
        global.bot ||
        ctx.telegram?.bot ||
        null;

    if (!bot) {
        clearPairingState(userId);

        await ctx.reply(
            '❌ Pairing system error.\n\n' +
            'Telegram bot instance is unavailable.'
        );

        return;
    }

    bot.on('text', handler);
}

module.exports = pairCommand;
