// Dados de demonstração: npm run seed   (use DATABASE_URL para popular o Supabase)
const { open } = require('../src/db');
const U = require('../src/util');

(async () => {
  const db = await open();
  if (await db.get('SELECT 1 AS x FROM mercados LIMIT 1')) { console.log('Banco já tem dados. Nada feito.'); return db.close(); }
  const m = (await db.run('INSERT INTO mercados (nome,email,senha_hash,pix_chave,whatsapp,cidade,slug) VALUES (?,?,?,?,?,?,?)',
    ['Mercadinho Demo', 'demo@demo.com', U.hashSenha('demo12345'), 'pix@mercadinhodemo.com', '81999990000', 'Escada', U.slugify('Mercadinho Demo')])).id;
  await db.run("INSERT INTO usuarios (mercado_id,nome,email,senha_hash,papel) VALUES (?,?,?,?,'dono')", [m, 'Mercadinho Demo', 'demo@demo.com', U.hashSenha('demo12345')]);
  await db.run("INSERT INTO usuarios (mercado_id,nome,email,senha_hash,papel) VALUES (?,?,?,?,'caixa')", [m, 'Ana (caixa)', 'caixa@demo.com', U.hashSenha('caixa12345')]);
  const cli = async (nome, tel, lim, dia = null) => (await db.run('INSERT INTO clientes (mercado_id,nome,telefone,telefone_norm,limite,dia_vencimento,token,aceitou_em) VALUES (?,?,?,?,?,?,?,?)', [m, nome, tel, U.normTel(tel), lim, dia, U.novoToken(), U.agoraUTC()])).id;
  const lan = (c, tipo, v, d) => db.run('INSERT INTO lancamentos (mercado_id,cliente_id,tipo,valor,descricao) VALUES (?,?,?,?,?)', [m, c, tipo, v, d]);
  const a = await cli('Dona Maria Souza', '81988880001', 30000, 10), b = await cli('Seu José Lima', '81988880002', 20000);
  await lan(a, 'compra', 8750, 'arroz, feijão, óleo'); await lan(a, 'compra', 4210, 'carne e pão'); await lan(a, 'pagamento', -5000, null);
  await lan(b, 'compra', 15900, 'compra do mês');
  const d = (n) => U.addDias(U.hojeISO(), n);
  const p = async (n, dias, cod = null) => (await db.run('INSERT INTO produtos (mercado_id,nome,alerta_dias,codigo) VALUES (?,?,?,?)', [m, n, dias, cod])).id;
  const ent = (pid, q, v) => db.run('INSERT INTO entradas (mercado_id,produto_id,quantidade,validade) VALUES (?,?,?,?)', [m, pid, q, v]);
  await ent(await p('Leite integral 1L', 5, '7891000100103'), 24, d(3)); await ent(await p('Iogurte', 3), 12, d(-1)); await ent(await p('Biscoito', 15), 30, d(60));
  const pr = (t, dsc, pc, po, v) => db.run('INSERT INTO promocoes (mercado_id,titulo,descricao,preco,preco_original,validade) VALUES (?,?,?,?,?,?)', [m, t, dsc, pc, po, v]);
  await pr('Arroz 5kg', 'Só até acabar o estoque', 2490, 2990, d(5)); await pr('Leite 1L (leve 6)', 'Cada unidade', 479, 569, d(3));
  console.log('Seed ok. Dono: demo@demo.com / demo12345 · Caixa: caixa@demo.com / caixa12345');
  await db.close();
})().catch((e) => { console.error(e); process.exit(1); });
