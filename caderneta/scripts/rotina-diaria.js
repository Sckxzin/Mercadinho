// Rotina diária (Railway Cron: npm run alertas):
//  - lista produtos vencidos/vencendo por mercado
//  - coloca na fila as cobranças dos clientes com saldo acima do mínimo (1x por semana por cliente)
const { open } = require('../src/db');
const wa = require('../src/whatsapp');
const { brl } = require('../src/util');
const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const MIN_COBRANCA = Number(process.env.MIN_COBRANCA_CENTAVOS || 1000);

(async () => {
  const db = await open();
  for (const m of await db.all('SELECT * FROM mercados')) {
    const venc = await db.all(`SELECT p.nome,e.quantidade,e.validade FROM entradas e JOIN produtos p ON p.id=e.produto_id
      WHERE e.mercado_id=? AND e.baixado=0 AND e.validade::date <= (current_date + p.alerta_dias) ORDER BY e.validade`, [m.id]);
    console.log(`\n[${m.nome}] ${venc.length} lote(s) vencido(s)/vencendo`);
    venc.forEach((v) => console.log(`  - ${v.nome} x${v.quantidade} vence ${v.validade}`));

    const devedores = await db.all(`SELECT c.id,c.nome,c.telefone,c.token, SUM(l.valor) AS saldo FROM clientes c JOIN lancamentos l ON l.cliente_id=c.id
      WHERE c.mercado_id=? AND c.ativo=1 AND c.telefone IS NOT NULL GROUP BY c.id HAVING SUM(l.valor) >= ?`, [m.id, MIN_COBRANCA]);
    for (const c of devedores) {
      const recente = await db.get("SELECT 1 AS x FROM notificacoes WHERE cliente_id=? AND criado_em > to_char((now() - interval '7 day') at time zone 'utc','YYYY-MM-DD HH24:MI:SS')", [c.id]);
      if (recente) continue;
      const texto = wa.textoCobranca({ mercado: m, cliente: c, saldo: c.saldo, urlCliente: `${BASE}/c/${c.token}` });
      await wa.enfileira(db, { mercado_id: m.id, cliente_id: c.id, telefone: c.telefone, texto });
      console.log(`  cobrança na fila: ${c.nome} (${brl(c.saldo)})`);
    }
  }
  await db.close();
})().catch((e) => { console.error(e); process.exit(1); });
