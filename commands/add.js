'use strict';
const { getGroup } = require('../lib/database');
module.exports = {
  name: 'add',
  async run(ctx) {
    const settings = getGroup(ctx.remoteJid) || {};
    if (settings.allowAdd === false || settings.add === false)
      return ctx.textReply('❌ Adding members is disabled in this group.');
    const n = String(ctx.args[0] || '').replace(/\D/g, '');
    if (!n) return ctx.textReply('Usage: .add 234xxxxxxxxxx');
    try {
      await ctx.socket.groupParticipantsUpdate(ctx.remoteJid, [`${n}@s.whatsapp.net`], 'add');
      await ctx.textReply(`✅ Add request sent for +${n}.`);
    } catch (e) {
      await ctx.textReply(`❌ Add failed: ${e?.message || 'WhatsApp rejected it.'}`);
    }
  }
};
