// Rotina diária (Railway Cron: npm run alertas)
//  - lista produtos vencidos/vencendo por mercado
//  - lembrete de vencimento da conta (3 dias antes e no dia) para clientes com "dia de vencimento"
//  - cobrança semanal dos clientes com saldo acima do mínimo (no máx. 1 mensagem por semana)
//  - se a API oficial do WhatsApp estiver configurada, envia na hora; senão fica na fila
//    do painel (aba Avisos) para o dono enviar com 1 toque
const U = require('./util');
const wa = require('./whatsapp');
const { proximoVencimento } = require('./rotas/publico');

const AVISAR_VENCIMENTO = [3, 0]; // dias antes do vencimento

async function rotinaDiaria(db, { hoje = U.hojeISO(), base = process.env.BASE_URL || 'http://localhost:3000', minimo = Number(process.env.MIN_COBRANCA_CENTAVOS || 1000), env = process.env, fetchFn, log = console.log } = {}) {
  base = base.replace(/\/$/, '');
  const relatorio = [];
  const automatico = wa.configurado(env);
  const desde = (dias) => U.inicioDiaUTC(U.addDias(hoje, -dias));

  for (const m of await db.all('SELECT * FROM mercados WHERE ativo=1 ORDER BY id')) {
    const r = { mercado: m.nome, validade: [], filas: [], enviadas: 0, erros: 0 };
    r.validade = await db.all(`SELECT p.nome,e.quantidade,e.validade FROM entradas e JOIN produtos p ON p.id=e.produto_id
      WHERE e.mercado_id=? AND e.baixado=0 AND e.validade <= to_char(?::date + p.alerta_dias, 'YYYY-MM-DD') ORDER BY e.validade`, [m.id, hoje]);

    const devedores = await db.all(`SELECT c.id,c.nome,c.telefone,c.token,c.dia_vencimento, SUM(l.valor) AS saldo
      FROM clientes c JOIN lancamentos l ON l.cliente_id=c.id
      WHERE c.mercado_id=? AND c.ativo=1 AND c.telefone IS NOT NULL GROUP BY c.id HAVING SUM(l.valor) > 0`, [m.id]);

    for (const c of devedores) {
      const urlCliente = `${base}/c/${c.token}`;
      let item = null;
      const venc = proximoVencimento(c.dia_vencimento, hoje);
      if (venc && AVISAR_VENCIMENTO.includes(venc.dias)) {
        const ja = await db.get("SELECT 1 AS x FROM notificacoes WHERE cliente_id=? AND tipo='vencimento' AND criado_em >= ?", [c.id, desde(0)]);
        if (!ja) item = { tipo: 'vencimento', texto: wa.textoVencimento({ mercado: m, cliente: c, saldo: c.saldo, urlCliente, data: venc.data, dias: venc.dias }) };
      }
      if (!item && c.saldo >= minimo) {
        const recente = await db.get('SELECT 1 AS x FROM notificacoes WHERE cliente_id=? AND criado_em >= ?', [c.id, desde(7)]);
        if (!recente) item = { tipo: 'cobranca', texto: wa.textoCobranca({ mercado: m, cliente: c, saldo: c.saldo, urlCliente }) };
      }
      if (!item) continue;

      const n = await wa.enfileira(db, { mercado_id: m.id, cliente_id: c.id, telefone: c.telefone, texto: item.texto, tipo: item.tipo });
      r.filas.push({ cliente: c.nome, saldo: c.saldo, tipo: item.tipo });
      if (automatico) {
        try {
          await wa.enviar({ telefone: c.telefone, params: [c.nome.split(' ')[0], m.nome, U.brl(c.saldo), urlCliente] }, { env, ...(fetchFn ? { fetchFn } : {}) });
          await db.run("UPDATE notificacoes SET status='enviada', enviada_em=? WHERE id=?", [U.agoraUTC(), n.id]);
          r.enviadas++;
        } catch (e) {
          await db.run("UPDATE notificacoes SET status='erro', erro=? WHERE id=?", [String(e.message).slice(0, 300), n.id]);
          r.erros++;
        }
      }
    }

    log(`\n[${m.nome}] ${r.validade.length} lote(s) vencido(s)/vencendo`);
    r.validade.forEach((v) => log(`  - ${v.nome} x${v.quantidade} vence ${v.validade}`));
    r.filas.forEach((f) => log(`  ${f.tipo === 'vencimento' ? 'lembrete de vencimento' : 'cobrança'}: ${f.cliente} (${U.brl(f.saldo)})`));
    if (automatico) log(`  WhatsApp automático: ${r.enviadas} enviada(s), ${r.erros} com erro`);
    relatorio.push(r);
  }
  return relatorio;
}

module.exports = { rotinaDiaria };
