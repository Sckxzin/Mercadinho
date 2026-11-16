// Redefine a senha de um acesso ao painel (para quem esqueceu a senha).
// Uso:  npm run redefinir-senha -- email@exemplo.com NovaSenha123
// Em produção, rode com a DATABASE_URL do Supabase definida. Todas as sessões abertas
// desse acesso são encerradas.
const { open } = require('../src/db');
const U = require('../src/util');

(async () => {
  const [email, senha] = process.argv.slice(2);
  if (!email || !senha || senha.length < 8) {
    console.error('Uso: npm run redefinir-senha -- email@exemplo.com NovaSenha123   (mín. 8 caracteres)');
    process.exit(1);
  }
  const db = await open();
  try {
    const u = await db.get('UPDATE usuarios SET senha_hash=?, sessao_versao=sessao_versao+1, ativo=1 WHERE email=? RETURNING id,mercado_id,nome', [U.hashSenha(senha), email.trim().toLowerCase()]);
    if (!u) { console.error('Nenhum acesso com esse email.'); process.exitCode = 1; return; }
    await db.run("INSERT INTO auditoria (mercado_id,usuario_id,acao,detalhe) VALUES (?,?,'senha.redefinida_suporte',?)", [u.mercado_id, u.id, u.nome]);
    console.log(`Senha de ${u.nome} redefinida. Sessões antigas encerradas.`);
  } finally {
    await db.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
