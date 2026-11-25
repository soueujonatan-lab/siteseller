const Database = require('better-sqlite3');
const fs = require('fs');
const path = require('path');
const file = process.env.DB_PATH || './data/siteseller.db';
fs.mkdirSync(path.dirname(file), { recursive: true });
const db = new Database(file);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
  business_name TEXT NOT NULL DEFAULT 'SiteSeller', created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS wa_config(
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  phone_number_id TEXT, waba_id TEXT, token_enc TEXT, connected_at INTEGER, last_error TEXT);
CREATE TABLE IF NOT EXISTS clients(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, phone TEXT NOT NULL, company TEXT, segment TEXT, notes TEXT,
  status TEXT NOT NULL DEFAULT 'Novo contato', consent INTEGER NOT NULL DEFAULT 0,
  opted_out INTEGER NOT NULL DEFAULT 0, sale_value REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, UNIQUE(user_id, phone));
CREATE TABLE IF NOT EXISTS templates(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, wa_name TEXT NOT NULL, language TEXT NOT NULL DEFAULT 'pt_BR',
  body TEXT NOT NULL, style TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS campaigns(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, template_id INTEGER NOT NULL REFERENCES templates(id),
  status TEXT NOT NULL DEFAULT 'draft', scheduled_at INTEGER,
  interval_seconds INTEGER NOT NULL DEFAULT 60, daily_limit INTEGER NOT NULL DEFAULT 200,
  last_error TEXT, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS campaign_targets(
  id INTEGER PRIMARY KEY, campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  state TEXT NOT NULL DEFAULT 'pending', error TEXT);
CREATE TABLE IF NOT EXISTS messages(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE, campaign_id INTEGER,
  direction TEXT NOT NULL, body TEXT NOT NULL, wa_message_id TEXT, status TEXT, error TEXT,
  created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS services(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL, price REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS settings(
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, key TEXT NOT NULL, value TEXT,
  PRIMARY KEY(user_id, key));
CREATE TABLE IF NOT EXISTS activities(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS idx_msg_wa ON messages(wa_message_id);
CREATE INDEX IF NOT EXISTS idx_msg_client ON messages(client_id, created_at);
CREATE INDEX IF NOT EXISTS idx_targets ON campaign_targets(campaign_id, state);
`);

db.activity = (uid, text) =>
  db.prepare('INSERT INTO activities(user_id,text,created_at) VALUES (?,?,?)').run(uid, text, Date.now());
db.getSetting = (uid, k, d) => {
  const r = db.prepare('SELECT value FROM settings WHERE user_id=? AND key=?').get(uid, k);
  return r ? r.value : d;
};
db.setSetting = (uid, k, v) =>
  db.prepare('INSERT INTO settings(user_id,key,value) VALUES (?,?,?) ON CONFLICT(user_id,key) DO UPDATE SET value=excluded.value')
    .run(uid, k, String(v));
module.exports = db;
