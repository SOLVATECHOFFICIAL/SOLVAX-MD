'use strict';

const menu = require('./menu');
const ping = require('./ping');
const vv = require('./vv');
const play = require('./play');
const video = require('./video');
const sticker = require('./sticker');
const lyrics = require('./lyrics');
const groupinfo = require('./groupinfo');
const tagall = require('./tagall');
const tagadmin = require('./tagadmin');
const add = require('./add');
const kick = require('./kick');
const promote = require('./promote');
const demote = require('./demote');
const mute = require('./mute');
const anti = require('./anti');

async function handleWhatsAppCommand(userId, session, msg) {
    const sock = session.socket;
    const jid = msg.key?.remoteJid;
    if (!jid || !sock) return;

    const text = msg.message?.conversation ||
                 msg.message?.extendedTextMessage?.text ||
                 '';
    if (!text) return;

    const senderJid = msg.key?.participant || jid;
    const isGroup = jid.endsWith('@g.us');

    const command = text.split(' ')[0].toLowerCase();

    // Determine reply destination
    const publicCommands = ['.play', '.video', '.lyrics', '.tagall', '.tagadmin',
                           '.add', '.kick', '.promote', '.demote', '.mute', '.lock', '.unlock'];
    const isPublic = publicCommands.includes(command) && isGroup;
    const replyJid = isPublic ? jid : senderJid;

    const sendReply = async (content) => {
        await sock.sendMessage(replyJid, content);
    };

    const sendLoading = async (loadingText) => {
        if (!global.AUTO_DELETE_LOADING) {
            return sock.sendMessage(replyJid, { text: loadingText });
        }
        const loading = await sock.sendMessage(replyJid, { text: loadingText });
        setTimeout(async () => {
            try {
                await sock.sendMessage(replyJid, {
                    delete: { remoteJid: replyJid, fromMe: true, id: loading.key.id }
                });
            } catch (e) {}
        }, 2000);
        return loading;
    };

    const context = {
        sock,
        msg,
        sender: jid,
        senderNumber: senderJid.split('@')[0],
        isGroup,
        userId,
        replyJid,
        sendReply,
        sendLoading,
        rawText: text,
        text: command,
        jidNumber: (j) => j.split('@')[0],
        cleanNumber: (n) => String(n).replace(/\D/g, ''),
        fetchBuffer: require('../lib/helpers').fetchBuffer,
        sleep: require('../lib/helpers').sleep,
        isOwner: senderJid === global.OWNER_NUMBER + '@s.whatsapp.net' || (global.CO_OWNERS || []).includes(senderJid.split('@')[0]),
        getGroup: async () => {
            if (!isGroup) return null;
            try { return await sock.groupMetadata(jid); } catch { return null; }
        },
        isAdmin: async () => {
            if (!isGroup) return true;
            const group = await sock.groupMetadata(jid);
            const participant = group.participants.find(p => p.id === senderJid);
            return Boolean(participant?.admin) || context.isOwner;
        },
        getGroupAdmins: async () => {
            if (!isGroup) return [];
            const group = await sock.groupMetadata(jid);
            return group.participants.filter(p => p.admin).map(p => p.id);
        },
        getBotAdminStatus: async () => {
            if (!isGroup) return false;
            const group = await sock.groupMetadata(jid);
            const botId = sock.user?.id || (await sock.getMe())?.id;
            const participant = group.participants.find(p => p.id === botId);
            return Boolean(participant?.admin);
        },
        getMentionedJids: () => {
            return msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        }
    };

    try {
        if (command === '.menu') return await menu(context);
        if (command === '.ping') return await ping(context);
        if (command === '.vv') return await vv(context);
        if (text.startsWith('.play ')) return await play(context);
        if (text.startsWith('.video ')) return await video(context);
        if (command === '.sticker') return await sticker(context);
        if (text.startsWith('.lyrics ')) return await lyrics(context);
        if (command === '.groupinfo') return await groupinfo(context);
        if (command === '.tagall') return await tagall(context);
        if (command === '.tagadmin') return await tagadmin(context);
        if (text.startsWith('.add ')) return await add(context);
        if (text.startsWith('.kick ')) return await kick(context);
        if (text.startsWith('.promote ')) return await promote(context);
        if (text.startsWith('.demote ')) return await demote(context);
        if (command === '.mute on' || command === '.lock') return await mute(context, 'on');
        if (command === '.mute off' || command === '.unlock') return await mute(context, 'off');
        if (command === '.antilink' || text.startsWith('.antilink ') ||
            command === '.antimention' || text.startsWith('.antimention ') ||
            command === '.antiviewonce' || text.startsWith('.antiviewonce ') ||
            command === '.antibot' || text.startsWith('.antibot ')) {
            return await anti(context);
        }
    } catch (error) {
        console.error(`[COMMAND] Error handling ${command}:`, error);
        try {
            await sendReply({ text: `❌ Command failed: ${error.message || 'unknown error'}` });
        } catch (e) {}
    }
}

module.exports = { handleWhatsAppCommand };
