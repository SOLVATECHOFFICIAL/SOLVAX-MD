'use strict';
const yts=require('yt-search');
module.exports={name:'lyrics',async run(ctx){const q=ctx.args.join(' ').trim();if(!q)return ctx.textReply('Usage: .lyrics song title');try{const r=await yts(`${q} lyrics`);const v=r.videos?.[0];if(!v)return ctx.textReply('❌ No result found.');await ctx.textReply(`🎶 ${v.title}\n${v.url}\n\nLyrics are not reproduced by this bot.`);}catch(e){await ctx.textReply('❌ Search failed.');}}};
