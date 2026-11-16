// Resumo do painel, relatórios (idade da dívida), exportação (CSV / backup) e auditoria.
const U = require('../util');

const FAIXAS = [['0-30', 30], ['31-60', 60], ['61-90', 90], ['90+', Infinity]];
const faixaDe = (dias) => FAIXAS.find(([, max]) => dias <= max)[0];

// Idade da dívida pelo método FIFO: os pagamentos quitam primeiro as compras mais antigas.
// O que sobra em aberto diz há quantos dias o cliente deve.
function idadeDaDivida(lancs, hoje) {
  let credito = lancs.filter((l) => l.valor < 0).reduce((s, l) => s - l.valor, 0);
  const abertos = [];
  for (const l of lancs.filter((x) => x.valor > 0)) {
    const usado = Math.min(credito, l.valor);
    credito -= usado;
    if (l.valor - usado > 0) abertos.push({ valor: l.valor - usado, dia: U.hojeISO(new Date(l.criado_em.replace(' ', 'T') + 'Z')) });
  }
  if (!abertos.length) return null;
  const porFaixa = {};
  for (const a of abertos) { const f = faixaDe(U.diasEntre(a.dia, hoje)); porFaixa[f] = (porFaixa[f] || 0) + a.valor; }
  return { dias: U.diasEntre(abertos[0].dia, hoje), porFaixa };
}

module.exports = function registraRelatorios({ api, db, audita, soDono }) {
  api.get('/resumo', async (req, res) => {
    const inicioMes = U.inicioMesUTC(), inicioHoje = U.inicioDiaUTC(U.hojeISO());
    const [s, dev, mes] = await Promise.all([
      db.get('SELECT COALESCE(SUM(valor),0) AS total FROM lancamentos WHERE mercado_id=?', [req.mid]),
      db.get('SELECT COUNT(*) AS n FROM (SELECT cliente_id FROM lancamentos WHERE mercado_id=? GROUP BY cliente_id HAVING SUM(valor)>0) x', [req.mid]),
      db.get(`SELECT COALESCE(SUM(CASE WHEN tipo='compra' THEN valor END),0) AS fiado,
          COALESCE(-SUM(CASE WHEN tipo='pagamento' THEN valor END),0) AS recebido,
          COALESCE(-SUM(CASE WHEN tipo='pagamento' AND criado_em >= ? THEN valor END),0) AS recebido_hoje
        FROM lancamentos WHERE mercado_id=? AND criado_em >= ?`, [inicioHoje, req.mid, inicioMes]),
    ]);
    res.json({ total_a_receber: s.total, clientes_devendo: dev.n, fiado_no_mes: mes.fiado, recebido_no_mes: mes.recebido, recebido_hoje: mes.recebido_hoje });
  });

  api.get('/relatorios', soDono, async (req, res) => {
    const hoje = U.hojeISO();
    const [lancs, clientes, formas] = await Promise.all([
      db.all(`SELECT l.cliente_id,l.valor,l.criado_em FROM lancamentos l
        WHERE l.mercado_id=? AND l.cliente_id IN (SELECT cliente_id FROM lancamentos WHERE mercado_id=? GROUP BY cliente_id HAVING SUM(valor)>0)
        ORDER BY l.cliente_id, l.id`, [req.mid, req.mid]),
      db.all('SELECT id,nome,telefone,ativo FROM clientes WHERE mercado_id=?', [req.mid]),
      db.all(`SELECT COALESCE(forma,'não informado') AS forma, -SUM(valor) AS total, COUNT(*) AS n FROM lancamentos
        WHERE mercado_id=? AND tipo='pagamento' AND criado_em >= ? GROUP BY 1 ORDER BY 2 DESC`, [req.mid, U.inicioMesUTC()]),
    ]);
    const porCliente = new Map();
    for (const l of lancs) { if (!porCliente.has(l.cliente_id)) porCliente.set(l.cliente_id, []); porCliente.get(l.cliente_id).push(l); }
    const nomes = new Map(clientes.map((c) => [c.id, c]));
    const faixas = Object.fromEntries(FAIXAS.map(([f]) => [f, 0]));
    const devedores = [];
    for (const [cid, ls] of porCliente) {
      const idade = idadeDaDivida(ls, hoje);
      if (!idade) continue;
      for (const [f, v] of Object.entries(idade.porFaixa)) faixas[f] += v;
      const c = nomes.get(cid) || {};
      devedores.push({ id: cid, nome: c.nome, telefone: c.telefone, arquivado: c.ativo === 0, saldo: ls.reduce((s, l) => s + l.valor, 0), dias: idade.dias, faixa: faixaDe(idade.dias) });
    }
    devedores.sort((a, b) => b.dias - a.dias || b.saldo - a.saldo);
    res.json({ hoje, faixas, devedores, recebido_por_forma: formas });
  });

  // ---------- exportação ----------
  const baixar = (res, nome, tipo, corpo) => res.set({ 'Content-Type': tipo, 'Content-Disposition': `attachment; filename="${nome}"`, 'Cache-Control': 'no-store' }).send(corpo);
  const dataBR = (s) => (s ? new Date(s.replace(' ', 'T') + 'Z').toLocaleString('pt-BR', { timeZone: U.TZ }) : '');

  api.get('/export/clientes.csv', soDono, async (req, res) => {
    const rows = await db.all(`SELECT c.id,c.nome,c.telefone,c.limite,c.dia_vencimento,c.ativo,c.criado_em,COALESCE(SUM(l.valor),0) AS saldo
      FROM clientes c LEFT JOIN lancamentos l ON l.cliente_id=c.id WHERE c.mercado_id=? GROUP BY c.id ORDER BY c.nome`, [req.mid]);
    await audita(req, 'export.clientes');
    baixar(res, `clientes-${U.hojeISO()}.csv`, 'text/csv; charset=utf-8', U.csv(rows, [
      ['id', 'ID'], ['nome', 'Nome'], ['telefone', 'Telefone'], [(r) => U.reaisCsv(r.saldo), 'Saldo (R$)'], [(r) => U.reaisCsv(r.limite), 'Limite (R$)'],
      ['dia_vencimento', 'Dia de vencimento'], [(r) => (r.ativo ? 'ativo' : 'arquivado'), 'Situação'], [(r) => dataBR(r.criado_em), 'Cadastrado em'],
    ]));
  });

  api.get('/export/lancamentos.csv', soDono, async (req, res) => {
    const de = U.dataValida(req.query.de) ? U.inicioDiaUTC(req.query.de) : '0000';
    const ate = U.dataValida(req.query.ate) ? U.inicioDiaUTC(U.addDias(req.query.ate, 1)) : '9999';
    const rows = await db.all(`SELECT l.id,l.criado_em,c.nome AS cliente,l.tipo,l.valor,l.forma,l.descricao,u.nome AS usuario
      FROM lancamentos l JOIN clientes c ON c.id=l.cliente_id LEFT JOIN usuarios u ON u.id=l.usuario_id
      WHERE l.mercado_id=? AND l.criado_em >= ? AND l.criado_em < ? ORDER BY l.id`, [req.mid, de, ate]);
    await audita(req, 'export.lancamentos');
    baixar(res, `lancamentos-${U.hojeISO()}.csv`, 'text/csv; charset=utf-8', U.csv(rows, [
      ['id', 'ID'], [(r) => dataBR(r.criado_em), 'Data'], ['cliente', 'Cliente'], ['tipo', 'Tipo'], [(r) => U.reaisCsv(r.valor), 'Valor (R$)'],
      ['forma', 'Forma'], ['descricao', 'Descrição'], ['usuario', 'Lançado por'],
    ]));
  });

  // Cópia de segurança completa do mercado (sem senhas, PINs nem imagens de comprovante)
  api.get('/export/backup.json', soDono, async (req, res) => {
    const m = req.mid;
    const [mercado, clientes, lancamentos, produtos, entradas, promocoes, contestacoes, pagamentos] = await Promise.all([
      db.get('SELECT id,nome,email,pix_chave,cidade,whatsapp,slug,mostrar_itens,criado_em FROM mercados WHERE id=?', [m]),
      db.all('SELECT id,nome,telefone,limite,dia_vencimento,ativo,aceitou_em,ativado_em,criado_em FROM clientes WHERE mercado_id=? ORDER BY id', [m]),
      db.all('SELECT id,cliente_id,tipo,valor,descricao,forma,contestado,estorno_de,usuario_id,criado_em FROM lancamentos WHERE mercado_id=? ORDER BY id', [m]),
      db.all('SELECT id,nome,codigo,alerta_dias,criado_em FROM produtos WHERE mercado_id=? ORDER BY id', [m]),
      db.all('SELECT id,produto_id,quantidade,validade,custo,baixado,criado_em FROM entradas WHERE mercado_id=? ORDER BY id', [m]),
      db.all('SELECT id,titulo,descricao,preco,preco_original,validade,ativo,criado_em FROM promocoes WHERE mercado_id=? ORDER BY id', [m]),
      db.all('SELECT id,cliente_id,lancamento_id,mensagem,resolvida,criado_em FROM contestacoes WHERE mercado_id=? ORDER BY id', [m]),
      db.all('SELECT id,cliente_id,valor,status,motivo,lancamento_id,criado_em,resolvido_em FROM pagamentos_informados WHERE mercado_id=? ORDER BY id', [m]),
    ]);
    await audita(req, 'export.backup');
    baixar(res, `backup-caderneta-${U.hojeISO()}.json`, 'application/json; charset=utf-8', JSON.stringify({
      gerado_em: new Date().toISOString(), versao: 1, observacao: 'Valores em centavos. Datas em UTC.',
      mercado, clientes, lancamentos, produtos, entradas, promocoes, contestacoes, pagamentos_informados: pagamentos,
    }, null, 1));
  });

  // ---------- auditoria: quem fez o quê ----------
  api.get('/auditoria', soDono, async (req, res) => {
    const antes = U.intId(req.query.antes) || 2 ** 31 - 1;
    const rows = await db.all(`SELECT a.id,a.acao,a.detalhe,a.criado_em,u.nome AS usuario FROM auditoria a LEFT JOIN usuarios u ON u.id=a.usuario_id
      WHERE a.mercado_id=? AND a.id<? ORDER BY a.id DESC LIMIT 51`, [req.mid, antes]);
    res.json({ itens: rows.slice(0, 50), tem_mais: rows.length > 50 });
  });
};

module.exports.idadeDaDivida = idadeDaDivida;
