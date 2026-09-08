module.exports = async ctx => {
  await ctx.reply(
    `🛠 Telegram controls\n\n` +
    `/pair - link a WhatsApp number\n` +
    `/status - check your session\n` +
    `/stop - stop and remove your session\n` +
    `/help - show this help\n\n` +
    `After linking, use .menu on WhatsApp.`
  );
};
