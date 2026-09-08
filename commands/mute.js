'use strict';
const {getGroup,setGroup}=require('../lib/database');
module.exports={name:'mute',async run(ctx){const g=await ctx.group();if(!g.botIsAdmin)return ctx.textReply('❌ The linked WhatsApp account must be a group admin.');const v=String(ctx.args[0]||'').toLowerCase();if(!['on','off'].includes(v))return ctx.textReply('Usage: .mute on | .mute off');setGroup(ctx.remoteJid,{muted:v==='on'});await ctx.textReply(`🔒 Group command mute: ${v.toUpperCase()}`);}};
