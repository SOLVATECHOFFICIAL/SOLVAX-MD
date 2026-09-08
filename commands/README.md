# SOLVAX MD WhatsApp Commands
Separate command layer for the WhatsApp session manager.

Commands:
.ping .menu .groupinfo .vv .sticker .play .video .lyrics
.tagall .tagadmin .add .kick .promote .demote .mute
.antilink .antimention .antiviewonce .antibot

Anti shortcuts:
.antilink on|off|kick|delete|warn
.antilink admin on|off
.antilink warns 3
.antilink resetwarns @tag
.antilink clearwarns

The command layer does not create a Baileys socket.
Load it with: require('./commands')
