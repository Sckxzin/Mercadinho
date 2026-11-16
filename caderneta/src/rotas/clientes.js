// Clientes, lançamentos (compra / pagamento / estorno), contestações e cobranças.
const U = require('../util');
const wa = require('../whatsapp');

const FORMAS = ['pix', 'dinheiro', 'cartão', 'outro'];
// busca sem acento e sem maiúsculas ("jose" encontra "José")
const SEM_ACENTO_SQL = (col) => `translate(lower(${col}),'áàâãäéèêëíìîïóòôõöúùûüçñ','aaaaaeeeeiiiiooooouuuucn')`;
const semAcento = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const escLike = (s) => s.replace(/[\\%_]/g, (c) => '\\' + c);

module.exports = function registraClientes({ api, db, baseUrl, saldoDe, audita, soDono }) {
  const urlCliente = (req, token) => `${baseUrl(req)}/c/${token}`;

  const meuCliente = async (req, res, t = db, trava = false) => {
    const c = await t.get(`SELECT * FROM clientes WHERE id=? AND mercado_id=?${trava ? ' FOR UPDATE' : ''}`, [U.intId(req.params.id), req.mid]);
    if (!c) res.status(404).json({ erro: 'Cliente não encontrado.' });
    return c;
  };

  // valida e normaliza os campos do cadastro; devolve { erro } ou os valores
  async function dadosCliente(req, atual = null) {
    const b = req.body || {};
    const out = {};
    if (b.nome !== undefined || !atual) {
      out.nome = U.texto(b.nome, 80);
      if (!out.nome) return { erro: 'Nome obrigatório.' };
    }
    if (b.telefone !== undefined) {
      const tel = U.texto(b.telefone, 30);
      const norm = tel ? U.normTel(tel) : null;
      if (norm && (norm.length < 10 || norm.length > 11)) return { erro: 'Telefone inválido. Use DDD + número, ex.: 81 99999-9999.' };
      if (norm) {
        const dono = await db.get('SELECT nome FROM clientes WHERE mercado_id=? AND telefone_norm=? AND ativo=1 AND id<>?', [req.mid, norm, atual?.id || 0]);
        if (dono) return { erro: `Esse telefone já é do cliente "${dono.nome}".`, status: 409 };
      }
      out.telefone = tel; out.telefone_norm = norm;
    }
    if (b.limite !== undefined) {
      const lim = String(b.limite).trim() === '' ? 0 : U.centavos(b.limite, { min: 0 });
      if (lim === null) return { erro: 'Limite inválido.' };
      out.limite = lim;
    }
    if (b.dia_vencimento !== undefined) {
      const d = b.dia_vencimento === null || String(b.dia_vencimento).trim() === '' ? null : Number(b.dia_vencimento);
      if (d !== null && !(Number.isInteger(d) && d >= 1 && d <= 28)) return { erro: 'Dia de vencimento deve ser de 1 a 28 (ou vazio).' };
      out.dia_vencimento = d;
    }
    return out;
  }

  // ---------- CLIENTES ----------
  api.get('/clientes', async (req, res) => {
    const q = semAcento(String(req.query.q || '').trim()).slice(0, 60);
    const dig = U.soDigitos(q);
    const ativo = req.query.arquivados === '1' ? 0 : 1;
    const limit = Math.min(Math.max(U.intId(req.query.limit) || 50, 1), 200);
    const offset = Math.max(Number.parseInt(req.query.offset, 10) || 0, 0);
    const filtro = `c.mercado_id=? AND c.ativo=? AND (?='' OR ${SEM_ACENTO_SQL('c.nome')} LIKE ? OR (?<>'' AND c.telefone_norm LIKE ?))`
      + (req.query.devendo === '1' ? ' AND COALESCE(s.saldo,0) > 0' : '');
    const params = [req.mid, ativo, q, `%${escLike(q)}%`, dig, `%${escLike(dig)}%`];
    const base = `FROM clientes c LEFT JOIN (
        SELECT cliente_id, SUM(valor) AS saldo,
               MAX(CASE WHEN tipo='pagamento' THEN criado_em END) AS ultimo_pagamento,
               MAX(CASE WHEN tipo='compra' THEN criado_em END) AS ultima_compra
        FROM lancamentos WHERE mercado_id=? GROUP BY cliente_id) s ON s.cliente_id=c.id
      WHERE ${filtro}`;
    const [rows, tot] = await Promise.all([
      db.all(`SELECT c.id,c.nome,c.telefone,c.limite,c.token,c.ativo,c.ativado_em,c.dia_vencimento,
          COALESCE(s.saldo,0) AS saldo, s.ultimo_pagamento, s.ultima_compra ${base}
        ORDER BY COALESCE(s.saldo,0) DESC, c.nome LIMIT ? OFFSET ?`, [req.mid, ...params, limit, offset]),
      db.get(`SELECT COUNT(*) AS n ${base}`, [req.mid, ...params]),
    ]);
    res.set('X-Total-Count', String(tot.n)).set('Access-Control-Expose-Headers', 'X-Total-Count');
    res.json(rows.map((r) => ({ ...r, url: urlCliente(req, r.token) })));
  });

  api.post('/clientes', async (req, res) => {
    const d = await dadosCliente(req);
    if (d.erro) return res.status(d.status || 400).json({ erro: d.erro });
    if (req.papel !== 'dono') delete d.limite; // caixa cadastra, mas quem define limite é o dono
    const r = await db.run('INSERT INTO clientes (mercado_id,nome,telefone,telefone_norm,limite,dia_vencimento,token,aceitou_em) VALUES (?,?,?,?,?,?,?,?)',
      [req.mid, d.nome, d.telefone ?? null, d.telefone_norm ?? null, d.limite ?? 0, d.dia_vencimento ?? null, U.novoToken(), req.body?.aceitou ? U.agoraUTC() : null]);
    const c = await db.get('SELECT * FROM clientes WHERE id=?', [r.id]);
    await audita(req, 'cliente.criado', `#${c.id} ${c.nome}`);
    res.status(201).json({ ...c, pin_hash: undefined, codigo_hash: undefined, url: urlCliente(req, c.token) });
  });

  api.patch('/clientes/:id', async (req, res) => {
    const c = await meuCliente(req, res); if (!c) return;
    const b = req.body || {};
    if (req.papel !== 'dono' && (b.limite !== undefined || b.ativo !== undefined || b.dia_vencimento !== undefined))
      return res.status(403).json({ erro: 'Só o dono pode mudar limite, vencimento ou arquivar.' });
    const d = await dadosCliente(req, c);
    if (d.erro) return res.status(d.status || 400).json({ erro: d.erro });
    const ativo = b.ativo === undefined ? c.ativo : b.ativo ? 1 : 0;
    if (ativo && !c.ativo && c.telefone_norm && await db.get('SELECT 1 AS x FROM clientes WHERE mercado_id=? AND telefone_norm=? AND ativo=1 AND id<>?', [req.mid, c.telefone_norm, c.id]))
      return res.status(409).json({ erro: 'Outro cliente ativo já usa esse telefone.' });
    const n = { ...c, ...d, ativo };
    await db.run('UPDATE clientes SET nome=?,telefone=?,telefone_norm=?,limite=?,dia_vencimento=?,ativo=? WHERE id=?',
      [n.nome, n.telefone, n.telefone_norm, n.limite, n.dia_vencimento, n.ativo, c.id]);
    const mud = [];
    if (n.limite !== c.limite) mud.push(`limite ${U.brl(c.limite)} → ${U.brl(n.limite)}`);
    if (n.ativo !== c.ativo) mud.push(n.ativo ? 'reativado' : 'arquivado');
    if (n.telefone !== c.telefone) mud.push('telefone alterado');
    if (n.nome !== c.nome) mud.push(`nome "${c.nome}" → "${n.nome}"`);
    if (n.dia_vencimento !== c.dia_vencimento) mud.push(`vencimento dia ${n.dia_vencimento ?? '—'}`);
    if (mud.length) await audita(req, 'cliente.editado', `#${c.id} ${n.nome}: ${mud.join(', ')}`);
    res.json({ ok: true });
  });

  api.post('/clientes/:id/novo-link', async (req, res) => {
    const c = await meuCliente(req, res); if (!c) return;
    const t = U.novoToken();
    await db.run('UPDATE clientes SET token=? WHERE id=?', [t, c.id]);
    await audita(req, 'cliente.novo_link', `#${c.id} ${c.nome}`);
    res.json({ url: urlCliente(req, t) });
  });

  // extrato paginado: ?antes=<id do último lançamento visto>&limit=50
  api.get('/clientes/:id/extrato', async (req, res) => {
    const c = await meuCliente(req, res); if (!c) return;
    const limit = Math.min(Math.max(U.intId(req.query.limit) || 50, 1), 200);
    const antes = U.intId(req.query.antes) || 2 ** 31 - 1;
    const lanc = await db.all(`SELECT l.id,l.tipo,l.valor,l.descricao,l.forma,l.contestado,l.criado_em,l.estorno_de,
        u.nome AS usuario, (e.id IS NOT NULL) AS estornado
      FROM lancamentos l LEFT JOIN usuarios u ON u.id=l.usuario_id LEFT JOIN lancamentos e ON e.estorno_de=l.id
      WHERE l.cliente_id=? AND l.id<? ORDER BY l.id DESC LIMIT ?`, [c.id, antes, limit + 1]);
    res.json({
      cliente: { id: c.id, nome: c.nome, telefone: c.telefone, limite: c.limite, ativo: c.ativo, dia_vencimento: c.dia_vencimento, ativado_em: c.ativado_em, aceitou_em: c.aceitou_em, url: urlCliente(req, c.token) },
      saldo: await saldoDe(c.id),
      lancamentos: lanc.slice(0, limit).map((l) => ({ ...l, estornado: !!l.estornado })),
      tem_mais: lanc.length > limit,
    });
  });

  // ---------- LANÇAMENTOS ----------
  // Tudo dentro de transação com a linha do cliente travada (FOR UPDATE): duas compras
  // ao mesmo tempo não conseguem furar o limite.
  api.post('/clientes/:id/compras', async (req, res) => {
    const { valor, descricao, forcar } = req.body || {};
    const v = U.centavos(valor);
    if (v === null) return res.status(400).json({ erro: 'Valor inválido.' });
    const out = await db.tx(async (t) => {
      const c = await meuCliente(req, res, t, true); if (!c) return null;
      if (!c.ativo) { res.status(409).json({ erro: 'Cliente arquivado. Reative para lançar.' }); return null; }
      const novoSaldo = (await saldoDe(c.id, t)) + v;
      if (c.limite > 0 && novoSaldo > c.limite && !forcar) {
        res.status(409).json({ erro: `Passa do limite de ${U.brl(c.limite)} (ficaria ${U.brl(novoSaldo)}).`, codigo: 'LIMITE', novo_saldo: novoSaldo });
        return null;
      }
      const r = await t.run("INSERT INTO lancamentos (mercado_id,cliente_id,tipo,valor,descricao,usuario_id) VALUES (?,?,'compra',?,?,?)", [req.mid, c.id, v, U.texto(descricao, 300), req.uid]);
      if (c.limite > 0 && novoSaldo > c.limite) await audita(req, 'compra.acima_limite', `#${c.id} ${c.nome}: ${U.brl(v)} (saldo ${U.brl(novoSaldo)}, limite ${U.brl(c.limite)})`, t);
      return { id: r.id, saldo: novoSaldo };
    });
    if (out) res.status(201).json(out);
  });

  api.post('/clientes/:id/pagamentos', async (req, res) => {
    const { valor, forma, descricao } = req.body || {};
    const v = U.centavos(valor);
    if (v === null) return res.status(400).json({ erro: 'Valor inválido.' });
    const f = FORMAS.includes(forma) ? forma : forma ? 'outro' : null;
    const out = await db.tx(async (t) => {
      const c = await meuCliente(req, res, t, true); if (!c) return null;
      const r = await t.run("INSERT INTO lancamentos (mercado_id,cliente_id,tipo,valor,forma,descricao,usuario_id) VALUES (?,?,'pagamento',?,?,?,?)", [req.mid, c.id, -v, f, U.texto(descricao, 300), req.uid]);
      return { id: r.id, saldo: await saldoDe(c.id, t) };
    });
    if (out) res.status(201).json(out);
  });

  // Estorno: cria o lançamento inverso (o histórico nunca é apagado). Cada lançamento
  // só pode ser estornado uma vez, e um estorno não pode ser estornado.
  api.post('/lancamentos/:id/estornar', soDono, async (req, res) => {
    try {
      const out = await db.tx(async (t) => {
        const l = await t.get('SELECT * FROM lancamentos WHERE id=? AND mercado_id=? FOR UPDATE', [U.intId(req.params.id), req.mid]);
        if (!l) return { status: 404, erro: 'Lançamento não encontrado.' };
        if (l.estorno_de) return { status: 400, erro: 'Este lançamento já é um estorno e não pode ser estornado.' };
        if (await t.get('SELECT 1 AS x FROM lancamentos WHERE estorno_de=?', [l.id])) return { status: 409, erro: 'Esse lançamento já foi estornado.' };
        const motivo = U.texto(req.body?.motivo, 150);
        await t.run("INSERT INTO lancamentos (mercado_id,cliente_id,tipo,valor,descricao,estorno_de,usuario_id) VALUES (?,?,'ajuste',?,?,?,?)",
          [req.mid, l.cliente_id, -l.valor, `Estorno do lançamento #${l.id}${motivo ? ': ' + motivo : ''}`, l.id, req.uid]);
        await t.run('UPDATE lancamentos SET contestado=0 WHERE id=?', [l.id]);
        await audita(req, 'lancamento.estornado', `#${l.id} (${l.tipo} ${U.brl(Math.abs(l.valor))})${motivo ? ': ' + motivo : ''}`, t);
        return { saldo: await saldoDe(l.cliente_id, t) };
      });
      if (out.erro) return res.status(out.status).json({ erro: out.erro });
      res.json(out);
    } catch (e) {
      // duas requisições simultâneas: o índice único do banco barra a segunda
      if (e.code === '23505') return res.status(409).json({ erro: 'Esse lançamento já foi estornado.' });
      throw e;
    }
  });

  api.get('/contestacoes', async (req, res) => {
    res.json(await db.all(`SELECT k.*,c.nome AS cliente_nome FROM contestacoes k JOIN clientes c ON c.id=k.cliente_id
      WHERE k.mercado_id=? AND k.resolvida=0 ORDER BY k.id DESC`, [req.mid]));
  });
  api.post('/contestacoes/:id/resolver', async (req, res) => {
    const r = await db.run('UPDATE contestacoes SET resolvida=1 WHERE id=? AND mercado_id=? AND resolvida=0', [U.intId(req.params.id), req.mid]);
    if (!r.changes) return res.status(404).json({ erro: 'Aviso não encontrado.' });
    await audita(req, 'aviso.resolvido', `#${U.intId(req.params.id)}`);
    res.json({ ok: true });
  });

  // ---------- COBRANÇA / WHATSAPP ----------
  const textoAtual = async (req, c) => {
    const m = await db.get('SELECT * FROM mercados WHERE id=?', [req.mid]);
    const saldo = await saldoDe(c.id);
    return { saldo, texto: wa.textoCobranca({ mercado: m, cliente: c, saldo, urlCliente: urlCliente(req, c.token) }) };
  };

  // cobrança manual: o dono clica e o WhatsApp abre com a mensagem pronta
  api.post('/clientes/:id/cobrar', async (req, res) => {
    const c = await meuCliente(req, res); if (!c) return;
    if (!c.telefone) return res.status(400).json({ erro: 'Cadastre o WhatsApp do cliente antes.' });
    const { texto } = await textoAtual(req, c);
    const n = await wa.enfileira(db, { mercado_id: req.mid, cliente_id: c.id, telefone: c.telefone, texto, status: 'enviada' });
    res.json(n);
  });

  // fila criada pela rotina diária (cobrança semanal e lembrete de vencimento)
  api.get('/notificacoes', async (req, res) => {
    res.json(await db.all(`SELECT n.id,n.tipo,n.texto,n.criado_em,n.status,n.erro,c.nome AS cliente_nome,c.id AS cliente_id
      FROM notificacoes n LEFT JOIN clientes c ON c.id=n.cliente_id
      WHERE n.mercado_id=? AND n.status IN ('pendente','erro') ORDER BY n.id DESC LIMIT 100`, [req.mid]));
  });
  // "Enviar": refaz o texto com o saldo de AGORA (o cliente pode ter pago desde que entrou na fila)
  api.post('/notificacoes/:id/enviar', async (req, res) => {
    const n = await db.get("SELECT * FROM notificacoes WHERE id=? AND mercado_id=? AND status IN ('pendente','erro')", [U.intId(req.params.id), req.mid]);
    if (!n) return res.status(404).json({ erro: 'Mensagem não encontrada ou já enviada.' });
    const c = await db.get('SELECT * FROM clientes WHERE id=? AND mercado_id=?', [n.cliente_id, req.mid]);
    if (!c || !c.telefone || !c.ativo) {
      await db.run("UPDATE notificacoes SET status='descartada' WHERE id=?", [n.id]);
      return res.status(409).json({ erro: 'Cliente sem telefone ou arquivado. Mensagem descartada.' });
    }
    const { saldo, texto } = await textoAtual(req, c);
    if (saldo <= 0) {
      await db.run("UPDATE notificacoes SET status='descartada' WHERE id=?", [n.id]);
      return res.status(409).json({ erro: `${c.nome} já está em dia. Mensagem descartada.` });
    }
    const link = wa.linkWa(c.telefone, texto);
    await db.run("UPDATE notificacoes SET status='enviada', texto=?, link_wa=?, enviada_em=? WHERE id=?", [texto, link, U.agoraUTC(), n.id]);
    res.json({ link_wa: link });
  });
  api.post('/notificacoes/:id/descartar', async (req, res) => {
    const r = await db.run("UPDATE notificacoes SET status='descartada' WHERE id=? AND mercado_id=? AND status IN ('pendente','erro')", [U.intId(req.params.id), req.mid]);
    if (!r.changes) return res.status(404).json({ erro: 'Mensagem não encontrada.' });
    res.json({ ok: true });
  });
};
