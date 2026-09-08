const fs = require('fs');
const path = require('path');

const file = path.join(process.cwd(), 'data', 'database.json');
let db = { users: {}, groups: {}, settings: {} };

function ensure() {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, JSON.stringify(db, null, 2));
}

function load() {
  ensure();
  try {
    db = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    db = { users: {}, groups: {}, settings: {} };
  }
  db.users ||= {};
  db.groups ||= {};
  db.settings ||= {};
  return db;
}

let writeTimer;
function save() {
  ensure();
  clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(db, null, 2));
    fs.renameSync(temp, file);
  }, 50);
}

function getUser(id) {
  const key = String(id);
  if (!db.users[key]) {
    db.users[key] = { id: key, createdAt: Date.now(), lastSeen: Date.now() };
    save();
  } else {
    db.users[key].lastSeen = Date.now();
  }
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
  Object.assign(group, patch);
  save();
  return group;
}

load();
module.exports = { load, save, getUser, getGroup, setGroup, data: db, file };
