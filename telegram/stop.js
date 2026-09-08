const { stopWhatsAppSession } = require('../lib/whatsapp');
module.exports = async ctx => {
  const id = ctx.from.id;
  const session = global.sessions[id];
  if (!session) return ctx.reply('ℹ️ No active WhatsApp session.');
  await stopWhatsAppSession(id, true);
  await ctx.reply('🛑 WhatsApp session stopped and local credentials removed.\n\nUse /pair to link again.');
};
