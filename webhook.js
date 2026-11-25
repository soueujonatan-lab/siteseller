// Processa eventos enviados pela Meta: status de entrega e respostas dos clientes.
const db = require('./db');
const wa = require('./whatsapp');
const { decrypt } = require('./crypto');
const { normPhone, phoneVariants, isOptOut } = require('./utils');
const RANK = { queued: 0, sent: 1, delivered: 2, read: 3 };

function updateStatus(uid, s) {
  const row = db.prepare('SELECT id,status FROM messages WHERE user_id=? AND wa_message_id=?').get(uid, s.id);
  if (!row) return;
  if (s.status === 'failed') {
    const e = (s.errors && s.errors[0]) || {};
    db.prepare("UPDATE messages SET status='failed', error=? WHERE id=?").run(`${e.code || ''} ${e.title || e.message || 'Falha na entrega'}`.trim(), row.id);
  } else if ((RANK[s.status] ?? -1) > (RANK[row.status] ?? -1)) {
    db.prepare('UPDATE messages SET status=? WHERE id=?').run(s.status, row.id);
  }
}

function textOf(m) {
  if (m.type === 'text') return m.text.body;
  if (m.type === 'button') return m.button.text;
  if (m.type === 'interactive') return (m.interactive.button_reply || m.interactive.list_reply || {}).title || '[interação]';
  return `[${m.type}]`;
}

async function inbound(uid, cfgRow, m, contact) {
  if (db.prepare('SELECT 1 FROM messages WHERE user_id=? AND wa_message_id=?').get(uid, m.id)) return; // duplicado
  let client;
  for (const p of phoneVariants(m.from)) {
    client = db.prepare('SELECT * FROM clients WHERE user_id=? AND phone=?').get(uid, p);
    if (client) break;
  }
  const now = Date.now();
  if (!client) {
    const name = (contact && contact.profile && contact.profile.name) || m.from;
    const r = db.prepare("INSERT INTO clients(user_id,name,phone,status,consent,created_at,updated_at) VALUES (?,?,?,?,1,?,?)")
      .run(uid, name, normPhone(m.from), 'Novo contato', now, now);
    client = db.prepare('SELECT * FROM clients WHERE id=?').get(r.lastInsertRowid);
  }
  const text = textOf(m);
  db.prepare("INSERT INTO messages(user_id,client_id,direction,body,wa_message_id,status,created_at) VALUES (?,?,?,?,?,?,?)")
    .run(uid, client.id, 'in', text, m.id, 'received', now);

  if (isOptOut(text)) {
    db.prepare("UPDATE clients SET opted_out=1, status='Não interessado', updated_at=? WHERE id=?").run(now, client.id);
    db.prepare(`UPDATE campaign_targets SET state='skipped', error='Opt-out' WHERE client_id=? AND state='pending'`).run(client.id);
    db.activity(uid, `${client.name} pediu para não receber mais mensagens`);
    try { // confirmacao (permitida: o cliente acabou de escrever)
      const cfg = { phone_number_id: cfgRow.phone_number_id, token: decrypt(cfgRow.token_enc) };
      const id = await wa.sendText(cfg, client.phone, 'Tudo certo! Você não receberá mais mensagens nossas.');
      db.prepare("INSERT INTO messages(user_id,client_id,direction,body,wa_message_id,status,created_at) VALUES (?,?,?,?,?,?,?)")
        .run(uid, client.id, 'out', 'Tudo certo! Você não receberá mais mensagens nossas.', id, 'sent', Date.now());
    } catch (e) { console.error('confirmacao opt-out:', e.message); }
    return;
  }
  if (client.status === 'Aguardando resposta') {
    db.prepare("UPDATE clients SET status='Interessado', updated_at=? WHERE id=?").run(now, client.id);
  }
  db.activity(uid, `Nova resposta de ${client.name}`);
}

async function handle(body) {
  for (const entry of body.entry || []) {
    for (const ch of entry.changes || []) {
      const v = ch.value || {};
      const pnid = v.metadata && v.metadata.phone_number_id;
      if (!pnid) continue;
      const cfgRow = db.prepare('SELECT * FROM wa_config WHERE phone_number_id=?').get(pnid);
      if (!cfgRow) continue;
      for (const s of v.statuses || []) updateStatus(cfgRow.user_id, s);
      for (const m of v.messages || []) {
        await inbound(cfgRow.user_id, cfgRow, m, (v.contacts || []).find((c) => c.wa_id === m.from));
      }
    }
  }
}
module.exports = { handle };
