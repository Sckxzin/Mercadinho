# Caderneta — base do sistema para mercadinhos

Substitui o caderno de fiado por banco de dados, com página de consulta para o cliente,
alertas de validade e cobrança por WhatsApp.

## Rodar local (sem instalar banco)
```bash
npm install
npm run seed     # dados de demonstração (demo@demo.com / demo12345)
npm start        # http://localhost:3000  (painel do dono)
npm test         # 45 verificações ponta a ponta
npm run alertas  # rotina diária: validade + fila de cobranças (agendar via cron)
```
**Produção (Railway + Supabase):** veja `DEPLOY.md`. Banco: PostgreSQL (`DATABASE_URL`); sem ela, usa Postgres embutido local.
Variáveis: `PORT`, `DATABASE_URL`, `APP_SECRET` (obrigatório em produção), `BASE_URL`, `REGISTRO_ABERTO`, `MIN_COBRANCA_CENTAVOS`.

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

## Próximos passos
1. WhatsApp automático: implementar `enviar()` em `src/whatsapp.js` com a API oficial (templates aprovados, custo por conversa). Evitar libs não-oficiais.
3. Pix com baixa automática (fase 2), PWA instalável, impressão de extrato.
4. Painel em React se quiser UI mais rica (a API já está pronta).
5. Notificação de promoção por WhatsApp para clientes que aceitarem receber.

## Fora do escopo (de propósito)
PDV completo e nota fiscal. Validar primeiro com 2–3 mercados reais.
