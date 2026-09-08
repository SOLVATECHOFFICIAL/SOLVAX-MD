const { cleanNumber } = require('../lib/helpers');
const { createWhatsAppSession, stopWhatsAppSession } = require('../lib/whatsapp');

module.exports = async function pair(ctx) {
  const userId = ctx.from.id;
  const existing = global.sessions[userId];

  if (existing && (existing.connected || existing.state === 'connecting' || existing.state === 'pairing')) {
    return ctx.reply(`⚠️ You already have a WhatsApp session.\n\n/status to check it.`);
  }

  const oldState = global.pairingStates[userId];
  if (oldState?.timeoutId) clearTimeout(oldState.timeoutId);
  delete global.pairingStates[userId];

  await ctx.reply(
    `📱 Send your WhatsApp number with country code.\n\n` +
    `Example: 2349012345678\n\n` +
    `Digits only. No + sign. No leading zero.\n\n` +
    `⏳ You have 120 seconds.`
  );

  const timeoutId = setTimeout(() => {
    const state = global.pairingStates[userId];
    if (state?.step === 'awaiting_number') {
      delete global.pairingStates[userId];
      ctx.reply('⏳ Pairing request timed out.\n\nSend /pair again.').catch(() => {});
    }
  }, (global.config.maxPairingSeconds || 120) * 1000);

  global.pairingStates[userId] = { step: 'awaiting_number', timeoutId };
};

async function handlePairText(ctx) {
  const userId = ctx.from.id;
  const state = global.pairingStates[userId];
  if (!state || state.step !== 'awaiting_number') return;
  clearTimeout(state.timeoutId);
  delete global.pairingStates[userId];

  const clean = cleanNumber(ctx.message.text);
  if (clean.length < 10 || clean.length > 15) {
    await ctx.reply('❌ Invalid number.\n\nExample: 2349012345678');
    return;
  }

  await ctx.reply(`⏳ Preparing WhatsApp pairing for ${clean}...`);
  try {
    await stopWhatsAppSession(userId, true);
    await createWhatsAppSession(userId, clean, ctx, { pairing: true });
  } catch (error) {
    console.error('[PAIR]', error.stack || error);
    await ctx.reply(
      `❌ Pairing failed.\n\n${error.message || 'Unknown error'}\n\n` +
      `Check that the number belongs to the WhatsApp account you are linking, then try /pair again.`
    );
    await stopWhatsAppSession(userId, true);
  }
}

module.exports.handlePairText = handlePairText;
