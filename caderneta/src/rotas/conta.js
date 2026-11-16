// Conta do mercado: cadastro, login, sessão, troca de senha e equipe (dono + caixas).
const U = require('../util');
const { registroAberto } = require('./admin');

const PAPEIS = { dono: 'Dono', caixa: 'Caixa' };
const emailValido = (e) => /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/.test(e);
const tokenDe = (u) => U.assina({ u: u.id, m: u.mercado_id, v: u.sessao_versao });

module.exports = function registraConta({ app, api, db, audita }) {
  // ---------- público ----------
  app.post('/api/registro', async (req, res) => {
    const { nome, email, senha, pix_chave, whatsapp } = req.body || {};
    const em = String(email || '').trim().toLowerCase();
    if (!U.texto(nome, 80) || !emailValido(em) || String(senha || '').length < 8) return res.status(400).json({ erro: 'Informe nome, email válido e senha (mín. 8 caracteres).' });
    if (!(await registroAberto(db))) return res.status(403).json({ erro: 'Cadastro de novos mercados está fechado.' });
    if (!U.limite('reg:' + req.ip, 10, 60 * 60_000)) return res.status(429).json({ erro: 'Muitos cadastros. Tente mais tarde.' });
    try {
      const u = await db.tx(async (t) => {
        if (await t.get('SELECT 1 AS x FROM usuarios WHERE email=?', [em])) throw Object.assign(new Error('dup'), { code: '23505' });
        const hash = U.hashSenha(String(senha));
        const m = await t.run('INSERT INTO mercados (nome,email,senha_hash,pix_chave,whatsapp,slug) VALUES (?,?,?,?,?,?)',
          [U.texto(nome, 80), em, hash, U.texto(pix_chave, 120), U.texto(whatsapp, 30), U.slugify(nome)]);
        const r = await t.run("INSERT INTO usuarios (mercado_id,nome,email,senha_hash,papel) VALUES (?,?,?,?,'dono')", [m.id, U.texto(nome, 80), em, hash]);
        return { id: r.id, mercado_id: m.id, sessao_versao: 1 };
      });
      await audita({ mid: u.mercado_id, uid: u.id }, 'mercado.criado');
      res.status(201).json({ token: tokenDe(u), mercado_id: u.mercado_id });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ erro: 'Email já cadastrado.' });
      throw e;
    }
  });

  app.post('/api/login', async (req, res) => {
    const em = String(req.body?.email || '').trim().toLowerCase();
    if (!U.limite('login:' + req.ip, 10, 60_000) || !U.limite('login-em:' + em, 20, 15 * 60_000))
      return res.status(429).json({ erro: 'Muitas tentativas. Aguarde um pouco.' });
    const u = await db.get('SELECT u.*, m.nome AS mercado_nome, m.ativo AS mercado_ativo, m.bloqueio_motivo FROM usuarios u JOIN mercados m ON m.id=u.mercado_id WHERE u.email=?', [em]);
    if (!u || !U.confereSenha(String(req.body?.senha || ''), u.senha_hash)) return res.status(401).json({ erro: 'Email ou senha inválidos.' });
    if (!u.ativo) return res.status(403).json({ erro: 'Este acesso foi desativado pelo dono do mercado.' });
    if (!u.mercado_ativo) return res.status(403).json({ erro: `Acesso suspenso${u.bloqueio_motivo ? ': ' + u.bloqueio_motivo : ''}. Fale com o suporte da Caderneta.` });
    await db.run('UPDATE usuarios SET ultimo_login=? WHERE id=?', [U.agoraUTC(), u.id]);
    res.json({ token: tokenDe(u), mercado: { id: u.mercado_id, nome: u.mercado_nome }, usuario: { nome: u.nome, papel: u.papel } });
  });

  // ---------- autenticação das rotas /api ----------
  // O token carrega a "versão da sessão": trocar a senha ou "sair de todos os aparelhos"
  // incrementa a versão no banco e derruba todos os tokens antigos.
  api.use(async (req, res, next) => {
    try {
      const p = U.verifica((req.get('authorization') || '').replace(/^Bearer /, ''));
      const u = p && U.intId(p.u) ? await db.get('SELECT u.id,u.mercado_id,u.nome,u.email,u.papel,u.ativo,u.sessao_versao,m.ativo AS mercado_ativo FROM usuarios u JOIN mercados m ON m.id=u.mercado_id WHERE u.id=?', [p.u]) : null;
      if (u && !u.mercado_ativo) return res.status(401).json({ erro: 'Acesso suspenso. Fale com o suporte da Caderneta.' });
      if (!u || !u.ativo || u.sessao_versao !== p.v) return res.status(401).json({ erro: 'Sessão encerrada. Entre novamente.' });
      req.mid = u.mercado_id; req.uid = u.id; req.papel = u.papel; req.usuario = u;
      next();
    } catch (e) {
      next(e);
    }
  });

  // ---------- minha conta ----------
  api.get('/eu', async (req, res) => {
    const { id, nome, email, papel } = req.usuario;
    res.json({ id, nome, email, papel });
  });

  api.post('/eu/senha', async (req, res) => {
    const { atual, nova } = req.body || {};
    if (String(nova || '').length < 8) return res.status(400).json({ erro: 'A nova senha precisa ter pelo menos 8 caracteres.' });
    if (!U.limite('senha:' + req.uid, 5, 15 * 60_000)) return res.status(429).json({ erro: 'Muitas tentativas. Aguarde um pouco.' });
    const u = await db.get('SELECT * FROM usuarios WHERE id=?', [req.uid]);
    if (!U.confereSenha(String(atual || ''), u.senha_hash)) return res.status(400).json({ erro: 'Senha atual incorreta.' });
    const r = await db.get('UPDATE usuarios SET senha_hash=?, sessao_versao=sessao_versao+1 WHERE id=? RETURNING id,mercado_id,sessao_versao', [U.hashSenha(String(nova)), req.uid]);
    await audita(req, 'senha.trocada');
    res.json({ token: tokenDe(r) }); // este aparelho continua logado; os outros caem
  });

  api.post('/eu/sair-de-todos', async (req, res) => {
    await db.run('UPDATE usuarios SET sessao_versao=sessao_versao+1 WHERE id=?', [req.uid]);
    await audita(req, 'sessoes.encerradas');
    res.json({ ok: true });
  });

  // ---------- equipe (só o dono) ----------
  const soDono = (req, res, next) => (req.papel === 'dono' ? next() : res.status(403).json({ erro: 'Só o dono do mercado pode fazer isso.' }));

  api.get('/equipe', soDono, async (req, res) => {
    res.json(await db.all('SELECT id,nome,email,papel,ativo,criado_em FROM usuarios WHERE mercado_id=? ORDER BY papel DESC, nome', [req.mid]));
  });

  api.post('/equipe', soDono, async (req, res) => {
    const { nome, email, senha } = req.body || {};
    const em = String(email || '').trim().toLowerCase();
    if (!U.texto(nome, 80) || !emailValido(em) || String(senha || '').length < 8) return res.status(400).json({ erro: 'Informe nome, email válido e senha (mín. 8 caracteres).' });
    if (await db.get('SELECT 1 AS x FROM usuarios WHERE email=?', [em])) return res.status(409).json({ erro: 'Esse email já tem acesso.' });
    const r = await db.run("INSERT INTO usuarios (mercado_id,nome,email,senha_hash,papel) VALUES (?,?,?,?,'caixa')", [req.mid, U.texto(nome, 80), em, U.hashSenha(String(senha))]);
    await audita(req, 'equipe.adicionado', `${U.texto(nome, 80)} <${em}>`);
    res.status(201).json({ id: r.id });
  });

  api.patch('/equipe/:id', soDono, async (req, res) => {
    const u = await db.get('SELECT * FROM usuarios WHERE id=? AND mercado_id=?', [U.intId(req.params.id), req.mid]);
    if (!u) return res.status(404).json({ erro: 'Pessoa não encontrada.' });
    if (u.id === req.uid) return res.status(400).json({ erro: 'Use "Minha conta" para alterar o seu próprio acesso.' });
    const { ativo, senha } = req.body || {};
    if (senha !== undefined && String(senha).length < 8) return res.status(400).json({ erro: 'A senha precisa ter pelo menos 8 caracteres.' });
    await db.run('UPDATE usuarios SET ativo=?, senha_hash=?, sessao_versao=sessao_versao+1 WHERE id=?',
      [ativo === undefined ? u.ativo : ativo ? 1 : 0, senha !== undefined ? U.hashSenha(String(senha)) : u.senha_hash, u.id]);
    await audita(req, ativo === false ? 'equipe.desativado' : ativo === true ? 'equipe.reativado' : 'equipe.senha_redefinida', u.nome);
    res.json({ ok: true });
  });

  return { soDono, PAPEIS };
};
