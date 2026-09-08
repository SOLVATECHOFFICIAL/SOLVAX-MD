const { groupMetadata } = require('../lib/group');

module.exports = async ctx => {
  try {
    const meta = await groupMetadata(ctx);
    const admins = meta.participants.filter(p => p.admin).length;
    await ctx.reply(`👥 ${meta.subject}\n\n🆔 ${meta.id}\n👤 Members: ${meta.participants.length}\n🛡 Admins: ${admins}\n📝 ${meta.desc || 'No description'}`);
  } catch (error) {
    await ctx.reply(`❌ ${error?.message || 'Unable to read group information.'}`);
  }
};
