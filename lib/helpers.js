const { DisconnectReason } = require('@whiskeysockets/baileys');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanNumber(value) {
  return String(value || '').replace(/[^0-9]/g, '');
}

function jidNumber(jid) {
  return String(jid || '').split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

function toJid(number) {
  const clean = cleanNumber(number);
  return clean ? `${clean}@s.whatsapp.net` : null;
}

function isGroupJid(jid) {
  return String(jid || '').endsWith('@g.us');
}

function isLoggedOut(error) {
  const code = error?.output?.statusCode ?? error?.statusCode ?? error?.data?.statusCode;
  return code === DisconnectReason.loggedOut || code === 401;
}

function disconnectCode(error) {
  return error?.output?.statusCode ?? error?.statusCode ?? error?.data?.statusCode ?? null;
}

function commandParts(text, prefix = '.') {
  const value = String(text || '').trim();
  if (!value.startsWith(prefix)) return null;
  const body = value.slice(prefix.length).trim();
  if (!body) return null;
  const parts = body.split(/\s+/);
  const command = parts.shift().toLowerCase();
  return { command, args: parts, text: parts.join(' ') };
}

function unwrapMessage(message) {
  let m = message;
  if (!m) return null;
  if (m.ephemeralMessage) m = m.ephemeralMessage.message;
  if (m.viewOnceMessage) m = m.viewOnceMessage.message;
  if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
  if (m.viewOnceMessageV2Extension) m = m.viewOnceMessageV2Extension.message;
  return m || null;
}

function getText(message) {
  const m = unwrapMessage(message);
  return (
    m?.conversation ||
    m?.extendedTextMessage?.text ||
    m?.imageMessage?.caption ||
    m?.videoMessage?.caption ||
    m?.documentWithCaptionMessage?.message?.documentMessage?.caption ||
    ''
  ).trim();
}

function getMediaType(message) {
  const m = unwrapMessage(message);
  if (!m) return null;
  if (m.imageMessage) return 'image';
  if (m.videoMessage) return 'video';
  if (m.audioMessage) return 'audio';
  if (m.stickerMessage) return 'sticker';
  if (m.documentMessage || m.documentWithCaptionMessage) return 'document';
  return null;
}

function getQuotedMessage(message) {
  const m = unwrapMessage(message);
  const ctx = m?.extendedTextMessage?.contextInfo ||
    m?.imageMessage?.contextInfo ||
    m?.videoMessage?.contextInfo ||
    m?.documentMessage?.contextInfo;
  return ctx?.quotedMessage ? {
    key: {
      remoteJid: message.key.remoteJid,
      fromMe: Boolean(ctx.participant === global.sessions?.[message._sessionUserId]?.sock?.user?.id),
      id: ctx.stanzaId,
      participant: ctx.participant
    },
    message: ctx.quotedMessage
  } : null;
}

module.exports = {
  sleep,
  cleanNumber,
  jidNumber,
  toJid,
  isGroupJid,
  isLoggedOut,
  disconnectCode,
  commandParts,
  unwrapMessage,
  getText,
  getMediaType,
  getQuotedMessage
};
