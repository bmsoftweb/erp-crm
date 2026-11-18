import { pool } from './db.js';
import { tirarProprietarioDosEnvolvidos } from './participantes.js';
import { contarPublico, normalizarSelecao, variaveisDoTexto } from './campanhas.js';
import { recalcularContrato } from './contratos.js';
import { assuntoComIcone } from './schema.js';

/**
 * Regras aplicadas depois de qualquer gravação, venha ela das telas genéricas de CRUD,
 * do Kanban ou dos editores de proposta/pedido. Assim os campos calculados do negócio
 * nunca dependem de qual tela fez a alteração.
 *
 * As datas usam NOW() do MySQL, que roda em UTC-3 (ver db.ts).
 */

type Executor = { query: typeof pool.query };

/**
 * Recalcula os campos de follow-up do negócio:
 *  - data_proximo_followup: a atividade pendente mais próxima (vazio = nenhuma agendada);
 *  - data_ultimo_contato: a última atividade concluída ou interação registrada.
 */
export async function sincronizarNegocio(negocioId: string | null | undefined, db: Executor = pool) {
  if (!negocioId) return;
  await db.query(
    `UPDATE crm_negocios n SET
        n.data_proximo_followup = (
          SELECT MIN(TIMESTAMP(a.data_vencimento, COALESCE(a.hora_vencimento, '00:00:00')))
            FROM crm_atividades a WHERE a.negocio_id = n.id AND a.concluida = 0),
        n.data_ultimo_contato = NULLIF(GREATEST(
          COALESCE((SELECT MAX(a.concluida_em) FROM crm_atividades a WHERE a.negocio_id = n.id AND a.concluida = 1), '1000-01-01 00:00:00'),
          COALESCE((SELECT MAX(h.criado_em) FROM crm_historico_interacoes h WHERE h.negocio_id = n.id), '1000-01-01 00:00:00')
        ), '1000-01-01 00:00:00')
      WHERE n.id = ?`,
    [negocioId],
  );
}

/**
 * Ajustes no que vai ser gravado. Negócio: o funil vem sempre da etapa escolhida,
 * para que funil e etapa nunca fiquem desencontrados.
 */
export async function antesDeGravar(recurso: string, payload: Record<string, any>, empresaId?: string) {
  // Contato: a pessoa precisa existir e ser do grupo de empresas da filial (o campo não é um vínculo escolhido na tela)
  if (recurso === 'pessoas_contatos' && payload.pessoa_id != null) {
    const [rows] = await pool.query<any[]>(
      'SELECT 1 FROM cad_pessoas WHERE id = ? AND date_delete IS NULL AND grupo_id = (SELECT eg.grupo_id FROM sys_empresas eg WHERE eg.id = ?)',
      [payload.pessoa_id, empresaId ?? null],
    );
    if (!rows.length) throw new Error('A pessoa do contato não existe.');
  }
  // Pessoa no cadastro do ERP: tipo lead/cliente = is_cliente; CPF/CNPJ só com dígitos, e ele diz se é física ou jurídica
  if (recurso === 'pessoas') {
    if ('tipo' in payload) {
      payload.is_cliente = payload.tipo === 'cliente' ? 1 : 0;
      delete payload.tipo;
    }
    if ('cpf' in payload) {
      const doc = String(payload.cpf ?? '').replace(/\D/g, '');
      if (doc && doc.length !== 11 && doc.length !== 14) throw new Error('CPF/CNPJ deve ter 11 ou 14 dígitos.');
      payload.cpf = doc || null;
      if (doc) payload.tipo_pessoa = doc.length === 11 ? 'F' : 'J';
    }
  }
  if (recurso === 'atividades' && [payload.executor_id, payload.departamento_id, Number(payload.executor_bot) || null].filter(Boolean).length > 1) {
    throw new Error('Quem executa: escolha um usuário, um departamento ou o Bot, só um deles (nenhum = qualquer pessoa).');
  }
  if (recurso === 'atividades' && Number(payload.executor_bot) && payload.lembrete_para === 'nenhum') {
    throw new Error('Com o Bot executando, escolha em "Lembrete para" com quem ele conversa.');
  }
  // Reunião externa/interna/virtual: ícone no começo do assunto (a tela manda assunto e tipo juntos)
  // ponytail: gravação parcial com só um dos dois não ajusta o ícone; ler o registro aqui se isso passar a existir
  if (recurso === 'atividades' && 'assunto' in payload && 'tipo' in payload) {
    payload.assunto = assuntoComIcone(payload.assunto, payload.tipo);
  }
  if (recurso === 'negocios' && payload.etapa_id) {
    const [rows] = await pool.query<any[]>('SELECT funil_id FROM crm_etapas WHERE id = ?', [payload.etapa_id]);
    if (!rows.length) throw new Error('A etapa escolhida não existe.');
    payload.funil_id = rows[0].funil_id;
  }
  if (recurso === 'campanhas') {
    // Critérios do público validados; variável inexistente na mensagem barra a gravação
    // Lista de critérios ou seleção com IA ({ modo: 'ia', pedido, sql, explicacao })
    if ('criterios' in payload) payload.criterios = JSON.stringify(normalizarSelecao(payload.criterios));
    if ('mensagem' in payload || 'assunto' in payload) variaveisDoTexto(payload.assunto, payload.mensagem);
  }
  if (recurso === 'contratos') {
    const dia = payload.dia_vencimento;
    if (dia != null && (dia < 1 || dia > 31)) throw new Error('O dia de vencimento deve ser de 1 a 31.');
    if (payload.data_fim && payload.data_inicio && payload.data_fim < payload.data_inicio) {
      throw new Error('O fim do contrato não pode ser antes do início.');
    }
  }
  if (recurso === 'contrato_itens' && payload.produto_id) {
    // Sem valor informado, vale o preço de tabela do produto
    if (payload.preco_unitario == null || payload.preco_unitario === '') {
      const [rows] = await pool.query<any[]>('SELECT preco_venda AS preco FROM cad_produtos WHERE id = ?', [payload.produto_id]);
      payload.preco_unitario = Number(rows[0]?.preco) || 0;
    }
    const quantidade = Number(payload.quantidade ?? 1);
    const bruto = quantidade * Number(payload.preco_unitario || 0);
    const desconto = Number(payload.desconto || 0);
    // Em branco = sem desconto
    payload.desconto = desconto;
    if (quantidade <= 0) throw new Error('A quantidade deve ser maior que zero.');
    if (desconto < 0 || desconto > bruto) throw new Error('O desconto não pode passar do valor do item.');
    payload.subtotal = Math.round((bruto - desconto) * 100) / 100;
  }
}

/** Negócios ligados ao registro, lidos antes de alterá-lo ou excluí-lo */
export async function antesDeExcluir(recurso: string, id: string): Promise<string[]> {
  if (recurso !== 'atividades' && recurso !== 'historico_interacoes') return [];
  const [rows] = await pool.query<any[]>(`SELECT negocio_id FROM crm_${recurso} WHERE id = ?`, [id]);
  return rows.map((r) => r.negocio_id).filter(Boolean);
}

/** usuarioId: quem fez a alteração (atividade concluída agora grava quem concluiu; null = o sistema, ex.: o Bot) */
export async function aposGravar(recurso: string, id: string | null, negociosAnteriores: string[] = [], db: Executor = pool, usuarioId: number | null = null) {
  const negocios = new Set(negociosAnteriores);

  // Contato: um principal só por pessoa, e ativo (sem nenhum marcado, o primeiro ativo assume)
  if (recurso === 'pessoas_contatos' && id) {
    const [rows] = await db.query<any[]>('SELECT pessoa_id, principal, ativo FROM cad_pessoas_contatos WHERE id = ?', [id]);
    const c = rows[0];
    if (c) {
      if (Number(c.principal) && !Number(c.ativo)) await db.query('UPDATE cad_pessoas_contatos SET principal = 0 WHERE id = ?', [id]);
      else if (Number(c.principal)) await db.query('UPDATE cad_pessoas_contatos SET principal = 0 WHERE pessoa_id = ? AND id <> ?', [c.pessoa_id, id]);
      await db.query(
        `UPDATE cad_pessoas_contatos SET principal = 1
          WHERE id = (SELECT id FROM (SELECT id FROM cad_pessoas_contatos WHERE pessoa_id = ? AND ativo = 1 ORDER BY id LIMIT 1) primeiro)
            AND NOT EXISTS (SELECT 1 FROM (SELECT id FROM cad_pessoas_contatos WHERE pessoa_id = ? AND principal = 1 AND ativo = 1) marcado)`,
        [c.pessoa_id, c.pessoa_id],
      );
    }
  }

  if (recurso === 'negocios' && id) {
    // Data do ganho/perda acompanha o status; reaberto, as duas voltam a ficar vazias
    await db.query(
      `UPDATE crm_negocios SET
          data_ganho = IF(status = 'ganho', COALESCE(data_ganho, NOW()), NULL),
          data_perda = IF(status = 'perdido', COALESCE(data_perda, NOW()), NULL),
          motivo_perda = IF(status = 'perdido', motivo_perda, NULL)
        WHERE id = ?`,
      [id],
    );
    // Trocou o proprietário (inclusive pela troca rápida): ele sai dos envolvidos
    await tirarProprietarioDosEnvolvidos(id, db);
  }

  if (recurso === 'atividades' && id) {
    // Quem concluiu: gravado só na passagem para concluída (concluida_em ainda vazia); reaberta, apaga.
    // concluida_por vem antes no SET: o MySQL aplica em ordem, e ele precisa ver a concluida_em de antes
    await db.query(
      `UPDATE crm_atividades SET concluida_por = IF(concluida = 1, IF(concluida_em IS NULL, ?, concluida_por), NULL),
                             concluida_em = IF(concluida = 1, COALESCE(concluida_em, NOW()), NULL)
        WHERE id = ?`,
      [usuarioId, id],
    );
  }

  if ((recurso === 'atividades' || recurso === 'historico_interacoes') && id) {
    const [rows] = await db.query<any[]>(`SELECT negocio_id FROM crm_${recurso} WHERE id = ?`, [id]);
    if (rows[0]?.negocio_id) negocios.add(rows[0].negocio_id);
  }

  // Totais do contrato acompanham os itens, as datas e a periodicidade
  if (recurso === 'contratos' && id) await recalcularContrato(id, db);
  if (recurso === 'contrato_itens' && id) {
    const [rows] = await db.query<any[]>('SELECT contrato_id FROM crm_contrato_itens WHERE id = ?', [id]);
    if (rows[0]) await recalcularContrato(rows[0].contrato_id, db);
  }


  // Campanha encerrada (concluída, cancelada ou excluída): data de encerramento e
  // os disparos que ainda não saíram são cancelados
  if (recurso === 'campanhas' && id) {
    await db.query(
      `UPDATE crm_campanhas SET encerrada_em = IF(situacao IN ('concluida', 'cancelada') OR excluida_em IS NOT NULL, COALESCE(encerrada_em, NOW()), NULL)
        WHERE id = ?`,
      [id],
    );
    await db.query(
      `UPDATE crm_campanha_disparos d JOIN crm_campanhas c ON c.id = d.campanha_id
          SET d.situacao = 'cancelado'
        WHERE c.id = ? AND d.situacao = 'pendente' AND (c.situacao IN ('concluida', 'cancelada') OR c.excluida_em IS NOT NULL)`,
      [id],
    );
    // Público estimado acompanha os critérios gravados
    const [c] = await db.query<any[]>('SELECT empresa_id, criterios FROM crm_campanhas WHERE id = ?', [id]);
    if (c[0]?.criterios) {
      const n = await contarPublico(c[0].criterios, c[0].empresa_id, db).catch(() => null);
      if (n !== null) await db.query('UPDATE crm_campanhas SET publico_estimado = ? WHERE id = ?', [n, id]);
    }
  }

  for (const n of negocios) await sincronizarNegocio(n, db);
}
