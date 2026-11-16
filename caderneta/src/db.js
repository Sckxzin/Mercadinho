// Camada de banco (PostgreSQL).
//  - Produção (Railway + Supabase): defina DATABASE_URL -> usa o driver "pg".
//  - Local / testes: sem DATABASE_URL -> usa PGlite (Postgres embutido, sem instalar nada).
// Mesmo SQL nos dois. Placeholders: use "?" que viram $1,$2...
const path = require('node:path');

const SCHEMA = `
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
  criado_em     TEXT NOT NULL DEFAULT to_char(now() at time zone 'utc','YYYY-MM-DD HH24:MI:SS')
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
  criado_em     TEXT NOT NULL DEFAULT to_char(now() at time zone 'utc','YYYY-MM-DD HH24:MI:SS')
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
  criado_em   TEXT NOT NULL DEFAULT to_char(now() at time zone 'utc','YYYY-MM-DD HH24:MI:SS')
);
CREATE INDEX IF NOT EXISTS idx_lanc_cliente ON lancamentos(cliente_id);

CREATE TABLE IF NOT EXISTS contestacoes (
  id            SERIAL PRIMARY KEY,
  mercado_id    INTEGER NOT NULL,
  cliente_id    INTEGER NOT NULL REFERENCES clientes(id) ON DELETE CASCADE,
  lancamento_id INTEGER,
  mensagem      TEXT,
  resolvida     INTEGER NOT NULL DEFAULT 0,
  criado_em     TEXT NOT NULL DEFAULT to_char(now() at time zone 'utc','YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS produtos (
  id          SERIAL PRIMARY KEY,
  mercado_id  INTEGER NOT NULL REFERENCES mercados(id) ON DELETE CASCADE,
  nome        TEXT NOT NULL,
  codigo      TEXT,
  alerta_dias INTEGER NOT NULL DEFAULT 7,
  criado_em   TEXT NOT NULL DEFAULT to_char(now() at time zone 'utc','YYYY-MM-DD HH24:MI:SS')
);

CREATE TABLE IF NOT EXISTS entradas (
  id          SERIAL PRIMARY KEY,
  mercado_id  INTEGER NOT NULL REFERENCES mercados(id) ON DELETE CASCADE,
  produto_id  INTEGER NOT NULL REFERENCES produtos(id) ON DELETE CASCADE,
  quantidade  INTEGER NOT NULL,
  validade    TEXT NOT NULL,
  custo       INTEGER,
  baixado     INTEGER NOT NULL DEFAULT 0,
  criado_em   TEXT NOT NULL DEFAULT to_char(now() at time zone 'utc','YYYY-MM-DD HH24:MI:SS')
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
  criado_em   TEXT NOT NULL DEFAULT to_char(now() at time zone 'utc','YYYY-MM-DD HH24:MI:SS')
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
  criado_em      TEXT NOT NULL DEFAULT to_char(now() at time zone 'utc','YYYY-MM-DD HH24:MI:SS')
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
  criado_em     TEXT NOT NULL DEFAULT to_char(now() at time zone 'utc','YYYY-MM-DD HH24:MI:SS'),
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
`;

const aPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
const num = (v) => (typeof v === 'bigint' ? Number(v) : v);
const normaliza = (rows) => rows.map((r) => { const o = {}; for (const k in r) o[k] = num(r[k]); return o; });

// opts: { memory: true } força Postgres embutido em memória (testes)
async function open(opts = {}) {
  const url = process.env.DATABASE_URL;
  let exec, query, close;

  if (url && !opts.memory) {
    const { Pool, types } = require('pg');
    types.setTypeParser(20, Number);    // int8 (COUNT/SUM) -> number
    types.setTypeParser(1700, Number);  // numeric -> number
    const pool = new Pool({
      connectionString: url,
      max: Number(process.env.PG_POOL_MAX || 5),
      ssl: /localhost|127\.0\.0\.1/.test(url) ? false : { rejectUnauthorized: false },
    });
    pool.on('error', (e) => console.error('pg pool:', e.message));
    exec = (sql) => pool.query(sql);
    query = (sql, params) => pool.query(aPg(sql), params).then((r) => ({ rows: r.rows, rowCount: r.rowCount }));
    close = () => pool.end();
  } else {
    const { PGlite } = require('@electric-sql/pglite');
    const dir = opts.memory ? undefined : process.env.PGLITE_DIR || path.join(__dirname, '..', '.pgdata');
    const pg = new PGlite(dir, { parsers: { 20: Number, 1700: Number } });
    await pg.waitReady;
    exec = (sql) => pg.exec(sql);
    query = (sql, params) => pg.query(aPg(sql), params).then((r) => ({ rows: normaliza(r.rows), rowCount: r.affectedRows ?? r.rows.length }));
    close = () => pg.close();
  }

  await exec(SCHEMA);

  return {
    all: async (sql, p = []) => (await query(sql, p)).rows,
    get: async (sql, p = []) => (await query(sql, p)).rows[0],
    // run: INSERT devolve { id } (via RETURNING id); UPDATE/DELETE devolvem { changes }
    run: async (sql, p = []) => {
      const ins = /^\s*insert/i.test(sql) && !/returning/i.test(sql);
      const r = await query(ins ? sql + ' RETURNING id' : sql, p);
      return { id: ins ? r.rows[0]?.id : undefined, changes: r.rowCount };
    },
    close,
  };
}

module.exports = { open };
