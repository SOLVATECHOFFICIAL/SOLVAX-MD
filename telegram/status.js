const { getWhatsAppStatus } = require('../lib/whatsapp');

module.exports = async ctx => {
  const userId = String(ctx.from.id);
  const status = getWhatsAppStatus(userId);

  if (!status.exists) {
    if (status.pairing) {
      return ctx.reply('🟡 WhatsApp pairing is still in progress.\n\nUse /cancel to stop it.');
    }
    return ctx.reply('🔴 No WhatsApp session is active.\n\nUse /pair to link one.');
  }

  const state = status.connected
    ? '🟢 Connected'
    : `🟡 ${status.status || 'Connecting'}`;

  const phone = status.phoneNumber || 'Unknown';
  const started = status.createdAt
    ? new Date(status.createdAt).toLocaleString()
    : 'Unknown';

  await ctx.reply(`${state}\n\n📱 ${phone}\n🕒 Session started: ${started}\n🔁 Reconnect attempts: ${status.reconnectAttempts || 0}`);
};
