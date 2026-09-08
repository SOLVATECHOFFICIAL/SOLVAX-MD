'use strict';
const { getGroup } = require('../lib/database');

const TYPES = ['antilink','antimention','antiviewonce','antibot'];

function cfg(group, type) {
  group.anti = group.anti || {};
  group.anti[type] = {
    enabled:false, action:'warn', affectAdmins:false, maxWarns:2,
    warns:{}, ...(group.anti[type] || {})
  };
  return group.anti[type];
}

module.exports = TYPES.map(type => ({
  name: type,
  async run(ctx) {
    const g = await ctx.group();
    if (!g.botIsAdmin)
      return ctx.textReply('❌ The linked WhatsApp account must be a group admin to manage anti settings.');

    const group = getGroup(ctx.remoteJid) || {};
    const c = cfg(group, type);
    const a = ctx.args.map(x => x.toLowerCase());

    if (!a.length) return ctx.textReply(
`${type.toUpperCase()}
Status: ${c.enabled ? '🟢 ON' : '🔴 OFF'}
Action: ${c.action}
Affect admins: ${c.affectAdmins ? 'YES' : 'NO'}
Max warns: ${c.maxWarns}

.${type} on|off
.${type} kick|delete|warn
.${type} admin on|off
.${type} warns <n>
.${type} resetwarns @tag
.${type} clearwarns`);

    if (a[0] === 'on' || a[0] === 'off') c.enabled = a[0] === 'on';
    else if (['kick','delete','warn'].includes(a[0])) c.action = a[0];
    else if (a[0] === 'admin' && ['on','off'].includes(a[1])) c.affectAdmins = a[1] === 'on';
    else if (a[0] === 'warns' && Number(a[1]) >= 1) c.maxWarns = Number(a[1]);
    else if (a[0] === 'resetwarns') {
      for (const jid of ctx.mentions) delete c.warns[jid];
    } else if (a[0] === 'clearwarns') c.warns = {};
    else return ctx.textReply('❌ Invalid anti option.');

    if (typeof global.setGroup !== 'function')
      return ctx.textReply('⚠️ Anti settings parsed, but your database needs a setGroup() writer.');

    await global.setGroup(ctx.remoteJid, group);
    await ctx.textReply(`${type} updated: ${c.enabled ? 'ON' : 'OFF'} | action=${c.action} | admins=${c.affectAdmins ? 'on':'off'} | warns=${c.maxWarns}`);
  }
}));
