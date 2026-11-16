// Página do cliente pelo link pessoal /c/<token> (somente leitura + "tem algo errado?").
const U = require('../util');

module.exports = function registraPublico({ app, db, porToken, saldoDe }) {
  app.get('/api/publico/:token', async (req, res) => {
    if (!U.limite('pub:' + req.ip, 60, 60_000)) return res.status(429).json({ erro: 'Muitas requisições.' });
    const c = await porToken(req.params.token);
    if (!c) return res.status(404).json({ erro: 'Link inválido ou expirado.' });
    const lanc = await db.all('SELECT id,tipo,valor,descricao,criado_em,contestado FROM lancamentos WHERE cliente_id=? ORDER BY id DESC LIMIT 100', [c.id]);
    const saldo = await saldoDe(c.id);
    res.set('Cache-Control', 'no-store');
    res.json({
      mercado: c.mercado_nome, slug: c.mercado_slug, cliente: c.nome.split(' ')[0], saldo, pix_chave: c.pix_chave,
      whatsapp: c.mercado_whatsapp, vencimento: saldo > 0 ? proximoVencimento(c.dia_vencimento) : null,
      lancamentos: lanc.map((l) => ({
        id: l.id, tipo: l.tipo, valor: l.valor, data: l.criado_em, contestado: !!l.contestado,
        descricao: l.tipo === 'compra' && !c.mostrar_itens ? null : l.descricao,
      })),
    });
  });

  app.post('/api/publico/:token/contestar', async (req, res) => {
    if (!U.limite('cont:' + req.ip, 10, 60_000)) return res.status(429).json({ erro: 'Muitas requisições.' });
    const c = await porToken(req.params.token);
    if (!c) return res.status(404).json({ erro: 'Link inválido.' });
    const { lancamento_id, mensagem } = req.body || {};
    let lid = null;
    if (lancamento_id) {
      const l = await db.get('SELECT id FROM lancamentos WHERE id=? AND cliente_id=?', [U.intId(lancamento_id), c.id]);
      if (!l) return res.status(404).json({ erro: 'Lançamento não encontrado.' });
      lid = l.id;
      await db.run('UPDATE lancamentos SET contestado=1 WHERE id=?', [lid]);
    }
    const abertas = (await db.get('SELECT COUNT(*) AS n FROM contestacoes WHERE cliente_id=? AND resolvida=0', [c.id])).n;
    if (abertas >= 20) return res.status(429).json({ erro: 'Você já tem muitos avisos em aberto. Fale com o mercado.' });
    await db.run('INSERT INTO contestacoes (mercado_id,cliente_id,lancamento_id,mensagem) VALUES (?,?,?,?)', [c.mercado_id, c.id, lid, String(mensagem || '').slice(0, 500)]);
    res.status(201).json({ ok: true });
  });
};

// próxima data de vencimento a partir do dia do mês combinado (no fuso do mercado)
function proximoVencimento(dia, hoje = U.hojeISO()) {
  if (!dia) return null;
  const [y, m, d] = hoje.split('-').map(Number);
  const dd = String(dia).padStart(2, '0');
  const data = d <= dia ? `${y}-${String(m).padStart(2, '0')}-${dd}` : m === 12 ? `${y + 1}-01-${dd}` : `${y}-${String(m + 1).padStart(2, '0')}-${dd}`;
  return { data, dias: U.diasEntre(hoje, data) };
}

module.exports.proximoVencimento = proximoVencimento;
