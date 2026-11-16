// Promoções, Pix com valor e comprovantes de pagamento.
const express = require('express');
const U = require('../util');

const MAX_IMG = 2 * 1024 * 1024; // 2 MB

// Confere o tipo REAL do arquivo pelos bytes (não confia no Content-Type enviado)
function tipoImagem(buf) {
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

// valida preço / preço original / validade de uma promoção (só os campos enviados)
function precosPromo(b = {}) {
  const out = {};
  for (const k of ['preco', 'preco_original']) {
    if (b[k] === undefined) continue;
    if (b[k] === null || String(b[k]).trim() === '') { out[k] = null; continue; }
    out[k] = U.centavos(b[k]);
    if (out[k] === null) return { erro: 'Preço inválido.' };
  }
  if (b.validade !== undefined) {
    if (b.validade && !U.dataValida(b.validade)) return { erro: 'Validade inválida.' };
    out.validade = b.validade || null;
  }
  return out;
}

module.exports = function registraLoja({ app, api, db, porToken, saldoDe, audita }) {
  // ===== DONO: promoções =====
  api.get('/promocoes', async (req, res) => {
    res.json(await db.all('SELECT * FROM promocoes WHERE mercado_id=? ORDER BY ativo DESC, id DESC', [req.mid]));
  });
  api.post('/promocoes', async (req, res) => {
    const { titulo, descricao } = req.body || {};
    if (!titulo) return res.status(400).json({ erro: 'Título obrigatório.' });
    const v = precosPromo(req.body);
    if (v.erro) return res.status(400).json({ erro: v.erro });
    const r = await db.run('INSERT INTO promocoes (mercado_id,titulo,descricao,preco,preco_original,validade) VALUES (?,?,?,?,?,?)', [
      req.mid, String(titulo).slice(0, 80), U.texto(descricao, 300), v.preco ?? null, v.preco_original ?? null, v.validade ?? null]);
    res.status(201).json({ id: r.id });
  });
  api.patch('/promocoes/:id', async (req, res) => {
    const p = await db.get('SELECT * FROM promocoes WHERE id=? AND mercado_id=?', [U.intId(req.params.id), req.mid]);
    if (!p) return res.status(404).json({ erro: 'Promoção não encontrada.' });
    const { titulo, descricao, ativo } = req.body || {};
    const v = precosPromo(req.body);
    if (v.erro) return res.status(400).json({ erro: v.erro });
    const n = { ...p, ...v };
    await db.run('UPDATE promocoes SET titulo=?,descricao=?,preco=?,preco_original=?,validade=?,ativo=? WHERE id=?', [
      U.texto(titulo, 80) ?? p.titulo, descricao === undefined ? p.descricao : U.texto(descricao, 300),
      n.preco, n.preco_original, n.validade, ativo === undefined ? p.ativo : ativo ? 1 : 0, p.id]);
    res.json({ ok: true });
  });
  api.delete('/promocoes/:id', async (req, res) => {
    const r = await db.run('DELETE FROM promocoes WHERE id=? AND mercado_id=?', [U.intId(req.params.id), req.mid]);
    if (!r.changes) return res.status(404).json({ erro: 'Promoção não encontrada.' });
    res.json({ ok: true });
  });

  // ===== DONO: comprovantes =====
  api.get('/pagamentos-informados', async (req, res) => {
    const status = ['pendente', 'confirmado', 'recusado'].includes(req.query.status) ? req.query.status : 'pendente';
    res.json(await db.all(`SELECT p.id,p.cliente_id,c.nome AS cliente_nome,p.valor,p.status,p.motivo,p.criado_em,p.resolvido_em,
        (p.comprovante IS NOT NULL) AS tem_comprovante
      FROM pagamentos_informados p JOIN clientes c ON c.id=p.cliente_id
      WHERE p.mercado_id=? AND p.status=? ORDER BY p.id DESC LIMIT 100`, [req.mid, status]));
  });
  api.get('/pagamentos-informados/:id/comprovante', async (req, res) => {
    const p = await db.get('SELECT comprovante,mime FROM pagamentos_informados WHERE id=? AND mercado_id=?', [U.intId(req.params.id), req.mid]);
    if (!p || !p.comprovante) return res.status(404).json({ erro: 'Sem comprovante.' });
    res.set({ 'Content-Type': p.mime, 'Cache-Control': 'private, no-store' }).send(Buffer.from(p.comprovante));
  });
  api.post('/pagamentos-informados/:id/confirmar', async (req, res) => {
    const id = U.intId(req.params.id);
    // o dono pode corrigir o valor se o cliente digitou errado
    const informado = req.body?.valor !== undefined && String(req.body.valor).trim() !== '';
    const valorNovo = informado ? U.centavos(req.body.valor) : undefined;
    if (valorNovo === null) return res.status(400).json({ erro: 'Valor inválido.' });
    // Tudo numa transação: marcar como confirmado E lançar o pagamento acontecem juntos ou
    // não acontecem. O "WHERE status='pendente'" garante que só uma requisição confirma.
    const out = await db.tx(async (t) => {
      const p = await t.get("SELECT id,cliente_id,valor,status FROM pagamentos_informados WHERE id=? AND mercado_id=? FOR UPDATE", [id, req.mid]);
      if (!p) return { status: 404, erro: 'Não encontrado.' };
      if (p.status !== 'pendente') return { status: 409, erro: 'Já foi resolvido.' };
      const valor = valorNovo ?? p.valor;
      const l = await t.run("INSERT INTO lancamentos (mercado_id,cliente_id,tipo,valor,forma,descricao,usuario_id) VALUES (?,?,'pagamento',?,'pix',?,?)", [req.mid, p.cliente_id, -valor, `Comprovante #${p.id}`, req.uid]);
      await t.run('UPDATE pagamentos_informados SET status=\'confirmado\',valor=?,lancamento_id=?,resolvido_em=? WHERE id=?', [valor, l.id, U.agoraUTC(), id]);
      await audita(req, 'comprovante.confirmado', `#${p.id}: ${U.brl(valor)}${valor !== p.valor ? ` (informado ${U.brl(p.valor)})` : ''}`, t);
      return { saldo: await saldoDe(p.cliente_id, t) };
    });
    if (out.erro) return res.status(out.status).json({ erro: out.erro });
    res.json(out);
  });
  api.post('/pagamentos-informados/:id/recusar', async (req, res) => {
    const r = await db.run("UPDATE pagamentos_informados SET status='recusado',motivo=?,resolvido_em=? WHERE id=? AND mercado_id=? AND status='pendente'",
      [U.texto(req.body?.motivo, 200), U.agoraUTC(), U.intId(req.params.id), req.mid]);
    if (!r.changes) return res.status(404).json({ erro: 'Não encontrado ou já resolvido.' });
    await audita(req, 'comprovante.recusado', `#${U.intId(req.params.id)}`);
    res.json({ ok: true });
  });

  // ===== CLIENTE (pelo link pessoal) =====
  const hoje = () => U.hojeISO();

  app.get('/api/publico/:token/extras', async (req, res) => {
    if (!U.limite('ext:' + req.ip, 60, 60_000)) return res.status(429).json({ erro: 'Muitas requisições.' });
    const c = await porToken(req.params.token);
    if (!c) return res.status(404).json({ erro: 'Link inválido.' });
    res.set('Cache-Control', 'no-store');
    const promocoes = await db.all(`SELECT id,titulo,descricao,preco,preco_original,validade FROM promocoes
      WHERE mercado_id=? AND ativo=1 AND (validade IS NULL OR validade >= ?) ORDER BY id DESC LIMIT 30`, [c.mercado_id, hoje()]);
    const informados = await db.all(`SELECT id,valor,status,motivo,criado_em FROM pagamentos_informados
      WHERE cliente_id=? ORDER BY id DESC LIMIT 10`, [c.id]);
    res.json({ promocoes, pagamentos_informados: informados, pix_disponivel: !!c.pix_chave });
  });

  // Pix copia-e-cola com valor (padrão: saldo devedor)
  app.get('/api/publico/:token/pix', async (req, res) => {
    if (!U.limite('pix:' + req.ip, 30, 60_000)) return res.status(429).json({ erro: 'Muitas requisições.' });
    const c = await porToken(req.params.token);
    if (!c) return res.status(404).json({ erro: 'Link inválido.' });
    if (!c.pix_chave) return res.status(409).json({ erro: 'O mercado ainda não cadastrou a chave Pix.' });
    const m = await db.get('SELECT nome,cidade FROM mercados WHERE id=?', [c.mercado_id]);
    const centavos = req.query.valor ? U.centavos(req.query.valor, { max: 5_000_000 }) : Math.max(await saldoDe(c.id), 0);
    if (centavos === null || centavos > 5_000_000) return res.status(400).json({ erro: 'Valor inválido.' });
    res.json({ valor: centavos, copia_e_cola: U.pixPayload({ chave: c.pix_chave, nome: m.nome, cidade: m.cidade, centavos, txid: 'CAD' + c.id }) });
  });

  // Cliente envia o comprovante: corpo = imagem crua (jpeg/png), valor na query
  app.post('/api/publico/:token/comprovante', express.raw({ type: () => true, limit: MAX_IMG }), async (req, res) => {
    if (!U.limite('comp:' + req.ip, 5, 10 * 60_000)) return res.status(429).json({ erro: 'Muitos envios. Tente novamente em alguns minutos.' });
    const c = await porToken(req.params.token);
    if (!c) return res.status(404).json({ erro: 'Link inválido.' });
    const valor = U.centavos(req.query.valor, { max: 5_000_000 });
    if (valor === null) return res.status(400).json({ erro: 'Informe o valor pago.' });
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const mime = buf.length ? tipoImagem(buf) : null;
    if (!mime) return res.status(400).json({ erro: 'Envie o comprovante como imagem JPG ou PNG (até 2 MB).' });
    const pend = (await db.get("SELECT COUNT(*) AS n FROM pagamentos_informados WHERE cliente_id=? AND status='pendente'", [c.id])).n;
    if (pend >= 5) return res.status(429).json({ erro: 'Você já tem comprovantes aguardando confirmação.' });
    const r = await db.run('INSERT INTO pagamentos_informados (mercado_id,cliente_id,valor,comprovante,mime) VALUES (?,?,?,?,?)', [c.mercado_id, c.id, valor, buf, mime]);
    res.status(201).json({ id: r.id, status: 'pendente' });
  });
};
