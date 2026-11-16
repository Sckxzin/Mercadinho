// STUB de WhatsApp. Hoje: monta a mensagem, grava na fila (notificacoes) e gera
// um link wa.me para o dono clicar e enviar manualmente (zero custo, zero risco de ban).
//
// Para automatizar de verdade, implemente enviar() com a API oficial (Meta Cloud API
// ou um BSP como Twilio/Z-API oficial). Mensagens iniciadas pela empresa exigem
// TEMPLATE aprovado e têm custo por conversa. NÃO use bibliotecas não-oficiais em
// produção: risco real de banimento do número.
const { brl, soDigitos } = require('./util');

function linkWa(telefone, texto) {
  let n = soDigitos(telefone);
  if (n && !n.startsWith('55')) n = '55' + n;
  return `https://wa.me/${n}?text=${encodeURIComponent(texto)}`;
}

function textoCobranca({ mercado, cliente, saldo, urlCliente }) {
  return (
    `Olá, ${cliente.nome.split(' ')[0]}! Aqui é do ${mercado.nome}. ` +
    `Sua conta na caderneta está em ${brl(saldo)}. ` +
    `Veja o extrato completo aqui: ${urlCliente}` +
    (mercado.pix_chave ? `\nPix: ${mercado.pix_chave}` : '')
  );
}

async function enfileira(db, { mercado_id, cliente_id, telefone, texto }) {
  const link = linkWa(telefone, texto);
  const r = await db.run('INSERT INTO notificacoes (mercado_id, cliente_id, texto, link_wa) VALUES (?,?,?,?)', [mercado_id, cliente_id, texto, link]);
  return { id: r.id, link_wa: link };
}

// Ponto de extensão: troque pelo envio real (API oficial)
async function enviar(/* notificacao */) {
  throw new Error('Envio automático não configurado. Use link_wa (manual) ou implemente a API oficial.');
}

module.exports = { linkWa, textoCobranca, enfileira, enviar };
