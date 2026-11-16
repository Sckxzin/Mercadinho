const express = require('express');
const path = require('node:path');
const { open } = require('./db');
const U = require('./util');
const wa = require('./whatsapp');
const registraLoja = require('./loja');
const registraApp = require('./portal');

const hojeISO = () => new Date().toISOString().slice(0, 10);
const addDias = (iso, n) => {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

function createApp(db) {
  const app = U.asyncRouter(express());
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // atrás do proxy do Railway: IP real do cliente + https correto
  app.use(express.json({ limit: '100kb' }));
  app.use((req, res, next) => {
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex, nofollow' });
    next();
  });

  app.get('/health', async (req, res) => { await db.get('SELECT 1 AS ok'); res.json({ ok: true }); });

  const baseUrl = (req) => (process.env.BASE_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');
  const saldoDe = async (clienteId) => (await db.get('SELECT COALESCE(SUM(valor),0) AS s FROM lancamentos WHERE cliente_id=?', [clienteId])).s;

  // ---------- AUTH (dono do mercado) ----------
  app.post('/api/registro', async (req, res) => {
    const { nome, email, senha, pix_chave, whatsapp } = req.body || {};
    if (!nome || !email || !senha || senha.length < 8) return res.status(400).json({ erro: 'Informe nome, email e senha (mín. 8 caracteres).' });
    if (process.env.REGISTRO_ABERTO === 'false') return res.status(403).json({ erro: 'Cadastro de novos mercados está fechado.' });
    if (!U.limite('reg:' + req.ip, 10, 60 * 60_000)) return res.status(429).json({ erro: 'Muitos cadastros. Tente mais tarde.' });
    try {
      const r = await db.run('INSERT INTO mercados (nome,email,senha_hash,pix_chave,whatsapp,slug) VALUES (?,?,?,?,?,?)',
        [String(nome).slice(0, 80), String(email).toLowerCase(), U.hashSenha(senha), pix_chave || null, whatsapp || null, U.slugify(nome)]);
      res.status(201).json({ token: U.assina({ m: r.id }), mercado_id: r.id });
    } catch (e) {
      if (e.code === '23505' || /unique|duplicate/i.test(e.message)) return res.status(409).json({ erro: 'Email já cadastrado.' });
      throw e;
    }
  });

  app.post('/api/login', async (req, res) => {
    const { email, senha } = req.body || {};
    if (!U.limite('login:' + req.ip, 10, 60_000)) return res.status(429).json({ erro: 'Muitas tentativas. Aguarde um minuto.' });
    const m = await db.get('SELECT * FROM mercados WHERE email=?', [String(email || '').toLowerCase()]);
    if (!m || !U.confereSenha(String(senha || ''), m.senha_hash)) return res.status(401).json({ erro: 'Email ou senha inválidos.' });
    res.json({ token: U.assina({ m: m.id }), mercado: { id: m.id, nome: m.nome } });
  });

  const auth = (req, res, next) => {
    const p = U.verifica((req.get('authorization') || '').replace(/^Bearer /, ''));
    if (!p) return res.status(401).json({ erro: 'Não autenticado.' });
    req.mid = p.m;
    next();
  };
  const api = U.asyncRouter(express.Router());
  api.use(auth);

  api.get('/mercado', async (req, res) => {
    res.json(await db.get('SELECT id,nome,email,pix_chave,whatsapp,mostrar_itens,cidade,slug FROM mercados WHERE id=?', [req.mid]));
  });
  api.patch('/mercado', async (req, res) => {
    const { nome, pix_chave, whatsapp, mostrar_itens, cidade } = req.body || {};
    const cur = await db.get('SELECT * FROM mercados WHERE id=?', [req.mid]);
    await db.run('UPDATE mercados SET nome=?,pix_chave=?,whatsapp=?,mostrar_itens=?,cidade=? WHERE id=?', [
      nome ?? cur.nome, pix_chave ?? cur.pix_chave, whatsapp ?? cur.whatsapp,
      mostrar_itens === undefined ? cur.mostrar_itens : mostrar_itens ? 1 : 0, cidade ?? cur.cidade, req.mid]);
    res.json({ ok: true });
  });

  // ---------- CLIENTES ----------
  api.get('/clientes', async (req, res) => {
    const rows = await db.all(`
      SELECT c.id,c.nome,c.telefone,c.limite,c.token,c.ativo,c.ativado_em,
             COALESCE(SUM(l.valor),0) AS saldo,
             MAX(CASE WHEN l.tipo='pagamento' THEN l.criado_em END) AS ultimo_pagamento,
             MAX(CASE WHEN l.tipo='compra' THEN l.criado_em END) AS ultima_compra
      FROM clientes c LEFT JOIN lancamentos l ON l.cliente_id=c.id
      WHERE c.mercado_id=? AND c.ativo=1 GROUP BY c.id ORDER BY saldo DESC, c.nome`, [req.mid]);
    res.json(rows.map((r) => ({ ...r, url: `${baseUrl(req)}/c/${r.token}` })));
  });

  api.post('/clientes', async (req, res) => {
    const { nome, telefone, limite, aceitou } = req.body || {};
    if (!nome) return res.status(400).json({ erro: 'Nome obrigatório.' });
    const r = await db.run('INSERT INTO clientes (mercado_id,nome,telefone,limite,token,aceitou_em) VALUES (?,?,?,?,?,?)',
      [req.mid, String(nome).slice(0, 80), telefone || null, limite ? U.toCents(limite) : 0, U.novoToken(), aceitou ? new Date().toISOString() : null]);
    const c = await db.get('SELECT * FROM clientes WHERE id=?', [r.id]);
    res.status(201).json({ ...c, url: `${baseUrl(req)}/c/${c.token}` });
  });

  const meuCliente = async (req, res) => {
    const c = await db.get('SELECT * FROM clientes WHERE id=? AND mercado_id=?', [U.intId(req.params.id), req.mid]);
    if (!c) res.status(404).json({ erro: 'Cliente não encontrado.' });
    return c;
  };

  api.patch('/clientes/:id', async (req, res) => {
    const c = await meuCliente(req, res); if (!c) return;
    const { nome, telefone, limite, ativo } = req.body || {};
    await db.run('UPDATE clientes SET nome=?,telefone=?,limite=?,ativo=? WHERE id=?', [
      nome ?? c.nome, telefone ?? c.telefone, limite === undefined ? c.limite : U.toCents(limite),
      ativo === undefined ? c.ativo : ativo ? 1 : 0, c.id]);
    res.json({ ok: true });
  });

  api.post('/clientes/:id/novo-link', async (req, res) => {
    const c = await meuCliente(req, res); if (!c) return;
    const t = U.novoToken();
    await db.run('UPDATE clientes SET token=? WHERE id=?', [t, c.id]);
    res.json({ url: `${baseUrl(req)}/c/${t}` });
  });

  api.get('/clientes/:id/extrato', async (req, res) => {
    const c = await meuCliente(req, res); if (!c) return;
    const lanc = await db.all('SELECT id,tipo,valor,descricao,forma,contestado,criado_em FROM lancamentos WHERE cliente_id=? ORDER BY id DESC', [c.id]);
    res.json({ cliente: { id: c.id, nome: c.nome, telefone: c.telefone, limite: c.limite, ativado_em: c.ativado_em, url: `${baseUrl(req)}/c/${c.token}` }, saldo: await saldoDe(c.id), lancamentos: lanc });
  });

  // ---------- LANÇAMENTOS ----------
  api.post('/clientes/:id/compras', async (req, res) => {
    const c = await meuCliente(req, res); if (!c) return;
    const { valor, descricao, forcar } = req.body || {};
    const v = U.toCents(valor);
    if (!(v > 0) || v > 100_000_000) return res.status(400).json({ erro: 'Valor inválido.' });
    const novoSaldo = (await saldoDe(c.id)) + v;
    if (c.limite > 0 && novoSaldo > c.limite && !forcar)
      return res.status(409).json({ erro: `Passa do limite de ${U.brl(c.limite)} (ficaria ${U.brl(novoSaldo)}).`, codigo: 'LIMITE', novo_saldo: novoSaldo });
    const r = await db.run("INSERT INTO lancamentos (mercado_id,cliente_id,tipo,valor,descricao) VALUES (?,?,'compra',?,?)", [req.mid, c.id, v, descricao ? String(descricao).slice(0, 300) : null]);
    res.status(201).json({ id: r.id, saldo: novoSaldo });
  });

  api.post('/clientes/:id/pagamentos', async (req, res) => {
    const c = await meuCliente(req, res); if (!c) return;
    const { valor, forma, descricao } = req.body || {};
    const v = U.toCents(valor);
    if (!(v > 0) || v > 100_000_000) return res.status(400).json({ erro: 'Valor inválido.' });
    const r = await db.run("INSERT INTO lancamentos (mercado_id,cliente_id,tipo,valor,forma,descricao) VALUES (?,?,'pagamento',?,?,?)", [req.mid, c.id, -v, forma || null, descricao || null]);
    res.status(201).json({ id: r.id, saldo: await saldoDe(c.id) });
  });

  api.post('/lancamentos/:id/estornar', async (req, res) => {
    const l = await db.get('SELECT * FROM lancamentos WHERE id=? AND mercado_id=?', [U.intId(req.params.id), req.mid]);
    if (!l) return res.status(404).json({ erro: 'Lançamento não encontrado.' });
    await db.run("INSERT INTO lancamentos (mercado_id,cliente_id,tipo,valor,descricao) VALUES (?,?,'ajuste',?,?)",
      [req.mid, l.cliente_id, -l.valor, `Estorno do lançamento #${l.id}${req.body?.motivo ? ': ' + String(req.body.motivo).slice(0, 150) : ''}`]);
    await db.run('UPDATE lancamentos SET contestado=0 WHERE id=?', [l.id]);
    res.json({ saldo: await saldoDe(l.cliente_id) });
  });

  api.get('/contestacoes', async (req, res) => {
    res.json(await db.all(`SELECT k.*,c.nome AS cliente_nome FROM contestacoes k JOIN clientes c ON c.id=k.cliente_id
      WHERE k.mercado_id=? AND k.resolvida=0 ORDER BY k.id DESC`, [req.mid]));
  });
  api.post('/contestacoes/:id/resolver', async (req, res) => {
    await db.run('UPDATE contestacoes SET resolvida=1 WHERE id=? AND mercado_id=?', [U.intId(req.params.id), req.mid]);
    res.json({ ok: true });
  });

  // ---------- COBRANÇA / WHATSAPP ----------
  api.post('/clientes/:id/cobrar', async (req, res) => {
    const c = await meuCliente(req, res); if (!c) return;
    const m = await db.get('SELECT * FROM mercados WHERE id=?', [req.mid]);
    const texto = wa.textoCobranca({ mercado: m, cliente: c, saldo: await saldoDe(c.id), urlCliente: `${baseUrl(req)}/c/${c.token}` });
    res.json(await wa.enfileira(db, { mercado_id: req.mid, cliente_id: c.id, telefone: c.telefone, texto }));
  });

  // ---------- PRODUTOS / VALIDADE ----------
  api.get('/produtos', async (req, res) => {
    res.json(await db.all(`SELECT p.*, COALESCE(SUM(CASE WHEN e.baixado=0 THEN e.quantidade END),0) AS em_estoque
      FROM produtos p LEFT JOIN entradas e ON e.produto_id=p.id WHERE p.mercado_id=? GROUP BY p.id ORDER BY p.nome`, [req.mid]));
  });
  api.post('/produtos', async (req, res) => {
    const { nome, codigo, alerta_dias } = req.body || {};
    if (!nome) return res.status(400).json({ erro: 'Nome obrigatório.' });
    const r = await db.run('INSERT INTO produtos (mercado_id,nome,codigo,alerta_dias) VALUES (?,?,?,?)', [req.mid, String(nome).slice(0, 80), codigo || null, Number.isInteger(Number(alerta_dias)) ? Number(alerta_dias) : 7]);
    res.status(201).json({ id: r.id });
  });
  api.post('/produtos/:id/entradas', async (req, res) => {
    const p = await db.get('SELECT * FROM produtos WHERE id=? AND mercado_id=?', [U.intId(req.params.id), req.mid]);
    if (!p) return res.status(404).json({ erro: 'Produto não encontrado.' });
    const { quantidade, validade, custo } = req.body || {};
    if (!(quantidade > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(validade || '') || isNaN(Date.parse(validade))) return res.status(400).json({ erro: 'Informe quantidade e validade (AAAA-MM-DD).' });
    const r = await db.run('INSERT INTO entradas (mercado_id,produto_id,quantidade,validade,custo) VALUES (?,?,?,?,?)', [req.mid, p.id, Math.floor(quantidade), validade, custo ? U.toCents(custo) : null]);
    res.status(201).json({ id: r.id });
  });
  api.post('/entradas/:id/baixar', async (req, res) => {
    await db.run('UPDATE entradas SET baixado=1 WHERE id=? AND mercado_id=?', [U.intId(req.params.id), req.mid]);
    res.json({ ok: true });
  });

  api.get('/alertas/validade', async (req, res) => {
    const hoje = hojeISO();
    const rows = await db.all(`SELECT e.id AS entrada_id,p.nome,e.quantidade,e.validade,p.alerta_dias
      FROM entradas e JOIN produtos p ON p.id=e.produto_id
      WHERE e.mercado_id=? AND e.baixado=0 ORDER BY e.validade`, [req.mid]);
    const dias = (v) => Math.round((Date.parse(v + 'T00:00:00Z') - Date.parse(hoje + 'T00:00:00Z')) / 86400000);
    const lista = rows.map((r) => ({ ...r, dias_restantes: dias(r.validade) }));
    res.json({
      vencidos: lista.filter((r) => r.dias_restantes < 0),
      vencendo: lista.filter((r) => r.dias_restantes >= 0 && r.dias_restantes <= r.alerta_dias),
    });
  });

  // ---------- RESUMO ----------
  api.get('/resumo', async (req, res) => {
    const s = await db.get('SELECT COALESCE(SUM(valor),0) AS total FROM lancamentos WHERE mercado_id=?', [req.mid]);
    const dev = await db.get('SELECT COUNT(*) AS n FROM (SELECT cliente_id FROM lancamentos WHERE mercado_id=? GROUP BY cliente_id HAVING SUM(valor)>0) x', [req.mid]);
    const mes = await db.get(`SELECT COALESCE(SUM(CASE WHEN tipo='compra' THEN valor END),0) AS fiado,
        COALESCE(-SUM(CASE WHEN tipo='pagamento' THEN valor END),0) AS recebido
      FROM lancamentos WHERE mercado_id=? AND criado_em >= to_char(date_trunc('month', now() at time zone 'utc'),'YYYY-MM-DD')`, [req.mid]);
    res.json({ total_a_receber: s.total, clientes_devendo: dev.n, fiado_no_mes: mes.fiado, recebido_no_mes: mes.recebido });
  });

  // ---------- PÁGINA / API PÚBLICA DO CLIENTE ----------
  const porToken = async (token) => {
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
    return db.get('SELECT c.*, m.nome AS mercado_nome, m.slug AS mercado_slug, m.pix_chave, m.whatsapp AS mercado_whatsapp, m.mostrar_itens FROM clientes c JOIN mercados m ON m.id=c.mercado_id WHERE c.token=? AND c.ativo=1', [token]);
  };

  app.get('/api/publico/:token', async (req, res) => {
    if (!U.limite('pub:' + req.ip, 60, 60_000)) return res.status(429).json({ erro: 'Muitas requisições.' });
    const c = await porToken(req.params.token);
    if (!c) return res.status(404).json({ erro: 'Link inválido ou expirado.' });
    const lanc = await db.all('SELECT id,tipo,valor,descricao,criado_em,contestado FROM lancamentos WHERE cliente_id=? ORDER BY id DESC LIMIT 100', [c.id]);
    res.set('Cache-Control', 'no-store');
    res.json({
      mercado: c.mercado_nome, slug: c.mercado_slug, cliente: c.nome.split(' ')[0], saldo: await saldoDe(c.id), pix_chave: c.pix_chave,
      whatsapp: c.mercado_whatsapp,
      lancamentos: lanc.map((l) => ({
        id: l.id, tipo: l.tipo, valor: l.valor, data: l.criado_em, contestado: !!l.contestado,
        descricao: l.tipo === 'compra' && !c.mostrar_itens ? null : l.descricao,
      })),
    });
  });

  app.post('/api/publico/:token/contestar', async (req, res) => {
    if (!U.limite('cont:' + req.ip, 10, 60_000)) return res.status(429).json({ erro: 'Muitas requisições.' });
    const c = await porToken(req.params.token);
    if (!c) return res.status(404).json({ erro: 'Link inválido.' });
    const { lancamento_id, mensagem } = req.body || {};
    let lid = null;
    if (lancamento_id) {
      const l = await db.get('SELECT id FROM lancamentos WHERE id=? AND cliente_id=?', [U.intId(lancamento_id), c.id]);
      if (!l) return res.status(404).json({ erro: 'Lançamento não encontrado.' });
      lid = l.id;
      await db.run('UPDATE lancamentos SET contestado=1 WHERE id=?', [lid]);
    }
    await db.run('INSERT INTO contestacoes (mercado_id,cliente_id,lancamento_id,mensagem) VALUES (?,?,?,?)', [c.mercado_id, c.id, lid, String(mensagem || '').slice(0, 500)]);
    res.status(201).json({ ok: true });
  });

  registraLoja({ app, api, db, porToken, saldoDe });
  registraApp({ app, api, db, baseUrl });
  app.use('/api', api);

  const PUB = path.join(__dirname, '..', 'public');
  app.get('/c/:token', (req, res) => res.set('Cache-Control', 'no-store').sendFile(path.join(PUB, 'cliente.html')));
  app.get('/painel', (req, res) => res.sendFile(path.join(PUB, 'painel.html')));
  app.get('/', (req, res) => res.redirect('/painel'));

  // 404 de API e erros
  app.use('/api', (req, res) => res.status(404).json({ erro: 'Rota não encontrada.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.too.large') return res.status(413).json({ erro: 'Arquivo grande demais.' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ erro: 'Requisição inválida.' });
    console.error('Erro:', err);
    res.status(500).json({ erro: 'Erro interno. Tente novamente.' });
  });

  return app;
}

async function main() {
  if (process.env.DATABASE_URL && (!process.env.APP_SECRET || process.env.APP_SECRET.length < 24))
    throw new Error('Defina APP_SECRET (mínimo 24 caracteres aleatórios) nas variáveis do Railway antes de subir em produção.');
  const db = await open();
  const port = process.env.PORT || 3000;
  const server = createApp(db).listen(port, '0.0.0.0', () => console.log(`Caderneta rodando na porta ${port} (${process.env.DATABASE_URL ? 'Postgres' : 'banco local embutido'})`));
  const parar = () => server.close(() => db.close().finally(() => process.exit(0)));
  process.on('SIGTERM', parar); process.on('SIGINT', parar);
}

if (require.main === module) main().catch((e) => { console.error('Falha ao iniciar:', e); process.exit(1); });

module.exports = { createApp, hojeISO, addDias };
