'use strict';
const fs=require('fs');
const path=require('path');
const {Telegraf}=require('telegraf');
const config=require('./config.json');
require('./lib/database');
const {handleWhatsAppCommand}=require('./commands');
const {setWhatsAppCommandHandler,restoreSessions,stopAllWhatsAppSessions}=require('./lib/whatsapp');
const {beginPairing,handlePairNumber,cancelPairing}=require('./telegram/pair');
const telegramHelp=require('./telegram/help');
const telegramStart=require('./telegram/start');
const telegramStatus=require('./telegram/status');
const telegramStop=require('./telegram/stop');

const token=process.env.BOT_TOKEN||process.env.TELEGRAM_BOT_TOKEN||config.telegramToken||config.botToken||config.telegramBotToken||'';
if(!token){console.error('❌ Missing Telegram bot token. Set BOT_TOKEN or telegramToken in config.json.');process.exit(1);}
const bot=new Telegraf(token);global.bot=bot;
setWhatsAppCommandHandler(handleWhatsAppCommand);

bot.start(telegramStart);bot.help(telegramHelp);bot.command('pair',beginPairing);bot.command('cancel',cancelPairing);bot.command('status',telegramStatus);bot.command('stop',telegramStop);
bot.on('text',async ctx=>{if(ctx.message?.text?.startsWith('/'))return;try{await handlePairNumber(ctx);}catch(e){console.error('[TELEGRAM] message handler:',e?.stack||e);}});
bot.catch((err,ctx)=>console.error(`[TELEGRAM] Update ${ctx?.update?.update_id||''} failed:`,err?.stack||err));

async function main(){
 console.log(`🚀 ${config.botName||'SolvaX MD'} starting...`);
 await restoreSessions();
 await bot.launch();
 console.log('✅ Telegram bot is running.');
}
let shutting=false;
async function shutdown(signal){if(shutting)return;shutting=true;console.log(`\n[APP] ${signal} received. Shutting down...`);try{bot.stop(signal);}catch{}try{await stopAllWhatsAppSessions({deleteAuth:false});}catch(e){console.error('[APP] WhatsApp shutdown failed:',e);}process.exit(0);}
process.once('SIGINT',()=>shutdown('SIGINT'));process.once('SIGTERM',()=>shutdown('SIGTERM'));
main().catch(e=>{console.error('[APP] Fatal startup error:',e?.stack||e);process.exit(1);});
