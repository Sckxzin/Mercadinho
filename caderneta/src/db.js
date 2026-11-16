// Camada de banco (PostgreSQL).
//  - Produção (Railway + Supabase): defina DATABASE_URL -> usa o driver "pg".
//  - Local / testes: sem DATABASE_URL -> usa PGlite (Postgres embutido, sem instalar nada).
// Mesmo SQL nos dois. Placeholders: use "?" que viram $1,$2...
//
// O esquema evolui por MIGRAÇÕES numeradas (abaixo). Cada uma roda uma única vez,
// dentro de uma transação, e fica registrada em schema_migracoes. Para mudar o banco,
// ACRESCENTE uma migração no fim da lista; nunca edite uma que já rodou em produção.
const path = require('node:path');

const AGORA = "to_char(now() at time zone 'utc','YYYY-MM-DD HH24:MI:SS')";

const MIGRACOES = [
  // 1 — esquema original (v0.4). "IF NOT EXISTS" para bancos que já existiam antes das migrações.
  `
CREATE TABLE IF NOT EXISTS mercados (
  id            SERIAL PRIMARY KEY,
  nome          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  senha_hash    TEXT NOT NULL,
  pix_chave     TEXT,
  cidade        TEXT,
  whatsapp      TEXT,
  slug          TEXT UNIQUE,
  mostrar_itens INTEGER NOT NULL DEFAULT 0,
  criado_em     TEXT NOT NULL DEFAULT ${AGORA}
);
CREATE TABLE IF NOT EXISTS clientes (
  id            SERIAL PRIMARY KEY,
  mercado_id    INTEGER NOT NULL REFERENCES mercados(id) ON DELETE CASCADE,
  nome          TEXT NOT NULL,
  telefone      TEXT,
  limite        INTEGER NOT NULL DEFAULT 0,
  token         TEXT NOT NULL UNIQUE,
  aceitou_em    TEXT,
  pin_hash      TEXT,
  codigo_hash   TEXT,
  codigo_expira TEXT,
  ativado_em    TEXT,
  ativo         INTEGER NOT NULL DEFAULT 1,
  criado_em     TEXT NOT NULL DEFAULT ${AGORA}
);
CREATE INDEX IF NOT EXISTS idx_clientes_mercado ON clientes(mercado_id);
-- Razão única: compra (+), pagamento (-), ajuste (+/-). Saldo = soma.
CREATE TABLE IF NOT EXISTS lancamentos (
  id          SERIAL PRIMARY KEY,
  mercado_id  INTEGER NOT NULL REFERENCES mercados(id) ON DELETE CASCADE,
  cliente_id  INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  tipo        TEXT NOT NULL CHECK (tipo IN ('compra','pagamento','ajuste')),
  valor       INTEGER NOT NULL,
  descricao   TEXT,
  forma       TEXT,
  contestado  INTEGER NOT NULL DEFAULT 0,
  criado_em   TEXT NOT NULL DEFAULT ${AGORA}
);
CREATE INDEX IF NOT EXISTS idx_lanc_cliente ON lancamentos(cliente_id);
CREATE TABLE IF NOT EXISTS contestacoes (
  id            SERIAL PRIMARY KEY,
  mercado_id    INTEGER NOT NULL,
  cliente_id    INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  lancamento_id INTEGER,
  mensagem      TEXT,
  resolvida     INTEGER NOT NULL DEFAULT 0,
  criado_em     TEXT NOT NULL DEFAULT ${AGORA}
);
CREATE TABLE IF NOT EXISTS produtos (
  id          SERIAL PRIMARY KEY,
  mercado_id  INTEGER NOT NULL REFERENCES mercados(id) ON DELETE CASCADE,
  nome        TEXT NOT NULL,
  codigo      TEXT,
  alerta_dias INTEGER NOT NULL DEFAULT 7,
  criado_em   TEXT NOT NULL DEFAULT ${AGORA}
);
CREATE TABLE IF NOT EXISTS entradas (
  id          SERIAL PRIMARY KEY,
  mercado_id  INTEGER NOT NULL REFERENCES mercados(id) ON DELETE CASCADE,
  produto_id  INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  quantidade  INTEGER NOT NULL,
  validade    TEXT NOT NULL,
  custo       INTEGER,
  baixado     INTEGER NOT NULL DEFAULT 0,
  criado_em   TEXT NOT NULL DEFAULT ${AGORA}
);
CREATE INDEX IF NOT EXISTS idx_entradas_validade ON entradas(mercado_id, validade);
CREATE TABLE IF NOT EXISTS notificacoes (
  id          SERIAL PRIMARY KEY,
  mercado_id  INTEGER NOT NULL,
  cliente_id  INTEGER,
  canal       TEXT NOT NULL DEFAULT 'whatsapp',
  texto       TEXT NOT NULL,
  link_wa     TEXT,
  status      TEXT NOT NULL DEFAULT 'pendente',
  criado_em   TEXT NOT NULL DEFAULT ${AGORA}
);
CREATE TABLE IF NOT EXISTS promocoes (
  id             SERIAL PRIMARY KEY,
  mercado_id     INTEGER NOT NULL REFERENCES mercados(id) ON DELETE CASCADE,
  titulo         TEXT NOT NULL,
  descricao      TEXT,
  preco          INTEGER,
  preco_original INTEGER,
  validade       TEXT,
  ativo          INTEGER NOT NULL DEFAULT 1,
  criado_em      TEXT NOT NULL DEFAULT ${AGORA}
);
CREATE TABLE IF NOT EXISTS pagamentos_informados (
  id            SERIAL PRIMARY KEY,
  mercado_id    INTEGER NOT NULL REFERENCES mercados(id) ON DELETE CASCADE,
  cliente_id    INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  valor         INTEGER NOT NULL,
  comprovante   BYTEA,
  mime          TEXT,
  status        TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','confirmado','recusado')),
  motivo        TEXT,
  lancamento_id INTEGER,
  criado_em     TEXT NOT NULL DEFAULT ${AGORA},
  resolvido_em  TEXT
);
CREATE INDEX IF NOT EXISTS idx_pi_mercado ON pagamentos_informados(mercado_id, status);
-- SEGURANÇA (Supabase): sem RLS, a API pública do Supabase exporia estas tabelas
-- (inclusive hashes de senha e comprovantes). Com RLS ligado e NENHUMA policy, só o
-- servidor (conexão direta com o role postgres) acessa.
ALTER TABLE mercados ENABLE ROW LEVEL SECURITY;
ALTER TABLE clientes ENABLE ROW LEVEL SECURITY;
ALTER TABLE lancamentos ENABLE ROW LEVEL SECURITY;
ALTER TABLE contestacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE produtos ENABLE ROW LEVEL SECURITY;
ALTER TABLE entradas ENABLE ROW LEVEL SECURITY;
ALTER TABLE notificacoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE promocoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE pagamentos_informados ENABLE ROW LEVEL SECURITY;
`,

  // 2 — equipe (usuários com papel), auditoria, estorno único, telefone normalizado,
  //     dia de vencimento da conta e controle de envio das cobranças.
  `
CREATE TABLE IF NOT EXISTS usuarios (
  id             SERIAL PRIMARY KEY,
  mercado_id     INTEGER NOT NULL REFERENCES mercados(id) ON DELETE CASCADE,
  nome           TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE,
  senha_hash     TEXT NOT NULL,
  papel          TEXT NOT NULL DEFAULT 'caixa' CHECK (papel IN ('dono','caixa')),
  ativo          INTEGER NOT NULL DEFAULT 1,
  sessao_versao  INTEGER NOT NULL DEFAULT 1,
  criado_em      TEXT NOT NULL DEFAULT ${AGORA}
);
CREATE INDEX IF NOT EXISTS idx_usuarios_mercado ON usuarios(mercado_id);
-- cada mercado que já existia ganha o seu usuário "dono" com o mesmo email e senha
INSERT INTO usuarios (mercado_id, nome, email, senha_hash, papel)
  SELECT m.id, m.nome, m.email, m.senha_hash, 'dono' FROM mercados m
  WHERE NOT EXISTS (SELECT 1 FROM usuarios u WHERE u.email = m.email);

CREATE TABLE IF NOT EXISTS auditoria (
  id          SERIAL PRIMARY KEY,
  mercado_id  INTEGER NOT NULL REFERENCES mercados(id) ON DELETE CASCADE,
  usuario_id  INTEGER,
  acao        TEXT NOT NULL,
  detalhe     TEXT,
  criado_em   TEXT NOT NULL DEFAULT ${AGORA}
);
CREATE INDEX IF NOT EXISTS idx_auditoria_mercado ON auditoria(mercado_id, id);

ALTER TABLE lancamentos ADD COLUMN IF NOT EXISTS usuario_id INTEGER;
ALTER TABLE lancamentos ADD COLUMN IF NOT EXISTS estorno_de INTEGER;
-- estornos antigos (só tinham a descrição): liga o PRIMEIRO estorno de cada lançamento
UPDATE lancamentos SET estorno_de = x.orig FROM (
  SELECT MIN(id) AS lid, (substring(descricao from 'Estorno do lançamento #([0-9]+)'))::int AS orig
  FROM lancamentos WHERE tipo = 'ajuste' AND descricao LIKE 'Estorno do lançamento #%' GROUP BY 2
) x WHERE lancamentos.id = x.lid AND x.orig IS NOT NULL;
-- um lançamento só pode ser estornado UMA vez (garantido pelo banco)
CREATE UNIQUE INDEX IF NOT EXISTS uq_lanc_estorno ON lancamentos(estorno_de) WHERE estorno_de IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_lanc_mercado ON lancamentos(mercado_id, criado_em);

ALTER TABLE clientes ADD COLUMN IF NOT EXISTS telefone_norm TEXT;
ALTER TABLE clientes ADD COLUMN IF NOT EXISTS dia_vencimento INTEGER;
UPDATE clientes SET telefone_norm = CASE WHEN x.d LIKE '55%' AND length(x.d) > 11 THEN substr(x.d, 3) ELSE x.d END
  FROM (SELECT id AS cid, regexp_replace(telefone, '[^0-9]', '', 'g') AS d FROM clientes WHERE telefone IS NOT NULL) x
  WHERE clientes.id = x.cid;
UPDATE clientes SET telefone_norm = NULL WHERE telefone_norm = '';
CREATE INDEX IF NOT EXISTS idx_clientes_tel ON clientes(mercado_id, telefone_norm);

ALTER TABLE notificacoes ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'cobranca';
ALTER TABLE notificacoes ADD COLUMN IF NOT EXISTS enviada_em TEXT;
ALTER TABLE notificacoes ADD COLUMN IF NOT EXISTS erro TEXT;
CREATE INDEX IF NOT EXISTS idx_notif_mercado ON notificacoes(mercado_id, status);
CREATE INDEX IF NOT EXISTS idx_notif_cliente ON notificacoes(cliente_id, criado_em);

ALTER TABLE usuarios ENABLE ROW LEVEL SECURITY;
ALTER TABLE auditoria ENABLE ROW LEVEL SECURITY;
`,

  // 3 — painel do administrador do sistema (você): admins, registro das ações do admin,
  //     configurações globais e suspensão de mercados.
  `
CREATE TABLE IF NOT EXISTS admins (
  id             SERIAL PRIMARY KEY,
  nome           TEXT NOT NULL,
  email          TEXT NOT NULL UNIQUE,
  senha_hash     TEXT NOT NULL,
  ativo          INTEGER NOT NULL DEFAULT 1,
  sessao_versao  INTEGER NOT NULL DEFAULT 1,
  ultimo_login   TEXT,
  criado_em      TEXT NOT NULL DEFAULT ${AGORA}
);
CREATE TABLE IF NOT EXISTS admin_log (
  id          SERIAL PRIMARY KEY,
  admin_id    INTEGER,
  acao        TEXT NOT NULL,
  mercado_id  INTEGER,
  detalhe     TEXT,
  criado_em   TEXT NOT NULL DEFAULT ${AGORA}
);
CREATE INDEX IF NOT EXISTS idx_admin_log ON admin_log(id);
CREATE TABLE IF NOT EXISTS config (
  chave  TEXT PRIMARY KEY,
  valor  TEXT
);
ALTER TABLE mercados ADD COLUMN IF NOT EXISTS ativo INTEGER NOT NULL DEFAULT 1;
ALTER TABLE mercados ADD COLUMN IF NOT EXISTS bloqueio_motivo TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ultimo_login TEXT;
ALTER TABLE admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE config ENABLE ROW LEVEL SECURITY;
`,
];

const aPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
const num = (v) => (typeof v === 'bigint' ? Number(v) : v);
const normaliza = (rows) => rows.map((r) => { const o = {}; for (const k in r) o[k] = num(r[k]); return o; });

// Interface comum (all/get/run) sobre uma função query(sql, params)
function interfaceSobre(query) {
  return {
    all: async (sql, p = []) => (await query(sql, p)).rows,
    get: async (sql, p = []) => (await query(sql, p)).rows[0],
    // run: INSERT devolve { id } (via RETURNING id); UPDATE/DELETE devolvem { changes }
    run: async (sql, p = []) => {
      const ins = /^\s*insert/i.test(sql) && !/returning/i.test(sql);
      const r = await query(ins ? sql + ' RETURNING id' : sql, p);
      return { id: ins ? r.rows[0]?.id : undefined, changes: r.rowCount };
    },
  };
}

// opts: { memory: true } força Postgres embutido em memória (testes); { url } força uma conexão
async function open(opts = {}) {
  const url = opts.url || (opts.memory ? null : process.env.DATABASE_URL);
  let query, close, tx;

  if (url) {
    const { Pool, types } = require('pg');
    types.setTypeParser(20, Number);    // int8 (COUNT/SUM) -> number
    types.setTypeParser(1700, Number);  // numeric -> number
    const pool = new Pool({
      connectionString: url,
      max: Number(process.env.PG_POOL_MAX || 5),
      ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
    });
    pool.on('error', (e) => console.error('pg pool:', e.message));
    const viaCliente = (c) => (sql, params) => c.query(aPg(sql), params).then((r) => ({ rows: r.rows, rowCount: r.rowCount }));
    query = viaCliente(pool);
    close = () => pool.end();
    tx = async (fn) => {
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        const out = await fn(interfaceSobre(viaCliente(c)));
        await c.query('COMMIT');
        return out;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        c.release();
      }
    };
  } else {
    const { PGlite } = require('@electric-sql/pglite');
    const dir = opts.memory ? undefined : process.env.PGLITE_DIR || path.join(__dirname, '..', '.pgdata');
    const pg = new PGlite(dir, { parsers: { 20: Number, 1700: Number } });
    await pg.waitReady;
    const viaCliente = (c) => (sql, params) => c.query(aPg(sql), params).then((r) => ({ rows: normaliza(r.rows), rowCount: r.affectedRows ?? r.rows.length }));
    query = viaCliente(pg);
    close = () => pg.close();
    tx = (fn) => pg.transaction((t) => fn(interfaceSobre(viaCliente(t))));
  }

  const db = { ...interfaceSobre(query), tx, close };
  await migra(db);
  return db;
}

async function migra(db) {
  await db.run(`CREATE TABLE IF NOT EXISTS schema_migracoes (versao INTEGER PRIMARY KEY, aplicada_em TEXT NOT NULL DEFAULT ${AGORA})`);
  await db.run('ALTER TABLE schema_migracoes ENABLE ROW LEVEL SECURITY');
  for (let i = 0; i < MIGRACOES.length; i++) {
    const versao = i + 1;
    await db.tx(async (t) => {
      // trava global: se duas instâncias subirem juntas, só uma migra
      await t.get('SELECT pg_advisory_xact_lock(724501)');
      if (await t.get('SELECT 1 AS x FROM schema_migracoes WHERE versao=?', [versao])) return;
      for (const cmd of separaComandos(MIGRACOES[i])) await t.run(cmd);
      await t.all('INSERT INTO schema_migracoes (versao) VALUES (?) RETURNING versao', [versao]);
    });
  }
}

// divide um bloco SQL em comandos (as migrações não usam ";" dentro de strings)
const separaComandos = (sql) => sql.split(/;\s*$/m).map((s) => s.replace(/^\s*--.*$/gm, '').trim()).filter(Boolean);

module.exports = { open, MIGRACOES };
