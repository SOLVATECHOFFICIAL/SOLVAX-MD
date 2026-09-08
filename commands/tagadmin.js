const { groupMetadata } = require('../lib/group');
module.exports = async ctx => {
  const meta = await groupMetadata(ctx);
  const admins = meta.participants.filter(p => p.admin).map(p => p.id);
  await ctx.sock.sendMessage(ctx.jid, { text: `🛡 Admins:\n${admins.map(j => `@${j.split('@')[0]}`).join(' ')}`, mentions: admins }, { quoted: ctx.msg });
};
