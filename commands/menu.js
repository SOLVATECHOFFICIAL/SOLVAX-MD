'use strict';
module.exports = {
  name: 'menu',
  async run(ctx) {
    await ctx.textReply(`╭───〔 SOLVAX MD 〕───╮
│
│ .ping        Check bot speed
│ .menu        Show command menu
│ .groupinfo   Show group info + members
│ .vv          View view-once photos/videos
│ .sticker     Image/video/gif → sticker
│ .play        Download YouTube music
│ .video       Download YouTube video
│ .lyrics      Search song lyrics
│
│ GROUP TOOLS
│ .tagall      Mention all members
│ .tagadmin    Mention all admins
│ .add 234xxx  Add member - works for all if group allows
│ .kick @tag   Remove member - ADMIN ONLY
│ .promote @   Make admin - OWNER ONLY
│ .demote @    Remove admin - OWNER ONLY
│ .mute on/off Lock/Unlock group - ADMIN ONLY
│
│ ANTI SYSTEM
│ .antilink
│ .antimention
│ .antiviewonce
│ .antibot
│
╰─────────────────────────────────────╯`);
  }
};
