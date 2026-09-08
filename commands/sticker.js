'use strict';
const {downloadContentFromMessage}=require('@whiskeysockets/baileys');
const sharp=require('sharp');
async function bufferFrom(stream){const chunks=[];for await(const c of stream)chunks.push(c);return Buffer.concat(chunks);}
module.exports={name:'sticker',async run(ctx){const m=ctx.message?.message||{};let media=m.imageMessage;let quoted=ctx.quoted?.message;if(!media&&quoted?.imageMessage)media=quoted.imageMessage;if(!media)return ctx.textReply('🖼️ Send or reply to an image with .sticker.');try{const stream=await downloadContentFromMessage(media,'image');const input=await bufferFrom(stream);const output=await sharp(input).webp().resize({width:512,height:512,fit:'inside'}).toBuffer();await ctx.socket.sendMessage(ctx.remoteJid,{sticker:output});}catch(e){await ctx.textReply(`❌ Sticker conversion failed: ${e?.message||e}`);}}};
