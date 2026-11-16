# Publicar a Caderneta: GitHub → Supabase (banco) → Railway (app)

Tempo: cerca de 20 minutos. Ordem: 1) banco, 2) código no GitHub, 3) Railway.

## 1. Supabase (banco de dados)
1. Em supabase.com crie um projeto. Escolha a região **São Paulo** e guarde a senha do banco.
2. Clique em **Connect** (ou Project Settings → Database) e copie a **Connection string** do modo **Session pooler**.
   Troque `[YOUR-PASSWORD]` pela sua senha. Ela é parecida com:
   `postgresql://postgres.xxxx:SENHA@aws-0-sa-east-1.pooler.supabase.com:5432/postgres`
   - Use o **Session pooler**, não a conexão direta: a direta usa IPv6 e o Railway pode não alcançá-la.
3. Não precisa criar tabelas: o app cria tudo sozinho na primeira vez que sobe (inclusive a proteção RLS).

## 2. GitHub
Na pasta do projeto (onde está o `package.json`):
```powershell
git init
git add .
git commit -m "Caderneta v0.4"
git branch -M main
git remote add origin https://github.com/SEU_USUARIO/caderneta.git
git push -u origin main
```
Crie antes o repositório vazio **privado** no GitHub. O arquivo `.env` e a pasta `node_modules` já ficam de fora (`.gitignore`).

## 3. Railway
1. Em railway.com: **New Project → Deploy from GitHub repo** e escolha o `caderneta`.
2. Abra o serviço → **Variables** e cadastre:
   | Variável | Valor |
   |---|---|
   | `DATABASE_URL` | a string do Session pooler (passo 1) |
   | `APP_SECRET` | um texto aleatório longo. Gere com: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
   | `BASE_URL` | preencha depois do passo 3 (domínio) |
3. **Settings → Networking → Generate Domain**. Copie o endereço (`https://xxxx.up.railway.app`) e cadastre-o em `BASE_URL`. O Railway reinicia sozinho.
4. Abra `https://xxxx.up.railway.app/health`. Deve aparecer `{"ok":true}`.
5. Abra `/painel` → **Criar conta do mercado**. Depois vá em **Config** e preencha **chave Pix** e **cidade**.
6. (Recomendado) Assim que criar o seu mercado, adicione a variável `REGISTRO_ABERTO=false` para ninguém mais criar contas. Para cadastrar outro mercado depois, volte para `true` ou remova a variável.

Se o app não subir, veja a aba **Deployments → Logs**. Os erros mais comuns:
- `Defina APP_SECRET…` → faltou a variável `APP_SECRET`.
- `password authentication failed` / `ENOTFOUND` → `DATABASE_URL` com senha errada ou conexão direta em vez do Session pooler.

## 4. Rotina diária (opcional): validade e cobranças
No Railway crie um segundo serviço a partir do mesmo repositório, com as mesmas variáveis, comando `npm run alertas` e um **Cron Schedule** (por exemplo `0 11 * * *`, todo dia às 8h de Brasília). Ele lista produtos vencendo e coloca cobranças na fila. O envio continua manual pelo botão do WhatsApp no painel.

## Cuidados
- **Segurança do banco:** as tabelas ficam com RLS ligado e sem políticas, então a API pública do Supabase não enxerga nada. Só o servidor acessa. Não use a chave `anon` nem exponha a `DATABASE_URL`.
- **Backup:** confira o que o seu plano do Supabase oferece. Os comprovantes (imagens) ficam dentro do banco.
- **Uma instância só:** o limite de tentativas (anti força bruta) fica na memória do app. Mantenha **1 réplica** no Railway.
- **LGPD:** o app guarda nome, telefone e movimentações dos clientes do mercado. Deixe o aviso/consentimento do cadastro ligado.
- **Custos e limites:** os planos do Railway e do Supabase mudam. Confira nos sites antes de levar clientes de verdade (no plano grátis o Supabase pode pausar projetos inativos).

## Teste local sem nada instalado
`npm install`, `npm run seed`, `npm start`. Sem `DATABASE_URL` o app usa um Postgres embutido (pasta `.pgdata`).
Para testar contra o Supabase da sua máquina: defina `DATABASE_URL` e `APP_SECRET` no PowerShell (`$env:DATABASE_URL="..."`) e rode `npm start`.
