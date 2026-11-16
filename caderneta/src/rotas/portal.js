// Portal do cliente: endereço fixo por mercado (/m/<slug>), primeiro acesso com código
// gerado pelo dono, login por telefone + PIN, e app instalável (PWA).
const path = require('node:path');
const express = require('express');
const U = require('../util');

const PUB = path.join(__dirname, '..', 'public');
const { normTel } = U;
const MSG_FALHA = 'Telefone ou PIN inválido. Se for seu primeiro acesso, peça o código ao mercado.';

module.exports = function registraApp({ app, api, db, baseUrl, audita }) {
  const mercadoPorSlug = async (slug) => (/^[a-z0-9-]{3,50}$/.test(slug) ? db.get('SELECT id,nome,slug,whatsapp FROM mercados WHERE slug=?', [slug]) : null);
  const acharCliente = async (mercadoId, telefone) => {
    const t = normTel(telefone);
    if (t.length < 10) return null;
    // se (por dados antigos) houver dois clientes ativos com o mesmo telefone, ninguém entra:
    // é melhor pedir ajuda ao mercado do que abrir a conta da pessoa errada.
    const cs = await db.all('SELECT * FROM clientes WHERE mercado_id=? AND ativo=1 AND telefone_norm=? LIMIT 2', [mercadoId, t]);
    return cs.length === 1 ? cs[0] : null;
  };
  // limita tentativas por IP e por telefone (evita adivinhar PIN/código)
  const tentativa = (req, slug, tel) => U.limite('app-ip:' + req.ip, 30, 15 * 60_000) && U.limite(`app:${slug}:${normTel(tel)}`, 8, 15 * 60_000);

  // ----- DONO: gerar código de primeiro acesso / redefinir PIN -----
  api.post('/clientes/:id/codigo-acesso', async (req, res) => {
    const c = await db.get('SELECT * FROM clientes WHERE id=? AND mercado_id=?', [U.intId(req.params.id), req.mid]);
    if (!c) return res.status(404).json({ erro: 'Cliente não encontrado.' });
    if (!c.telefone || normTel(c.telefone).length < 10) return res.status(400).json({ erro: 'Cadastre o telefone (com DDD) do cliente antes.' });
    const codigo = String(require('node:crypto').randomInt(0, 1_000_000)).padStart(6, '0');
    const expira = new Date(Date.now() + 7 * 864e5).toISOString();
    await db.run('UPDATE clientes SET codigo_hash=?, codigo_expira=? WHERE id=?', [U.sha(`${c.id}:${codigo}`), expira, c.id]);
    await audita(req, 'cliente.convite_app', `#${c.id} ${c.nome}`);
    const m = await db.get('SELECT nome,slug FROM mercados WHERE id=?', [req.mid]);
    const url = `${baseUrl(req)}/m/${m.slug}`;
    const texto = `Olá, ${c.nome.split(' ')[0]}! O ${m.nome} agora tem app: veja sua conta, promoções e pague por Pix. Acesse ${url} e no primeiro acesso use seu telefone e o código ${codigo} (vale 7 dias).`;
    res.json({ codigo, expira_em: expira, url_app: url, texto, link_wa: require('../whatsapp').linkWa(c.telefone, texto) });
  });

  api.get('/mercado/qr', async (req, res) => {
    const m = await db.get('SELECT slug FROM mercados WHERE id=?', [req.mid]);
    const svg = await require('qrcode').toString(`${baseUrl(req)}/m/${m.slug}`, { type: 'svg', margin: 2, width: 320 });
    res.type('image/svg+xml').send(svg);
  });

  // ----- CLIENTE (público) -----
  app.get('/api/app/:slug', async (req, res) => {
    if (!U.limite('app-info:' + req.ip, 120, 60_000)) return res.status(429).json({ erro: 'Muitas requisições.' });
    const m = await mercadoPorSlug(req.params.slug);
    if (!m) return res.status(404).json({ erro: 'Mercado não encontrado.' });
    const hoje = U.hojeISO();
    const promocoes = await db.all(`SELECT id,titulo,descricao,preco,preco_original,validade FROM promocoes
      WHERE mercado_id=? AND ativo=1 AND (validade IS NULL OR validade >= ?) ORDER BY id DESC LIMIT 30`, [m.id, hoje]);
    res.set('Cache-Control', 'no-store').json({ mercado: m.nome, whatsapp: m.whatsapp, promocoes });
  });

  app.post('/api/app/:slug/ativar', async (req, res) => {
    const m = await mercadoPorSlug(req.params.slug);
    const { telefone, codigo, pin } = req.body || {};
    if (!m || !tentativa(req, req.params.slug, telefone)) return res.status(m ? 429 : 404).json({ erro: m ? 'Muitas tentativas. Aguarde alguns minutos.' : 'Mercado não encontrado.' });
    if (!/^\d{4,6}$/.test(String(pin || ''))) return res.status(400).json({ erro: 'O PIN deve ter de 4 a 6 números.' });
    const c = await acharCliente(m.id, telefone);
    const ok = c && c.codigo_hash && c.codigo_expira > new Date().toISOString() && c.codigo_hash === U.sha(`${c.id}:${String(codigo || '').trim()}`);
    if (!ok) return res.status(401).json({ erro: 'Telefone ou código inválido ou expirado. Peça um código novo ao mercado.' });
    await db.run("UPDATE clientes SET pin_hash=?, codigo_hash=NULL, codigo_expira=NULL, ativado_em=to_char(now() at time zone 'utc','YYYY-MM-DD HH24:MI:SS'), aceitou_em=COALESCE(aceitou_em, to_char(now() at time zone 'utc','YYYY-MM-DD HH24:MI:SS')) WHERE id=?", [U.hashSenha(String(pin)), c.id]);
    res.json({ token: c.token });
  });

  app.post('/api/app/:slug/entrar', async (req, res) => {
    const m = await mercadoPorSlug(req.params.slug);
    const { telefone, pin } = req.body || {};
    if (!m || !tentativa(req, req.params.slug, telefone)) return res.status(m ? 429 : 404).json({ erro: m ? 'Muitas tentativas. Aguarde alguns minutos.' : 'Mercado não encontrado.' });
    const c = await acharCliente(m.id, telefone);
    if (!c || !c.pin_hash || !U.confereSenha(String(pin || ''), c.pin_hash)) return res.status(401).json({ erro: MSG_FALHA });
    res.json({ token: c.token });
  });

  // ----- páginas / PWA -----
  app.get('/m/:slug', (req, res) => res.set('Cache-Control', 'no-store').sendFile(path.join(PUB, 'app.html')));
  app.get('/m/:slug/manifest.webmanifest', async (req, res) => {
    const m = await mercadoPorSlug(req.params.slug);
    if (!m) return res.status(404).end();
    res.type('application/manifest+json').json({
      name: m.nome, short_name: m.nome.slice(0, 12), id: `/m/${m.slug}`, start_url: `/m/${m.slug}`, scope: '/', display: 'standalone',
      background_color: '#0b1220', theme_color: '#0b1220',
      icons: [{ src: '/assets/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/assets/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }],
    });
  });
  app.get('/sw.js', (req, res) => res.type('application/javascript').set('Cache-Control', 'no-store')
    .send("self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(clients.claim()));self.addEventListener('fetch',()=>{});"));
  app.use('/assets', express.static(path.join(PUB, 'assets'), { maxAge: '7d' }));
};
