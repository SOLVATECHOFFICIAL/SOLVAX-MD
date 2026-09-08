module.exports = async ctx => {
  if (!ctx.isGroup) return ctx.reply('❌ This command only works in groups.');
  const meta = await ctx.sock.groupMetadata(ctx.jid);
  const admins = meta.participants.filter(p => p.admin).length;
  await ctx.reply(`👥 ${meta.subject}\n\n🆔 ${meta.id}\n👤 Members: ${meta.participants.length}\n🛡 Admins: ${admins}\n📝 ${meta.desc || 'No description'}`);
};
