// Teste de ponta a ponta (sem frameworks): npm test
// Por padrão usa o Postgres embutido em memória. Para rodar contra um Postgres de verdade:
//   TEST_DATABASE_URL=postgres://usuario:senha@localhost:5432/banco_de_teste npm test
// (o banco de teste é APAGADO no início)
const assert = require('node:assert/strict');
const { open } = require('../src/db');
const { createApp, addDias, hojeISO } = require('../src/server');
const extras = require('./test-extras');
const testaAdmin = require('./test-admin');

(async () => {
  const url = process.env.TEST_DATABASE_URL;
  if (url) {
    const { Client } = require('pg');
    const c = new Client({ connectionString: url }); await c.connect();
    await c.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;'); await c.end();
    console.log('Banco: Postgres em', url.replace(/\/\/[^@]*@/, '//***@'));
  }
  const db = await open(url ? { url } : { memory: true });
  const server = createApp(db).listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body, token) => {
    const r = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  let n = 0; const ok = (m) => { n++; console.log(`  ✓ ${m}`); };

  // registro / login
  let r = await call('POST', '/api/registro', { nome: 'Mercado A', email: 'a@a.com', senha: 'senha12345', pix_chave: 'pix-a' });
  assert.equal(r.status, 201); const A = r.body.token;
  r = await call('POST', '/api/registro', { nome: 'Mercado B', email: 'b@b.com', senha: 'senha12345' }); const B = r.body.token;
  assert.equal((await call('POST', '/api/login', { email: 'a@a.com', senha: 'errada123' })).status, 401); ok('login rejeita senha errada');
  assert.equal((await call('GET', '/api/clientes')).status, 401); ok('API exige autenticação');

  // clientes + saldo
  r = await call('POST', '/api/clientes', { nome: 'Maria Souza', telefone: '81988887777', limite: '100', aceitou: true }, A);
  assert.equal(r.status, 201); const cid = r.body.id, tokenCli = r.body.token;
  assert.ok(tokenCli.length >= 30); ok('token do cliente longo e aleatório');
  r = await call('POST', `/api/clientes/${cid}/compras`, { valor: '60,50', descricao: 'arroz e feijão' }, A);
  assert.equal(r.body.saldo, 6050); ok('compra fiada soma no saldo');
  r = await call('POST', `/api/clientes/${cid}/compras`, { valor: '50' }, A);
  assert.equal(r.status, 409); assert.equal(r.body.codigo, 'LIMITE'); ok('bloqueia acima do limite');
  r = await call('POST', `/api/clientes/${cid}/compras`, { valor: '50', forcar: true }, A);
  assert.equal(r.body.saldo, 11050); ok('dono pode forçar acima do limite');
  r = await call('POST', `/api/clientes/${cid}/pagamentos`, { valor: '30', forma: 'pix' }, A);
  assert.equal(r.body.saldo, 8050); ok('pagamento parcial abate saldo');

  // isolamento multi-tenant
  assert.equal((await call('GET', `/api/clientes/${cid}/extrato`, null, B)).status, 404);
  assert.equal((await call('POST', `/api/clientes/${cid}/pagamentos`, { valor: '1' }, B)).status, 404);
  assert.equal((await call('GET', '/api/clientes', null, B)).body.length, 0); ok('mercado B não enxerga dados do A');

  // página pública
  r = await call('GET', `/api/publico/${tokenCli}`);
  assert.equal(r.body.saldo, 8050); assert.equal(r.body.cliente, 'Maria');
  assert.ok(r.body.lancamentos.filter((l) => l.tipo === 'compra').every((l) => l.descricao === null)); ok('cliente vê saldo; itens ocultos por padrão');
  await call('PATCH', '/api/mercado', { mostrar_itens: true }, A);
  r = await call('GET', `/api/publico/${tokenCli}`);
  assert.ok(r.body.lancamentos.some((l) => l.descricao === 'arroz e feijão')); ok('dono libera detalhe dos itens');
  assert.equal((await call('GET', '/api/publico/token-inexistente-123456789')).status, 404); ok('token inválido = 404');
  const lid = r.body.lancamentos[0].id;
  assert.equal((await call('POST', `/api/publico/${tokenCli}/contestar`, { lancamento_id: lid, mensagem: 'não comprei isso' })).status, 201);
  r = await call('GET', '/api/contestacoes', null, A); assert.equal(r.body.length, 1); ok('contestação chega ao dono');
  // estorno
  r = await call('POST', `/api/lancamentos/${lid}/estornar`, { motivo: 'erro de digitação' }, A);
  assert.equal(typeof r.body.saldo, 'number'); ok('estorno gera lançamento inverso');
  // novo link invalida o antigo
  r = await call('POST', `/api/clientes/${cid}/novo-link`, null, A);
  assert.equal((await call('GET', `/api/publico/${tokenCli}`)).status, 404); ok('novo link invalida o antigo');

  // cobrança WhatsApp
  r = await call('POST', `/api/clientes/${cid}/cobrar`, null, A);
  assert.ok(r.body.link_wa.startsWith('https://wa.me/5581988887777?text=')); ok('gera link wa.me de cobrança');

  // validade
  r = await call('POST', '/api/produtos', { nome: 'Leite', alerta_dias: 5 }, A); const pid = r.body.id;
  await call('POST', `/api/produtos/${pid}/entradas`, { quantidade: 10, validade: addDias(hojeISO(), 3) }, A);
  await call('POST', `/api/produtos/${pid}/entradas`, { quantidade: 4, validade: addDias(hojeISO(), -2) }, A);
  await call('POST', `/api/produtos/${pid}/entradas`, { quantidade: 8, validade: addDias(hojeISO(), 90) }, A);
  r = await call('GET', '/api/alertas/validade', null, A);
  assert.equal(r.body.vencidos.length, 1); assert.equal(r.body.vencendo.length, 1); ok('alerta: 1 vencido, 1 vencendo, 1 ok');
  await call('POST', `/api/entradas/${r.body.vencidos[0].entrada_id}/baixar`, null, A);
  assert.equal((await call('GET', '/api/alertas/validade', null, A)).body.vencidos.length, 0); ok('dar baixa remove do alerta');

  // ---- promoções, Pix com valor e comprovante ----
  const tok2 = (await call('POST', `/api/clientes/${cid}/novo-link`, null, A)).body.url.split('/').pop();
  await call('PATCH', '/api/mercado', { pix_chave: 'pix@mercado-a.com', cidade: 'Escada' }, A);
  r = await call('POST', '/api/promocoes', { titulo: 'Arroz 5kg', preco: '24,90', preco_original: '29,90', validade: addDias(hojeISO(), 5) }, A);
  assert.equal(r.status, 201);
  await call('POST', '/api/promocoes', { titulo: 'Vencida', preco: '1', validade: addDias(hojeISO(), -1) }, A);
  r = await call('GET', `/api/publico/${tok2}/extras`);
  assert.equal(r.body.promocoes.length, 1); assert.equal(r.body.promocoes[0].preco, 2490); ok('cliente vê só promoções ativas e dentro da validade');
  assert.equal((await call('GET', '/api/promocoes', null, B)).body.length, 0); ok('promoções isoladas por mercado');

  r = await call('GET', `/api/publico/${tok2}/pix`);
  assert.ok(r.body.copia_e_cola.startsWith('000201') && r.body.copia_e_cola.includes('pix@mercado-a.com') && r.body.copia_e_cola.includes('5802BR'));
  const { crc16 } = require('../src/util'); const pl = r.body.copia_e_cola;
  assert.equal(crc16(pl.slice(0, -4)), pl.slice(-4)); ok('Pix copia-e-cola válido (CRC16 confere) com valor do saldo');

  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(50, 1)]);
  const envia = (t, valor, body) => fetch(`${base}/api/publico/${t}/comprovante?valor=${valor}`, { method: 'POST', headers: { 'content-type': 'image/png' }, body }).then(async (x) => ({ status: x.status, body: await x.json() }));
  assert.equal((await envia(tok2, '10', Buffer.from('<script>alert(1)</script>'))).status, 400); ok('rejeita arquivo que não é imagem');
  assert.equal((await envia(tok2, '0', png)).status, 400); ok('rejeita comprovante sem valor');
  const antes = (await call('GET', `/api/publico/${tok2}`)).body.saldo;
  r = await envia(tok2, '20', png); assert.equal(r.status, 201); const pid2 = r.body.id;
  assert.equal((await call('GET', `/api/publico/${tok2}`)).body.saldo, antes); ok('comprovante enviado NÃO abate o saldo antes de confirmar');
  r = await call('GET', '/api/pagamentos-informados', null, A); assert.equal(r.body.length, 1); assert.equal(r.body[0].cliente_nome, 'Maria Souza'); ok('dono vê comprovante pendente');
  assert.equal((await call('GET', `/api/pagamentos-informados/${pid2}/comprovante`, null, B)).status, 404); ok('outro mercado não acessa o comprovante');
  const img = await fetch(`${base}/api/pagamentos-informados/${pid2}/comprovante`, { headers: { authorization: 'Bearer ' + A } });
  assert.equal(img.headers.get('content-type'), 'image/png'); assert.equal(Buffer.from(await img.arrayBuffer()).length, png.length); ok('dono baixa a imagem do comprovante');
  r = await call('POST', `/api/pagamentos-informados/${pid2}/confirmar`, {}, A);
  assert.equal(r.body.saldo, antes - 2000); ok('confirmar abate o saldo');
  assert.equal((await call('POST', `/api/pagamentos-informados/${pid2}/confirmar`, {}, A)).status, 409); ok('não confirma duas vezes (sem abatimento duplo)');
  r = await envia(tok2, '5', png); await call('POST', `/api/pagamentos-informados/${r.body.id}/recusar`, { motivo: 'valor não caiu' }, A);
  r = await call('GET', `/api/publico/${tok2}/extras`);
  assert.deepEqual(r.body.pagamentos_informados.map((x) => x.status), ['recusado', 'confirmado']); ok('cliente acompanha status (confirmado/recusado)');

  // ---- portal do cliente (login por telefone + PIN) ----
  const slug = (await call('GET', '/api/mercado', null, A)).body.slug;
  assert.match(slug, /^mercado-a-[0-9a-f]{4}$/); ok('mercado ganha endereço fixo (slug)');
  r = await call('GET', `/api/app/${slug}`); assert.equal(r.body.mercado, 'Mercado A'); assert.equal(r.body.promocoes.length, 1); ok('página pública do mercado mostra promoções sem login');
  assert.equal((await call('GET', '/api/app/nao-existe-123')).status, 404);
  assert.equal((await call('POST', `/api/app/${slug}/entrar`, { telefone: '81988887777', pin: '1234' })).status, 401); ok('sem ativação não entra');
  r = await call('POST', `/api/clientes/${cid}/codigo-acesso`, null, A);
  assert.match(r.body.codigo, /^\d{6}$/); assert.ok(r.body.link_wa.includes('wa.me/5581988887777')); const cod = r.body.codigo; ok('dono gera código de acesso de 6 dígitos');
  assert.equal((await call('POST', `/api/clientes/${cid}/codigo-acesso`, null, B)).status, 404); ok('outro mercado não gera código para meu cliente');
  assert.equal((await call('POST', `/api/app/${slug}/ativar`, { telefone: '81988887777', codigo: '000000', pin: '4321' })).status, 401); ok('código errado é recusado');
  assert.equal((await call('POST', `/api/app/${slug}/ativar`, { telefone: '(81) 98888-7777', codigo: cod, pin: '12' })).status, 400); ok('PIN fraco/curto é recusado');
  r = await call('POST', `/api/app/${slug}/ativar`, { telefone: '(81) 98888-7777', codigo: cod, pin: '4321' });
  assert.equal(r.status, 200); ok('primeiro acesso com código cria o PIN (telefone aceita máscara)');
  assert.equal((await call('POST', `/api/app/${slug}/ativar`, { telefone: '81988887777', codigo: cod, pin: '9999' })).status, 401); ok('código só funciona uma vez');
  assert.equal((await call('POST', `/api/app/${slug}/entrar`, { telefone: '81988887777', pin: '0000' })).status, 401); ok('PIN errado é recusado');
  r = await call('POST', `/api/app/${slug}/entrar`, { telefone: '+55 81 98888-7777', pin: '4321' });
  assert.equal(r.status, 200); assert.equal((await call('GET', `/api/publico/${r.body.token}`)).body.cliente, 'Maria'); ok('login com telefone + PIN abre a conta do cliente');
  // login no slug de OUTRO mercado não funciona
  const slugB = (await call('GET', '/api/mercado', null, B)).body.slug;
  assert.equal((await call('POST', `/api/app/${slugB}/entrar`, { telefone: '81988887777', pin: '4321' })).status, 401); ok('cliente não entra pelo endereço de outro mercado');
  // força bruta: depois de várias tentativas, bloqueia (mesmo com PIN certo)
  let bloqueou = false; for (let i = 0; i < 10; i++) { const x = await call('POST', `/api/app/${slug}/entrar`, { telefone: '81988887777', pin: '1111' }); if (x.status === 429) bloqueou = true; }
  assert.ok(bloqueou); assert.equal((await call('POST', `/api/app/${slug}/entrar`, { telefone: '81988887777', pin: '4321' })).status, 429); ok('bloqueia tentativas em excesso (anti força bruta)');
  r = await fetch(`${base}/m/${slug}/manifest.webmanifest`).then((x) => x.json()); assert.equal(r.start_url, `/m/${slug}`); ok('manifest PWA por mercado');
  const qr = await fetch(`${base}/api/mercado/qr`, { headers: { authorization: 'Bearer ' + A } }); assert.ok((await qr.text()).includes('<svg')); ok('QR code do mercado');

  r = await call('GET', '/api/resumo', null, A);
  assert.ok(r.body.total_a_receber >= 0 && r.body.clientes_devendo >= 0); ok('resumo do painel');

  await extras({ db, base, call, ok, A, B, slug });
  await testaAdmin({ db, base, call, ok, slug });
  console.log(`\n${n} verificações passaram.`);
  server.close(); await db.close();
})().catch((e) => { console.error('FALHOU:', e); process.exit(1); });
