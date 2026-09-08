const { cleanNumber } = require('../lib/helpers');
const { createWhatsAppSession } = require('../lib/whatsapp');

module.exports = async (ctx) => {
    const userId = ctx.from.id;

    global.sessions ??= {};
    global.pairingStates ??= {};

    const sessions = global.sessions;
    const pairingStates = global.pairingStates;

    const existing = sessions[userId];

    if (
        existing &&
        (
            existing.connected ||
            existing.state === 'connecting' ||
            existing.state === 'pairing'
        )
    ) {
        return ctx.reply(
            '⚠️ You already have a WhatsApp session.\n\n' +
            'Use /status to check it.'
        );
    }

    if (pairingStates[userId]) {
        clearTimeout(pairingStates[userId].timeoutId);
        delete pairingStates[userId];
    }

    await ctx.reply(
        '📱 Send your WhatsApp number with country code.\n\n' +
        'Example:\n' +
        '2349012345678\n\n' +
        'Digits only.\n' +
        'No + sign.\n' +
        'No leading zero.\n\n' +
        '⏳ You have 120 seconds.'
    );

    const timeoutId = setTimeout(() => {
        if (pairingStates[userId]) {
            delete pairingStates[userId];

            ctx.reply(
                '⏳ Pairing request timed out.\n\n' +
                'Send /pair again.'
            ).catch(() => {});
        }
    }, 120000);

    pairingStates[userId] = {
        step: 'awaiting_number',
        timeoutId
    };
};


async function handlePairText(ctx) {
    const userId = ctx.from.id;

    global.sessions ??= {};
    global.pairingStates ??= {};

    const sessions = global.sessions;
    const pairingStates = global.pairingStates;

    const state = pairingStates[userId];

    if (!state || state.step !== 'awaiting_number') {
        return;
    }

    const text = String(ctx.message?.text || '').trim();
    const clean = cleanNumber(text);

    if (!/^\d+$/.test(clean)) {
        return ctx.reply(
            '❌ Invalid number.\n\n' +
            'Example:\n' +
            '2349012345678'
        );
    }

    if (clean.length < 10 || clean.length > 15) {
        return ctx.reply(
            '❌ Invalid WhatsApp number.\n\n' +
            'Example:\n' +
            '2349012345678'
        );
    }

    if (!clean.startsWith('234')) {
        return ctx.reply(
            '❌ This bot currently accepts Nigerian numbers only.\n\n' +
            'Example:\n' +
            '2349012345678'
        );
    }

    clearTimeout(state.timeoutId);
    delete pairingStates[userId];

    await ctx.reply(
        `⏳ Preparing WhatsApp pairing for ${clean}...`
    );

    try {
        await createWhatsAppSession(
            userId,
            clean,
            ctx,
            { pairing: true }
        );

    } catch (error) {
        console.error(
            '[PAIR ERROR]',
            error
        );

        delete sessions[userId];

        await ctx.reply(
            '❌ Pairing failed.\n\n' +
            `${error?.message || 'Unknown error'}\n\n` +
            'Check that the number belongs to the WhatsApp account you are linking, then try /pair again.'
        );
    }
}

module.exports.handlePairText = handlePairText;
