/**
 * Cadastros do ERP (bmerp) com os nomes de coluna que o CRM usa. São tabelas derivadas simples: o MySQL as
 * junta à consulta (derived_merge) e usa os índices da tabela de verdade. Só para leitura; a gravação vai
 * direto em cad_pessoas, cad_produtos e sys_usuarios.
 *
 * Pessoas (cad_pessoas.grupo_id), produtos e categorias são do grupo de empresas (sys_grupos) da filial: DO_GRUPO,
 * com o ? da filial. Contatos e endereços são da pessoa: PESSOA_DO_GRUPO.
 */
import { pool } from './db.js';

/** Filial (e) liberada para o usuário (u): as de sys_usuarios_empresas; sem nenhuma lá, só sys_usuarios.empresa_id */
export const FILIAL_LIBERADA = `COALESCE(e.ativo, 1) = 1 AND (
     EXISTS (SELECT 1 FROM sys_usuarios_empresas ue WHERE ue.usuario_id = u.id AND ue.empresa_id = e.id)
     OR (e.id = u.empresa_id AND NOT EXISTS (SELECT 1 FROM sys_usuarios_empresas ue WHERE ue.usuario_id = u.id)))`;

/** Lead = pessoa que não é cliente nem tem outro papel no ERP (fornecedor puro não entra no CRM) */
export const PESSOA_DO_CRM = (p: string) =>
  `(${p}.is_cliente = 1 OR NOT (${p}.is_fornecedor OR ${p}.is_transportadora OR ${p}.is_colaborador OR ${p}.is_representante OR ${p}.is_contador OR ${p}.is_banco))`;

/** cad_pessoas como a antiga "pessoas" do CRM; cidade/uf = endereço principal (que no ERP fica na própria pessoa) */
export const PESSOAS = `(SELECT p.id, p.nome, IF(p.is_cliente = 1, 'cliente', 'lead') AS tipo, p.codigo AS cod_integracao, p.cpf_cnpj AS cpf,
        p.fone_principal AS telefone, p.whatsapp, p.email_principal AS email, p.observacoes AS obs, p.segmento_id, p.ativo,
        p.nao_receber_campanhas, p.personalizados, p.google_place_id, p.prospeccao_busca_id, p.cidade_nome AS cidade, p.cidade_uf AS uf,
        p.date_insert AS criado_em, p.date_update AS atualizado_em, p.grupo_id
   FROM cad_pessoas p WHERE p.date_delete IS NULL)`;

/** cad_pessoas_contatos como a antiga "pessoas_contatos" */
export const CONTATOS = `(SELECT c.id, c.pessoa_id, c.nome, c.cargo, c.departamento, c.papel, c.email, c.fone AS telefone, c.ramal, c.celular,
        c.whatsapp, c.aceita_whatsapp, c.aceita_email, c.linkedin, c.aniversario AS data_nascimento, c.principal, c.ativo, c.observacoes AS obs
   FROM cad_pessoas_contatos c)`;

/** Endereço principal da pessoa (colunas de cad_pessoas) no formato de uma linha só */
export const ENDERECO_PESSOA = (p: string) =>
  `NULLIF(CONCAT_WS(', ', NULLIF(CONCAT_WS(', ', ${p}.logradouro, NULLIF(${p}.numero, '')), ''), ${p}.complemento, NULLIF(${p}.bairro, ''),
     NULLIF(CONCAT_WS('/', ${p}.cidade_nome, ${p}.cidade_uf), ''), IF(COALESCE(${p}.cep, '') = '', NULL, CONCAT('CEP ', ${p}.cep))), '')`;

/** Pessoas, produtos, categorias e unidades são do grupo de empresas: `col` = a grupo_id deles; ? = a filial logada */
export const DO_GRUPO = (col: string) => `${col} = (SELECT eg.grupo_id FROM sys_empresas eg WHERE eg.id = ?)`;

/** Contato ou endereço (col = o pessoa_id dele) de uma pessoa do grupo da filial; ? = a filial logada */
export const PESSOA_DO_GRUPO = (col: string) => `${col} IN (SELECT gp.id FROM cad_pessoas gp WHERE ${DO_GRUPO('gp.grupo_id')})`;

/** Grupo de empresas da filial: vai em cad_pessoas.grupo_id na pessoa nova */
export async function grupoDaFilial(empresaId: string | number): Promise<number> {
  const [r] = await pool.query<any[]>('SELECT grupo_id FROM sys_empresas WHERE id = ?', [empresaId]);
  if (!r.length) throw new Error('Filial não encontrada.');
  return Number(r[0].grupo_id);
}

/** cad_produtos como a antiga "produtos" (serviço = cad_produtos.servico = 1); grupo_id é a categoria, grupo_empresas_id o grupo de empresas */
export const PRODUTOS = `(SELECT pr.id, pr.nome, pr.nome_proposta, pr.sku AS codigo_sku, pr.preco_venda AS preco_tabela,
        NULLIF(pr.categoria_id, 0) AS grupo_id, pr.unidade_id, um.sigla AS unidade_medida, pr.descricao, pr.servico, pr.ativo,
        pr.grupo_id AS grupo_empresas_id, pr.date_insert AS criado_em, pr.date_update AS atualizado_em
   FROM cad_produtos pr LEFT JOIN cad_produtos_unidades_medida um ON um.id = pr.unidade_id)`;

/** Usuários (sem filial): nome, contato e situação. Para tipo, departamento e permissões, USUARIOS_FILIAL */
export const USUARIOS = `(SELECT u.id, u.login, COALESCE(NULLIF(u.nome, ''), u.login) AS nome, u.sigla, u.email, u.telefone, u.cargo, u.ativo
   FROM sys_usuarios u)`;

/** Usuário em cada filial liberada para ele, com o perfil do CRM (crm_usuarios); filtrar sempre por empresa_id */
export const USUARIOS_FILIAL = `(SELECT u.id, u.login, COALESCE(NULLIF(u.nome, ''), u.login) AS nome, u.sigla, u.email, u.telefone, u.cargo, u.ativo,
        e.id AS empresa_id, COALESCE(cu.tipo, IF(u.nivel IN ('super', 'admin'), 'admin', 'client')) AS tipo,
        cu.departamento_id, cu.permissoes, COALESCE(cu.revezamento, 0) AS revezamento
   FROM sys_usuarios u
   JOIN sys_empresas e ON ${FILIAL_LIBERADA}
   LEFT JOIN crm_usuarios cu ON cu.usuario_id = u.id AND cu.empresa_id = e.id)`;

/** Logo da filial para a impressão do CRM: fica em crm_config (cada módulo do ERP tem o seu) */
export const LOGO = (empresaId: string) =>
  `(SELECT JSON_UNQUOTE(c.valor) FROM crm_config c WHERE c.empresa_id = ${empresaId} AND c.grupo = 'empresa' AND c.chave = 'logo' LIMIT 1)`;

/** Grava (ou apaga, com vazio) o logo da filial */
export async function gravarLogo(empresaId: string, logo: string | null) {
  await pool.query("DELETE FROM crm_config WHERE empresa_id = ? AND grupo = 'empresa' AND chave = 'logo'", [empresaId]);
  if (logo) await pool.query("INSERT INTO crm_config (empresa_id, grupo, chave, valor) VALUES (?, 'empresa', 'logo', ?)", [empresaId, JSON.stringify(logo)]);
}

/** Filial (sys_empresas) com o nome que aparece no CRM */
export const EMPRESAS = `(SELECT e.id, COALESCE(NULLIF(e.nome_fantasia, ''), e.razao_social) AS nome, e.razao_social, e.cnpj, e.telefone, e.email,
        NULLIF(CONCAT_WS(', ', NULLIF(CONCAT_WS(', ', e.logradouro, e.numero), ''), e.complemento, e.bairro,
               NULLIF(CONCAT_WS('/', e.cidade, e.uf), ''), IF(e.cep IS NULL, NULL, CONCAT('CEP ', e.cep))), '') AS endereco,
        ${LOGO('e.id')} AS logo, e.ativo
   FROM sys_empresas e)`;

/** Fotos do produto t como JSON, na ordem (coluna calculada do recurso produtos) */
export const FOTOS_SQL = `(SELECT CAST(CONCAT('[', GROUP_CONCAT(JSON_QUOTE(i.url) ORDER BY i.ordem, i.id), ']') AS JSON)
   FROM cad_produtos_imagens i WHERE i.produto_id = t.id AND i.variante_id IS NULL)`;
