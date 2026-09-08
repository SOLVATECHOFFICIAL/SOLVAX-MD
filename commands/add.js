'use strict';
module.exports={name:'add',async run(ctx){
 const g=await ctx.group(); if(!g.botIsAdmin) return ctx.textReply('❌ The linked WhatsApp account must be a group admin.');
 const n=String(ctx.args[0]||'').replace(/\D/g,''); if(n.length<10||n.length>15) return ctx.textReply('Usage: .add 234xxxxxxxxxx');
 try{await ctx.socket.groupParticipantsUpdate(ctx.remoteJid,[`${n}@s.whatsapp.net`],'add');await ctx.textReply(`✅ Add request sent for +${n}.`);}catch(e){await ctx.textReply(`❌ Add failed: ${e?.message||'WhatsApp rejected it.'}`);}
}};
