const express = require('express');
const path = require('node:path');
const { open } = require('./db');
const U = require('./util');

// Content-Security-Policy: só carrega scripts/estilos do próprio app (e a fonte do Google),
// impede que o painel seja embutido em outro site e bloqueia envio de dados para fora.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

function createApp(db) {
  const app = U.asyncRouter(express());
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // atrás do proxy do Railway: IP real do cliente + https correto
  app.use(express.json({ limit: '100kb' }));
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow',
      'X-Frame-Options': 'DENY', 'Content-Security-Policy': CSP, 'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()',
      ...(req.secure ? { 'Strict-Transport-Security': 'max-age=15552000' } : {}),
    });
    next();
  });

  app.get('/health', async (req, res) => { await db.get('SELECT 1 AS ok'); res.json({ ok: true }); });

  const baseUrl = (req) => (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const saldoDe = async (clienteId, t = db) => (await t.get('SELECT COALESCE(SUM(valor),0) AS s FROM lancamentos WHERE cliente_id=?', [clienteId])).s;
  const porToken = async (token) => {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
    return db.get('SELECT c.*, m.nome AS mercado_nome, m.slug AS mercado_slug, m.pix_chave, m.whatsapp AS mercado_whatsapp, m.mostrar_itens FROM clientes c JOIN mercados m ON m.id=c.mercado_id WHERE c.token=? AND c.ativo=1 AND m.ativo=1', [token]);
  };
  // registro de auditoria (quem fez o quê). Nunca derruba a operação principal.
  const audita = async (req, acao, detalhe = null, t = db) => {
    try {
      await t.run('INSERT INTO auditoria (mercado_id,usuario_id,acao,detalhe) VALUES (?,?,?,?)', [req.mid, req.uid || null, acao, detalhe ? String(detalhe).slice(0, 500) : null]);
    } catch (e) {
      if (t !== db) throw e; // dentro de transação, o erro precisa abortar tudo
      console.error('auditoria:', e.message);
    }
  };

  const api = U.asyncRouter(express.Router());
  const ctx = { app, api, db, baseUrl, saldoDe, porToken, audita };

  // ordem importa: conta registra /api/registro e /api/login (públicos) e o middleware de auth do router
  const { soDono } = require('./rotas/conta')(ctx);
  ctx.soDono = soDono;

  api.get('/mercado', async (req, res) => {
    res.json(await db.get('SELECT id,nome,email,pix_chave,whatsapp,mostrar_itens,cidade,slug FROM mercados WHERE id=?', [req.mid]));
  });
  api.patch('/mercado', soDono, async (req, res) => {
    const { nome, pix_chave, whatsapp, mostrar_itens, cidade } = req.body || {};
    if (nome !== undefined && !U.texto(nome, 80)) return res.status(400).json({ erro: 'O nome do mercado não pode ficar vazio.' });
    const cur = await db.get('SELECT * FROM mercados WHERE id=?', [req.mid]);
    const v = (x, atual, max) => (x === undefined ? atual : U.texto(x, max));
    await db.run('UPDATE mercados SET nome=?,pix_chave=?,whatsapp=?,mostrar_itens=?,cidade=? WHERE id=?', [
      v(nome, cur.nome, 80), v(pix_chave, cur.pix_chave, 120), v(whatsapp, cur.whatsapp, 30),
      mostrar_itens === undefined ? cur.mostrar_itens : mostrar_itens ? 1 : 0, v(cidade, cur.cidade, 60), req.mid]);
    if ((pix_chave !== undefined && U.texto(pix_chave, 120) !== cur.pix_chave)) await audita(req, 'mercado.pix_alterado', U.texto(pix_chave, 120) || '(removida)');
    res.json({ ok: true });
  });

  require('./rotas/admin')(ctx); // antes de montar /api (que exige login de mercado)
  require('./rotas/clientes')(ctx);
  require('./rotas/estoque')(ctx);
  require('./rotas/relatorios')(ctx);
  require('./rotas/publico')(ctx);
  require('./rotas/loja')(ctx);
  require('./rotas/portal')(ctx);
  app.use('/api', api);

  const PUB = path.join(__dirname, '..', 'public');
  app.get('/c/:token', (req, res) => res.set('Cache-Control', 'no-store').sendFile(path.join(PUB, 'cliente.html')));
  app.get('/painel', (req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(PUB, 'painel.html')));
  app.get('/admin', (req, res) => res.set('Cache-Control', 'no-cache').sendFile(path.join(PUB, 'admin.html')));
  app.get('/', (req, res) => res.redirect('/painel'));

  // 404 de API e erros
  app.use('/api', (req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ erro: 'Arquivo grande demais.' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ erro: 'Requisição inválida.' });
    console.error('Erro:', err);
    if (res.headersSent) return;
    res.status(500).json({ erro: 'Erro interno. Tente novamente.' });
  });

  return app;
}

async function main() {
  if (process.env.DATABASE_URL && (!process.env.APP_SECRET || process.env.APP_SECRET.length < 24))
    throw new Error('Defina APP_SECRET (mínimo 24 caracteres aleatórios) nas variáveis do Railway antes de subir em produção.');
  const db = await open();
  await require('./rotas/admin').adminInicial(db);
  if (!(await db.get('SELECT 1 AS x FROM admins LIMIT 1'))) console.log('Nenhum admin ainda. Crie com: npm run criar-admin -- seu@email.com SenhaForte123 (ou defina ADMIN_EMAIL e ADMIN_SENHA).');
  const port = process.env.PORT || 3000;
  const server = createApp(db).listen(port, '0.0.0.0', () => console.log(`Caderneta rodando na porta ${port} (${process.env.DATABASE_URL ? 'Postgres' : 'banco local embutido'}, fuso ${U.TZ})`));
  const parar = () => server.close(() => db.close().finally(() => process.exit(0)));
  process.on('SIGTERM', parar); process.on('SIGINT', parar);
}

if (require.main === module) main().catch((e) => { console.error('Falha ao iniciar:', e); process.exit(1); });

module.exports = { createApp, hojeISO: U.hojeISO, addDias: U.addDias };
