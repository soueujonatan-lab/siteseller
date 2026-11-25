require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const wa = require('./whatsapp');
const webhook = require('./webhook');
const scheduler = require('./scheduler');
const { encrypt, decrypt } = require('./crypto');
const { STATUSES, normPhone, validPhone, csvCell } = require('./utils');

if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) throw new Error('Defina JWT_SECRET (32+ caracteres) no .env');
decrypt(encrypt('teste')); // valida ENC_KEY na inicializacao

const app = express();
app.set('trust proxy', 1);
app.use(helmet());
app.use(express.json({ limit: '1mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

// ---------- Autenticacao ----------
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false });
const sign = (u) => jwt.sign({ uid: u.id }, process.env.JWT_SECRET, { expiresIn: '7d' });
const userDto = (u) => ({ id: u.id, email: u.email, business_name: u.business_name });

app.post('/auth/register', authLimiter, ah(async (req, res) => {
  if (process.env.ALLOW_REGISTRATION !== 'true') return bad(res, 'Cadastro desativado neste servidor', 403);
  const { email, password } = req.body || {};
  if (!/^\S+@\S+\.\S+$/.test(email || '')) return bad(res, 'E-mail inválido');
  if (!password || password.length < 8) return bad(res, 'A senha deve ter ao menos 8 caracteres');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email.toLowerCase())) return bad(res, 'E-mail já cadastrado', 409);
  const hash = await bcrypt.hash(password, 12);
  const r = db.prepare('INSERT INTO users(email,password_hash,created_at) VALUES (?,?,?)').run(email.toLowerCase(), hash, Date.now());
  const u = db.prepare('SELECT * FROM users WHERE id=?').get(r.lastInsertRowid);
  res.json({ token: sign(u), user: userDto(u) });
}));

app.post('/auth/login', authLimiter, ah(async (req, res) => {
  const { email, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(email || '').toLowerCase());
  const ok = u && (await bcrypt.compare(String(password || ''), u.password_hash));
  if (!ok) return bad(res, 'E-mail ou senha incorretos', 401);
  res.json({ token: sign(u), user: userDto(u) });
}));

// Webhook da Meta (publico, protegido por assinatura HMAC)
app.get('/webhook', (req, res) => {
  const t = process.env.WEBHOOK_VERIFY_TOKEN;
  if (t && req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === t) return res.status(200).send(req.query['hub.challenge']);
  res.sendStatus(403);
});
app.post('/webhook', (req, res) => {
  const secret = process.env.META_APP_SECRET;
  const sig = req.get('x-hub-signature-256') || '';
  const exp = 'sha256=' + crypto.createHmac('sha256', secret || '').update(req.rawBody || Buffer.alloc(0)).digest('hex');
  if (!secret || sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return res.sendStatus(401);
  res.sendStatus(200); // responde rapido; processa em seguida
  webhook.handle(req.body || {}).catch((e) => console.error('webhook:', e));
});

app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------- Rotas autenticadas ----------
app.use((req, res, next) => {
  const h = req.get('authorization') || '';
  try {
    req.uid = jwt.verify(h.replace(/^Bearer /, ''), process.env.JWT_SECRET).uid;
    if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(req.uid)) throw new Error('x');
    next();
  } catch { bad(res, 'Sessão inválida ou expirada', 401); }
});

const waCfg = (uid) => {
  const r = db.prepare('SELECT * FROM wa_config WHERE user_id=?').get(uid);
  return r && r.token_enc && r.phone_number_id ? { phone_number_id: r.phone_number_id, token: decrypt(r.token_enc) } : null;
};
const getClient = (uid, id) => db.prepare('SELECT * FROM clients WHERE id=? AND user_id=?').get(id, uid);

// Painel
app.get('/dashboard', (req, res) => {
  const u = req.uid;
  const one = (sql, ...p) => db.prepare(sql).get(u, ...p);
  const sentWhere = "user_id=? AND direction='out' AND status IN ('sent','delivered','read')";
  const off = Number(process.env.TZ_OFFSET_HOURS ?? -3);
  const days = [];
  for (let i = 6; i >= 0; i--) days.push(new Date(Date.now() + off * 3600e3 - i * 86400e3).toISOString().slice(0, 10));
  const rows = db.prepare(`SELECT strftime('%Y-%m-%d', created_at/1000, 'unixepoch', ?) d,
      COUNT(*) sent, SUM(status IN ('delivered','read')) delivered FROM messages
      WHERE ${sentWhere} AND created_at>? GROUP BY d`).all(`${off} hours`, u, Date.now() - 8 * 86400e3);
  const series = days.map((d) => { const r = rows.find((x) => x.d === d); return { day: d.slice(8) + '/' + d.slice(5, 7), sent: r ? r.sent : 0, delivered: r ? r.delivered || 0 : 0 }; });
  res.json({
    clients: one('SELECT COUNT(*) n FROM clients WHERE user_id=?').n,
    sent: one(`SELECT COUNT(*) n FROM messages WHERE ${sentWhere}`).n,
    interested: one("SELECT COUNT(*) n FROM clients WHERE user_id=? AND status='Interessado'").n,
    sales: one("SELECT COUNT(*) n FROM clients WHERE user_id=? AND status='Venda concluída'").n,
    revenue: one("SELECT COALESCE(SUM(sale_value),0) s FROM clients WHERE user_id=? AND status='Venda concluída'").s,
    series,
    activities: db.prepare('SELECT text, created_at FROM activities WHERE user_id=? ORDER BY id DESC LIMIT 15').all(u),
  });
});

// Clientes
function cleanClient(b, base = {}) {
  const c = { ...base };
  if (b.name !== undefined) c.name = String(b.name).trim().slice(0, 120);
  if (b.phone !== undefined) c.phone = normPhone(b.phone);
  for (const k of ['company', 'segment', 'notes']) if (b[k] !== undefined) c[k] = b[k] === null ? null : String(b[k]).trim().slice(0, 1000);
  if (b.status !== undefined) c.status = b.status;
  if (b.consent !== undefined) c.consent = b.consent ? 1 : 0;
  if (b.opted_out !== undefined) c.opted_out = b.opted_out ? 1 : 0;
  if (b.sale_value !== undefined) c.sale_value = Math.max(0, Number(b.sale_value) || 0);
  return c;
}
function validateClient(c) {
  if (!c.name) return 'Informe o nome';
  if (!validPhone(c.phone || '')) return 'Telefone inválido. Use DDD (e DDI para números fora do Brasil).';
  if (!STATUSES.includes(c.status)) return 'Status inválido';
  return null;
}
app.get('/clients', (req, res) => {
  const q = `%${String(req.query.q || '').trim()}%`;
  const params = [req.uid, q, q, q, q];
  let sql = 'SELECT * FROM clients WHERE user_id=? AND (name LIKE ? OR phone LIKE ? OR company LIKE ? OR segment LIKE ?)';
  if (req.query.status) { sql += ' AND status=?'; params.push(req.query.status); }
  res.json(db.prepare(sql + ' ORDER BY name COLLATE NOCASE').all(...params));
});
app.post('/clients', (req, res) => {
  const c = cleanClient(req.body || {}, { status: 'Novo contato', consent: 0, opted_out: 0, sale_value: 0 });
  const err = validateClient(c); if (err) return bad(res, err);
  if (db.prepare('SELECT 1 FROM clients WHERE user_id=? AND phone=?').get(req.uid, c.phone)) return bad(res, 'Já existe um cliente com este telefone', 409);
  const now = Date.now();
  const r = db.prepare('INSERT INTO clients(user_id,name,phone,company,segment,notes,status,consent,opted_out,sale_value,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
    .run(req.uid, c.name, c.phone, c.company || null, c.segment || null, c.notes || null, c.status, c.consent, c.opted_out, c.sale_value, now, now);
  db.activity(req.uid, `Cliente cadastrado: ${c.name}`);
  res.json(getClient(req.uid, r.lastInsertRowid));
});
app.post('/clients/import', (req, res) => {
  const { consent, contacts } = req.body || {};
  if (consent !== true) return bad(res, 'É necessário confirmar que você tem autorização (opt-in) dos contatos');
  if (!Array.isArray(contacts) || contacts.length > 500) return bad(res, 'Envie até 500 contatos por vez');
  const ins = db.prepare("INSERT OR IGNORE INTO clients(user_id,name,phone,status,consent,created_at,updated_at) VALUES (?,?,?,'Novo contato',1,?,?)");
  let imported = 0, skipped = 0; const now = Date.now();
  db.transaction(() => {
    for (const c of contacts) {
      const phone = normPhone(c.phone), name = String(c.name || '').trim().slice(0, 120);
      if (!name || !validPhone(phone)) { skipped++; continue; }
      ins.run(req.uid, name, phone, now, now).changes ? imported++ : skipped++;
    }
  })();
  if (imported) db.activity(req.uid, `${imported} contatos importados`);
  res.json({ imported, skipped });
});
app.put('/clients/:id', (req, res) => {
  const cur = getClient(req.uid, req.params.id); if (!cur) return bad(res, 'Cliente não encontrado', 404);
  const c = cleanClient(req.body || {}, cur);
  const err = validateClient(c); if (err) return bad(res, err);
  const dup = db.prepare('SELECT id FROM clients WHERE user_id=? AND phone=? AND id<>?').get(req.uid, c.phone, cur.id);
  if (dup) return bad(res, 'Já existe outro cliente com este telefone', 409);
  db.prepare('UPDATE clients SET name=?,phone=?,company=?,segment=?,notes=?,status=?,consent=?,opted_out=?,sale_value=?,updated_at=? WHERE id=?')
    .run(c.name, c.phone, c.company || null, c.segment || null, c.notes || null, c.status, c.consent, c.opted_out, c.sale_value, Date.now(), cur.id);
  if (c.status !== cur.status) db.activity(req.uid, `${c.name}: ${cur.status} → ${c.status}`);
  res.json(getClient(req.uid, cur.id));
});
app.delete('/clients/:id', (req, res) => {
  if (!getClient(req.uid, req.params.id)) return bad(res, 'Cliente não encontrado', 404);
  db.prepare('DELETE FROM clients WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});
app.get('/clients/:id/messages', (req, res) => {
  if (!getClient(req.uid, req.params.id)) return bad(res, 'Cliente não encontrado', 404);
  res.json(db.prepare('SELECT id,direction,body,status,error,created_at FROM messages WHERE client_id=? ORDER BY created_at').all(req.params.id));
});
app.post('/clients/:id/reply', ah(async (req, res) => {
  const cl = getClient(req.uid, req.params.id); if (!cl) return bad(res, 'Cliente não encontrado', 404);
  if (cl.opted_out) return bad(res, 'Este contato pediu para não receber mais mensagens', 409);
  const text = String((req.body || {}).text || '').trim().slice(0, 4000);
  if (!text) return bad(res, 'Digite a mensagem');
  const cfg = waCfg(req.uid); if (!cfg) return bad(res, 'Configure o WhatsApp em Configurações', 409);
  try {
    const id = await wa.sendText(cfg, cl.phone, text);
    const r = db.prepare("INSERT INTO messages(user_id,client_id,direction,body,wa_message_id,status,created_at) VALUES (?,?,?,?,?,?,?)").run(req.uid, cl.id, 'out', text, id, 'sent', Date.now());
    res.json(db.prepare('SELECT id,direction,body,status,error,created_at FROM messages WHERE id=?').get(r.lastInsertRowid));
  } catch (e) {
    bad(res, `${e.message} (texto livre só é permitido até 24h após a última resposta do cliente)`, 502);
  }
}));

// Modelos de mensagem (devem existir e estar APROVADOS no gerenciador da Meta)
app.get('/templates', (req, res) => res.json(db.prepare('SELECT * FROM templates WHERE user_id=? ORDER BY id DESC').all(req.uid)));
app.post('/templates', (req, res) => {
  const { name, wa_name, language, body, style } = req.body || {};
  if (!name || !/^[a-z0-9_]{1,512}$/.test(wa_name || '')) return bad(res, 'Nome do modelo na Meta: apenas minúsculas, números e _');
  if (!body || body.length > 1024) return bad(res, 'Texto do modelo inválido (máx. 1024 caracteres)');
  const r = db.prepare('INSERT INTO templates(user_id,name,wa_name,language,body,style,created_at) VALUES (?,?,?,?,?,?,?)')
    .run(req.uid, String(name).slice(0, 80), wa_name, language || 'pt_BR', body, style || null, Date.now());
  res.json(db.prepare('SELECT * FROM templates WHERE id=?').get(r.lastInsertRowid));
});
app.delete('/templates/:id', (req, res) => {
  try { db.prepare('DELETE FROM templates WHERE id=? AND user_id=?').run(req.params.id, req.uid); res.json({ ok: true }); }
  catch { bad(res, 'Modelo em uso por uma campanha', 409); }
});

// Campanhas
const CAMPAIGN_SQL = `SELECT c.*, t.name template_name,
  (SELECT COUNT(*) FROM campaign_targets WHERE campaign_id=c.id) total,
  (SELECT COUNT(*) FROM campaign_targets WHERE campaign_id=c.id AND state='pending') pending,
  (SELECT COUNT(*) FROM campaign_targets WHERE campaign_id=c.id AND state='failed') failed,
  (SELECT COUNT(*) FROM messages WHERE campaign_id=c.id AND direction='out' AND status IN ('sent','delivered','read')) sent,
  (SELECT COUNT(*) FROM messages WHERE campaign_id=c.id AND direction='out' AND status IN ('delivered','read')) delivered,
  (SELECT COUNT(DISTINCT ct.client_id) FROM campaign_targets ct WHERE ct.campaign_id=c.id AND ct.state='sent'
     AND EXISTS (SELECT 1 FROM messages m WHERE m.client_id=ct.client_id AND m.direction='in')) replied
  FROM campaigns c JOIN templates t ON t.id=c.template_id WHERE c.user_id=?`;
app.get('/campaigns', (req, res) => res.json(db.prepare(CAMPAIGN_SQL + ' ORDER BY c.id DESC').all(req.uid)));
app.post('/campaigns', (req, res) => {
  const b = req.body || {};
  if (!b.name || !String(b.name).trim()) return bad(res, 'Dê um nome à campanha');
  if (!db.prepare('SELECT 1 FROM templates WHERE id=? AND user_id=?').get(b.template_id, req.uid)) return bad(res, 'Modelo inválido');
  const interval = Math.min(Math.max(parseInt(b.interval_seconds) || 60, 5), 3600);
  const limit = Math.min(Math.max(parseInt(b.daily_limit) || 200, 1), 100000);
  const ids = [...new Set((b.client_ids || []).map(Number))];
  const eligible = ids.filter((id) => { const c = getClient(req.uid, id); return c && c.consent && !c.opted_out; });
  if (!eligible.length) return bad(res, 'Nenhum cliente elegível (é preciso consentimento e não ter pedido saída)');
  let id;
  db.transaction(() => {
    id = db.prepare('INSERT INTO campaigns(user_id,name,template_id,scheduled_at,interval_seconds,daily_limit,created_at) VALUES (?,?,?,?,?,?,?)')
      .run(req.uid, String(b.name).trim().slice(0, 80), b.template_id, b.scheduled_at || null, interval, limit, Date.now()).lastInsertRowid;
    const ins = db.prepare('INSERT INTO campaign_targets(campaign_id,client_id) VALUES (?,?)');
    eligible.forEach((cid) => ins.run(id, cid));
  })();
  res.json(db.prepare(CAMPAIGN_SQL + ' AND c.id=?').get(req.uid, id));
});
app.post('/campaigns/:id/:action', (req, res) => {
  const c = db.prepare('SELECT * FROM campaigns WHERE id=? AND user_id=?').get(req.params.id, req.uid);
  if (!c) return bad(res, 'Campanha não encontrada', 404);
  const a = req.params.action;
  if (a === 'start') {
    if (!['draft', 'paused'].includes(c.status)) return bad(res, 'Campanha não pode ser iniciada neste estado', 409);
    if (!waCfg(req.uid)) return bad(res, 'Configure o WhatsApp antes de iniciar', 409);
    const st = c.scheduled_at && c.scheduled_at > Date.now() ? 'scheduled' : 'running';
    db.prepare('UPDATE campaigns SET status=?, last_error=NULL WHERE id=?').run(st, c.id);
    db.activity(req.uid, `Campanha "${c.name}" ${st === 'running' ? 'iniciada' : 'agendada'}`);
  } else if (a === 'pause') {
    if (!['running', 'scheduled'].includes(c.status)) return bad(res, 'Campanha não está ativa', 409);
    db.prepare("UPDATE campaigns SET status='paused' WHERE id=?").run(c.id);
  } else if (a === 'cancel') {
    if (['completed', 'cancelled'].includes(c.status)) return bad(res, 'Campanha já encerrada', 409);
    db.prepare("UPDATE campaigns SET status='cancelled' WHERE id=?").run(c.id);
    db.prepare("UPDATE campaign_targets SET state='skipped', error='Campanha cancelada' WHERE campaign_id=? AND state='pending'").run(c.id);
    db.activity(req.uid, `Campanha "${c.name}" cancelada`);
  } else return bad(res, 'Ação inválida');
  res.json(db.prepare(CAMPAIGN_SQL + ' AND c.id=?').get(req.uid, c.id));
});

// Configuracoes
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
app.get('/settings', (req, res) => {
  const u = db.prepare('SELECT business_name FROM users WHERE id=?').get(req.uid);
  const w = db.prepare('SELECT phone_number_id,waba_id,token_enc,last_error FROM wa_config WHERE user_id=?').get(req.uid) || {};
  res.json({
    business_name: u.business_name,
    only_in_hours: db.getSetting(req.uid, 'only_in_hours', '0') === '1',
    hours_start: db.getSetting(req.uid, 'hours_start', '09:00'),
    hours_end: db.getSetting(req.uid, 'hours_end', '18:00'),
    services: db.prepare('SELECT id,name,price FROM services WHERE user_id=? ORDER BY id').all(req.uid),
    // O token nunca e devolvido ao aplicativo.
    wa: { configured: !!(w.token_enc && w.phone_number_id), phone_number_id: w.phone_number_id || null, waba_id: w.waba_id || null, last_error: w.last_error || null },
  });
});
app.put('/settings', (req, res) => {
  const b = req.body || {};
  if (!String(b.business_name || '').trim()) return bad(res, 'Informe o nome comercial');
  if (!HHMM.test(b.hours_start) || !HHMM.test(b.hours_end) || b.hours_start >= b.hours_end) return bad(res, 'Horário inválido (use HH:MM e início antes do fim)');
  db.prepare('UPDATE users SET business_name=? WHERE id=?').run(String(b.business_name).trim().slice(0, 80), req.uid);
  db.setSetting(req.uid, 'only_in_hours', b.only_in_hours ? '1' : '0');
  db.setSetting(req.uid, 'hours_start', b.hours_start);
  db.setSetting(req.uid, 'hours_end', b.hours_end);
  res.json({ ok: true });
});
app.put('/settings/whatsapp', ah(async (req, res) => {
  const { phone_number_id, waba_id, access_token } = req.body || {};
  if (!/^\d{5,30}$/.test(phone_number_id || '')) return bad(res, 'ID do número de telefone inválido');
  const prev = db.prepare('SELECT token_enc FROM wa_config WHERE user_id=?').get(req.uid);
  const tokenEnc = access_token ? encrypt(String(access_token).trim()) : prev && prev.token_enc;
  if (!tokenEnc) return bad(res, 'Informe o token de acesso');
  db.prepare(`INSERT INTO wa_config(user_id,phone_number_id,waba_id,token_enc,connected_at,last_error) VALUES (?,?,?,?,?,NULL)
    ON CONFLICT(user_id) DO UPDATE SET phone_number_id=excluded.phone_number_id, waba_id=excluded.waba_id,
    token_enc=excluded.token_enc, connected_at=excluded.connected_at, last_error=NULL`)
    .run(req.uid, phone_number_id, waba_id || null, tokenEnc, Date.now());
  res.json({ ok: true });
}));
app.get('/whatsapp/status', ah(async (req, res) => {
  const cfg = waCfg(req.uid);
  if (!cfg) return res.json({ ok: false, error: 'WhatsApp não configurado' });
  try { res.json({ ok: true, ...(await wa.status(cfg)) }); }
  catch (e) {
    db.prepare('UPDATE wa_config SET last_error=? WHERE user_id=?').run(e.message, req.uid);
    res.json({ ok: false, error: e.message });
  }
}));
app.post('/services', (req, res) => {
  const { name, price } = req.body || {};
  if (!String(name || '').trim()) return bad(res, 'Informe o nome do serviço');
  const r = db.prepare('INSERT INTO services(user_id,name,price) VALUES (?,?,?)').run(req.uid, String(name).trim().slice(0, 80), Math.max(0, Number(price) || 0));
  res.json(db.prepare('SELECT id,name,price FROM services WHERE id=?').get(r.lastInsertRowid));
});
app.delete('/services/:id', (req, res) => { db.prepare('DELETE FROM services WHERE id=? AND user_id=?').run(req.params.id, req.uid); res.json({ ok: true }); });

// Relatorio CSV (clientes + resultado das campanhas)
app.get('/reports/export.csv', (req, res) => {
  const rows = [['Nome', 'Telefone', 'Empresa', 'Segmento', 'Status', 'Valor da venda', 'Consentimento', 'Não receber']];
  db.prepare('SELECT * FROM clients WHERE user_id=? ORDER BY name').all(req.uid)
    .forEach((c) => rows.push([c.name, c.phone, c.company, c.segment, c.status, c.sale_value, c.consent ? 'sim' : 'não', c.opted_out ? 'sim' : 'não']));
  rows.push([]); rows.push(['Campanha', 'Status', 'Total', 'Enviadas', 'Entregues', 'Respostas', 'Falhas']);
  db.prepare(CAMPAIGN_SQL + ' ORDER BY c.id').all(req.uid).forEach((c) => rows.push([c.name, c.status, c.total, c.sent, c.delivered, c.replied, c.failed]));
  res.type('text/csv').send('\uFEFF' + rows.map((r) => r.map(csvCell).join(',')).join('\n'));
});

app.use((_req, res) => bad(res, 'Rota não encontrada', 404));
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') return bad(res, 'JSON inválido');
  console.error(err);
  bad(res, 'Erro interno do servidor', 500);
});

app.listen(process.env.PORT || 3000, () => {
  console.log(`SiteSeller backend na porta ${process.env.PORT || 3000}`);
  scheduler.start();
});
