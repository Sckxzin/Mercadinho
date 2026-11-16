// Testes das correções e funcionalidades da v0.5 (chamado por scripts/test.js)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const U = require('../src/util');
const { open, MIGRACOES } = require('../src/db');
const { rotinaDiaria } = require('../src/rotina');
const { idadeDaDivida } = require('../src/rotas/relatorios');
const { proximoVencimento } = require('../src/rotas/publico');
const wa = require('../src/whatsapp');

module.exports = async function extras({ db, base, call, ok, A, B, slug }) {
  // token padrão: o do dono do Mercado A (lido na hora da chamada, pois muda após trocar a senha)
  const get = (p, t = A) => call('GET', p, null, t);
  const post = (p, b, t = A) => call('POST', p, b || {}, t);
  const patch = (p, b, t = A) => call('PATCH', p, b, t);
  const del = (p, t = A) => call('DELETE', p, null, t);
  const raw = (p, t) => fetch(base + p, { headers: { authorization: 'Bearer ' + t } });
  const saldo = async (id, t = A) => (await get(`/api/clientes/${id}/extrato`, t)).body.saldo;
  const novoCli = async (nome, extra = {}, t) => (await post('/api/clientes', { nome, ...extra }, t)).body;

  console.log('\n  — valores, datas e utilidades —');
  for (const [entrada, esperado] of [['12,50', 1250], ['12.50', 1250], ['1.234,56', 123456], ['1,234.56', 123456], ['R$ 1.234', 123400], ['1.234.567,89', 123456789],
    ['0,99', 99], ['10', 1000], [12.5, 1250], ['  7,5 ', 750]]) assert.equal(U.toCents(entrada), esperado, `toCents(${entrada})`);
  for (const ruim of ['abc', '', '1,2,3', '12.34.5', '1..2', null, undefined, '1e5', 'NaN', Infinity]) assert.ok(Number.isNaN(U.toCents(ruim)), `toCents(${ruim}) deveria ser NaN`);
  ok('valores com ponto de milhar e vírgula ("1.234,56") são entendidos; lixo é recusado');
  assert.equal(U.centavos('-5'), null); assert.equal(U.centavos('0'), null); assert.equal(U.centavos('0', { min: 0 }), 0); ok('valores negativos ou zero são recusados onde não fazem sentido');

  assert.equal(U.hojeISO(new Date('2026-01-01T02:30:00Z')), '2025-12-31'); // 23h30 do dia 31 em Brasília
  assert.equal(U.hojeISO(new Date('2026-01-01T03:30:00Z')), '2026-01-01');
  assert.equal(U.inicioMesUTC(new Date('2026-03-01T01:00:00Z')), '2026-02-01 03:00:00'); // ainda é fevereiro em Brasília
  assert.equal(U.inicioDiaUTC('2026-11-16'), '2026-11-16 03:00:00');
  ok('"hoje" e "este mês" seguem o horário de Brasília (não UTC)');
  assert.ok(U.dataValida('2026-02-28') && !U.dataValida('2026-02-30') && !U.dataValida('16/11/2026')); ok('datas impossíveis (30/02) são recusadas');

  U.limite('teste-faxina', 1, 1000);
  assert.ok(U.faxinaLimites(Date.now() + 2 * 60 * 60_000) === 0); ok('contador anti-abuso é limpo (sem vazamento de memória)');
  assert.equal(U.verifica('a.b'), null); assert.equal(U.verifica('xx'), null); assert.equal(U.verifica(null), null); ok('token malformado não derruba o servidor');

  for (const [rota, tipo] of [['/assets/ui.css', 'text/css'], ['/assets/icon-192.png', 'image/png'], [`/m/${slug}`, 'text/html'], ['/painel', 'text/html'], ['/c/qualquer-token-1234567890', 'text/html'], ['/sw.js', 'javascript']]) {
    const x = await fetch(base + rota); assert.equal(x.status, 200, rota); assert.ok(x.headers.get('content-type').includes(tipo), rota);
  }
  ok('páginas, estilos e ícones são servidos (painel, app do cliente, link pessoal)');
  const h = await fetch(base + '/painel');
  assert.ok(h.headers.get('content-security-policy').includes("frame-ancestors 'none'")); assert.equal(h.headers.get('x-frame-options'), 'DENY'); ok('cabeçalhos de segurança (CSP, anti-iframe)');

  const cont = await get('/api/contadores'); assert.ok(['comprovantes', 'avisos', 'validade'].every((k) => Number.isInteger(cont.body[k]))); ok('contadores das abas numa chamada só');

  console.log('\n  — lançamentos —');
  const c1 = await novoCli('Joana Teste', { telefone: '81 97777-0001', limite: '1.000' });
  assert.equal(c1.limite, 100000); ok('limite "1.000" vira R$ 1.000,00');
  let r = await post(`/api/clientes/${c1.id}/compras`, { valor: '1.234,56', forcar: true });
  assert.equal(r.status, 201); assert.equal(r.body.saldo, 123456); ok('compra de "1.234,56" lança R$ 1.234,56');
  assert.equal((await post(`/api/clientes/${c1.id}/compras`, { valor: 'abc' })).status, 400);
  assert.equal((await post(`/api/clientes/${c1.id}/pagamentos`, { valor: '-10' })).status, 400);
  assert.equal((await post('/api/clientes', { nome: 'X', limite: 'muito' })).status, 400); ok('valor inválido é recusado com mensagem (sem gravar lixo)');

  // limite sob concorrência: 6 compras de R$30 ao mesmo tempo num limite de R$100
  const c2 = await novoCli('Concorrência', { limite: '100' });
  const rs = await Promise.all(Array.from({ length: 6 }, () => post(`/api/clientes/${c2.id}/compras`, { valor: '30' })));
  assert.equal(rs.filter((x) => x.status === 201).length, 3); assert.equal(await saldo(c2.id), 9000); ok('compras simultâneas não furam o limite (transação + trava)');

  // estorno
  const l1 = (await post(`/api/clientes/${c2.id}/pagamentos`, { valor: '20', forma: 'dinheiro' })).body.id;
  const est = await Promise.all(Array.from({ length: 4 }, () => post(`/api/lancamentos/${l1}/estornar`, { motivo: 'teste' })));
  assert.equal(est.filter((x) => x.status === 200).length, 1); assert.ok(est.filter((x) => x.status === 409).length === 3);
  assert.equal(await saldo(c2.id), 9000); ok('estorno só acontece uma vez, mesmo com cliques simultâneos');
  let ex = (await get(`/api/clientes/${c2.id}/extrato`)).body;
  const estorno = ex.lancamentos.find((l) => l.estorno_de === l1);
  assert.ok(estorno && ex.lancamentos.find((l) => l.id === l1).estornado);
  assert.equal((await post(`/api/lancamentos/${estorno.id}/estornar`, {})).status, 400); ok('não dá para estornar um estorno; extrato marca o que foi estornado');

  // extrato paginado
  ex = (await get(`/api/clientes/${c2.id}/extrato?limit=2`)).body;
  assert.equal(ex.lancamentos.length, 2); assert.ok(ex.tem_mais);
  const pag2 = (await get(`/api/clientes/${c2.id}/extrato?limit=2&antes=${ex.lancamentos[1].id}`)).body;
  assert.ok(pag2.lancamentos.every((l) => l.id < ex.lancamentos[1].id)); assert.ok(ex.lancamentos[0].usuario); ok('extrato paginado ("carregar mais") e mostra quem lançou');

  console.log('\n  — clientes —');
  assert.equal((await post('/api/clientes', { nome: 'Duplicado', telefone: '+55 (81) 97777-0001' })).status, 409);
  const c3 = await novoCli('Outro Telefone', { telefone: '81977770003' });
  assert.equal((await patch(`/api/clientes/${c3.id}`, { telefone: '81977770001' })).status, 409);
  assert.equal((await post('/api/clientes', { nome: 'Tel curto', telefone: '1234' })).status, 400); ok('telefone duplicado no mesmo mercado é recusado (login do app seguro)');
  assert.equal((await post('/api/clientes', { nome: 'Mesmo tel em outro mercado', telefone: '81977770001' }, B)).status, 201); ok('o mesmo telefone pode existir em outro mercado');
  await novoCli('José Ávila');
  r = await get('/api/clientes?q=jose avila'); assert.equal(r.body.length, 1); assert.equal(r.body[0].nome, 'José Ávila'); ok('busca ignora acentos ("jose" acha "José")');
  r = await get('/api/clientes?q=977770003'); assert.equal(r.body[0]?.nome, 'Outro Telefone'); ok('busca por telefone');
  const todos = await fetch(base + '/api/clientes?limit=2', { headers: { authorization: 'Bearer ' + A } });
  assert.equal((await todos.json()).length, 2); assert.ok(Number(todos.headers.get('x-total-count')) > 2); ok('lista de clientes paginada (total no cabeçalho)');
  r = await get('/api/clientes?devendo=1'); assert.ok(r.body.length > 0 && r.body.every((c) => c.saldo > 0)); ok('filtro "só quem deve"');
  await patch(`/api/clientes/${c3.id}`, { ativo: false });
  assert.ok(!(await get('/api/clientes')).body.some((c) => c.id === c3.id)); assert.ok((await get('/api/clientes?arquivados=1')).body.some((c) => c.id === c3.id));
  assert.equal((await post(`/api/clientes/${c3.id}/compras`, { valor: '5' })).status, 409); ok('arquivar cliente: some da lista e não recebe lançamentos');
  assert.equal((await patch(`/api/clientes/${c1.id}`, { dia_vencimento: 31 })).status, 400);
  assert.equal((await patch(`/api/clientes/${c1.id}`, { dia_vencimento: 10 })).status, 200); ok('dia de vencimento da conta (1 a 28)');

  console.log('\n  — equipe e sessão —');
  assert.equal((await get('/api/eu', A)).body.papel, 'dono');
  r = await post('/api/equipe', { nome: 'Caixa Um', email: 'caixa@a.com', senha: 'caixa12345' }); assert.equal(r.status, 201); const caixaId = r.body.id;
  assert.equal((await post('/api/equipe', { nome: 'Dup', email: 'CAIXA@a.com', senha: 'caixa12345' })).status, 409);
  assert.equal((await post('/api/registro', { nome: 'Outro', email: 'caixa@a.com', senha: 'senha12345' })).status, 409); ok('dono cadastra caixa (email único no sistema)');
  r = await post('/api/login', { email: 'caixa@a.com', senha: 'caixa12345' }); assert.equal(r.body.usuario.papel, 'caixa'); const C = r.body.token;
  assert.equal((await post(`/api/clientes/${c1.id}/compras`, { valor: '5', forcar: true }, C)).status, 201);
  assert.equal((await get('/api/clientes', C)).status, 200); ok('caixa lança compras e vê clientes');
  for (const [m, p, b] of [['PATCH', '/api/mercado', { nome: 'Hack' }], ['GET', '/api/relatorios'], ['GET', '/api/export/backup.json'], ['GET', '/api/equipe'],
    ['POST', `/api/lancamentos/${l1}/estornar`, {}], ['PATCH', `/api/clientes/${c1.id}`, { limite: '99999' }], ['GET', '/api/auditoria']])
    assert.equal((await call(m, p, b, C)).status, 403, `${m} ${p} deveria ser proibido ao caixa`);
  ok('caixa NÃO estorna, não muda limite/config, não vê relatórios, backup nem equipe');
  ex = (await get(`/api/clientes/${c1.id}/extrato`)).body; assert.equal(ex.lancamentos[0].usuario, 'Caixa Um'); ok('lançamento registra quem fez (caixa)');
  await patch(`/api/equipe/${caixaId}`, { ativo: false });
  assert.equal((await get('/api/clientes', C)).status, 401); assert.equal((await post('/api/login', { email: 'caixa@a.com', senha: 'caixa12345' })).status, 403); ok('desativar caixa derruba a sessão na hora');

  assert.equal((await post('/api/eu/senha', { atual: 'errada', nova: 'novasenha123' })).status, 400);
  r = await post('/api/eu/senha', { atual: 'senha12345', nova: 'novasenha123' }); assert.equal(r.status, 200); const A2 = r.body.token;
  assert.equal((await get('/api/clientes', A)).status, 401); assert.equal((await get('/api/clientes', A2)).status, 200);
  assert.equal((await post('/api/login', { email: 'a@a.com', senha: 'novasenha123' })).status, 200); ok('trocar senha: aparelhos antigos saem, este continua');
  await post('/api/eu/sair-de-todos', {}, A2); assert.equal((await get('/api/clientes', A2)).status, 401); ok('"sair de todos os aparelhos" funciona');
  A = (await post('/api/login', { email: 'a@a.com', senha: 'novasenha123' })).body.token;

  console.log('\n  — comprovantes, cobranças e rotina —');
  const cliTok = (await get(`/api/clientes/${c2.id}/extrato`)).body.cliente.url.split('/').pop();
  await patch('/api/mercado', { pix_chave: 'pix@a.com' });
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20, 1)]);
  const comp = await fetch(`${base}/api/publico/${cliTok}/comprovante?valor=10,00`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: png }).then((x) => x.json());
  const antes = await saldo(c2.id);
  const conf = await Promise.all([1, 2, 3].map(() => post(`/api/pagamentos-informados/${comp.id}/confirmar`, { valor: '10,00' })));
  assert.equal(conf.filter((x) => x.status === 200).length, 1); assert.equal(await saldo(c2.id), antes - 1000); ok('comprovante confirmado uma vez só (transação), mesmo com cliques simultâneos');

  r = await post(`/api/clientes/${c1.id}/cobrar`); assert.ok(r.body.link_wa.startsWith('https://wa.me/5581977770001'));
  assert.equal((await post(`/api/clientes/${(await novoCli('Sem tel')).id}/cobrar`)).status, 400); ok('cobrança manual exige telefone');

  // rotina diária: lembrete de vencimento e cobrança semanal
  const hoje = U.hojeISO();
  const dia = Number(U.addDias(hoje, 3).slice(8));
  const cv = await novoCli('Vence Logo', { telefone: '81977770010' });
  await post(`/api/clientes/${cv.id}/compras`, { valor: '50' });
  if (dia <= 28) await patch(`/api/clientes/${cv.id}`, { dia_vencimento: dia });
  const cc = await novoCli('Cobrança Semanal', { telefone: '81977770011' });
  await post(`/api/clientes/${cc.id}/compras`, { valor: '80' });
  const silencioso = () => {};
  let rel = await rotinaDiaria(db, { hoje, base, log: silencioso, env: {} });
  const relA = rel.find((x) => x.mercado === 'Mercado A');
  if (dia <= 28) assert.ok(relA.filas.some((f) => f.cliente === 'Vence Logo' && f.tipo === 'vencimento'));
  assert.ok(relA.filas.some((f) => f.cliente === 'Cobrança Semanal' && f.tipo === 'cobranca'));
  rel = await rotinaDiaria(db, { hoje, base, log: silencioso, env: {} });
  assert.equal(rel.find((x) => x.mercado === 'Mercado A').filas.length, 0); ok('rotina: lembrete de vencimento e cobrança semanal, sem repetir no mesmo período');
  assert.deepEqual(proximoVencimento(10, '2026-11-16'), { data: '2026-12-10', dias: 24 });
  assert.deepEqual(proximoVencimento(20, '2026-12-16'), { data: '2026-12-20', dias: 4 });
  assert.deepEqual(proximoVencimento(5, '2026-12-16'), { data: '2027-01-05', dias: 20 }); ok('cálculo do próximo vencimento (inclusive virada de ano)');

  let fila = (await get('/api/notificacoes')).body;
  const nc = fila.find((x) => x.cliente_nome === 'Cobrança Semanal');
  r = await post(`/api/notificacoes/${nc.id}/enviar`); assert.ok(r.body.link_wa.includes('wa.me/5581977770011'));
  assert.equal((await post(`/api/notificacoes/${nc.id}/enviar`)).status, 404); ok('fila de cobranças no painel: enviar com 1 toque');
  if (dia <= 28) {
    const nv = fila.find((x) => x.cliente_nome === 'Vence Logo');
    await post(`/api/clientes/${cv.id}/pagamentos`, { valor: '50' });
    r = await post(`/api/notificacoes/${nv.id}/enviar`); assert.equal(r.status, 409); ok('quem já pagou não recebe a cobrança da fila');
  }
  fila = (await get('/api/notificacoes')).body;
  for (const x of fila) await post(`/api/notificacoes/${x.id}/descartar`);
  assert.equal((await get('/api/notificacoes')).body.length, 0); ok('descartar mensagens da fila');

  // WhatsApp automático (API oficial) com resposta simulada
  const env = { WA_TOKEN: 't', WA_PHONE_ID: '123', WA_TEMPLATE: 'cobranca' };
  const chamadas = [];
  const fetchOk = async (u, o) => { chamadas.push({ u, body: JSON.parse(o.body), auth: o.headers.authorization }); return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'wamid.1' }] }) }; };
  const ca = await novoCli('Auto Envio', { telefone: '81977770020' }); await post(`/api/clientes/${ca.id}/compras`, { valor: '40' });
  rel = await rotinaDiaria(db, { hoje, base, log: silencioso, env, fetchFn: fetchOk });
  assert.ok(rel.find((x) => x.mercado === 'Mercado A').enviadas >= 1);
  const ch = chamadas.find((x) => x.body.to === '5581977770020');
  assert.ok(ch && ch.u.endsWith('/123/messages') && ch.auth === 'Bearer t' && ch.body.template.name === 'cobranca' && ch.body.template.components[0].parameters[0].text === 'Auto');
  const ce = await novoCli('Erro Envio', { telefone: '81977770021' }); await post(`/api/clientes/${ce.id}/compras`, { valor: '40' });
  await rotinaDiaria(db, { hoje, base, log: silencioso, env, fetchFn: async () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'template não aprovado' } }) }) });
  assert.ok((await get('/api/notificacoes')).body.some((x) => x.cliente_nome === 'Erro Envio' && x.status === 'erro' && x.erro.includes('template'))); ok('WhatsApp automático (API oficial): envia pelo template e registra erro na fila');
  await assert.rejects(wa.enviar({ telefone: '1', params: [] }, { env: {} }), /não configurado/); ok('sem configuração, o envio automático fica desligado');

  console.log('\n  — produtos —');
  const pr = (await post('/api/produtos', { nome: 'Café 500g', codigo: '7890000000001', alerta_dias: 10 })).body.id;
  assert.equal((await post('/api/produtos', { nome: 'Outro', codigo: '7890000000001' })).status, 409);
  assert.equal((await get('/api/produtos/codigo/7890000000001')).body.id, pr); ok('produto com código de barras (único, busca pelo código)');
  assert.equal((await patch(`/api/produtos/${pr}`, { nome: 'Café 1kg', alerta_dias: 5 })).status, 200);
  assert.equal((await patch(`/api/produtos/${pr}`, { alerta_dias: -1 })).status, 400); ok('editar produto');
  assert.equal((await post(`/api/produtos/${pr}/entradas`, { quantidade: 5, validade: '2026-02-30' })).status, 400);
  assert.equal((await post(`/api/produtos/${pr}/entradas`, { quantidade: 2.5, validade: U.addDias(hoje, 30) })).status, 400);
  const ent = (await post(`/api/produtos/${pr}/entradas`, { quantidade: 5, validade: U.addDias(hoje, 2), custo: '12,90' })).body.id;
  r = await get(`/api/produtos/${pr}/entradas`); assert.equal(r.body[0].dias_restantes, 2); assert.equal(r.body[0].custo, 1290); ok('lotes do produto com dias restantes');
  assert.equal((await post(`/api/entradas/${ent}/baixar`)).status, 200); assert.equal((await post(`/api/entradas/${ent}/baixar`)).status, 404); ok('dar baixa duas vezes avisa');
  assert.equal((await del(`/api/produtos/${pr}`, B)).status, 404);
  assert.equal((await del(`/api/produtos/${pr}`)).status, 200); assert.equal((await get('/api/produtos/codigo/7890000000001')).status, 404); ok('excluir produto (só do próprio mercado)');

  console.log('\n  — relatórios, exportação e auditoria —');
  // idade da dívida (FIFO): compra antiga de 100, compra nova de 50, pagamento de 60 => 40 antigos + 50 novos
  const velho = U.inicioDiaUTC(U.addDias(hoje, -70)).replace(' 03:', ' 15:');
  const idade = idadeDaDivida([{ valor: 10000, criado_em: velho }, { valor: 5000, criado_em: U.agoraUTC() }, { valor: -6000, criado_em: U.agoraUTC() }], hoje);
  assert.equal(idade.dias, 70); assert.deepEqual(idade.porFaixa, { '61-90': 4000, '0-30': 5000 }); ok('idade da dívida: pagamentos quitam primeiro as compras mais antigas');
  const cvelho = await novoCli('Devedor Antigo');
  await db.run("INSERT INTO lancamentos (mercado_id,cliente_id,tipo,valor,criado_em) VALUES ((SELECT mercado_id FROM clientes WHERE id=?),?,'compra',7000,?)", [cvelho.id, cvelho.id, velho]);
  r = await get('/api/relatorios'); assert.equal(r.status, 200);
  const dv = r.body.devedores.find((d) => d.nome === 'Devedor Antigo'); assert.equal(dv.faixa, '61-90'); assert.equal(dv.dias, 70);
  assert.ok(r.body.faixas['61-90'] >= 7000); assert.ok(r.body.recebido_por_forma.length > 0); ok('relatório: devedores por idade da dívida e recebido por forma');
  r = await get('/api/resumo'); assert.ok(r.body.recebido_hoje > 0); ok('resumo mostra recebido hoje');
  const cz = await novoCli('Estorno no Mês'); const f0 = (await get('/api/resumo')).body.fiado_no_mes;
  const lz = (await post(`/api/clientes/${cz.id}/compras`, { valor: '33' })).body.id;
  assert.equal((await get('/api/resumo')).body.fiado_no_mes, f0 + 3300);
  await post(`/api/lancamentos/${lz}/estornar`, {}); assert.equal((await get('/api/resumo')).body.fiado_no_mes, f0); ok('compra estornada sai do "fiado no mês"');

  const cf = await novoCli('=HYPERLINK("http://mal")'); await post(`/api/clientes/${cf.id}/compras`, { valor: '1' });
  let resp = await raw('/api/export/clientes.csv', A); const bytes = Buffer.from(await resp.arrayBuffer()); let txt = bytes.toString('utf8');
  assert.ok(resp.headers.get('content-type').startsWith('text/csv') && resp.headers.get('content-disposition').includes('clientes-'));
  assert.ok(txt.startsWith('﻿ID;Nome;Telefone;Saldo (R$)')); assert.ok(txt.includes('"\'=HYPERLINK(""http://mal"")"')); ok('CSV de clientes (abre no Excel, protegido contra fórmula maliciosa)');
  resp = await raw(`/api/export/lancamentos.csv?de=${hoje}&ate=${hoje}`, A); txt = await resp.text();
  assert.ok(txt.includes('Lançado por') && txt.includes('Caixa Um') && !txt.includes('Devedor Antigo')); ok('CSV de lançamentos por período');
  resp = await raw('/api/export/backup.json', A); const bk = await resp.json(); const bks = JSON.stringify(bk);
  assert.ok(bk.clientes.length > 3 && bk.lancamentos.length > 3); assert.ok(!/senha_hash|pin_hash|codigo_hash|comprovante"/.test(bks)); ok('backup completo em JSON, sem senhas nem PINs');
  assert.ok(!JSON.stringify(await (await raw('/api/export/backup.json', B)).json()).includes('Joana')); ok('backup só tem dados do próprio mercado');
  r = await get('/api/auditoria'); const acoes = r.body.itens.map((x) => x.acao);
  for (const a of ['lancamento.estornado', 'equipe.adicionado', 'equipe.desativado', 'senha.trocada', 'comprovante.confirmado', 'export.backup', 'compra.acima_limite', 'cliente.editado'])
    assert.ok(acoes.includes(a), `auditoria sem ${a}`);
  ok('auditoria registra quem fez estorno, troca de senha, equipe, comprovante e exportação');
  assert.equal((await get('/api/auditoria', B)).body.itens.filter((x) => x.acao === 'lancamento.estornado').length, 0); ok('auditoria isolada por mercado');

  console.log('\n  — portal / página do cliente —');
  r = await get(`/api/publico/${(await get(`/api/clientes/${c1.id}/extrato`)).body.cliente.url.split('/').pop()}`);
  assert.equal(r.body.vencimento.data.slice(8), '10'); ok('cliente vê a data de vencimento da conta');
  assert.equal((await post(`/api/app/${slug}/entrar`, { telefone: '81977770001', pin: '0000' })).status, 401); ok('login do app usa o telefone normalizado');

  console.log('\n  — migração de um banco antigo (v0.4) —');
  await testaMigracao(ok);
};

async function testaMigracao(ok) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caderneta-mig-'));
  try {
    const { PGlite } = require('@electric-sql/pglite');
    const pg = new PGlite(dir);
    await pg.exec(MIGRACOES[0]); // banco como era na v0.4, sem tabela de migrações
    await pg.exec(`INSERT INTO mercados (nome,email,senha_hash,slug) VALUES ('Antigo','velho@x.com','${U.hashSenha('senhaantiga1')}','antigo-0001');
      INSERT INTO clientes (mercado_id,nome,telefone,token) VALUES (1,'Cli','+55 (81) 98888-1111','${U.novoToken()}');
      INSERT INTO lancamentos (mercado_id,cliente_id,tipo,valor) VALUES (1,1,'compra',1000);
      INSERT INTO lancamentos (mercado_id,cliente_id,tipo,valor,descricao) VALUES (1,1,'ajuste',-1000,'Estorno do lançamento #1: x');
      INSERT INTO lancamentos (mercado_id,cliente_id,tipo,valor,descricao) VALUES (1,1,'ajuste',-1000,'Estorno do lançamento #1');`);
    await pg.close();
    const abre = async () => {
      const antigo = process.env.PGLITE_DIR, durl = process.env.DATABASE_URL;
      process.env.PGLITE_DIR = dir; delete process.env.DATABASE_URL;
      try { return await open(); } finally {
        if (antigo === undefined) delete process.env.PGLITE_DIR; else process.env.PGLITE_DIR = antigo;
        if (durl) process.env.DATABASE_URL = durl;
      }
    };
    const db = await abre();
    const u = await db.get("SELECT * FROM usuarios WHERE email='velho@x.com'");
    assert.equal(u.papel, 'dono'); assert.ok(U.confereSenha('senhaantiga1', u.senha_hash)); ok('dono do banco antigo vira usuário "dono" com a mesma senha');
    assert.equal((await db.get('SELECT telefone_norm FROM clientes WHERE id=1')).telefone_norm, '81988881111'); ok('telefones antigos são normalizados');
    const ests = await db.all("SELECT id,estorno_de FROM lancamentos WHERE tipo='ajuste' ORDER BY id");
    assert.equal(ests[0].estorno_de, 1); assert.equal(ests[1].estorno_de, null); ok('estornos antigos ligados ao original (e o duplicado não quebra a migração)');
    assert.equal((await db.all('SELECT versao FROM schema_migracoes ORDER BY versao')).length, MIGRACOES.length);
    await db.run("INSERT INTO lancamentos (mercado_id,cliente_id,tipo,valor,descricao) VALUES (1,1,'ajuste',5,'marcador')");
    await db.close();
    const db2 = await abre(); // reabrir não pode reaplicar nada
    assert.equal((await db2.get("SELECT COUNT(*) AS n FROM usuarios")).n, 1);
    assert.equal((await db2.get("SELECT COUNT(*) AS n FROM lancamentos WHERE descricao='marcador'")).n, 1);
    await db2.close();
    ok('migrações registradas e não rodam duas vezes');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
