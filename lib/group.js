async function groupMetadata(ctx) {
  if (!ctx.isGroup) throw new Error('This command only works in groups.');
  return ctx.sock.groupMetadata(ctx.jid);
}

function participantId(p) {
  return p?.id || p?.jid || '';
}

async function isSenderAdmin(ctx, meta) {
  const sender = String(ctx.senderNumber || '');
  const p = meta.participants.find(x => String(participantId(x)).split('@')[0].split(':')[0] === sender);
  return Boolean(p?.admin);
}

async function isBotAdmin(ctx, meta) {
  const botId = ctx.sock.user?.id || '';
  const botNumber = String(botId).split('@')[0].split(':')[0];
  const p = meta.participants.find(x => String(participantId(x)).split('@')[0].split(':')[0] === botNumber);
  return Boolean(p?.admin);
}

async function requireAdmin(ctx) {
  const meta = await groupMetadata(ctx);
  if (!(await isSenderAdmin(ctx, meta)) && !ctx.isOwner()) {
    await ctx.reply('❌ Group-admin permission required.');
    return null;
  }
  if (!(await isBotAdmin(ctx, meta))) {
    await ctx.reply('❌ Make the bot a group admin first.');
    return null;
  }
  return meta;
}

module.exports = { groupMetadata, isSenderAdmin, isBotAdmin, requireAdmin, participantId };
