module.exports = async ctx => {
  const name = ctx.from?.first_name || 'there';
  await ctx.reply(
    `👋 Hello ${name}.\n\n` +
    `*SolvaX MD* controls a WhatsApp session from Telegram.\n\n` +
    `Commands:\n` +
    `/pair - link a WhatsApp number\n` +
    `/status - check your session\n` +
    `/stop - stop and remove your session\n` +
    `/help - show help`,
    { parse_mode: 'Markdown' }
  );
};
