// Promoções, Pix com valor e comprovantes de pagamento.
const express = require('express');
const U = require('./util');

const MAX_IMG = 2 * 1024 * 1024; // 2 MB

// Confere o tipo REAL do arquivo pelos bytes (não confia no Content-Type enviado)
function tipoImagem(buf) {
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

module.exports = function registraLoja({ app, api, db, porToken, saldoDe }) {
  // ===== DONO: promoções =====
  api.get('/promocoes', async (req, res) => {
    res.json(await db.all('SELECT * FROM promocoes WHERE mercado_id=? ORDER BY ativo DESC, id DESC', [req.mid]));
  });
  api.post('/promocoes', async (req, res) => {
    const { titulo, descricao, preco, preco_original, validade } = req.body || {};
    if (!titulo) return res.status(400).json({ erro: 'Título obrigatório.' });
    if (validade && !/^\d{4}-\d{2}-\d{2}$/.test(validade)) return res.status(400).json({ erro: 'Validade no formato AAAA-MM-DD.' });
    const r = await db.run('INSERT INTO promocoes (mercado_id,titulo,descricao,preco,preco_original,validade) VALUES (?,?,?,?,?,?)', [
      req.mid, String(titulo).slice(0, 80), descricao ? String(descricao).slice(0, 300) : null,
      preco ? U.toCents(preco) : null, preco_original ? U.toCents(preco_original) : null, validade || null]);
    res.status(201).json({ id: r.id });
  });
  api.patch('/promocoes/:id', async (req, res) => {
    const p = await db.get('SELECT * FROM promocoes WHERE id=? AND mercado_id=?', [U.intId(req.params.id), req.mid]);
    if (!p) return res.status(404).json({ erro: 'Promoção não encontrada.' });
    const { titulo, descricao, preco, preco_original, validade, ativo } = req.body || {};
    await db.run('UPDATE promocoes SET titulo=?,descricao=?,preco=?,preco_original=?,validade=?,ativo=? WHERE id=?', [
      titulo ?? p.titulo, descricao ?? p.descricao,
      preco === undefined ? p.preco : preco ? U.toCents(preco) : null,
      preco_original === undefined ? p.preco_original : preco_original ? U.toCents(preco_original) : null,
      validade === undefined ? p.validade : validade || null, ativo === undefined ? p.ativo : ativo ? 1 : 0, p.id]);
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
    const p = await db.get('SELECT * FROM pagamentos_informados WHERE id=? AND mercado_id=?', [id, req.mid]);
    if (!p) return res.status(404).json({ erro: 'Não encontrado.' });
    // o dono pode corrigir o valor se o cliente digitou errado
    const valor = req.body?.valor ? U.toCents(req.body.valor) : p.valor;
    if (!(valor > 0) || valor > 100_000_000) return res.status(400).json({ erro: 'Valor inválido.' });
    // "reserva" atômica: só uma requisição consegue passar de pendente -> confirmado (sem abatimento duplo)
    const claim = await db.run("UPDATE pagamentos_informados SET status='confirmado',valor=?,resolvido_em=to_char(now() at time zone 'utc','YYYY-MM-DD HH24:MI:SS') WHERE id=? AND mercado_id=? AND status='pendente'", [valor, id, req.mid]);
    if (!claim.changes) return res.status(409).json({ erro: 'Já foi resolvido.' });
    const l = await db.run("INSERT INTO lancamentos (mercado_id,cliente_id,tipo,valor,forma,descricao) VALUES (?,?,'pagamento',?,'pix',?)", [req.mid, p.cliente_id, -valor, `Comprovante #${p.id}`]);
    await db.run('UPDATE pagamentos_informados SET lancamento_id=? WHERE id=?', [l.id, id]);
    res.json({ saldo: await saldoDe(p.cliente_id) });
  });
  api.post('/pagamentos-informados/:id/recusar', async (req, res) => {
    const r = await db.run("UPDATE pagamentos_informados SET status='recusado',motivo=?,resolvido_em=to_char(now() at time zone 'utc','YYYY-MM-DD HH24:MI:SS') WHERE id=? AND mercado_id=? AND status='pendente'",
      [String(req.body?.motivo || '').slice(0, 200) || null, U.intId(req.params.id), req.mid]);
    if (!r.changes) return res.status(404).json({ erro: 'Não encontrado ou já resolvido.' });
    res.json({ ok: true });
  });

  // ===== CLIENTE (pelo link pessoal) =====
  const hoje = () => new Date().toISOString().slice(0, 10);

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
    const centavos = req.query.valor ? U.toCents(req.query.valor) : Math.max(await saldoDe(c.id), 0);
    if (!(centavos >= 0) || centavos > 5_000_000) return res.status(400).json({ erro: 'Valor inválido.' });
    res.json({ valor: centavos, copia_e_cola: U.pixPayload({ chave: c.pix_chave, nome: m.nome, cidade: m.cidade, centavos, txid: 'CAD' + c.id }) });
  });

  // Cliente envia o comprovante: corpo = imagem crua (jpeg/png), valor na query
  app.post('/api/publico/:token/comprovante', express.raw({ type: () => true, limit: MAX_IMG }), async (req, res) => {
    if (!U.limite('comp:' + req.ip, 5, 10 * 60_000)) return res.status(429).json({ erro: 'Muitos envios. Tente novamente em alguns minutos.' });
    const c = await porToken(req.params.token);
    if (!c) return res.status(404).json({ erro: 'Link inválido.' });
    const valor = U.toCents(req.query.valor);
    if (!(valor > 0) || valor > 5_000_000) return res.status(400).json({ erro: 'Informe o valor pago.' });
    const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const mime = buf.length ? tipoImagem(buf) : null;
    if (!mime) return res.status(400).json({ erro: 'Envie o comprovante como imagem JPG ou PNG (até 2 MB).' });
    const pend = (await db.get("SELECT COUNT(*) AS n FROM pagamentos_informados WHERE cliente_id=? AND status='pendente'", [c.id])).n;
    if (pend >= 5) return res.status(429).json({ erro: 'Você já tem comprovantes aguardando confirmação.' });
    const r = await db.run('INSERT INTO pagamentos_informados (mercado_id,cliente_id,valor,comprovante,mime) VALUES (?,?,?,?,?)', [c.mercado_id, c.id, valor, buf, mime]);
    res.status(201).json({ id: r.id, status: 'pendente' });
  });
};
