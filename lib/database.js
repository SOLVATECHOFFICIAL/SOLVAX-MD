'use strict';
const fs = require('fs');
const path = require('path');

const file = path.join(process.cwd(), 'data', 'database.json');
const EMPTY_DB = () => ({ version: 2, users: {}, groups: {}, settings: {} });
let db = EMPTY_DB();
let writeTimer = null;
let saveInProgress = false;

function ensure() {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(db, null, 2), 'utf8');
}
function load() {
  ensure();
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    db = parsed && typeof parsed === 'object' ? parsed : EMPTY_DB();
  } catch (e) {
    console.error('[DATABASE] Load failed:', e?.message || e);
    db = EMPTY_DB();
  }
  db.version ||= 2; db.users ||= {}; db.groups ||= {}; db.settings ||= {};
  return db;
}
function saveNow() {
  if (saveInProgress) return;
  saveInProgress = true;
  try {
    ensure();
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(temp, file);
  } catch (e) { console.error('[DATABASE] Save failed:', e?.stack || e); }
  finally { saveInProgress = false; }
}
function save() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => { writeTimer = null; saveNow(); }, 75);
}
function getUser(id) {
  const key = String(id);
  db.users[key] ||= { id: key, createdAt: Date.now() };
  db.users[key].lastSeen = Date.now(); save();
  return db.users[key];
}
function getGroup(id) {
  const key = String(id);
  db.groups[key] ||= {
    id: key, createdAt: Date.now(), muted: false,
    anti: {
      antilink: { enabled:false, action:'delete', affectAdmins:false, maxWarns:2, warns:{} },
      antimention: { enabled:false, action:'delete', affectAdmins:false, maxWarns:2, warns:{} },
      antiviewonce: { enabled:false, action:'delete', affectAdmins:false, maxWarns:2, warns:{} },
      antibot: { enabled:false, action:'delete', affectAdmins:false, maxWarns:2, warns:{} }
    }
  };
  db.groups[key].anti ||= {};
  for (const type of ['antilink','antimention','antiviewonce','antibot']) {
    db.groups[key].anti[type] ||= { enabled:false, action:'delete', affectAdmins:false, maxWarns:2, warns:{} };
    const c=db.groups[key].anti[type]; c.warns ||= {}; c.maxWarns ||= 2; c.action ||= 'delete';
  }
  return db.groups[key];
}
function setGroup(id, patch) {
  const group=getGroup(id);
  if (patch && typeof patch==='object') Object.assign(group, patch);
  save(); return group;
}
load();
global.getGroup = getGroup;
global.setGroup = setGroup;
module.exports = { load, save, saveNow, getUser, getGroup, setGroup, file, get data(){return db;} };
