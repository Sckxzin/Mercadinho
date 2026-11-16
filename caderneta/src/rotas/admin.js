// Painel do ADMINISTRADOR DO SISTEMA (o dono da plataforma, não o dono do mercado).
// Login próprio em /admin. O token do admin não abre o painel de mercado e vice-versa.
// Privacidade (LGPD): o admin vê números agregados e as equipes dos mercados, mas não a
// lista de clientes nem as compras de cada um.
const os = require('node:os');
const express = require('express');
const U = require('../util');
const wa = require('../whatsapp');
const { MIGRACOES } = require('../db');
const VERSAO = require('../../package.json').version;

const emailValido = (e) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e);
const tokenAdmin = (a) => U.assina({ a: a.id, v: a.sessao_versao }, 60 * 60 * 12); // sessão de 12 h

// configurações globais (tabela config); "registro_aberto" no banco vale mais que a variável de ambiente
async function registroAberto(db) {
  const c = await db.get("SELECT valor FROM config WHERE chave='registro_aberto'");
  if (c) return c.valor === '1';
  return process.env.REGISTRO_ABERTO !== 'false';
}

// cria o primeiro admin a partir de ADMIN_EMAIL / ADMIN_SENHA (só se ainda não existir nenhum)
async function adminInicial(db, env = process.env) {
  if (!env.ADMIN_EMAIL || !env.ADMIN_SENHA) return false;
  if (await db.get('SELECT 1 AS x FROM admins LIMIT 1')) return false;
  if (env.ADMIN_SENHA.length < 10) { console.warn('ADMIN_SENHA precisa de pelo menos 10 caracteres. Admin não criado.'); return false; }
  await db.run('INSERT INTO admins (nome,email,senha_hash) VALUES (?,?,?)', ['Administrador', env.ADMIN_EMAIL.trim().toLowerCase(), U.hashSenha(env.ADMIN_SENHA)]);
  console.log(`Admin criado: ${env.ADMIN_EMAIL}`);
  return true;
}

module.exports = function registraAdmin({ app, db }) {
  const adm = U.asyncRouter(express.Router());
  const log = (req, acao, mercado_id = null, detalhe = null) =>
    db.run('INSERT INTO admin_log (admin_id,acao,mercado_id,detalhe) VALUES (?,?,?,?)', [req.admin?.id ?? null, acao, mercado_id, detalhe ? String(detalhe).slice(0, 500) : null]);
  const inicio = Date.now();

  // ---------- login ----------
  app.post('/api/admin/login', async (req, res) => {
    const em = String(req.body?.email || '').trim().toLowerCase();
    if (!U.limite('adm-login:' + req.ip, 5, 15 * 60_000) || !U.limite('adm-login-em:' + em, 10, 60 * 60_000))
      return res.status(429).json({ erro: 'Muitas tentativas. Aguarde 15 minutos.' });
    const a = await db.get('SELECT * FROM admins WHERE email=?', [em]);
    if (!a || !a.ativo || !U.confereSenha(String(req.body?.senha || ''), a.senha_hash)) return res.status(401).json({ erro: 'Email ou senha inválidos.' });
    await db.run('UPDATE admins SET ultimo_login=? WHERE id=?', [U.agoraUTC(), a.id]);
    await log({ admin: a }, 'admin.login', null, req.ip);
    res.json({ token: tokenAdmin(a), admin: { nome: a.nome, email: a.email } });
  });

  adm.use(async (req, res, next) => {
    try {
      const p = U.verifica((req.get('authorization') || '').replace(/^Bearer /, ''));
      const a = p && U.intId(p.a) ? await db.get('SELECT id,nome,email,ativo,sessao_versao FROM admins WHERE id=?', [p.a]) : null;
      if (!a || !a.ativo || a.sessao_versao !== p.v) return res.status(401).json({ erro: 'Sessão de administrador encerrada. Entre novamente.' });
      req.admin = a;
      res.set('Cache-Control', 'no-store');
      next();
    } catch (e) { next(e); }
  });

  adm.get('/eu', async (req, res) => res.json({ id: req.admin.id, nome: req.admin.nome, email: req.admin.email }));

  // ---------- visão geral ----------
  adm.get('/visao', async (req, res) => {
    const mes = U.inicioMesUTC(), d30 = U.inicioDiaUTC(U.addDias(U.hojeISO(), -30)), d7 = U.inicioDiaUTC(U.addDias(U.hojeISO(), -7));
    const t0 = Date.now();
    const [m, u, c, l, pend, ult, ativos7, novos] = await Promise.all([
      db.get('SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN ativo=1 THEN 1 ELSE 0 END),0) AS ativos FROM mercados'),
      db.get("SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN papel='caixa' THEN 1 ELSE 0 END),0) AS caixas FROM usuarios WHERE ativo=1"),
      db.get('SELECT COUNT(*) AS total, COALESCE(SUM(CASE WHEN ativado_em IS NOT NULL THEN 1 ELSE 0 END),0) AS com_app FROM clientes WHERE ativo=1'),
      // estornados (e os próprios estornos) não contam como fiado/recebido do mês
      db.get(`SELECT COALESCE(SUM(l.valor),0) AS a_receber,
          COALESCE(SUM(CASE WHEN l.tipo='compra' AND l.criado_em >= ? AND e.id IS NULL THEN l.valor END),0) AS fiado_mes,
          COALESCE(-SUM(CASE WHEN l.tipo='pagamento' AND l.criado_em >= ? AND e.id IS NULL THEN l.valor END),0) AS recebido_mes,
          COALESCE(SUM(CASE WHEN l.criado_em >= ? THEN 1 ELSE 0 END),0) AS lanc_30d
        FROM lancamentos l LEFT JOIN lancamentos e ON e.estorno_de=l.id`, [mes, mes, d30]),
      db.get("SELECT COUNT(*) AS n FROM pagamentos_informados WHERE status='pendente'"),
      db.get('SELECT MAX(versao) AS v FROM schema_migracoes'),
      db.get('SELECT COUNT(DISTINCT mercado_id) AS n FROM lancamentos WHERE criado_em >= ?', [d7]),
      db.get('SELECT COUNT(*) AS n FROM mercados WHERE criado_em >= ?', [mes]),
    ]);
    res.json({
      mercados: { total: m.total, ativos: m.ativos, suspensos: m.total - m.ativos, ativos_7d: ativos7.n, novos_mes: novos.n },
      usuarios: u, clientes: c, financeiro: l, comprovantes_pendentes: pend.n,
      sistema: {
        versao: VERSAO, node: process.version, banco: process.env.DATABASE_URL ? 'PostgreSQL' : 'embutido (PGlite)', banco_ms: Date.now() - t0,
        migracao: `${ult.v}/${MIGRACOES.length}`, no_ar_desde: new Date(inicio).toISOString(), memoria_mb: Math.round(process.memoryUsage().rss / 1048576),
        fuso: U.TZ, whatsapp_automatico: wa.configurado(), registro_aberto: await registroAberto(db), servidor: os.hostname(),
        app_secret_padrao: !process.env.APP_SECRET,
      },
    });
  });

  // ---------- mercados ----------
  const METRICAS = `
    (SELECT COUNT(*) FROM clientes c WHERE c.mercado_id=m.id AND c.ativo=1) AS clientes,
    (SELECT COALESCE(SUM(valor),0) FROM lancamentos l WHERE l.mercado_id=m.id) AS a_receber,
    (SELECT MAX(criado_em) FROM lancamentos l WHERE l.mercado_id=m.id) AS ultimo_lancamento,
    (SELECT MAX(ultimo_login) FROM usuarios u WHERE u.mercado_id=m.id) AS ultimo_login,
    (SELECT email FROM usuarios u WHERE u.mercado_id=m.id AND u.papel='dono' ORDER BY id LIMIT 1) AS email_dono`;

  adm.get('/mercados', async (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase().slice(0, 60);
    const rows = await db.all(`SELECT m.id,m.nome,m.slug,m.cidade,m.ativo,m.bloqueio_motivo,m.criado_em, ${METRICAS}
      FROM mercados m WHERE (?='' OR lower(m.nome) LIKE ? OR lower(m.email) LIKE ? OR lower(COALESCE(m.cidade,'')) LIKE ?)
      ORDER BY m.ativo DESC, m.id DESC LIMIT 500`, [q, `%${q}%`, `%${q}%`, `%${q}%`]);
    res.json(rows);
  });

  const meuMercado = async (req, res) => {
    const m = await db.get(`SELECT m.id,m.nome,m.slug,m.cidade,m.whatsapp,m.pix_chave,m.ativo,m.bloqueio_motivo,m.criado_em, ${METRICAS} FROM mercados m WHERE m.id=?`, [U.intId(req.params.id)]);
    if (!m) res.status(404).json({ erro: 'Mercado não encontrado.' });
    return m;
  };

  adm.get('/mercados/:id', async (req, res) => {
    const m = await meuMercado(req, res); if (!m) return;
    const mes = U.inicioMesUTC();
    const [equipe, num, auditoria, acoesAdmin] = await Promise.all([
      db.all('SELECT id,nome,email,papel,ativo,ultimo_login,criado_em FROM usuarios WHERE mercado_id=? ORDER BY papel DESC, id', [m.id]),
      db.get(`SELECT
          (SELECT COUNT(*) FROM clientes WHERE mercado_id=? AND ativo=1 AND ativado_em IS NOT NULL) AS clientes_app,
          (SELECT COUNT(*) FROM (SELECT cliente_id FROM lancamentos WHERE mercado_id=? GROUP BY cliente_id HAVING SUM(valor)>0) x) AS devendo,
          (SELECT COALESCE(SUM(l.valor),0) FROM lancamentos l WHERE l.mercado_id=? AND l.tipo='compra' AND l.criado_em >= ? AND NOT EXISTS (SELECT 1 FROM lancamentos e WHERE e.estorno_de=l.id)) AS fiado_mes,
          (SELECT COALESCE(-SUM(l.valor),0) FROM lancamentos l WHERE l.mercado_id=? AND l.tipo='pagamento' AND l.criado_em >= ? AND NOT EXISTS (SELECT 1 FROM lancamentos e WHERE e.estorno_de=l.id)) AS recebido_mes,
          (SELECT COUNT(*) FROM lancamentos WHERE mercado_id=?) AS lancamentos,
          (SELECT COUNT(*) FROM produtos WHERE mercado_id=?) AS produtos,
          (SELECT COUNT(*) FROM promocoes WHERE mercado_id=? AND ativo=1) AS promocoes,
          (SELECT COUNT(*) FROM pagamentos_informados WHERE mercado_id=? AND status='pendente') AS comprovantes_pendentes`,
      [m.id, m.id, m.id, mes, m.id, mes, m.id, m.id, m.id, m.id]),
      db.all(`SELECT a.acao,a.detalhe,a.criado_em,u.nome AS usuario FROM auditoria a LEFT JOIN usuarios u ON u.id=a.usuario_id
        WHERE a.mercado_id=? ORDER BY a.id DESC LIMIT 40`, [m.id]),
      db.all(`SELECT l.acao,l.detalhe,l.criado_em,a.nome AS admin FROM admin_log l LEFT JOIN admins a ON a.id=l.admin_id
        WHERE l.mercado_id=? ORDER BY l.id DESC LIMIT 20`, [m.id]),
    ]);
    res.json({ mercado: m, equipe, numeros: num, auditoria, acoes_admin: acoesAdmin });
  });

  // criar um mercado para um cliente novo (útil com o cadastro público fechado)
  adm.post('/mercados', async (req, res) => {
    const { nome, email, senha, cidade, whatsapp } = req.body || {};
    const em = String(email || '').trim().toLowerCase();
    if (!U.texto(nome, 80) || !emailValido(em) || String(senha || '').length < 8) return res.status(400).json({ erro: 'Informe nome, email válido e senha (mín. 8 caracteres).' });
    try {
      const id = await db.tx(async (t) => {
        if (await t.get('SELECT 1 AS x FROM usuarios WHERE email=?', [em])) throw Object.assign(new Error('dup'), { code: '23505' });
        const hash = U.hashSenha(String(senha));
        const m = await t.run('INSERT INTO mercados (nome,email,senha_hash,cidade,whatsapp,slug) VALUES (?,?,?,?,?,?)',
          [U.texto(nome, 80), em, hash, U.texto(cidade, 60), U.texto(whatsapp, 30), U.slugify(nome)]);
        await t.run("INSERT INTO usuarios (mercado_id,nome,email,senha_hash,papel) VALUES (?,?,?,?,'dono')", [m.id, U.texto(nome, 80), em, hash]);
        return m.id;
      });
      await log(req, 'mercado.criado', id, `${U.texto(nome, 80)} <${em}>`);
      res.status(201).json({ id });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ erro: 'Esse email já tem acesso.' });
      throw e;
    }
  });

  // suspender / reativar (ex.: falta de pagamento). Suspenso: ninguém da equipe entra e
  // o app/link dos clientes mostra "indisponível". Nenhum dado é apagado.
  adm.patch('/mercados/:id', async (req, res) => {
    const m = await meuMercado(req, res); if (!m) return;
    const { ativo, motivo, nome } = req.body || {};
    if (nome !== undefined && !U.texto(nome, 80)) return res.status(400).json({ erro: 'Nome não pode ficar vazio.' });
    const novoAtivo = ativo === undefined ? m.ativo : ativo ? 1 : 0;
    await db.run('UPDATE mercados SET ativo=?, bloqueio_motivo=?, nome=? WHERE id=?',
      [novoAtivo, novoAtivo ? null : U.texto(motivo, 200) || m.bloqueio_motivo, U.texto(nome, 80) ?? m.nome, m.id]);
    if (novoAtivo !== m.ativo) await log(req, novoAtivo ? 'mercado.reativado' : 'mercado.suspenso', m.id, novoAtivo ? m.nome : `${m.nome}: ${U.texto(motivo, 200) || 'sem motivo'}`);
    if (nome !== undefined && U.texto(nome, 80) !== m.nome) await log(req, 'mercado.renomeado', m.id, `${m.nome} → ${U.texto(nome, 80)}`);
    res.json({ ok: true });
  });

  // ---------- pessoas das equipes ----------
  const pessoa = async (req, res) => {
    const u = await db.get('SELECT u.*, m.nome AS mercado_nome FROM usuarios u JOIN mercados m ON m.id=u.mercado_id WHERE u.id=?', [U.intId(req.params.id)]);
    if (!u) res.status(404).json({ erro: 'Pessoa não encontrada.' });
    return u;
  };
  adm.post('/usuarios/:id/senha', async (req, res) => {
    const u = await pessoa(req, res); if (!u) return;
    if (String(req.body?.senha || '').length < 8) return res.status(400).json({ erro: 'A senha precisa ter pelo menos 8 caracteres.' });
    await db.run('UPDATE usuarios SET senha_hash=?, sessao_versao=sessao_versao+1 WHERE id=?', [U.hashSenha(String(req.body.senha)), u.id]);
    await log(req, 'usuario.senha_redefinida', u.mercado_id, `${u.nome} <${u.email}>`);
    res.json({ ok: true });
  });
  adm.patch('/usuarios/:id', async (req, res) => {
    const u = await pessoa(req, res); if (!u) return;
    const ativo = req.body?.ativo ? 1 : 0;
    if (!ativo && u.papel === 'dono' && (await db.get("SELECT COUNT(*) AS n FROM usuarios WHERE mercado_id=? AND papel='dono' AND ativo=1", [u.mercado_id])).n <= 1)
      return res.status(400).json({ erro: 'Este é o único dono do mercado. Para bloquear o mercado inteiro, use "Suspender mercado".' });
    await db.run('UPDATE usuarios SET ativo=?, sessao_versao=sessao_versao+1 WHERE id=?', [ativo, u.id]);
    await log(req, ativo ? 'usuario.reativado' : 'usuario.desativado', u.mercado_id, `${u.nome} <${u.email}>`);
    res.json({ ok: true });
  });
  adm.post('/usuarios/:id/sair', async (req, res) => {
    const u = await pessoa(req, res); if (!u) return;
    await db.run('UPDATE usuarios SET sessao_versao=sessao_versao+1 WHERE id=?', [u.id]);
    await log(req, 'usuario.sessoes_encerradas', u.mercado_id, `${u.nome} <${u.email}>`);
    res.json({ ok: true });
  });

  // ---------- configurações globais ----------
  adm.get('/config', async (req, res) => res.json({ registro_aberto: await registroAberto(db) }));
  adm.patch('/config', async (req, res) => {
    if (req.body?.registro_aberto !== undefined) {
      const v = req.body.registro_aberto ? '1' : '0';
      await db.all('INSERT INTO config (chave,valor) VALUES (?,?) ON CONFLICT (chave) DO UPDATE SET valor=EXCLUDED.valor RETURNING chave', ['registro_aberto', v]);
      await log(req, v === '1' ? 'config.registro_aberto' : 'config.registro_fechado');
    }
    res.json({ registro_aberto: await registroAberto(db) });
  });

  // ---------- registro de ações do admin ----------
  adm.get('/log', async (req, res) => {
    const antes = U.intId(req.query.antes) || 2 ** 31 - 1;
    const rows = await db.all(`SELECT l.id,l.acao,l.detalhe,l.criado_em,l.mercado_id,m.nome AS mercado,a.nome AS admin FROM admin_log l
      LEFT JOIN mercados m ON m.id=l.mercado_id LEFT JOIN admins a ON a.id=l.admin_id WHERE l.id<? ORDER BY l.id DESC LIMIT 51`, [antes]);
    res.json({ itens: rows.slice(0, 50), tem_mais: rows.length > 50 });
  });

  // ---------- administradores ----------
  adm.get('/admins', async (req, res) => res.json(await db.all('SELECT id,nome,email,ativo,ultimo_login,criado_em FROM admins ORDER BY id')));
  adm.post('/admins', async (req, res) => {
    const { nome, email, senha } = req.body || {};
    const em = String(email || '').trim().toLowerCase();
    if (!U.texto(nome, 80) || !emailValido(em) || String(senha || '').length < 10) return res.status(400).json({ erro: 'Informe nome, email válido e senha (mín. 10 caracteres).' });
    if (await db.get('SELECT 1 AS x FROM admins WHERE email=?', [em])) return res.status(409).json({ erro: 'Esse email já é admin.' });
    await db.run('INSERT INTO admins (nome,email,senha_hash) VALUES (?,?,?)', [U.texto(nome, 80), em, U.hashSenha(String(senha))]);
    await log(req, 'admin.adicionado', null, `${U.texto(nome, 80)} <${em}>`);
    res.status(201).json({ ok: true });
  });
  adm.patch('/admins/:id', async (req, res) => {
    const id = U.intId(req.params.id);
    if (id === req.admin.id) return res.status(400).json({ erro: 'Você não pode desativar a si mesmo.' });
    const r = await db.run('UPDATE admins SET ativo=?, sessao_versao=sessao_versao+1 WHERE id=?', [req.body?.ativo ? 1 : 0, id]);
    if (!r.changes) return res.status(404).json({ erro: 'Admin não encontrado.' });
    await log(req, req.body?.ativo ? 'admin.reativado' : 'admin.desativado', null, `#${id}`);
    res.json({ ok: true });
  });
  adm.post('/eu/senha', async (req, res) => {
    const { atual, nova } = req.body || {};
    if (String(nova || '').length < 10) return res.status(400).json({ erro: 'A nova senha precisa ter pelo menos 10 caracteres.' });
    if (!U.limite('adm-senha:' + req.admin.id, 5, 15 * 60_000)) return res.status(429).json({ erro: 'Muitas tentativas. Aguarde.' });
    const a = await db.get('SELECT * FROM admins WHERE id=?', [req.admin.id]);
    if (!U.confereSenha(String(atual || ''), a.senha_hash)) return res.status(400).json({ erro: 'Senha atual incorreta.' });
    const n = await db.get('UPDATE admins SET senha_hash=?, sessao_versao=sessao_versao+1 WHERE id=? RETURNING id,sessao_versao', [U.hashSenha(String(nova)), a.id]);
    await log(req, 'admin.senha_trocada');
    res.json({ token: tokenAdmin(n) });
  });

  app.use('/api/admin', adm);
};

module.exports.registroAberto = registroAberto;
module.exports.adminInicial = adminInicial;
