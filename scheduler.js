// Envia campanhas respeitando intervalo, limite diario e horario de atendimento.
const db = require('./db');
const wa = require('./whatsapp');
const { decrypt } = require('./crypto');
const busy = new Set();

const localHHMM = (tz) =>
  new Date().toLocaleTimeString('en-GB', { timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit' });

function waConfig(uid) {
  const r = db.prepare('SELECT * FROM wa_config WHERE user_id=?').get(uid);
  if (!r || !r.token_enc || !r.phone_number_id) return null;
  return { phone_number_id: r.phone_number_id, token: decrypt(r.token_enc) };
}
const pause = (c, msg) => {
  db.prepare("UPDATE campaigns SET status='paused', last_error=? WHERE id=?").run(msg, c.id);
  db.activity(c.user_id, `Campanha "${c.name}" pausada: ${msg}`);
};

async function processCampaign(c) {
  const uid = c.user_id, now = Date.now();
  if (db.getSetting(uid, 'only_in_hours', '0') === '1') {
    const t = localHHMM(db.getSetting(uid, 'timezone', 'America/Sao_Paulo'));
    if (t < db.getSetting(uid, 'hours_start', '09:00') || t >= db.getSetting(uid, 'hours_end', '18:00')) return;
  }
  const last = db.prepare("SELECT MAX(created_at) m FROM messages WHERE campaign_id=? AND direction='out'").get(c.id).m || 0;
  if (now - last < c.interval_seconds * 1000) return;
  const n24 = db.prepare("SELECT COUNT(*) n FROM messages WHERE campaign_id=? AND direction='out' AND created_at>?").get(c.id, now - 86400000).n;
  if (n24 >= c.daily_limit) return;

  const t = db.prepare(`SELECT ct.id tid, cl.* FROM campaign_targets ct JOIN clients cl ON cl.id=ct.client_id
    WHERE ct.campaign_id=? AND ct.state='pending' ORDER BY ct.id LIMIT 1`).get(c.id);
  if (!t) {
    db.prepare("UPDATE campaigns SET status='completed' WHERE id=?").run(c.id);
    db.activity(uid, `Campanha "${c.name}" concluída`);
    return;
  }
  if (t.opted_out || !t.consent) {
    db.prepare("UPDATE campaign_targets SET state='skipped', error='Sem consentimento ou opt-out' WHERE id=?").run(t.tid);
    return;
  }
  const tpl = db.prepare('SELECT * FROM templates WHERE id=?').get(c.template_id);
  const cfg = waConfig(uid);
  if (!cfg || !tpl) return pause(c, 'WhatsApp não configurado ou modelo removido');

  const vars = [t.name.split(' ')[0], t.company || 'sua empresa'];
  const body = wa.render(tpl.body, vars);
  try {
    const waId = await wa.sendTemplate(cfg, t.phone, tpl, vars);
    db.prepare("INSERT INTO messages(user_id,client_id,campaign_id,direction,body,wa_message_id,status,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(uid, t.id, c.id, 'out', body, waId, 'sent', Date.now());
    db.prepare("UPDATE campaign_targets SET state='sent' WHERE id=?").run(t.tid);
    db.prepare("UPDATE clients SET status='Aguardando resposta', updated_at=? WHERE id=? AND status='Novo contato'").run(Date.now(), t.id);
    db.prepare('UPDATE campaigns SET last_error=NULL WHERE id=?').run(c.id);
  } catch (e) {
    db.prepare("INSERT INTO messages(user_id,client_id,campaign_id,direction,body,status,error,created_at) VALUES (?,?,?,?,?,?,?,?)")
      .run(uid, t.id, c.id, 'out', body, 'failed', e.message, Date.now());
    db.prepare("UPDATE campaign_targets SET state='failed', error=? WHERE id=?").run(e.message, t.tid);
    db.prepare('UPDATE wa_config SET last_error=? WHERE user_id=?').run(e.message, uid);
    if (e.fatal) pause(c, 'Token do WhatsApp inválido ou expirado. Atualize em Configurações.');
  }
}

function tick() {
  const now = Date.now();
  db.prepare("UPDATE campaigns SET status='running' WHERE status='scheduled' AND scheduled_at<=?").run(now);
  for (const c of db.prepare("SELECT * FROM campaigns WHERE status='running'").all()) {
    if (busy.has(c.id)) continue;
    busy.add(c.id);
    processCampaign(c).catch((e) => console.error('campanha', c.id, e.message)).finally(() => busy.delete(c.id));
  }
}
module.exports = { start: () => setInterval(tick, 10000) };
