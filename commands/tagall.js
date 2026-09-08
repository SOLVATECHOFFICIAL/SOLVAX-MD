'use strict';
module.exports={name:'tagall',async run(ctx){const g=await ctx.group();const ids=g.participants.map(p=>p.id).filter(Boolean);const prefix=ctx.args.length?ctx.args.join(' ')+'\n\n':'';await ctx.socket.sendMessage(ctx.remoteJid,{text:prefix+ids.map(j=>'@'+String(j).split('@')[0]).join(' '),mentions:ids});}};
