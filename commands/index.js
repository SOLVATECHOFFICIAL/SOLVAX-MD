'use strict';
const fs = require('fs');
const path = require('path');
const config = require('../config.json');
const { jidNumber, isGroupJid, getText, getQuotedMessage } = require('../lib/helpers');

const commands = new Map();
const commandList = [];
const dir = __dirname;
for (const file of fs.readdirSync(dir).filter(f=>f.endsWith('.js') && f!=='index.js').sort()) {
  const loaded = require(path.join(dir,file));
  for (const command of (Array.isArray(loaded) ? loaded : [loaded])) {
    if (!command?.name || typeof command.run !== 'function') continue;
    const names=[command.name,...(command.aliases||[])].map(String).map(x=>x.toLowerCase().replace(/^\./,''));
    for (const n of names) commands.set(n,command);
    commandList.push(command);
  }
}

function parse(text) {
  const value=String(text||'').trim();
  const prefix=String(config.prefix||'.');
  if (!value.startsWith(prefix)) return null;
  const parts=value.slice(prefix.length).trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return null;
  const name=parts.shift().toLowerCase();
  return {name,args:parts,text:parts.join(' ')};
}
function getMentions(message) {
  const m=message?.message||{};
  const c=m.extendedTextMessage?.contextInfo||m.imageMessage?.contextInfo||m.videoMessage?.contextInfo||m.documentMessage?.contextInfo||{};
  return Array.isArray(c.mentionedJid) ? c.mentionedJid : [];
}
async function group(ctx) {
  if (!isGroupJid(ctx.remoteJid)) throw new Error('This command only works in groups.');
  const metadata=await ctx.socket.groupMetadata(ctx.remoteJid);
  const botJid=ctx.socket?.user?.id||'';
  const bot=metadata.participants?.find(p=>jidNumber(p.id)===jidNumber(botJid));
  const sender=ctx.message?.key?.participant || (ctx.message?.key?.fromMe ? botJid : ctx.remoteJid);
  const senderP=metadata.participants?.find(p=>jidNumber(p.id)===jidNumber(sender));
  return {
    metadata, participants:metadata.participants||[], botJid,
    botIsAdmin:Boolean(bot?.admin), botIsOwner:Boolean(bot?.admin==='superadmin'||(metadata.owner&&jidNumber(metadata.owner)===jidNumber(botJid))),
    senderIsAdmin:Boolean(senderP?.admin), senderJid:sender
  };
}

async function handleWhatsAppCommand(userId, session, message) {
  if (!session?.socket || session.stopping || !message?.key?.fromMe) return false;
  const text=getText(message.message); const parsed=parse(text); if (!parsed) return false;
  const command=commands.get(parsed.name); if (!command) return false;
  const remoteJid=message.key.remoteJid; if (!remoteJid) return false;
  const ctx={
    userId:String(userId), session, socket:session.socket, message, msg:message, remoteJid,
    jid:remoteJid, text, command:parsed.name, args:parsed.args, mentions:getMentions(message), group,
    isGroup:isGroupJid(remoteJid), isSelf:true, quoted:getQuotedMessage(message),
    async reply(content,options={}) { return session.socket.sendMessage(remoteJid,content,options); },
    async textReply(content,options={}) { return session.socket.sendMessage(remoteJid,{text:String(content)},options); }
  };
  await command.run(ctx); return true;
}

global.handleWhatsAppCommand=handleWhatsAppCommand;
module.exports={commands,commandList,handleWhatsAppCommand,parse,getText};
