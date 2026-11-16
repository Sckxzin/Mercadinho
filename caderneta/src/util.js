const crypto = require('node:crypto');

const SECRET = process.env.APP_SECRET || 'troque-este-segredo-em-producao';

const brl = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

// Converte o que a pessoa digitou em centavos. Aceita "12,50", "12.50", "1.234,56",
// "1,234.56", "R$ 1.234", 12.5 ... Devolve NaN quando não dá para entender.
function toCents(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v * 100) : NaN;
  let s = String(v ?? '').trim().replace(/^R\$/i, '').replace(/\s/g, '');
  if (!/^-?\d[\d.,]*$/.test(s)) return NaN;
  const lc = s.lastIndexOf(','), lp = s.lastIndexOf('.');
  if (lc > -1 && lp > -1) {
    // tem os dois: o que aparece por último é o separador decimal
    const [dec, mil] = lc > lp ? [',', '.'] : ['.', ','];
    if (s.split(dec).length > 2) return NaN;
    s = s.split(mil).join('').replace(dec, '.');
  } else if (lc > -1) {
    s = /^-?\d{1,3}(,\d{3}){2,}$/.test(s) ? s.replace(/,/g, '') : s.split(',').length === 2 ? s.replace(',', '.') : NaN;
  } else if (lp > -1) {
    // só ponto: "1.234" / "1.234.567" são milhares; "12.50" é decimal
    s = /^-?\d{1,3}(\.\d{3})+$/.test(s) ? s.replace(/\./g, '') : s.split('.').length === 2 ? s : NaN;
  }
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) : NaN;
}
// valor monetário válido dentro de um intervalo (em centavos) ou null
const centavos = (v, { min = 1, max = 100_000_000 } = {}) => { const c = toCents(v); return Number.isSafeInteger(c) && c >= min && c <= max ? c : null; };

// ---------- datas no fuso do mercado (padrão: Brasília) ----------
// O banco guarda tudo em UTC ("YYYY-MM-DD HH:MM:SS"); "hoje" e "este mês" seguem o fuso local.
const TZ = process.env.APP_TZ || 'America/Sao_Paulo';
const fmtDia = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const fmtHora = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const hojeISO = (d = new Date()) => fmtDia.format(d);
const addDias = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const diasEntre = (de, ate) => Math.round((Date.parse(ate + 'T00:00:00Z') - Date.parse(de + 'T00:00:00Z')) / 864e5);
// diferença (ms) entre o relógio local e o UTC num instante
function offsetMs(d) {
  const p = Object.fromEntries(fmtHora.formatToParts(d).map((x) => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(d.getTime() / 1000) * 1000;
}
// meia-noite local de um dia (YYYY-MM-DD) expressa como texto UTC, no formato do banco
function inicioDiaUTC(iso) {
  const guess = new Date(iso + 'T00:00:00Z');
  return new Date(guess.getTime() - offsetMs(guess)).toISOString().replace('T', ' ').slice(0, 19);
}
const inicioMesUTC = (d = new Date()) => inicioDiaUTC(hojeISO(d).slice(0, 8) + '01');
const agoraUTC = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const dataValida = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

// Token longo e imprevisível para o link do cliente (192 bits)
const novoToken = () => crypto.randomBytes(24).toString('base64url');

function hashSenha(senha) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(senha, salt, 32).toString('hex');
  return `${salt}:${h}`;
}
function confereSenha(senha, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, h] = stored.split(':');
  const calc = crypto.scryptSync(senha, salt, 32);
  const real = Buffer.from(h, 'hex');
  return real.length === calc.length && crypto.timingSafeEqual(real, calc);
}

// Token de sessão assinado (HMAC)
function assina(payload, ttlSeg = 60 * 60 * 24 * 7) {
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + ttlSeg })).toString('base64url');
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}
function verifica(token) {
  if (typeof token !== 'string' || token.split('.').length !== 2) return null;
  const [body, sig] = token.split('.');
  const esperado = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig), b = Buffer.from(esperado);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    return p && p.exp > Date.now() / 1000 ? p : null;
  } catch {
    return null;
  }
}

// Rate limit simples em memória (por chave). Uma faxina periódica apaga as chaves velhas,
// senão o mapa cresceria para sempre.
const hits = new Map();
const JANELA_MAX = 60 * 60_000;
function limite(chave, max, janelaMs) {
  const agora = Date.now();
  const arr = (hits.get(chave) || []).filter((t) => agora - t < janelaMs);
  arr.push(agora);
  hits.set(chave, arr);
  return arr.length <= max;
}
function faxinaLimites(agora = Date.now()) {
  for (const [k, arr] of hits) {
    const vivos = arr.filter((t) => agora - t < JANELA_MAX);
    if (vivos.length) hits.set(k, vivos); else hits.delete(k);
  }
  return hits.size;
}
setInterval(faxinaLimites, 5 * 60_000).unref();

const soDigitos = (s) => String(s || '').replace(/\D/g, '');
// telefone sem máscara e sem o 55 do país: "(81) 98888-7777" e "+55 81 98888-7777" -> "81988887777"
const normTel = (t) => { const d = soDigitos(t); return d.startsWith('55') && d.length > 11 ? d.slice(2) : d; };

// Pix "copia e cola" estático (BR Code / EMV) com valor preenchido
const semAcento = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 ]/g, '').trim();
function crc16(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}
function pixPayload({ chave, nome, cidade, centavos: c, txid = '***' }) {
  const f = (id, v) => id + String(v.length).padStart(2, '0') + v;
  const conta = f('00', 'br.gov.bcb.pix') + f('01', chave);
  let p = f('00', '01') + f('26', conta) + f('52', '0000') + f('53', '986');
  if (c > 0) p += f('54', (c / 100).toFixed(2));
  p += f('58', 'BR') + f('59', semAcento(nome).toUpperCase().slice(0, 25) || 'MERCADO')
    + f('60', semAcento(cidade).toUpperCase().slice(0, 15) || 'BRASIL')
    + f('62', f('05', semAcento(txid).replace(/ /g, '').slice(0, 25) || '***')) + '6304';
  return p + crc16(p);
}

const slugify = (nome) => (semAcento(nome).toLowerCase().replace(/\s+/g, '-').slice(0, 30) || 'mercado') + '-' + crypto.randomBytes(2).toString('hex');
const sha = (t) => crypto.createHash('sha256').update(String(t) + SECRET).digest('hex');

// id numérico seguro vindo da URL (0 = inválido -> "não encontrado" em vez de erro 500)
const intId = (v) => { const n = Number(v); return Number.isSafeInteger(n) && n > 0 && n < 2 ** 31 ? n : 0; };
const texto = (v, max) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim().slice(0, max));

// CSV compatível com Excel em português (separador ";" e BOM para acentos)
function csv(linhas, colunas) {
  // texto que começa com = + @ (ou - sem número) vira fórmula no Excel: neutraliza com apóstrofo
  const formula = /^[=+@\t\r]|^-(?![\d,.]+$)/;
  const cel = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[";\n\r]/.test(s) || formula.test(s) ? `"${(formula.test(s) ? "'" : '') + s.replace(/"/g, '""')}"` : s; };
  return '﻿' + [colunas.map((c) => c[1]).join(';'), ...linhas.map((l) => colunas.map((c) => cel(typeof c[0] === 'function' ? c[0](l) : l[c[0]])).join(';'))].join('\r\n');
}
const reaisCsv = (c) => (c / 100).toFixed(2).replace('.', ',');

// Express 4 não captura erro de handler async: este wrapper manda o erro para o handler global
function asyncRouter(target) {
  for (const m of ['get', 'post', 'patch', 'put', 'delete']) {
    const orig = target[m].bind(target);
    target[m] = (p, ...hs) => (hs.length === 0 ? orig(p) : orig(p, ...hs.map((h) => (h.length >= 4 ? h : (req, res, next) => Promise.resolve(h(req, res, next)).catch(next)))));
  }
  return target;
}

module.exports = {
  intId, texto, asyncRouter, slugify, sha, pixPayload, crc16, brl, toCents, centavos, novoToken, hashSenha, confereSenha,
  assina, verifica, limite, faxinaLimites, soDigitos, normTel, csv, reaisCsv,
  TZ, hojeISO, addDias, diasEntre, inicioDiaUTC, inicioMesUTC, agoraUTC, dataValida,
};
