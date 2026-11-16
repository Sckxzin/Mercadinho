// Produtos, entradas (lotes com validade) e alertas de vencimento.
const U = require('../util');

module.exports = function registraEstoque({ api, db, audita, soDono }) {
  const meuProduto = async (req, res) => {
    const p = await db.get('SELECT * FROM produtos WHERE id=? AND mercado_id=?', [U.intId(req.params.id), req.mid]);
    if (!p) res.status(404).json({ erro: 'Produto não encontrado.' });
    return p;
  };

  async function dadosProduto(req, atual = null) {
    const b = req.body || {};
    const out = {};
    if (b.nome !== undefined || !atual) {
      out.nome = U.texto(b.nome, 80);
      if (!out.nome) return { erro: 'Nome obrigatório.' };
    }
    if (b.codigo !== undefined) {
      out.codigo = U.texto(b.codigo, 40);
      if (out.codigo && await db.get('SELECT 1 AS x FROM produtos WHERE mercado_id=? AND codigo=? AND id<>?', [req.mid, out.codigo, atual?.id || 0]))
        return { erro: 'Já existe um produto com esse código.', status: 409 };
    }
    if (b.alerta_dias !== undefined && String(b.alerta_dias).trim() !== '') {
      const n = Number(b.alerta_dias);
      if (!Number.isInteger(n) || n < 0 || n > 365) return { erro: 'Aviso de validade: de 0 a 365 dias.' };
      out.alerta_dias = n;
    }
    return out;
  }

  api.get('/produtos', async (req, res) => {
    res.json(await db.all(`SELECT p.*, COALESCE(SUM(CASE WHEN e.baixado=0 THEN e.quantidade END),0) AS em_estoque,
        MIN(CASE WHEN e.baixado=0 THEN e.validade END) AS proxima_validade
      FROM produtos p LEFT JOIN entradas e ON e.produto_id=p.id WHERE p.mercado_id=? GROUP BY p.id ORDER BY p.nome`, [req.mid]));
  });

  api.get('/produtos/codigo/:codigo', async (req, res) => {
    const p = await db.get('SELECT * FROM produtos WHERE mercado_id=? AND codigo=?', [req.mid, String(req.params.codigo).slice(0, 40)]);
    if (!p) return res.status(404).json({ erro: 'Nenhum produto com esse código.' });
    res.json(p);
  });

  api.post('/produtos', async (req, res) => {
    const d = await dadosProduto(req);
    if (d.erro) return res.status(d.status || 400).json({ erro: d.erro });
    const r = await db.run('INSERT INTO produtos (mercado_id,nome,codigo,alerta_dias) VALUES (?,?,?,?)', [req.mid, d.nome, d.codigo ?? null, d.alerta_dias ?? 7]);
    res.status(201).json({ id: r.id });
  });

  api.patch('/produtos/:id', async (req, res) => {
    const p = await meuProduto(req, res); if (!p) return;
    const d = await dadosProduto(req, p);
    if (d.erro) return res.status(d.status || 400).json({ erro: d.erro });
    const n = { ...p, ...d };
    await db.run('UPDATE produtos SET nome=?,codigo=?,alerta_dias=? WHERE id=?', [n.nome, n.codigo, n.alerta_dias, p.id]);
    res.json({ ok: true });
  });

  api.delete('/produtos/:id', soDono, async (req, res) => {
    const p = await meuProduto(req, res); if (!p) return;
    await db.run('DELETE FROM produtos WHERE id=?', [p.id]); // entradas vão junto (ON DELETE CASCADE)
    await audita(req, 'produto.excluido', `#${p.id} ${p.nome}`);
    res.json({ ok: true });
  });

  api.get('/produtos/:id/entradas', async (req, res) => {
    const p = await meuProduto(req, res); if (!p) return;
    const hoje = U.hojeISO();
    const rows = await db.all('SELECT id,quantidade,validade,custo,criado_em FROM entradas WHERE produto_id=? AND baixado=0 ORDER BY validade', [p.id]);
    res.json(rows.map((e) => ({ ...e, dias_restantes: U.diasEntre(hoje, e.validade) })));
  });

  api.post('/produtos/:id/entradas', async (req, res) => {
    const p = await meuProduto(req, res); if (!p) return;
    const { quantidade, validade, custo } = req.body || {};
    const q = Number(quantidade);
    if (!Number.isInteger(q) || q <= 0 || q > 1_000_000 || !U.dataValida(validade)) return res.status(400).json({ erro: 'Informe quantidade (número inteiro) e uma validade válida.' });
    const cu = custo === undefined || custo === null || String(custo).trim() === '' ? null : U.centavos(custo, { min: 0 });
    if (cu === null && custo !== undefined && custo !== null && String(custo).trim() !== '') return res.status(400).json({ erro: 'Custo inválido.' });
    const r = await db.run('INSERT INTO entradas (mercado_id,produto_id,quantidade,validade,custo) VALUES (?,?,?,?,?)', [req.mid, p.id, q, validade, cu]);
    res.status(201).json({ id: r.id });
  });

  api.post('/entradas/:id/baixar', async (req, res) => {
    const r = await db.run('UPDATE entradas SET baixado=1 WHERE id=? AND mercado_id=? AND baixado=0', [U.intId(req.params.id), req.mid]);
    if (!r.changes) return res.status(404).json({ erro: 'Lote não encontrado ou já baixado.' });
    res.json({ ok: true });
  });

  // "hoje" no fuso do mercado (Brasília), não em UTC
  api.get('/alertas/validade', async (req, res) => {
    const hoje = U.hojeISO();
    const rows = await db.all(`SELECT e.id AS entrada_id,p.id AS produto_id,p.nome,e.quantidade,e.validade,p.alerta_dias
      FROM entradas e JOIN produtos p ON p.id=e.produto_id
      WHERE e.mercado_id=? AND e.baixado=0 ORDER BY e.validade`, [req.mid]);
    const lista = rows.map((r) => ({ ...r, dias_restantes: U.diasEntre(hoje, r.validade) }));
    res.json({
      hoje,
      vencidos: lista.filter((r) => r.dias_restantes < 0),
      vencendo: lista.filter((r) => r.dias_restantes >= 0 && r.dias_restantes <= r.alerta_dias),
    });
  });
};
