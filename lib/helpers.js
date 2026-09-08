'use strict';

const {
    DisconnectReason
} = require('@whiskeysockets/baileys');


/* ============================================================
 * SLEEP
 * ============================================================
 */

function sleep(ms) {
    return new Promise(
        resolve => setTimeout(
            resolve,
            ms
        )
    );
}


/* ============================================================
 * CLEAN PHONE NUMBER
 * ============================================================
 *
 * Examples:
 *
 * +234 813 253 8119
 *        ↓
 * 2348132538119
 *
 * 234-813-253-8119
 *        ↓
 * 2348132538119
 *
 * ============================================================
 */

function cleanNumber(value) {
    return String(
        value || ''
    ).replace(
        /[^0-9]/g,
        ''
    );
}


/* ============================================================
 * EXTRACT NUMBER FROM JID
 * ============================================================
 *
 * Example:
 *
 * 2348132538119@s.whatsapp.net
 *        ↓
 * 2348132538119
 *
 * 2348132538119:12@s.whatsapp.net
 *        ↓
 * 2348132538119
 *
 * ============================================================
 */

function jidNumber(jid) {
    return String(
        jid || ''
    )
        .split('@')[0]
        .split(':')[0]
        .replace(
            /[^0-9]/g,
            ''
        );
}


/* ============================================================
 * CONVERT NUMBER TO WHATSAPP JID
 * ============================================================
 */

function toJid(number) {
    const clean =
        cleanNumber(number);

    return clean
        ? `${clean}@s.whatsapp.net`
        : null;
}


/* ============================================================
 * GROUP JID CHECK
 * ============================================================
 */

function isGroupJid(jid) {
    return String(
        jid || ''
    ).endsWith(
        '@g.us'
    );
}


/* ============================================================
 * LOGGED-OUT CHECK
 * ============================================================
 */

function isLoggedOut(error) {
    const code =
        error?.output?.statusCode ??
        error?.statusCode ??
        error?.data?.statusCode;

    return (
        code ===
            DisconnectReason.loggedOut ||
        code === 401
    );
}


/* ============================================================
 * DISCONNECT STATUS CODE
 * ============================================================
 */

function disconnectCode(error) {
    return (
        error?.output?.statusCode ??
        error?.statusCode ??
        error?.data?.statusCode ??
        null
    );
}


/* ============================================================
 * COMMAND PARSER
 * ============================================================
 *
 * Example:
 *
 * .menu
 *
 * result:
 *
 * {
 *   command: 'menu',
 *   args: [],
 *   text: ''
 * }
 *
 *
 * .play despacito
 *
 * result:
 *
 * {
 *   command: 'play',
 *   args: ['despacito'],
 *   text: 'despacito'
 * }
 *
 * ============================================================
 */

function commandParts(
    text,
    prefix = '.'
) {
    const value =
        String(
            text || ''
        ).trim();


    if (
        !value.startsWith(
            prefix
        )
    ) {
        return null;
    }


    const body =
        value
            .slice(
                prefix.length
            )
            .trim();


    if (!body) {
        return null;
    }


    const parts =
        body.split(
            /\s+/
        );


    const command =
        parts
            .shift()
            .toLowerCase();


    return {
        command,

        args:
            parts,

        text:
            parts.join(' ')
    };
}


/* ============================================================
 * UNWRAP MESSAGE
 * ============================================================
 *
 * Handles:
 *
 * normal message
 * ephemeral message
 * view-once message
 * view-once V2
 * view-once V2 extension
 *
 * ============================================================
 */

function unwrapMessage(
    message
) {
    let m =
        message;


    if (!m) {
        return null;
    }


    if (
        m.ephemeralMessage
    ) {

        m =
            m.ephemeralMessage.message;
    }


    if (
        m.viewOnceMessage
    ) {

        m =
            m.viewOnceMessage.message;
    }


    if (
        m.viewOnceMessageV2
    ) {

        m =
            m.viewOnceMessageV2.message;
    }


    if (
        m.viewOnceMessageV2Extension
    ) {

        m =
            m.viewOnceMessageV2Extension.message;
    }


    return m || null;
}


/* ============================================================
 * GET MESSAGE TEXT
 * ============================================================
 */

function getText(
    message
) {
    const m =
        unwrapMessage(
            message
        );


    return (
        m?.conversation ||

        m?.extendedTextMessage
            ?.text ||

        m?.imageMessage
            ?.caption ||

        m?.videoMessage
            ?.caption ||

        m?.documentWithCaptionMessage
            ?.message
            ?.documentMessage
            ?.caption ||

        ''
    ).trim();
}




/* ============================================================
 * MESSAGE IDENTITY HELPERS
 * ============================================================
 */

function getMessageText(message) {
    return getText(message);
}

function getRemoteJid(message) {
    return message?.key?.remoteJid || null;
}

function isSelfMessage(message) {
    return message?.key?.fromMe === true;
}

function isIgnoredJid(jid) {
    const value = String(jid || '');
    return value === 'status@broadcast' || value.endsWith('@broadcast');
}

/* ============================================================
 * GET MEDIA TYPE
 * ============================================================
 */

function getMediaType(
    message
) {
    const m =
        unwrapMessage(
            message
        );


    if (!m) {
        return null;
    }


    if (
        m.imageMessage
    ) {
        return 'image';
    }


    if (
        m.videoMessage
    ) {
        return 'video';
    }


    if (
        m.audioMessage
    ) {
        return 'audio';
    }


    if (
        m.stickerMessage
    ) {
        return 'sticker';
    }


    if (
        m.documentMessage ||
        m.documentWithCaptionMessage
    ) {
        return 'document';
    }


    return null;
}


/* ============================================================
 * GET QUOTED MESSAGE
 * ============================================================
 *
 * IMPORTANT:
 *
 * The old version tried:
 *
 * global.sessions[userId].sock
 *
 * but the actual session property is:
 *
 * global.sessions[userId].socket
 *
 * We also cannot rely on:
 *
 * message._sessionUserId
 *
 * unless the WhatsApp dispatcher explicitly attaches it.
 *
 * Therefore this function determines fromMe more safely.
 *
 * ============================================================
 */

function getQuotedMessage(
    message
) {
    const m =
        unwrapMessage(
            message
        );


    if (!m) {
        return null;
    }


    const ctx =
        m?.extendedTextMessage
            ?.contextInfo ||

        m?.imageMessage
            ?.contextInfo ||

        m?.videoMessage
            ?.contextInfo ||

        m?.documentMessage
            ?.contextInfo;


    if (
        !ctx?.quotedMessage
    ) {
        return null;
    }


    const remoteJid =
        message
            ?.key
            ?.remoteJid ||
        null;


    const participant =
        ctx.participant ||
        null;


    /*
     * Try to determine which SolvaX session received
     * the message.
     *
     * The dispatcher can attach _sessionUserId.
     */
    const sessionUserId =
        message
            ?._sessionUserId;


    let ownJid =
        null;


    if (
        sessionUserId &&
        global.sessions
    ) {

        const session =
            global.sessions[
                String(
                    sessionUserId
                )
            ];


        ownJid =
            session
                ?.socket
                ?.user
                ?.id ||
            null;
    }


    /*
     * Compare normalized JIDs.
     */
    const fromMe =
        Boolean(
            ownJid &&
            participant &&
            jidNumber(
                ownJid
            ) ===
            jidNumber(
                participant
            )
        );


    return {

        key: {

            remoteJid,

            fromMe,

            id:
                ctx.stanzaId ||
                null,

            participant
        },

        message:
            ctx.quotedMessage
    };
}


/* ============================================================
 * EXPORTS
 * ============================================================
 */

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
    getMessageText,
    getRemoteJid,
    isSelfMessage,
    isIgnoredJid,

    getMediaType,

    getQuotedMessage
};
