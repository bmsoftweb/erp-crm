import { pool } from './db.js';
import { CONTATOS, PESSOAS, PRODUTOS, USUARIOS_FILIAL } from './erp.js';

/**
 * Campanhas › "Selecionar com IA": o usuário descreve em português quem deve receber a campanha; a IA (Configurações › IA)
 * recebe a estrutura real das tabelas e devolve um SELECT com os ids das pessoas. Gravado nos critérios da campanha como
 * { modo: 'ia', pedido, sql, explicacao }.
 *
 * O SQL vem da IA e roda no banco de produção, então tem três travas: só um SELECT, sem comentários nem palavras
 * perigosas (conferirSqlIa); roda numa transação SOMENTE LEITURA com limite de tempo; e o resultado é cruzado com as
 * pessoas (idsDaSelecaoIa); cada tabela citada só mostra as linhas da filial logada (isolarEmpresa). O resto da campanha (contar, testar, gerar disparos) usa só a lista de ids.
 */

export interface SelecaoIa {
  modo: 'ia';
  pedido: string;
  sql: string;
  explicacao: string;
}

/**
 * Tabelas que a IA conhece (seleção de campanha e Consultas), pelo nome que têm no CRM, e as linhas que cada uma mostra:
 * as da filial logada (emp). Os cadastros do ERP (pessoas, contatos, produtos) são os do grupo de empresas da filial e
 * ganham empresa_id = a filial logada, para o SQL da IA poder filtrar empresa_id em toda tabela.
 */
const DO_CRM = (t: string) => (emp: number) => `SELECT * FROM crm_${t} WHERE empresa_id = ${emp}`;
const FILHA = (t: string, fk: string, pai: string) => (emp: number) =>
  `SELECT * FROM crm_${t} WHERE ${fk} IN (SELECT id FROM crm_${pai} WHERE empresa_id = ${emp})`;
const DO_ERP = (fonte: string) => (emp: number) => `SELECT x.*, ${emp} AS empresa_id FROM ${fonte} x`;
const GRUPO = (emp: number) => `(SELECT grupo_id FROM sys_empresas WHERE id = ${emp})`;
export const FONTES_IA: Record<string, (emp: number) => string> = {
  pessoas: (emp) => `${DO_ERP(PESSOAS)(emp)} WHERE x.grupo_id = ${GRUPO(emp)}`,
  pessoas_contatos: (emp) => `${DO_ERP(CONTATOS)(emp)} WHERE x.pessoa_id IN (SELECT id FROM cad_pessoas WHERE grupo_id = ${GRUPO(emp)})`,
  produtos: (emp) => `${DO_ERP(PRODUTOS)(emp)} WHERE x.grupo_empresas_id = ${GRUPO(emp)}`,
  usuarios: (emp) => `SELECT * FROM ${USUARIOS_FILIAL} x WHERE x.empresa_id = ${emp}`,
  etapas: FILHA('etapas', 'funil_id', 'funis'),
  proposta_itens: FILHA('proposta_itens', 'proposta_id', 'propostas'),
  pedido_itens: FILHA('pedido_itens', 'pedido_id', 'pedidos'),
  campanha_disparos: FILHA('campanha_disparos', 'campanha_id', 'campanhas'),
  ...Object.fromEntries(
    ['segmentos', 'negocios', 'funis', 'atividades', 'historico_interacoes', 'propostas', 'pedidos', 'contratos', 'whatsapp_atendimentos',
      'whatsapp_conversas', 'whatsapp_mensagens', 'vendas_produtos', 'avaliacoes', 'campanhas', 'departamentos'].map((t) => [t, DO_CRM(t)]),
  ),
};
export const TABELAS_IA = Object.keys(FONTES_IA);

/** Campos (nome e tipo) de uma tabela da IA, por uma consulta vazia */
export const camposDe = async (t: string) => (await pool.query<any[]>(`SELECT * FROM (${FONTES_IA[t](0)}) f LIMIT 0`))[1] as any[];

export type ColunasPorTabela = Record<string, string[]>;


/** Colunas que não interessam para selecionar pessoas (e só gastariam o pedido) */
export const COLUNAS_FORA = /(senha|token|hash|_cifrad|base64|dados|arquivo|assinatura|logo|foto|config_listas|permissoes)/i;

/** Palavras que não podem aparecer no SQL da IA (escrita, administração, leitura de arquivos, espera) */
const PROIBIDAS =
  /\b(insert|update|delete|replace|drop|alter|create|truncate|rename|grant|revoke|call|handler|lock|unlock|load_file|outfile|dumpfile|sleep|benchmark|get_lock|release_lock|set|use|show|describe|explain|information_schema|performance_schema|mysql|sys|extractvalue|updatexml|for\s+update|lock\s+in\s+share)\b/i;

export const MAX_PESSOAS_IA = 50_000;
export const TEMPO_MS = 15_000;

/**
 * Confere o SQL da IA: um SELECT só, sem comentários, sem palavras proibidas, com o marcador da empresa (as Consultas
 * não pedem o marcador: lá cada tabela é trocada pelas linhas da empresa, server/consultas.ts)
 */
export function conferirSqlIa(bruto: unknown, exigirEmpresa = true): string {
  const sql = String(bruto ?? '').trim().replace(/;\s*$/, '');
  if (!sql) throw new Error('A IA não montou o SQL.');
  if (sql.length > 20_000) throw new Error('SQL grande demais.');
  if (!/^select\b/i.test(sql)) throw new Error('O SQL precisa ser um SELECT.');
  if (sql.includes(';')) throw new Error('O SQL precisa ser um comando só.');
  if (/--|\/\*|#/.test(sql)) throw new Error('O SQL não pode ter comentários.');
  if (/@/.test(sql)) throw new Error('O SQL não pode usar variáveis (@).');
  const m = PROIBIDAS.exec(sql.replace(/'[^']*'/g, "''"));
  if (m) throw new Error(`O SQL não pode usar "${m[1]}".`);
  if (exigirEmpresa && !sql.includes(':empresa')) throw new Error('O SQL precisa filtrar a empresa com :empresa.');
  return sql;
}

/** Seleção com IA gravada/da tela, conferida */
export function normalizarSelecaoIa(v: any): SelecaoIa {
  const pedido = String(v?.pedido ?? '').trim().slice(0, 2000);
  if (!pedido) throw new Error('Descreva quem deve receber a campanha.');
  if (!String(v?.sql ?? '').trim()) throw new Error('Gere a seleção com a IA antes de gravar.');
  return { modo: 'ia', pedido, sql: conferirSqlIa(v.sql), explicacao: String(v?.explicacao ?? '').slice(0, 2000) };
}

export const ehSelecaoIa = (v: any): boolean => {
  let o = v;
  if (typeof o === 'string') {
    try {
      o = JSON.parse(o);
    } catch {
      return false;
    }
  }
  return Boolean(o && !Array.isArray(o) && typeof o === 'object' && o.modo === 'ia');
};

/**
 * Ids das pessoas da empresa que o SQL da IA seleciona (no máximo MAX_PESSOAS_IA): transação somente leitura, limite
 * de tempo, e só pessoas desta empresa
 */
/** O comando que roda de verdade: o SQL da IA com o número da empresa, por dentro da trava de tempo e das pessoas da empresa */
export function sqlExecutadoIa(sqlIa: string, empresaId: string | number): string {
  const emp = Number(empresaId);
  const sql = isolarEmpresa(conferirSqlIa(sqlIa).replace(/:empresa\b/g, String(emp)), emp);
  return `SELECT /*+ MAX_EXECUTION_TIME(${TEMPO_MS}) */ DISTINCT p.id FROM (${sql}) x JOIN ${PESSOAS} p ON p.id = x.id AND p.grupo_id = ${GRUPO(emp)} LIMIT ${MAX_PESSOAS_IA}`;
}

/**
 * Nomes das tabelas de verdade (deste banco) e dos bancos do servidor: não podem sobrar no SQL da IA depois da troca
 * pelas tabelas da empresa, seja qual for a sintaxe (vírgula, parênteses, subconsulta). Carregado antes de usar
 * isolarEmpresa (prepararIsolamento); sem a lista, isolarEmpresa recusa tudo
 */
let NOMES_REAIS: RegExp | null = null;

export function definirNomesReais(nomes: string[]) {
  const lista = [...new Set(nomes.map((n) => n.toLowerCase()))].filter((n) => !TABELAS_IA.includes(n) && /^[a-z0-9_$]+$/.test(n));
  NOMES_REAIS = lista.length ? new RegExp(`(?<![\\w$])(${lista.sort((a, b) => b.length - a.length).join('|')})(?![\\w$])`, 'i') : /(?!)/;
}

export async function prepararIsolamento() {
  if (NOMES_REAIS) return;
  const [t] = await pool.query<any[]>('SELECT TABLE_NAME AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()');
  const [b] = await pool.query<any[]>('SELECT SCHEMA_NAME AS n FROM information_schema.SCHEMATA');
  definirNomesReais([...t, ...b].map((r) => String(r.n)));
}

/** Palavras que não podem ser apelido de tabela (vêm logo depois do nome dela) */
const NAO_APELIDO = new Set([
  'where', 'join', 'left', 'right', 'inner', 'outer', 'cross', 'natural', 'straight_join', 'on', 'using', 'group', 'order',
  'limit', 'having', 'union', 'window', 'for', 'lock', 'into', 'as',
]);

/**
 * Troca cada tabela do FROM/JOIN por uma subconsulta com as linhas da empresa (FONTES_IA) e as colunas liberadas (sem
 * `colunas`, todas), mantendo o apelido. Recusa o que escaparia disso: tabela fora da lista, outro banco, tabelas separadas por vírgula.
 */
export function isolarEmpresa(sql: string, empresaId: string | number, colunas?: ColunasPorTabela): string {
  const emp = Number(empresaId);
  if (!Number.isInteger(emp) || emp < 0) throw new Error('Empresa inválida.');
  // Textos entre aspas saem do caminho (um nome de tabela dentro de um texto não é tabela)
  const textos: string[] = [];
  let s = sql.replace(/'(?:[^'\\]|\\.|'')*'/g, (t) => `\u0001${textos.push(t) - 1}\u0001`);
  const subconsultas: string[] = [];
  const nomes = [...TABELAS_IA].sort((a, b) => b.length - a.length);
  const re = new RegExp(`\\b(from|join)\\s+\`?(${nomes.join('|')})\`?(?![\\w.\`])(\\s+(?:as\\s+)?\`?([a-z_][a-z0-9_]*)\`?)?`, 'gi');
  s = s.replace(re, (_m, palavra: string, tabelaBruta: string, resto: string | undefined, apelidoBruto: string | undefined) => {
    const tabela = tabelaBruta.toLowerCase();
    let apelido = apelidoBruto;
    let sobra = '';
    if (apelido && NAO_APELIDO.has(apelido.toLowerCase())) {
      sobra = resto ?? '';
      apelido = undefined;
    }
    const cols = colunas ? colunas[tabela].map((c) => `\`${c}\``).join(', ') : '*';
    subconsultas.push(`(SELECT ${cols} FROM (${FONTES_IA[tabela](emp)}) f)`);
    return `${palavra} \u0002${subconsultas.length - 1}\u0002 AS ${apelido ?? tabela}${sobra}`;
  });
  if (/\b(from|join)\s+(?![\s(\u0002])/i.test(s)) {
    throw new Error(`Use só as tabelas do CRM (${TABELAS_IA.join(', ')}), sem nome de banco na frente.`);
  }
  if (new RegExp(`,\\s*\`?(${nomes.join('|')})\`?(?![\\w.\`(])`, 'i').test(s)) {
    throw new Error('Ligue as tabelas com JOIN, não com vírgula.');
  }
  // Tabela de verdade (ou outro banco) que escapou da troca: vírgula, parênteses...
  if (!NOMES_REAIS) throw new Error('A lista de tabelas do banco ainda não foi carregada.');
  if (NOMES_REAIS.test(s.replace(/\u0002\d+\u0002/g, ''))) {
    throw new Error(`Use só as tabelas do CRM (${TABELAS_IA.join(', ')}), sem nome de banco na frente.`);
  }
  return s.replace(/\u0002(\d+)\u0002/g, (_m, i) => subconsultas[Number(i)]).replace(/\u0001(\d+)\u0001/g, (_m, i) => textos[Number(i)]);
}


export async function idsDaSelecaoIa(sqlIa: string, empresaId: string | number): Promise<number[]> {
  await prepararIsolamento();
  const sql = sqlExecutadoIa(sqlIa, empresaId);
  const conn = await pool.getConnection();
  try {
    await conn.query('START TRANSACTION READ ONLY');
    const [r] = await conn.query<any[]>(sql);
    return r.map((l) => Number(l.id));
  } catch (err: any) {
    if (/max_execution_time|maximum statement execution time/i.test(err?.message ?? '')) throw new Error('A seleção demorou demais (mais de 15 s). Simplifique o pedido.');
    if (/Unknown column 'x.id'|x\.id/i.test(err?.message ?? '')) throw new Error('O SQL precisa devolver a coluna "id" das pessoas.');
    throw new Error(`O SQL da seleção não rodou: ${err?.sqlMessage || err?.message}`);
  } finally {
    await conn.query('ROLLBACK').catch(() => {});
    conn.release();
  }
}

/** Tipo de coluna pelo código do protocolo (cadastros do ERP, que são tabelas derivadas) */
const TIPO_CAMPO: Record<number, string> = { 1: 'tinyint', 2: 'smallint', 3: 'int', 8: 'bigint', 246: 'decimal', 10: 'date', 7: 'datetime', 12: 'datetime', 245: 'json', 252: 'text' };

/** Estrutura das tabelas da IA (nome, colunas, tipos e comentários): as crm_* pelo information_schema, as do ERP pelos campos */
export async function estrutura(): Promise<string> {
  const [cols] = await pool.query<any[]>(
    `SELECT TABLE_NAME t, COLUMN_NAME c, COLUMN_TYPE ty, COLUMN_COMMENT cm FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?) ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    [TABELAS_IA.map((t) => `crm_${t}`)],
  );
  const porTabela = new Map<string, string[]>();
  for (const l of cols) {
    if (COLUNAS_FORA.test(l.c)) continue;
    const t = String(l.t).slice(4);
    porTabela.set(t, [...(porTabela.get(t) ?? []), `${l.c} ${String(l.ty).replace(/ unsigned/, '')}${l.cm ? ` -- ${String(l.cm).slice(0, 60)}` : ''}`]);
  }
  for (const t of TABELAS_IA.filter((x) => !porTabela.has(x))) {
    const campos = (await camposDe(t)).filter((f) => !COLUNAS_FORA.test(f.name));
    porTabela.set(t, campos.map((f) => `${f.name} ${TIPO_CAMPO[f.columnType] ?? 'varchar'}`));
  }
  return TABELAS_IA.filter((t) => porTabela.has(t)).map((t) => `${t}(\n  ${porTabela.get(t)!.join(',\n  ')}\n)`).join('\n');
}

/** Pede à IA o SQL da seleção; com SQL recusado, pede de novo uma vez, dizendo o motivo */
export async function gerarSelecaoIa(pedidoBruto: unknown, empresaId: string | number): Promise<SelecaoIa & { total: number }> {
  const pedido = String(pedidoBruto ?? '').trim().slice(0, 2000);
  if (!pedido) throw Object.assign(new Error('Descreva quem deve receber a campanha.'), { status: 400 });
  const { conversarIa, lerChatbot, temChave } = await import('./chatbot.js');
  const cfg = await lerChatbot(empresaId);
  if (!temChave(cfg)) throw Object.assign(new Error('Configure a IA em Configurações › IA antes de selecionar com IA.'), { status: 400 });

  const [[{ hoje }]] = await pool.query<any>("SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS hoje");
  const system = `Você monta consultas MySQL 8 para selecionar o público de uma campanha de marketing de um CRM.
Hoje é ${hoje}. A empresa logada é :empresa (escreva literalmente :empresa; ele é trocado pelo número da empresa).

Responda só com JSON, sem texto em volta: {"sql":"...","explicacao":"..."}
- sql: UM comando SELECT que devolve a coluna "id" da tabela pessoas (ex.: SELECT DISTINCT p.id FROM pessoas p ... ).
  Filtre SEMPRE p.empresa_id = :empresa e também empresa_id = :empresa em toda tabela que tiver empresa_id.
  Use só as tabelas e colunas abaixo, ligadas com JOIN (nunca vírgula). Nada de ponto e vírgula, comentários, variáveis (@)
  ou comandos que não sejam SELECT. Datas com YEAR(), MONTH(), DATEDIFF() (nunca EXTRACT(... FROM ...) nem TRIM(... FROM ...)).
  Datas relativas com CURDATE() / DATE_SUB. Textos com LIKE e sem diferenciar acentos/maiúsculas quando fizer sentido.
- explicacao: em português, curta, o que o SQL seleciona (para o usuário conferir).

Ligações entre as tabelas:
- pessoas é o cliente/lead (empresa ou pessoa física). p.cpf guarda o CPF/CNPJ só com dígitos. tipo: 'cliente' ou 'lead'.
- Cidade e UF (do endereço principal) ficam em pessoas.cidade e pessoas.uf. pessoas_contatos.pessoa_id → pessoas.id.
- pessoas.segmento_id → segmentos.id.
- negocios.pessoa_id → pessoas.id (status 'aberto', 'ganho', 'perdido'); negocios.etapa_id → etapas.id; etapas.funil_id → funis.id.
- atividades.pessoa_id, propostas.pessoa_id, pedidos.pessoa_id, contratos.pessoa_id → pessoas.id.
- whatsapp_atendimentos.pessoa_id → pessoas.id (atendimentos de WhatsApp; fim = quando terminou). whatsapp_mensagens.pessoa_id → pessoas.id (direcao 'recebida' = do cliente).
- vendas_produtos: produtos vendidos (do ERP), uma linha por produto de cada nota. Não tem pessoa_id: liga pelo documento,
  vendas_produtos.cli_cnpj = pessoas.cpf. cancelado = 'S' é nota cancelada (normalmente fica de fora).
- avaliacoes.pessoa_id → pessoas.id (nota de 1 a 5 da pesquisa de satisfação).
- campanha_disparos.pessoa_id → pessoas.id (quem já recebeu cada campanha; situacao 'enviado','entregue','lido','falhou').
- Quem pediu para não receber campanhas (pessoas.nao_receber_campanhas = 1) é tirado depois, não precisa filtrar.

Tabelas:
${await estrutura()}`;

  let falas: { de: 'pessoa' | 'ia'; texto: string }[] = [{ de: 'pessoa', texto: pedido }];
  for (let tentativa = 0; ; tentativa++) {
    const r = await conversarIa(cfg, system, falas, []);
    let sql = '';
    let explicacao = '';
    try {
      const j = JSON.parse(/\{[\s\S]*\}/.exec(r.texto)?.[0] ?? '{}');
      sql = String(j.sql ?? '');
      explicacao = String(j.explicacao ?? '');
      conferirSqlIa(sql);
      const ids = await idsDaSelecaoIa(sql, empresaId);
      const [[{ n }]] = ids.length
        ? await pool.query<any>(`SELECT COUNT(*) AS n FROM ${PESSOAS} p WHERE p.id IN (?) AND p.nao_receber_campanhas = 0`, [ids])
        : [[{ n: 0 }]];
      return { modo: 'ia', pedido, sql: conferirSqlIa(sql), explicacao, total: Number(n) };
    } catch (err: any) {
      if (tentativa >= 1) throw Object.assign(new Error(`A IA não montou uma seleção válida: ${err.message}`), { status: 400 });
      falas = [...falas, { de: 'ia', texto: r.texto }, { de: 'pessoa', texto: `Esse SQL foi recusado: ${err.message} Corrija e responda de novo só com o JSON.` }];
    }
  }
}
