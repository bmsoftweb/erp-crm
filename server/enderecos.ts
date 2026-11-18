import { Router, Request, Response } from 'express';
import { pool } from './db.js';
import { TIPOS_ENDERECO } from './schema.js';

/**
 * Endereços da pessoa. São editados no próprio cadastro: o formulário manda a lista completa em `enderecos`
 * junto com a pessoa, e aqui ela é sincronizada. No ERP o principal fica nas colunas da própria cad_pessoas
 * (é o que a NF-e usa) e os demais em cad_pessoas_enderecos (sai o que foi removido, atualiza o que tem id,
 * inclui o resto). O código IBGE e o país do principal também vão para cad_pessoas.
 */

export interface Endereco {
  id: number | null;
  tipo: string;
  principal: number;
  cep: string | null;
  logradouro: string | null;
  numero: string | null;
  complemento: string | null;
  bairro: string | null;
  cidade: string | null;
  uf: string | null;
  codigo_ibge: string | null;
  pais: string | null;
  obs: string | null;
}

/** Endereço da lista → colunas de cad_pessoas_enderecos (obs vai na descrição) */
const valoresAdicional = (e: Endereco) => [e.tipo, e.cep, e.logradouro ?? '', e.numero, e.complemento, e.bairro, e.cidade, e.uf, e.codigo_ibge, e.obs?.slice(0, 60) ?? null];
const COLUNAS_ADICIONAL = 'tipo, cep, logradouro, numero, complemento, bairro, cidade_nome, cidade_uf, cidade_ibge, descricao';
const MAX_ENDERECOS = 50;

const txt = (v: any, max: number) => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, max) : null;
};

/**
 * Valida e normaliza a lista vinda do formulário (antes de gravar a pessoa, para não
 * gravar pela metade). Endereço totalmente vazio é descartado; se nenhum vier como
 * principal, o primeiro passa a ser.
 */
export function normalizarEnderecos(bruto: unknown): Endereco[] {
  if (!Array.isArray(bruto)) throw new Error('Endereços em formato inválido.');
  if (bruto.length > MAX_ENDERECOS) throw new Error(`Informe no máximo ${MAX_ENDERECOS} endereços.`);
  const tipos = TIPOS_ENDERECO.map((t) => t.value);
  const lista = bruto
    .map((e: any): Endereco => {
      const cep = String(e?.cep ?? '').replace(/\D/g, '');
      if (cep && cep.length !== 8) throw new Error(`CEP inválido: ${e.cep}.`);
      const uf = txt(e?.uf, 2)?.toUpperCase() ?? null;
      if (uf && !/^[A-Z]{2}$/.test(uf)) throw new Error(`UF inválida: ${e.uf}.`);
      const ibge = String(e?.codigo_ibge ?? '').replace(/\D/g, '');
      return {
        id: Number(e?.id) > 0 ? Number(e.id) : null,
        tipo: tipos.includes(e?.tipo) ? e.tipo : 'OUTRO',
        principal: e?.principal ? 1 : 0,
        cep: cep || null,
        logradouro: txt(e?.logradouro, 100),
        numero: txt(e?.numero, 10),
        complemento: txt(e?.complemento, 60),
        bairro: txt(e?.bairro, 50),
        cidade: txt(e?.cidade, 100),
        uf,
        codigo_ibge: ibge ? ibge.slice(0, 7) : null,
        pais: txt(e?.pais, 60) || 'Brasil',
        obs: txt(e?.obs, 255),
      };
    })
    .filter((e) => e.cep || e.logradouro || e.numero || e.complemento || e.bairro || e.cidade || e.obs);
  // Um principal só: vale o primeiro marcado, ou o primeiro da lista
  const principal = Math.max(0, lista.findIndex((e) => e.principal));
  lista.forEach((e, i) => (e.principal = i === principal ? 1 : 0));
  return lista;
}

/** Deixa os endereços da pessoa iguais à lista, numa transação (empresaId: a pessoa é de todas as filiais) */
export async function gravarEnderecos(_empresaId: string, pessoaId: string, lista: Endereco[]) {
  // O marcado como principal vai para a pessoa (se era um adicional, a linha dele sai de cad_pessoas_enderecos)
  const iPrincipal = lista.findIndex((e) => e.principal);
  const principal = iPrincipal >= 0 ? lista[iPrincipal] : null;
  const outros = lista.filter((_, i) => i !== iPrincipal);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const p = principal;
    await conn.query(
      `UPDATE cad_pessoas SET cep = ?, logradouro = ?, numero = ?, complemento = ?, bairro = ?, cidade_nome = ?, cidade_uf = ?,
              cidade_ibge = ?, pais_nome = COALESCE(?, pais_nome)
        WHERE id = ?`,
      [p?.cep ?? '', p?.logradouro ?? null, p?.numero?.slice(0, 7) ?? '', p?.complemento ?? null, p?.bairro ?? '', p?.cidade ?? null, p?.uf ?? null,
       p?.codigo_ibge ?? null, p?.pais?.toUpperCase() ?? null, pessoaId],
    );
    const ids = outros.map((e) => e.id).filter(Boolean);
    await conn.query(
      `DELETE FROM cad_pessoas_enderecos WHERE pessoa_id = ?${ids.length ? ' AND id NOT IN (?)' : ''}`,
      ids.length ? [pessoaId, ids] : [pessoaId],
    );
    for (const e of outros) {
      if (e.id) {
        const [r] = await conn.query<any>(
          `UPDATE cad_pessoas_enderecos SET ${COLUNAS_ADICIONAL.split(', ').map((c) => `${c} = ?`).join(', ')} WHERE id = ? AND pessoa_id = ?`,
          [...valoresAdicional(e), e.id, pessoaId],
        );
        if (r.affectedRows) continue; // id de outra pessoa: entra como novo
      }
      await conn.query(`INSERT INTO cad_pessoas_enderecos (pessoa_id, ${COLUNAS_ADICIONAL}) VALUES (?, ?)`, [pessoaId, valoresAdicional(e)]);
    }
    await conn.commit();
  } catch (err) {
    await conn.rollback().catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

export function createEnderecosRouter(): Router {
  const router = Router();

  router.get('/pessoas/:id/enderecos', async (req: Request, res: Response) => {
    try {
      // O principal (da própria pessoa, sem id) e depois os adicionais
      const [rows] = await pool.query<any[]>(
        `SELECT NULL AS id, 'OUTRO' AS tipo, 1 AS principal, NULLIF(cep, '') AS cep, logradouro, NULLIF(numero, '') AS numero, complemento,
                NULLIF(bairro, '') AS bairro, cidade_nome AS cidade, cidade_uf AS uf, cidade_ibge AS codigo_ibge, pais_nome AS pais, NULL AS obs
           FROM cad_pessoas WHERE id = ? AND COALESCE(logradouro, cidade_nome, NULLIF(cep, '')) IS NOT NULL
         UNION ALL
         SELECT id, tipo, 0, cep, logradouro, numero, complemento, bairro, cidade_nome, cidade_uf, cidade_ibge, 'BRASIL', descricao
           FROM cad_pessoas_enderecos WHERE pessoa_id = ?
          ORDER BY principal DESC, id`,
        [req.params.id, req.params.id],
      );
      res.json(rows);
    } catch (err: any) {
      res.status(400).json({ error: err.message });
    }
  });

  return router;
}
