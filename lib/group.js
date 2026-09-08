'use strict';

const { jidNumber, cleanNumber, toJid } = require('./helpers');

async function groupMetadata(ctx) {
  if (!ctx?.isGroup) throw new Error('This command only works in groups.');
  return ctx.sock.groupMetadata(ctx.jid);
}

function participantId(p) {
  return p?.id || p?.jid || '';
}

function participantNumber(p) {
  return jidNumber(participantId(p));
}

function normalizeTarget(value) {
  const number = cleanNumber(value);
  if (!number || number.length < 10 || number.length > 15) return null;
  return toJid(number);
}

function getReplyParticipant(ctx) {
  const message = ctx?.msg?.message || {};
  const wrappers = [
    message.extendedTextMessage,
    message.imageMessage,
    message.videoMessage,
    message.documentMessage,
    message.documentWithCaptionMessage?.message?.documentMessage
  ];
  for (const wrapper of wrappers) {
    const participant = wrapper?.contextInfo?.participant;
    if (participant) return participant;
  }
  return null;
}

function resolveTarget(ctx) {
  return getReplyParticipant(ctx) || normalizeTarget(ctx?.args?.[0]);
}

function isOwner(ctx) {
  return typeof ctx?.isOwner === 'function' ? Boolean(ctx.isOwner()) : Boolean(ctx?.isSelf);
}

async function isSenderAdmin(ctx, meta) {
  const sender = jidNumber(ctx?.senderJid || ctx?.senderNumber || '');
  if (!sender) return false;
  return Boolean(meta?.participants?.find(p => participantNumber(p) === sender && Boolean(p.admin)));
}

async function isBotAdmin(ctx, meta) {
  const bot = jidNumber(ctx?.sock?.user?.id || '');
  if (!bot) return false;
  return Boolean(meta?.participants?.find(p => participantNumber(p) === bot && Boolean(p.admin)));
}

async function requireAdmin(ctx) {
  let meta;
  try {
    meta = await groupMetadata(ctx);
  } catch (error) {
    await ctx.reply(`❌ ${error?.message || 'Unable to read group metadata.'}`);
    return null;
  }

  if (!(await isSenderAdmin(ctx, meta)) && !isOwner(ctx)) {
    await ctx.reply('❌ Group-admin permission required.');
    return null;
  }

  if (!(await isBotAdmin(ctx, meta))) {
    await ctx.reply('❌ Make the bot a group admin first.');
    return null;
  }

  return meta;
}

module.exports = {
  groupMetadata,
  isSenderAdmin,
  isBotAdmin,
  requireAdmin,
  participantId,
  participantNumber,
  normalizeTarget,
  resolveTarget,
  getReplyParticipant
};
