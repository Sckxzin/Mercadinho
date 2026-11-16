// Rotina diária (Railway Cron: npm run alertas). A lógica fica em src/rotina.js.
const { open } = require('../src/db');
const { rotinaDiaria } = require('../src/rotina');

(async () => {
  const db = await open();
  try {
    await rotinaDiaria(db);
  } finally {
    await db.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
