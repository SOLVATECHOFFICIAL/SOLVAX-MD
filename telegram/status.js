'use strict';
const {getWhatsAppStatus}=require('../lib/whatsapp');const {getPairingStatus}=require('./pair');
module.exports=async ctx=>{const id=String(ctx.from.id),s=getWhatsAppStatus(id),p=getPairingStatus(id);if(!s.exists)return ctx.reply(p?`🟡 Pairing: ${p.status||'in progress'}\n📱 ${p.phoneNumber||'Unknown'}`:'🔴 No WhatsApp session. Use /pair.');await ctx.reply(`${s.connected?'🟢 Connected':'🟡 '+(s.status||'Connecting')}\n\n📱 ${s.phoneNumber||'Unknown'}\n🕒 Started: ${s.createdAt?new Date(s.createdAt).toLocaleString():'Unknown'}\n🔁 Reconnects: ${s.reconnectAttempts||0}`);};
