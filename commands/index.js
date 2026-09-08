'use strict';

const path = require('path');
const { jidNumber, isGroupJid } = require('../lib/helpers');

const names = [
  'ping','menu','groupinfo','vv','sticker','play','video','lyrics',
  'tagall','tagadmin','add','kick','promote','demote','mute','anti'
];

const commands = new Map();

for (const name of names) {
  const loaded = require(path.join(__dirname, name));
  const list = Array.isArray(loaded) ? loaded : [loaded];
  for (const command of list) {
    commands.set(command.name, command);
    for (const alias of command.aliases || []) commands.set(alias, command);
  }
}

function getText(message) {
  const m = message?.message || {};
  if (m.conversation) return String(m.conversation).trim();
  if (m.extendedTextMessage?.text) return String(m.extendedTextMessage.text).trim();
  if (m.imageMessage?.caption) return String(m.imageMessage.caption).trim();
  if (m.videoMessage?.caption) return String(m.videoMessage.caption).trim();
  return '';
}

function parse(text) {
  if (!String(text).trim().startsWith('.')) return null;
  const parts = String(text).trim().slice(1).split(/\s+/);
  const name = (parts.shift() || '').toLowerCase();
  return name ? { name, args: parts } : null;
}

function mentions(message) {
  const c =
    message?.message?.extendedTextMessage?.contextInfo ||
    message?.message?.imageMessage?.contextInfo ||
    message?.message?.videoMessage?.contextInfo || {};
  return Array.isArray(c.mentionedJid) ? c.mentionedJid : [];
}

async function group(ctx) {
  if (!isGroupJid(ctx.remoteJid)) throw new Error('This command only works in groups.');
  const metadata = await ctx.socket.groupMetadata(ctx.remoteJid);
  const botJid = ctx.socket?.user?.id || '';
  const bot = (metadata.participants || []).find(
    p => jidNumber(p.id) === jidNumber(botJid)
  );
  return {
    metadata,
    participants: metadata.participants || [],
    botJid,
    botIsAdmin: Boolean(bot?.admin),
    botIsOwner: Boolean(
      bot?.admin === 'superadmin' ||
      (metadata.owner && jidNumber(metadata.owner) === jidNumber(botJid))
    )
  };
}

async function handleWhatsAppCommand(userId, session, message) {
  if (!session?.socket) return false;

  const text = getText(message);
  const parsed = parse(text);
  if (!parsed) return false;

  const command = commands.get(parsed.name);
  if (!command) return false;

  const remoteJid = message?.key?.remoteJid;
  if (!remoteJid) return false;

  const ctx = {
    userId: String(userId),
    session,
    socket: session.socket,
    message,
    remoteJid,
    text,
    command: parsed.name,
    args: parsed.args,
    mentions: mentions(message),
    group,

    async reply(content, options = {}) {
      return session.socket.sendMessage(remoteJid, content, options);
    },

    async textReply(text, options = {}) {
      return session.socket.sendMessage(
        remoteJid, { text: String(text) }, options
      );
    }
  };

  await command.run(ctx);
  return true;
}

global.handleWhatsAppCommand = handleWhatsAppCommand;

module.exports = { commands, handleWhatsAppCommand, getText, parse };
