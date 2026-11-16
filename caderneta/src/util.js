const crypto = require('node:crypto');

const SECRET = process.env.APP_SECRET || 'troque-este-segredo-em-producao';

const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const toCents = (v) => Math.round(Number(String(v).replace(',', '.')) * 100);

// Token longo e imprevisível para o link do cliente (192 bits)
const novoToken = () => crypto.randomBytes(24).toString('base64url');

function hashSenha(senha) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(senha, salt, 32).toString('hex');
  return `${salt}:${h}`;
}
function confereSenha(senha, stored) {
  const [salt, h] = stored.split(':');
  const calc = crypto.scryptSync(senha, salt, 32);
  const real = Buffer.from(h, 'hex');
  return real.length === calc.length && crypto.timingSafeEqual(real, calc);
}

// Token de sessão assinado (HMAC) — simples; troque por JWT se quiser
function assina(payload, ttlSeg = 60 * 60 * 24 * 7) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeg })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifica(token) {
  if (!token || !token.includes('.')) return null;
  const [body, sig] = token.split('.');
  const esperado = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(esperado);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const p = JSON.parse(Buffer.from(body, 'base64url').toString());
  return p.exp > Date.now() / 1000 ? p : null;
}

// Rate limit simples em memória (por chave)
const hits = new Map();
function limite(chave, max, janelaMs) {
  const agora = Date.now();
  const arr = (hits.get(chave) || []).filter((t) => agora - t < janelaMs);
  arr.push(agora);
  hits.set(chave, arr);
  return arr.length <= max;
}

const soDigitos = (s) => String(s || '').replace(/\D/g, '');

// Pix "copia e cola" estático (BR Code / EMV) com valor preenchido
const semAcento = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9 ]/g, '').trim();
function crc16(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
function pixPayload({ chave, nome, cidade, centavos, txid = '***' }) {
  const f = (id, v) => id + String(v.length).padStart(2, '0') + v;
  const conta = f('00', 'br.gov.bcb.pix') + f('01', chave);
  let p = f('00', '01') + f('26', conta) + f('52', '0000') + f('53', '986');
  if (centavos > 0) p += f('54', (centavos / 100).toFixed(2));
  p += f('58', 'BR') + f('59', semAcento(nome).toUpperCase().slice(0, 25) || 'MERCADO')
    + f('60', semAcento(cidade).toUpperCase().slice(0, 15) || 'BRASIL')
    + f('62', f('05', semAcento(txid).slice(0, 25) || '***')) + '6304';
  return p + crc16(p);
}

const slugify = (nome) => (semAcento(nome).toLowerCase().replace(/\s+/g, '-').slice(0, 30) || 'mercado') + '-' + crypto.randomBytes(2).toString('hex');
const sha = (t) => crypto.createHash('sha256').update(String(t) + SECRET).digest('hex');

// id numérico seguro vindo da URL (0 = inválido -> "não encontrado" em vez de erro 500)
const intId = (v) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 && n < 2 ** 31 ? n : 0; };

// Express 4 não captura erro de handler async: este wrapper manda o erro para o handler global
function asyncRouter(target) {
  for (const m of ['get', 'post', 'patch', 'put', 'delete']) {
    const orig = target[m].bind(target);
    target[m] = (p, ...hs) => (hs.length === 0 ? orig(p) : orig(p, ...hs.map((h) => (h.length >= 4 ? h : (req, res, next) => Promise.resolve(h(req, res, next)).catch(next)))));
  }
  return target;
}

module.exports = { intId, asyncRouter, slugify, sha, pixPayload, crc16, brl, toCents, novoToken, hashSenha, confereSenha, assina, verifica, limite, soDigitos };
