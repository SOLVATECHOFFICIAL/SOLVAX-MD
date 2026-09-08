const fs = require('fs');
const path = require('path');

const file = path.join(process.cwd(), 'data', 'database.json');
const EMPTY_DB = () => ({ users: {}, groups: {}, settings: {} });
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
  } catch (error) {
    console.error('[DATABASE] Failed loading database:', error?.message || error);
    db = EMPTY_DB();
  }
  db.users ||= {};
  db.groups ||= {};
  db.settings ||= {};
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
  } catch (error) {
    console.error('[DATABASE] Failed saving database:', error?.stack || error);
  } finally {
    saveInProgress = false;
  }
}

function save() {
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    saveNow();
  }, 50);
}

function getUser(id) {
  const key = String(id);
  if (!db.users[key]) {
    db.users[key] = { id: key, createdAt: Date.now(), lastSeen: Date.now() };
  } else {
    db.users[key].lastSeen = Date.now();
  }
  save();
  return db.users[key];
}

function getGroup(id) {
  const key = String(id);
  if (!db.groups[key]) {
    db.groups[key] = { id: key, createdAt: Date.now(), antiLink: false, muted: false };
    save();
  }
  return db.groups[key];
}

function setGroup(id, patch) {
  const group = getGroup(id);
  Object.assign(group, patch || {});
  save();
  return group;
}

load();

module.exports = {
  load,
  save,
  saveNow,
  getUser,
  getGroup,
  setGroup,
  file,
  get data() { return db; }
};
