'use strict';
module.exports={name:'tagadmin',async run(ctx){const g=await ctx.group();const ids=g.participants.filter(p=>p.admin).map(p=>p.id);if(!ids.length)return ctx.textReply('❌ No admins found.');await ctx.socket.sendMessage(ctx.remoteJid,{text:'🛡️ '+ids.map(j=>'@'+String(j).split('@')[0]).join(' '),mentions:ids});}};
