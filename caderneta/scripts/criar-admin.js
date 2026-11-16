// Cria (ou redefine a senha de) um administrador do sistema — o painel /admin.
// Uso:  npm run criar-admin -- seu@email.com SenhaForte123 "Seu Nome"
// Em produção, rode com a DATABASE_URL do Supabase definida.
// Alternativa sem terminal: defina ADMIN_EMAIL e ADMIN_SENHA no Railway; o primeiro admin
// é criado sozinho na subida do app (só quando ainda não existe nenhum).
const { open } = require('../src/db');
const U = require('../src/util');

(async () => {
  const [email, senha, nome = 'Administrador'] = process.argv.slice(2);
  if (!email || !senha || senha.length < 10) {
    console.error('Uso: npm run criar-admin -- seu@email.com SenhaForte123 "Seu Nome"   (senha com mín. 10 caracteres)');
    process.exit(1);
  }
  const db = await open();
  try {
    const em = email.trim().toLowerCase();
    const r = await db.get(`INSERT INTO admins (nome,email,senha_hash) VALUES (?,?,?)
      ON CONFLICT (email) DO UPDATE SET senha_hash=EXCLUDED.senha_hash, ativo=1, sessao_versao=admins.sessao_versao+1
      RETURNING (xmax = 0) AS novo`, [nome, em, U.hashSenha(senha)]);
    await db.run('INSERT INTO admin_log (acao,detalhe) VALUES (?,?)', [r.novo ? 'admin.criado_terminal' : 'admin.senha_redefinida_terminal', em]);
    console.log(r.novo ? `Admin ${em} criado. Entre em /admin.` : `Senha do admin ${em} redefinida.`);
  } finally {
    await db.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
