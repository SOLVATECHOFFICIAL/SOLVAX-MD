'use strict';
const yts=require('yt-search');
module.exports={name:'video',async run(ctx){const q=ctx.args.join(' ').trim();if(!q)return ctx.textReply('Usage: .video video name or YouTube URL');try{const r=await yts(q);const items=(r.videos||[]).slice(0,5);if(!items.length)return ctx.textReply('❌ No YouTube results found.');await ctx.textReply('🎬 YouTube results for: '+q+'\n\n'+items.map((v,i)=>`${i+1}. ${v.title}\n⏱ ${v.timestamp||'Unknown'}\n${v.url}`).join('\n\n'));}catch(e){await ctx.textReply('❌ YouTube search failed.');}}};
