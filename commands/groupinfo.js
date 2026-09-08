'use strict';
module.exports = {
  name: 'groupinfo',
  async run(ctx) {
    const g = await ctx.group();
    const admins = g.participants.filter(p => p.admin);
    const members = g.participants.map((p,i) =>
      `${i+1}. +${String(p.id).split('@')[0]}${p.admin ? ' — ADMIN' : ''}`
    ).join('\n');
    await ctx.textReply(`╭──〔 GROUP INFO 〕──╮
│ Name: ${g.metadata.subject || 'Unknown'}
│ Members: ${g.participants.length}
│ Admins: ${admins.length}
│ Bot admin: ${g.botIsAdmin ? 'YES' : 'NO'}
╰────────────────────╯

${members}`);
  }
};
