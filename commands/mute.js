'use strict';
module.exports = {
  name: 'mute',
  async run(ctx) {
    const g = await ctx.group();
    if (!g.botIsAdmin) return ctx.textReply('❌ The linked WhatsApp account must be a group admin.');
    const v = String(ctx.args[0] || '').toLowerCase();
    if (!['on','off'].includes(v)) return ctx.textReply('Usage: .mute on | .mute off');
    if (typeof global.setGroup !== 'function')
      return ctx.textReply('⚠️ Mute is ready, but your database needs a setGroup() writer.');
    const { getGroup } = require('../lib/database');
    const s = getGroup(ctx.remoteJid) || {};
    s.muted = v === 'on';
    await global.setGroup(ctx.remoteJid, s);
    await ctx.textReply(`🔒 Group mute: ${v.toUpperCase()}`);
  }
};
