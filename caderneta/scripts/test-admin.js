// Testes do painel do administrador do sistema (chamado por scripts/test.js)
const assert = require('node:assert/strict');
const { adminInicial } = require('../src/rotas/admin');

module.exports = async function testaAdmin({ db, base, call, ok, slug }) {
  console.log('\n  — painel do administrador —');
  const get = (p, t) => call('GET', p, null, t), post = (p, b, t) => call('POST', p, b || {}, t), patch = (p, b, t) => call('PATCH', p, b, t);

  let est = await get('/api/admin/estado'); assert.equal(est.body.tem_admin, false);
  assert.equal(await adminInicial(db, { ADMIN_EMAIL: 'root@x.com', ADMIN_SENHA: '123' }), false);
  est = await get('/api/admin/estado'); assert.equal(est.body.motivo, 'sem_variaveis'); // a rota usa as variáveis reais (vazias aqui)
  for (const [env, motivo] of [[{ ADMIN_SENHA: 'senha-longa-ok' }, 'sem_email'], [{ ADMIN_EMAIL: 'x@x.com' }, 'sem_senha'], [{ ADMIN_EMAIL: 'nao-email', ADMIN_SENHA: 'senha-longa-ok' }, 'email_invalido'], [{ ADMIN_EMAIL: 'x@x.com', ADMIN_SENHA: 'curta' }, 'senha_curta']]) {
    process.env.ADMIN_EMAIL = env.ADMIN_EMAIL || ''; process.env.ADMIN_SENHA = env.ADMIN_SENHA || '';
    assert.equal((await get('/api/admin/estado')).body.motivo, motivo, motivo);
  }
  delete process.env.ADMIN_EMAIL; delete process.env.ADMIN_SENHA;
  ok('tela do /admin explica por que o admin não foi criado (variável faltando, email inválido, senha curta)');
  assert.equal(await adminInicial(db, {}), false);
  assert.equal(await adminInicial(db, { ADMIN_EMAIL: 'root@x.com', ADMIN_SENHA: 'curta' }), false);
  assert.equal(await adminInicial(db, { ADMIN_EMAIL: ' "Root@X.com" ', ADMIN_SENHA: '  "senha-admin-forte"\n' }), true); // aspas e espaços colados junto
  assert.equal((await get('/api/admin/estado')).body.tem_admin, true);
  assert.equal(await adminInicial(db, { ADMIN_EMAIL: 'outro@x.com', ADMIN_SENHA: 'senha-admin-forte' }), false); ok('primeiro admin criado pelas variáveis (ignora aspas/espaços; só uma vez)');

  assert.equal((await post('/api/admin/login', { email: 'root@x.com', senha: 'errada-errada' })).status, 401);
  let r = await post('/api/admin/login', { email: 'root@x.com', senha: 'senha-admin-forte' }); assert.equal(r.status, 200); const ADM = r.body.token; ok('login do admin');

  const dono = (await post('/api/login', { email: 'a@a.com', senha: 'novasenha123' })).body.token;
  assert.equal((await get('/api/admin/visao', dono)).status, 401); assert.equal((await get('/api/admin/mercados')).status, 401);
  assert.equal((await get('/api/clientes', ADM)).status, 401); ok('token de mercado não abre o admin, e o do admin não abre um mercado');

  r = await get('/api/admin/visao', ADM);
  assert.ok(r.body.mercados.total >= 2 && r.body.clientes.total > 0 && typeof r.body.financeiro.a_receber === 'number');
  assert.equal(r.body.sistema.migracao.split('/')[0], r.body.sistema.migracao.split('/')[1]); ok('visão geral: mercados, clientes, dinheiro e saúde do sistema');
  r = await get('/api/admin/mercados?q=mercado a', ADM);
  const ma = r.body.find((m) => m.nome === 'Mercado A'); assert.ok(ma && ma.clientes > 0 && ma.email_dono === 'a@a.com'); ok('lista de mercados com busca e números');
  r = await get(`/api/admin/mercados/${ma.id}`, ADM);
  assert.ok(r.body.equipe.some((u) => u.papel === 'dono') && r.body.auditoria.length > 0);
  assert.ok(!JSON.stringify(r.body).includes('senha_hash') && !('clientes_lista' in r.body)); ok('detalhe do mercado: equipe e histórico, sem senhas nem lista de clientes');

  // suspensão
  const tokCli = (await get('/api/clientes?limit=1', dono)).body[0].url.split('/').pop();
  r = await patch(`/api/admin/mercados/${ma.id}`, { ativo: false, motivo: 'Mensalidade em aberto' }, ADM); assert.equal(r.status, 200);
  assert.equal((await get('/api/clientes', dono)).status, 401);
  r = await post('/api/login', { email: 'a@a.com', senha: 'novasenha123' }); assert.equal(r.status, 403); assert.ok(r.body.erro.includes('Mensalidade em aberto'));
  assert.equal((await get(`/api/publico/${tokCli}`)).status, 404); assert.equal((await get(`/api/app/${slug}`)).status, 404);
  ok('suspender mercado: equipe não entra (vê o motivo) e o app/link dos clientes fica indisponível');
  await patch(`/api/admin/mercados/${ma.id}`, { ativo: true }, ADM);
  assert.equal((await get(`/api/publico/${tokCli}`)).status, 200); assert.equal((await post('/api/login', { email: 'a@a.com', senha: 'novasenha123' })).status, 200); ok('reativar devolve tudo, sem perder dados');

  // criar mercado e redefinir senha
  r = await post('/api/admin/mercados', { nome: 'Mercado Novo', email: 'novo@m.com', senha: 'inicial123' }, ADM); assert.equal(r.status, 201); const mn = r.body.id;
  assert.equal((await post('/api/admin/mercados', { nome: 'Dup', email: 'novo@m.com', senha: 'inicial123' }, ADM)).status, 409);
  r = await post('/api/login', { email: 'novo@m.com', senha: 'inicial123' }); assert.equal(r.status, 200); const tokNovo = r.body.token; ok('admin cria mercado para um cliente novo');
  const uid = (await get(`/api/admin/mercados/${mn}`, ADM)).body.equipe[0].id;
  assert.equal((await post(`/api/admin/usuarios/${uid}/senha`, { senha: 'trocada123' }, ADM)).status, 200);
  assert.equal((await get('/api/eu', tokNovo)).status, 401); assert.equal((await post('/api/login', { email: 'novo@m.com', senha: 'trocada123' })).status, 200); ok('admin redefine senha de um dono (sessões antigas caem)');
  assert.equal((await patch(`/api/admin/usuarios/${uid}`, { ativo: false }, ADM)).status, 400); ok('não deixa desativar o único dono (use suspender)');

  // cadastro público
  r = await patch('/api/admin/config', { registro_aberto: false }, ADM); assert.equal(r.body.registro_aberto, false);
  assert.equal((await post('/api/registro', { nome: 'X', email: 'x@x.com', senha: 'senha12345' })).status, 403);
  await patch('/api/admin/config', { registro_aberto: true }, ADM); ok('admin abre/fecha o cadastro público');

  // admins e registro de ações
  assert.equal((await post('/api/admin/admins', { nome: 'Sócio', email: 'socio@x.com', senha: 'curta' }, ADM)).status, 400);
  assert.equal((await post('/api/admin/admins', { nome: 'Sócio', email: 'socio@x.com', senha: 'senha-do-socio' }, ADM)).status, 201);
  r = await post('/api/admin/eu/senha', { atual: 'senha-admin-forte', nova: 'nova-senha-admin' }, ADM); assert.equal(r.status, 200);
  assert.equal((await get('/api/admin/eu', ADM)).status, 401); const ADM2 = r.body.token; ok('admin adiciona outro admin e troca a própria senha');
  const acoes = (await get('/api/admin/log', ADM2)).body.itens.map((x) => x.acao);
  for (const a of ['admin.login', 'mercado.suspenso', 'mercado.reativado', 'mercado.criado', 'usuario.senha_redefinida', 'config.registro_fechado', 'admin.adicionado', 'admin.senha_trocada']) assert.ok(acoes.includes(a), a);
  ok('todas as ações do admin ficam registradas');
  const pg = await fetch(base + '/admin'); assert.equal(pg.status, 200); assert.ok((await pg.text()).includes('Caderneta — Admin')); ok('página /admin');
  let bloq = false; for (let i = 0; i < 7; i++) if ((await post('/api/admin/login', { email: 'root@x.com', senha: 'x' })).status === 429) bloq = true;
  assert.ok(bloq); ok('login do admin bloqueia força bruta');
};
