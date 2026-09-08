'use strict';
module.exports={name:'tagall',async run(ctx){const g=await ctx.group();if(!g.botIsAdmin)return ctx.textReply('❌ The linked WhatsApp account must be a group admin.');const ids=g.participants.map(p=>p.id).filter(Boolean);await ctx.socket.sendMessage(ctx.remoteJid,{text:ids.map(j=>'@'+String(j).split('@')[0]).join(' '),mentions:ids});}};
