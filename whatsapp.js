// Cliente da WhatsApp Business Platform (Cloud API oficial da Meta).
const GRAPH = () => `https://graph.facebook.com/${process.env.GRAPH_VERSION || 'v21.0'}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(cfg, path, { method = 'POST', body } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`${GRAPH()}/${path}`, {
        method,
        headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(15000),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return data;
      const er = data.error || {};
      const err = new Error(er.error_user_msg || er.message || `Erro HTTP ${res.status}`);
      err.status = res.status;
      err.code = er.code;
      err.fatal = res.status === 401 || er.code === 190; // token invalido/expirado
      if (res.status === 429 || res.status >= 500) { lastErr = err; await sleep(1000 * 2 ** attempt); continue; }
      throw err;
    } catch (e) {
      if (e.status) throw e;
      lastErr = e; // falha de rede: tenta de novo (reconexao)
      await sleep(1000 * 2 ** attempt);
    }
  }
  throw lastErr;
}

const placeholders = (body) => (body.match(/\{\{\d+\}\}/g) || []).length;
const render = (body, vars) => body.replace(/\{\{(\d+)\}\}/g, (_, n) => vars[Number(n) - 1] ?? '');

// Envia mensagem de MODELO aprovado pela Meta. vars[0] = nome, vars[1] = empresa.
async function sendTemplate(cfg, to, tpl, vars) {
  const n = placeholders(tpl.body);
  const template = { name: tpl.wa_name, language: { code: tpl.language } };
  if (n > 0) {
    template.components = [{ type: 'body', parameters: vars.slice(0, n).map((t) => ({ type: 'text', text: String(t || '-') })) }];
  }
  const r = await call(cfg, `${cfg.phone_number_id}/messages`, {
    body: { messaging_product: 'whatsapp', to, type: 'template', template },
  });
  return r.messages && r.messages[0] && r.messages[0].id;
}
// Texto livre: so funciona dentro da janela de 24h apos o cliente responder.
async function sendText(cfg, to, text) {
  const r = await call(cfg, `${cfg.phone_number_id}/messages`, {
    body: { messaging_product: 'whatsapp', to, type: 'text', text: { body: text } },
  });
  return r.messages && r.messages[0] && r.messages[0].id;
}
const status = (cfg) =>
  call(cfg, `${cfg.phone_number_id}?fields=display_phone_number,verified_name,quality_rating`, { method: 'GET' });

module.exports = { sendTemplate, sendText, status, render };
