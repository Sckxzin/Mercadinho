// WhatsApp.
//  - Padrão (sem configuração): manual. O sistema monta a mensagem e um link wa.me; o dono
//    toca em "Enviar" e o WhatsApp dele abre com o texto pronto. Sem custo e sem risco de ban.
//  - Automático (opcional): API oficial do WhatsApp (Meta Cloud API). Mensagens iniciadas pela
//    empresa exigem um TEMPLATE aprovado pela Meta e têm custo por conversa. Configure:
//      WA_TOKEN        token permanente do app na Meta
//      WA_PHONE_ID     "Phone number ID" do número da empresa
//      WA_TEMPLATE     nome do template aprovado (idioma pt_BR), com 4 variáveis no corpo:
//                      {{1}} primeiro nome, {{2}} nome do mercado, {{3}} saldo, {{4}} link da conta
//    Exemplo de corpo do template:
//      "Olá, {{1}}! Aqui é do {{2}}. Sua conta está em {{3}}. Veja o extrato: {{4}}"
// NÃO use bibliotecas não-oficiais em produção: risco real de banimento do número.
const { brl, soDigitos, agoraUTC } = require('./util');

const API = 'https://graph.facebook.com/v21.0';

const comDdi = (telefone) => { let n = soDigitos(telefone); if (n && !n.startsWith('55')) n = '55' + n; return n; };
const linkWa = (telefone, texto) => `https://wa.me/${comDdi(telefone)}?text=${encodeURIComponent(texto)}`;

function textoCobranca({ mercado, cliente, saldo, urlCliente }) {
  return (
    `Olá, ${cliente.nome.split(' ')[0]}! Aqui é do ${mercado.nome}. ` +
    `Sua conta na caderneta está em ${brl(saldo)}. ` +
    `Veja o extrato completo aqui: ${urlCliente}` +
    (mercado.pix_chave ? `\nPix: ${mercado.pix_chave}` : '')
  );
}

function textoVencimento({ mercado, cliente, saldo, urlCliente, data, dias }) {
  const quando = dias === 0 ? 'vence HOJE' : `vence em ${dias} dia${dias > 1 ? 's' : ''} (${data.split('-').reverse().join('/')})`;
  return (
    `Olá, ${cliente.nome.split(' ')[0]}! Lembrete do ${mercado.nome}: sua conta de ${brl(saldo)} ${quando}. ` +
    `Extrato e Pix: ${urlCliente}`
  );
}

async function enfileira(db, { mercado_id, cliente_id, telefone, texto, tipo = 'cobranca', status = 'pendente' }) {
  const link = linkWa(telefone, texto);
  const r = await db.run('INSERT INTO notificacoes (mercado_id, cliente_id, texto, link_wa, tipo, status, enviada_em) VALUES (?,?,?,?,?,?,?)',
    [mercado_id, cliente_id, texto, link, tipo, status, status === 'enviada' ? agoraUTC() : null]);
  return { id: r.id, link_wa: link };
}

const configurado = (env = process.env) => !!(env.WA_TOKEN && env.WA_PHONE_ID && env.WA_TEMPLATE);

// Envio pela API oficial. `params` = as 4 variáveis do template, em ordem.
async function enviar({ telefone, params }, { env = process.env, fetchFn = fetch } = {}) {
  if (!configurado(env)) throw new Error('Envio automático não configurado (WA_TOKEN, WA_PHONE_ID, WA_TEMPLATE).');
  const r = await fetchFn(`${API}/${encodeURIComponent(env.WA_PHONE_ID)}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${env.WA_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to: comDdi(telefone),
      type: 'template',
      template: {
        name: env.WA_TEMPLATE,
        language: { code: env.WA_TEMPLATE_LANG || 'pt_BR' },
        components: [{ type: 'body', parameters: params.map((p) => ({ type: 'text', text: String(p).slice(0, 1000) })) }],
      },
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.error?.message || `WhatsApp respondeu ${r.status}`);
  return { id: j?.messages?.[0]?.id || null };
}

module.exports = { linkWa, textoCobranca, textoVencimento, enfileira, enviar, configurado };
