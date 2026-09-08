const fs = require('fs');

const DB_FILE = './database.json';
let db = { antilink: {}, antimention: {}, antiviewonce: {}, antibot: {} };
let dbWriteTimer = null;

function loadDatabase() {
    if (!fs.existsSync(DB_FILE)) return;
    try {
        const loaded = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
        db = { ...db, ...loaded };
    } catch (error) {
        console.error('⚠️ Database could not be loaded.');
    }
}

function saveDatabase() {
    if (dbWriteTimer) clearTimeout(dbWriteTimer);
    dbWriteTimer = setTimeout(() => {
        try {
            fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
        } catch (error) {
            console.error('❌ Database save failed:', error.message);
        }
        dbWriteTimer = null;
    }, 1000);
}

function getAntiSettings(groupId, type) {
    if (!db[type]) db[type] = {};
    if (!db[type][groupId]) {
        db[type][groupId] = { enabled: false, action: 'kick', adminAllowed: true, warns: 3, warnings: {} };
    }
    return db[type][groupId];
}

function updateAntiSettings(groupId, type, key, value) {
    const settings = getAntiSettings(groupId, type);
    settings[key] = value;
    saveDatabase();
}

module.exports = { loadDatabase, saveDatabase, getAntiSettings, updateAntiSettings };