import { pool } from './db.js';
import { PESSOA_RECENTE } from './whatsapp.js';
import { USUARIOS, USUARIOS_FILIAL } from './erp.js';

// Atendimentos do WhatsApp (whatsapp_atendimentos): um registro por atendimento encerrado.
// Vieram do pesquisasSatisfacao.ts do bm-crm (a pesquisa de satisfação é do Suporte e ficou fora do ERP).

/**
 * Atendimento do WhatsApp encerrado (chatbot.ts, marcarEncerramento): registra de quando a quando, o cliente e quem
 * atendeu (o último da equipe que escreveu). Só se o cliente escreveu nele
 */
export async function registrarAtendimentoWhatsApp(empresaId: number, telefone: string, motivo: string) {
  // O atendimento vai do encerramento anterior até este (o último)
  const [e] = await pool.query<any[]>(
    "SELECT id FROM crm_whatsapp_mensagens WHERE empresa_id = ? AND telefone = ? AND tipo = 'encerramento' ORDER BY id DESC LIMIT 2",
    [empresaId, telefone],
  );
  if (!e[0]) return;
  const faixa = [empresaId, telefone, e[1]?.id ?? 0, e[0].id];
  const [r] = await pool.query<any[]>(
    `SELECT MIN(data_hora) AS inicio, ${PESSOA_RECENTE()} AS pessoa_id, SUM(direcao = 'recebida' AND (origem IS NULL OR origem NOT LIKE 'pesquisa%')) AS recebidas
       FROM crm_whatsapp_mensagens WHERE empresa_id = ? AND telefone = ? AND id > ? AND id < ? AND tipo NOT IN ('encerramento', 'evento')`,
    faixa,
  );
  if (!Number(r[0]?.recebidas)) return;
  // Quem atendeu: o último da equipe no atendimento (mensagem ou "começou o atendimento")
  const [u] = await pool.query<any[]>(
    `SELECT m.usuario_id, x.departamento_id FROM crm_whatsapp_mensagens m JOIN ${USUARIOS_FILIAL} x ON x.id = m.usuario_id AND x.empresa_id = m.empresa_id
      WHERE m.empresa_id = ? AND m.telefone = ? AND m.id > ? AND m.id < ? ORDER BY m.id DESC LIMIT 1`,
    faixa,
  );
  await pool.query(
    'INSERT INTO crm_whatsapp_atendimentos (empresa_id, telefone, pessoa_id, atendente_id, departamento_id, inicio, fim, motivo_fim) VALUES (?, ?, ?, ?, ?, ?, NOW(), ?)',
    [empresaId, telefone, r[0].pessoa_id, u[0]?.usuario_id ?? null, u[0]?.departamento_id ?? null, r[0].inicio, motivo],
  );
}

/** Pesquisa pós-atendimento enviada (pesquisa.ts): liga a avaliação ao atendimento que acabou de encerrar */
export async function ligarAvaliacao(empresaId: number, telefone: string, avaliacaoId: number) {
  await pool.query(
    `UPDATE crm_whatsapp_atendimentos SET avaliacao_id = ?
      WHERE empresa_id = ? AND telefone = ? AND avaliacao_id IS NULL AND fim >= NOW() - INTERVAL 5 MINUTE ORDER BY id DESC LIMIT 1`,
    [avaliacaoId, empresaId, telefone],
  );
}
