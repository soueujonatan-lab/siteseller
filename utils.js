const STATUSES = ['Novo contato', 'Aguardando resposta', 'Interessado', 'Negociação', 'Venda concluída', 'Não interessado'];

// Normaliza telefone para o formato da API (somente digitos, com DDI).
// Numeros com 10 ou 11 digitos sem "+" sao tratados como brasileiros (prefixo 55).
function normPhone(p) {
  const raw = String(p || '').trim();
  let d = raw.replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (!raw.startsWith('+') && (d.length === 10 || d.length === 11)) d = '55' + d;
  return d;
}
// A Meta as vezes devolve numeros BR sem o nono digito; testamos as duas formas.
function phoneVariants(p) {
  const d = normPhone(p);
  const v = new Set([d]);
  if (d.startsWith('55')) {
    if (d.length === 13) v.add(d.slice(0, 4) + d.slice(5));
    if (d.length === 12) v.add(d.slice(0, 4) + '9' + d.slice(4));
  }
  return [...v];
}
const validPhone = (d) => /^\d{10,15}$/.test(d);

function isOptOut(text) {
  const t = String(text || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  return /^\s*(parar|pare|sair|stop|cancelar|remover|descadastrar|unsubscribe)\b/.test(t) ||
    /nao quero (mais )?(receber|mensagens?)/.test(t) ||
    /nao (me )?(envie|mande)/.test(t) || /(me )?(tire|remova)/.test(t);
}
// Evita injecao de formulas ao abrir CSV no Excel.
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return '"' + s.replace(/"/g, '""') + '"';
}
module.exports = { STATUSES, normPhone, phoneVariants, validPhone, isOptOut, csvCell };
