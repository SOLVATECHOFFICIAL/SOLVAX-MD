function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanNumber(number) {
    return String(number || '').replace(/\D/g, '');
}

function jidNumber(jid) {
    if (!jid) return '';
    return jid.split('@')[0].split(':')[0].replace(/\D/g, '');
}

function isLoggedOut(error) {
    try {
        const { Boom } = require('@hapi/boom');
        const { DisconnectReason } = require('@whiskeysockets/baileys');
        return error instanceof Boom && error.output?.statusCode === DisconnectReason.loggedOut;
    } catch {
        return false;
    }
}

async function fetchBuffer(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
}

function log(message, level = 'info') {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level.toUpperCase()}] ${message}`);
}

module.exports = { sleep, cleanNumber, jidNumber, isLoggedOut, fetchBuffer, log };