// Criptografia AES-256-GCM para guardar o token do WhatsApp no banco.
const crypto = require('crypto');
function key() {
  const k = process.env.ENC_KEY || '';
  if (!/^[0-9a-f]{64}$/i.test(k)) throw new Error('ENC_KEY deve ter 64 caracteres hexadecimais');
  return Buffer.from(k, 'hex');
}
function encrypt(text) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
}
function decrypt(b64) {
  const b = Buffer.from(b64, 'base64');
  const d = crypto.createDecipheriv('aes-256-gcm', key(), b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
}
module.exports = { encrypt, decrypt };
