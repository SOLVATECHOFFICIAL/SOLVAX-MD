'use strict';
module.exports={name:'vv',async run(ctx){const q=ctx.quoted?.message;const media=q?.viewOnceMessage?.message||q?.viewOnceMessageV2?.message||q?.viewOnceMessageV2Extension?.message;if(!media)return ctx.textReply('❌ Reply to a view-once photo/video with .vv.');return ctx.textReply('⚠️ View-once media detected. SolvaX will not bypass WhatsApp view-once privacy or re-upload it.');}};
