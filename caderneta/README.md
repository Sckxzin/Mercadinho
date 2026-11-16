# Caderneta — base do sistema para mercadinhos

Substitui o caderno de fiado por banco de dados, com página de consulta para o cliente,
alertas de validade e cobrança por WhatsApp.

## Rodar local (sem instalar banco)
```bash
npm install
npm run seed     # demonstração: dono demo@demo.com / demo12345 · caixa caixa@demo.com / caixa12345
npm start        # http://localhost:3000  (painel)
npm test         # 122 verificações ponta a ponta
npm run lint     # verificação de código
npm run alertas  # rotina diária: validade, lembretes de vencimento e fila de cobranças (agendar via cron)
npm run redefinir-senha -- email@exemplo.com NovaSenha123   # para quem esqueceu a senha
npm run criar-admin -- seu@email.com SenhaForte123 "Seu Nome"   # seu acesso ao painel /admin
```
Testar contra um Postgres de verdade (o banco de teste é apagado): `TEST_DATABASE_URL=postgres://... npm test`.
Os testes rodam sozinhos no GitHub a cada envio (`.github/workflows/ci.yml`), no banco embutido e num Postgres 16.
**Produção (Railway + Supabase):** veja `DEPLOY.md`. Banco: PostgreSQL (`DATABASE_URL`); sem ela, usa Postgres embutido local.
Variáveis: `PORT`, `DATABASE_URL`, `APP_SECRET` (obrigatório em produção), `BASE_URL`, `REGISTRO_ABERTO`, `MIN_COBRANCA_CENTAVOS`, `APP_TZ` (padrão `America/Sao_Paulo`) e, opcionais, `WA_TOKEN`, `WA_PHONE_ID`, `WA_TEMPLATE` (WhatsApp automático).

## O que já funciona
- Multi-tenant (cada mercado isolado), login com scrypt + token assinado
- Clientes com limite de fiado, saldo calculado por razão (compra / pagamento / ajuste), estorno sem apagar histórico
- Link pessoal do cliente `/c/<token>` (192 bits, somente leitura, noindex, rate limit, "gerar novo link")
- Dono decide se o cliente vê os itens; botão "Tem algo errado?" → vira aviso no painel
- Produtos + entradas com validade, alerta "vence em X dias" por produto, dar baixa
- Cobrança: monta mensagem + link `wa.me` (manual, sem custo/sem risco de ban)
- Aviso LGPD na página do cliente e registro de ciência (`aceitou_em`)

## Promoções, Pix e comprovante (v0.2)
- **Promoções:** o dono cadastra (título, preço "de/por", validade) na aba *Promoções*; o cliente vê as ativas na página dele. Vencidas somem sozinhas.
- **Pix copia e cola com valor:** gerado no servidor (BR Code, CRC16 validado). Preencha a **chave Pix** e a **cidade** em *Config*.
- **Comprovante:** o cliente anexa foto/print (reduzida no celular antes de enviar; só JPG/PNG, verificado pelos bytes, máx. 2 MB). Cai na aba *Comprovantes*; o dono vê a imagem e **confirma** (abate o saldo, podendo corrigir o valor) ou **recusa** com motivo. Nada abate o saldo antes da confirmação, e não confirma duas vezes.
- Limitação conhecida: o Pix estático não avisa quando o dinheiro cai. A conferência é manual pelo app do banco. Baixa automática exige API de Pix (PSP) — fase seguinte.

## Portal do cliente (v0.3) — o "app"
- Cada mercado tem um endereço fixo `/m/<slug>` (aparece em *Config*, com **QR code** para imprimir e colar no balcão).
- Sem login o cliente já vê o nome do mercado e as **promoções**.
- **Primeiro acesso:** na ficha do cliente, o dono clica *Convidar para o app*: gera um **código de 6 dígitos** (vale 7 dias, uso único) e abre o WhatsApp com o convite pronto. O cliente informa telefone + código e **cria um PIN** (4–6 números). O mesmo botão serve para **redefinir o PIN** de quem esqueceu.
- **Dia a dia:** telefone + PIN. A sessão fica salva no aparelho; "Sair deste aparelho" encerra.
- **Instalável (PWA):** no Android aparece "Instalar como aplicativo"; no iPhone, Compartilhar → Adicionar à Tela de Início. Abre direto na conta.
- Segurança: ninguém vê dívida só por saber o telefone (precisa do código do balcão); PIN guardado com scrypt; limite de tentativas por IP e por telefone; o cliente só entra pelo endereço do próprio mercado.
- O link pessoal `/c/<token>` continua existindo. "Gerar novo link" também derruba as sessões abertas do app daquele cliente.
- Para virar app de loja (Play Store/App Store) depois: dá para empacotar este PWA (ex.: Capacitor/TWA) sem refazer nada.

## Painel do administrador (v0.6) — `/admin`
O seu painel, como dono da plataforma, com login próprio (separado dos mercados):
- **Visão geral:** total a receber em todos os mercados, fiado e recebido no mês, mercados ativos e os que usam de verdade (lançaram na semana), pessoas com acesso, clientes, comprovantes aguardando e **alertas** (mercados parados há 14+ dias, cadastro aberto, sistema sem APP_SECRET).
- **Mercados:** busca, números de cada um, equipe, histórico de ações. Você pode **criar mercado** para um cliente novo, **suspender** (ex.: mensalidade em aberto; a equipe vê o motivo e o app dos clientes fica indisponível, sem apagar nada) e **reativar**, renomear, redefinir senha, desconectar ou desativar qualquer pessoa da equipe.
- **Registro de ações:** tudo o que os administradores fizeram.
- **Sistema:** saúde (versão, banco, tempo de resposta, migrações, memória), abrir/fechar o **cadastro público**, outros administradores e sua senha.
- **Privacidade (LGPD):** o admin vê números e equipes, não a lista de clientes nem as compras de cada mercado.
- **Segurança:** sessão de 12 h que fecha com o navegador, senha de no mínimo 10 caracteres, bloqueio após 5 tentativas erradas.

Primeiro acesso: `npm run criar-admin -- seu@email.com SenhaForte123 "Seu Nome"` (com a `DATABASE_URL` de produção) **ou** defina `ADMIN_EMAIL` e `ADMIN_SENHA` no Railway: o primeiro admin é criado sozinho na subida (apague `ADMIN_SENHA` depois).

## v0.5 — mais seguro e mais fluido
**Correções**
- Valores com ponto de milhar ("1.234,56") funcionam; valores inválidos são recusados com mensagem (antes podiam gravar lixo).
- Estorno só uma vez por lançamento (garantido pelo banco), e não dá para estornar um estorno.
- Transações: duas compras ao mesmo tempo não furam o limite; confirmar comprovante lança o pagamento junto (ou nada).
- "Hoje", "este mês", validade e promoções no horário de Brasília (antes, depois das 21h o sistema já achava que era o dia seguinte).
- Telefone normalizado e único por mercado (o app do cliente não abre a conta de outra pessoa).
- Banco com **migrações versionadas** (`schema_migracoes`): bancos antigos são atualizados sozinhos ao subir.
- Memória do anti-abuso é limpa; cabeçalhos de segurança (CSP, anti-iframe).

**Novidades**
- **Equipe:** o dono cria acessos de **caixa** (lança compras e pagamentos; não estorna, não muda limites nem vê relatórios). Desativar derruba a sessão na hora.
- **Minha conta:** trocar senha e "sair de todos os aparelhos".
- **Auditoria:** quem estornou, confirmou comprovante, mudou limite, exportou dados etc.
- **Relatórios:** há quanto tempo cada cliente deve (faixas 0-30 / 31-60 / 61-90 / 90+), recebido por forma de pagamento.
- **Exportar:** clientes e lançamentos em CSV (abre no Excel) e **backup completo** em JSON.
- **Clientes:** busca sem acento e por telefone, filtros (devendo / arquivados), arquivar/reativar, lista e extrato paginados, extrato para imprimir/PDF, mostra quem lançou.
- **Dia de vencimento** da conta: o cliente vê no app e recebe lembrete 3 dias antes e no dia.
- **Fila de cobranças** na aba Avisos: a rotina diária prepara, o dono envia com 1 toque (a mensagem é refeita com o saldo de agora; quem já pagou é descartado).
- **WhatsApp automático (opcional)** pela API oficial da Meta — veja `src/whatsapp.js` e `DEPLOY.md`.
- **Produtos:** editar, excluir, ver lotes, código de barras (inclusive **lendo pela câmera** no Chrome do Android).
- **Painel fluido:** troca de tela sem recarregar, botão voltar do celular funciona, campo de dinheiro formata enquanto digita, erros aparecem dentro da janela (sem perder o que foi digitado), botões não aceitam clique duplo, "+" para lançar compra direto da lista, aviso de "sem internet".

## Próximos passos
1. Pix com baixa automática: exige escolher um provedor (PSP: Mercado Pago, Efí, banco) e uma conta com API — o pagamento cairia sozinho, sem comprovante.
2. Notificação de promoção por WhatsApp para clientes que aceitarem receber.
3. Empacotar o app do cliente para a Play Store (TWA/Capacitor).

## Fora do escopo (de propósito)
PDV completo e nota fiscal. Validar primeiro com 2–3 mercados reais.
