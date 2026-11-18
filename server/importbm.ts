import { Router, Request, Response } from 'express';
import { exigirImportador } from './permissoes.js';
import { pool } from './db.js';
import { lerConfig } from './config.js';
import { cifrar, decifrar } from './segredo.js';

/**
 * Importação das pessoas (PESSOAS) e dos produtos (PRODUTOSPRINCIPAL) do bmsoft (base
 * DBISAM) para o CRM, pela bmAPI.
 *
 * O usuário informa o token da bmAPI (X-API-Key) uma vez: o CRM procura o servidor dono
 * dele na tabela MySQL bmapi.servidores (URL, porta e identificação) e grava o token
 * cifrado na configuração da empresa (config integracoes.bmapi). Só quem tem o token
 * acessa; ele nunca volta ao navegador.
 *
 * Chave da importação: o ID do bmsoft vira cod_integracao "BM-<id>" na empresa
 * logada — o prefixo diz de qual sistema veio o registro. Quem já existe é
 * atualizado, o resto é incluído.
 *
 * Quem vem de outro sistema é sempre "cliente" (lead é quem nasce aqui no CRM).
 */

/** Prefixo do cod_integracao dos registros vindos do BMsoft */
const PREFIXO = 'BM-';

const PAGINA = 500;
const TIMEOUT_MS = 120_000;

/** Onde o token fica gravado (fora das chaves da rota /config: não é lido nem gravado por ela) */
const GRUPO = 'integracoes';
const CHAVE = 'bmapi';
const ONDE = 'Pessoas › Importar BM';

interface Servidor {
  numero: number;
  identificacao: string;
  baseUrl: string;
  token: string;
}

function erro(status: number, msg: string) {
  return Object.assign(new Error(msg), { status });
}

/** url + port da tabela: aceita com ou sem protocolo, com ou sem porta embutida */
function montarBaseUrl(url: string, port: string): string {
  let base = String(url || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//i.test(base)) base = `http://${base}`;
  const porta = String(port || '').trim();
  if (porta && !/^https?:\/\/[^/]+:\d+/i.test(base)) {
    const u = new URL(base);
    u.port = porta;
    base = u.toString().replace(/\/+$/, '');
  }
  return base;
}

/** Servidor da bmAPI dono do token (cadastro bmapi.servidores) */
async function servidorDoToken(token: string): Promise<Servidor> {
  const t = String(token || '').trim();
  if (!t) throw erro(400, 'Informe o token da bmAPI.');
  if (t.length > 64) throw erro(400, 'Token da bmAPI inválido.');
  const [rows] = await pool.query<any[]>('SELECT id, url, port, token, identificacao FROM bmapi.servidores WHERE token = ? LIMIT 1', [t]);
  const r = rows[0];
  if (!r || !r.url) throw erro(404, 'Token não encontrado na bmAPI. Confira o token do servidor.');
  return {
    numero: Number(r.id),
    identificacao: String(r.identificacao || `Servidor ${r.id}`).trim(),
    baseUrl: montarBaseUrl(r.url, r.port),
    token: String(r.token).trim(),
  };
}

/** Token gravado da empresa (null = ainda não informado) */
async function tokenGravado(empresaId: string): Promise<string | null> {
  const cfg = await lerConfig(empresaId, GRUPO, CHAVE);
  return cfg?.token_cifrado ? decifrar(cfg.token_cifrado, ONDE) : null;
}

async function gravarToken(empresaId: string, token: string | null) {
  const valor = JSON.stringify(token ? { token_cifrado: cifrar(token) } : null);
  const [existe] = await pool.query<any[]>('SELECT id FROM crm_config WHERE empresa_id = ? AND grupo = ? AND chave = ? LIMIT 1', [empresaId, GRUPO, CHAVE]);
  if (existe.length) await pool.query('UPDATE crm_config SET valor = ? WHERE id = ?', [valor, existe[0].id]);
  else await pool.query('INSERT INTO crm_config (empresa_id, grupo, chave, valor) VALUES (?, ?, ?, ?)', [empresaId, GRUPO, CHAVE, valor]);
}

/** SELECT na bmAPI; devolve as linhas com os nomes de coluna em minúsculas */
async function consultar(servidor: Servidor, sql: string, params: Record<string, any>): Promise<Record<string, any>[]> {
  let resposta: Awaited<ReturnType<typeof fetch>>;
  try {
    resposta = await fetch(`${servidor.baseUrl}/sql`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': servidor.token },
      body: JSON.stringify({ sql, params }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err: any) {
    const motivo = err?.name === 'TimeoutError' ? 'tempo esgotado' : err?.cause?.code || err?.message;
    throw erro(503, `Não foi possível acessar a bmAPI do servidor ${servidor.numero} (${motivo}).`);
  }
  const data: any = await resposta.json().catch(() => ({}));
  if (!resposta.ok || data?.success === false) {
    if (resposta.status === 401) throw erro(503, `A bmAPI recusou o token cadastrado para o servidor ${servidor.numero}.`);
    throw erro(400, String(data?.error || `bmAPI respondeu HTTP ${resposta.status}`));
  }
  return (data.rows || []).map((linha: Record<string, any>) => {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(linha)) out[k.toLowerCase()] = v;
    return out;
  });
}

export const texto = (v: any, max: number): string | null => {
  const s = String(v ?? '').trim();
  return s && s !== '[blob]' ? s.slice(0, max) : null;
};

export const digitos = (v: any, max: number): string | null => {
  const s = String(v ?? '').replace(/\D/g, '');
  return s ? s.slice(0, max) : null;
};

/**
 * Uma linha do bmsoft já no formato da tabela pessoas do CRM (de → para):
 * ID → cod_integracao ("BM-<id>"), Nome → nome, Email → email,
 * Fone1/Celular/Fone2 → telefone, CPFCNPJ → cpf, Obs → obs, Ativo → ativo.
 */
function converter(linha: Record<string, any>) {
  return {
    cod_integracao: `${PREFIXO}${linha.id}`,
    nome: texto(linha.nome, 255),
    email: texto(linha.email, 255),
    telefone: texto(linha.fone1, 50) || texto(linha.celular, 50) || texto(linha.fone2, 50),
    cpf: digitos(linha.cpfcnpj, 14),
    obs: texto(linha.obs, 512),
    /** Inativo no bmsoft entra (ou fica) inativo no CRM: continua nas listas, para propostas de reativação */
    ativo: String(linha.ativo ?? 'S').toUpperCase() === 'N' ? 0 : 1,
    /** ID do vendedor no bmsoft: vira o nome da revenda (campo personalizado "revenda", se existir) */
    id_vendedor: Number(linha.id_vendedor) || null,
    /** Endereço do cadastro (vira o endereço "Importado do bmsoft" da pessoa); null = sem endereço */
    endereco: enderecoDoBm(linha),
  };
}

/** Marca, na observação, o endereço que veio do bmsoft: as próximas importações atualizam só ele */
export const OBS_ENDERECO_BM = 'Importado do bmsoft';
const CAMPOS_ENDERECO = ['logradouro', 'numero', 'complemento', 'bairro', 'cep', 'cidade', 'uf', 'codigo_ibge'] as const;
export type EnderecoBm = Record<(typeof CAMPOS_ENDERECO)[number], string | null>;

/** Endereço do cadastro do bmsoft (Endereco, Numero, Complemento, Bairro, CEP, Cidade, UF, Cod_Cidade); vazio = null */
export function enderecoDoBm(linha: Record<string, any>): EnderecoBm | null {
  const e: EnderecoBm = {
    logradouro: texto(linha.endereco, 255),
    numero: texto(linha.numero, 20),
    complemento: texto(linha.complemento, 100),
    bairro: texto(linha.bairro, 100),
    cep: digitos(linha.cep, 8),
    cidade: texto(linha.cidade, 100),
    uf: texto(linha.uf, 2)?.toUpperCase() ?? null,
    codigo_ibge: digitos(linha.cod_cidade, 7),
  };
  return e.logradouro || e.cidade || e.cep ? e : null;
}

/** O endereço gravado é igual ao do bmsoft (nada a atualizar) */
export const enderecoIgual = (gravado: Record<string, any>, novo: EnderecoBm) => CAMPOS_ENDERECO.every((c) => (gravado[c] ?? null) === novo[c]);

/**
 * Nome do vendedor do bmsoft → valor do campo "revenda": a opção da lista com o mesmo nome (sem diferenciar
 * maiúsculas: DIMAPEL → Dimapel); sem opção igual, o nome como está no bmsoft
 */
export function valorRevenda(nomeVendedor: string | null | undefined, opcoes: string[] = []): string | null {
  const nome = String(nomeVendedor ?? '').trim();
  if (!nome) return null;
  return opcoes.find((o) => o.trim().toLowerCase() === nome.toLowerCase())?.trim() ?? nome;
}

/** Personalizados gravados (JSON) + a revenda; null quando não muda nada */
export function comRevenda(gravado: string | null | undefined, revenda: string | null): string | null {
  if (!revenda) return null;
  let obj: Record<string, unknown> = {};
  try {
    const lido = gravado ? JSON.parse(gravado) : {};
    if (lido && typeof lido === 'object' && !Array.isArray(lido)) obj = lido;
  } catch {
    // personalizados ilegível: começa de novo só com a revenda
  }
  if (obj.revenda === revenda) return null;
  return JSON.stringify({ ...obj, revenda });
}

/**
 * Uma linha de PRODUTOSPRINCIPAL já no formato da tabela produtos do CRM (de → para):
 * ID → cod_integracao ("BM-<id>") e codigo_sku, Descricao → nome, Texto → descricao,
 * PrecoVenda1 → preco_tabela, UNVenda → unidade_medida, Ativo → ativo.
 */
export function converterProduto(linha: Record<string, any>) {
  const preco = Number(linha.precovenda1);
  return {
    cod_integracao: `${PREFIXO}${linha.id}`,
    codigo_sku: String(linha.id).slice(0, 50),
    nome: texto(linha.descricao, 255),
    descricao: texto(linha.texto, 512), // o DBISAM corta em 512 (limite do CAST)
    preco_tabela: Number.isFinite(preco) && preco > 0 ? Math.round(preco * 100) / 100 : 0,
    unidade_medida: texto(linha.unvenda, 10) || 'UN',
    ativo: String(linha.ativo ?? '').toUpperCase() === 'S' ? 1 : 0,
  };
}

/** Lê uma tabela inteira do bmsoft, em páginas por ID (o DBISAM não tem OFFSET) */
async function lerDoBm<T>(servidor: Servidor, sql: string, converter: (l: Record<string, any>) => T): Promise<T[]> {
  const todas: T[] = [];
  let ultimo = 0;
  for (;;) {
    const linhas = await consultar(servidor, sql, { ultimo });
    if (!linhas.length) break;
    for (const l of linhas) todas.push(converter(l));
    ultimo = Number(linhas[linhas.length - 1].id);
    if (linhas.length < PAGINA) break;
  }
  return todas;
}

// Todas (ativas e inativas): pessoa que ficou inativa no bmsoft fica inativa aqui
const SQL_PESSOAS = `SELECT ID, Nome, Email, Fone1, Celular, Fone2, CPFCNPJ, CAST(Obs AS VARCHAR(512)) Obs, ID_Vendedor, Ativo,
       Endereco, Numero, Complemento, Bairro, CEP, Cod_Cidade, Cidade, UF
  FROM PESSOAS WHERE ID > :ultimo ORDER BY ID TOP ${PAGINA}`;

/** Cadastro de vendedores do bmsoft: o nome é a revenda da pessoa (PESSOAS.ID_Vendedor) */
const SQL_VENDEDORES = `SELECT ID, Nome FROM VENDEDORES WHERE ID > :ultimo ORDER BY ID TOP ${PAGINA}`;

// Todos (ativos e inativos): produto já importado que ficou inativo no bmsoft é desativado aqui
const SQL_PRODUTOS = `SELECT ID, Descricao, CAST(Texto AS VARCHAR(512)) Texto, PrecoVenda1, UNVenda, Ativo
  FROM PRODUTOSPRINCIPAL WHERE ID > :ultimo ORDER BY ID TOP ${PAGINA}`;

/** Data que vem do DBISAM pela bmAPI ("2026-10-09", "2026-10-09T00:00:00" ou "09/10/2026") → "aaaa-mm-dd" */
export function dataBm(v: any): string | null {
  const s = String(v ?? '').trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const br = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  return br ? `${br[3]}-${br[2]}-${br[1]}` : null;
}

const arred = (v: any, casas: number) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 10 ** casas) / 10 ** casas : 0;
};

/**
 * Uma linha de NFPRODUTOS (com a NFMESTRE, o cliente em PESSOAS e o produto em PRODUTOSPRINCIPAL) no formato
 * de vendas_produtos (de → para): NFMESTRE.ID → cod_integracao "BM-<id>", Geracao_Data → nf_data, Numero → nf_numero,
 * Total_Nota → nf_valor_total, CFOP → nf_cfop, Cliente_Doc (ou PESSOAS.CPFCNPJ) → cli_cnpj, PESSOAS Cidade/Bairro/UF → cli_*,
 * ID_Produto → pro_cod_integracao "BM-<id>" (o mesmo da importação de produtos), Descricao/Marca/Classe → pro_*,
 * Qtdade → pro_qtdade, Un → pro_un, Preco_Venda → pro_preco_venda, Valor_Contabil → pro_valor_total,
 * Custo_Total → pro_custo_unit, Cliente_Nome → cli_nome, Cancelado → cancelado ('S'/'N'),
 * PRODUTOSCLASSE.Descricao (pela Classe do produto) → pro_classe_descricao
 */
/**
 * Campos de vendas_produtos que a importação preenche: o tipo diz como o valor do BM é convertido (codbm = "BM-<valor>",
 * cnpj = só dígitos, data = aaaa-mm-dd, dec2/dec3 = número arredondado, sn = 'S'/'N', uf = 2 letras maiúsculas)
 */
export const DESTINOS_VENDA = [
  { campo: 'cod_integracao', rotulo: 'Cód. integração da NF', tipo: 'codbm' },
  { campo: 'nf_data', rotulo: 'Data', tipo: 'data' },
  { campo: 'nf_numero', rotulo: 'Nº da NF', tipo: 'texto', max: 20 },
  { campo: 'nf_valor_total', rotulo: 'Total da NF', tipo: 'dec2' },
  { campo: 'nf_cfop', rotulo: 'CFOP', tipo: 'texto', max: 5 },
  { campo: 'cli_cnpj', rotulo: 'CNPJ/CPF', tipo: 'cnpj' },
  { campo: 'cli_nome', rotulo: 'Cliente (NF)', tipo: 'texto', max: 50 },
  { campo: 'cli_cidade', rotulo: 'Cidade', tipo: 'texto', max: 50 },
  { campo: 'cli_bairro', rotulo: 'Bairro', tipo: 'texto', max: 50 },
  { campo: 'cli_uf', rotulo: 'UF', tipo: 'uf' },
  { campo: 'ven_cod_integracao', rotulo: 'Cód. integração do vendedor', tipo: 'codbm' },
  { campo: 'ven_nome', rotulo: 'Vendedor', tipo: 'texto', max: 50 },
  { campo: 'pro_cod_integracao', rotulo: 'Cód. integração do produto', tipo: 'codbm' },
  { campo: 'pro_descricao', rotulo: 'Produto', tipo: 'texto', max: 255 },
  { campo: 'pro_marca', rotulo: 'Marca', tipo: 'texto', max: 50 },
  { campo: 'pro_classe', rotulo: 'Classe', tipo: 'texto', max: 50 },
  { campo: 'pro_classe_descricao', rotulo: 'Descrição da classe', tipo: 'texto', max: 50 },
  { campo: 'pro_qtdade', rotulo: 'Quantidade', tipo: 'dec3' },
  { campo: 'pro_un', rotulo: 'Un.', tipo: 'texto', max: 3 },
  { campo: 'pro_preco_venda', rotulo: 'Preço de venda', tipo: 'dec2' },
  { campo: 'pro_valor_total', rotulo: 'Total do produto', tipo: 'dec2' },
  { campo: 'pro_custo_unit', rotulo: 'Custo unitário', tipo: 'dec2' },
  { campo: 'cancelado', rotulo: 'Cancelado (S/N)', tipo: 'sn' },
] as const;
export type CampoVenda = (typeof DESTINOS_VENDA)[number]['campo'];

/**
 * De onde vem cada campo: coluna do SQL do BM (nome sem diferença de maiúsculas). Várias separadas por vírgula =
 * a primeira preenchida (ex.: o documento da nota e, sem ele, o do cadastro do cliente)
 */
export const MAPA_VENDAS_PADRAO = Object.fromEntries(DESTINOS_VENDA.map((d) => [d.campo, d.campo])) as Record<CampoVenda, string>;
// Sem o documento na nota, o do cadastro do cliente; sem a UF do cadastro, a da nota
MAPA_VENDAS_PADRAO.cli_cnpj = 'cli_cnpj, cli_cnpj_cadastro';
MAPA_VENDAS_PADRAO.cli_uf = 'cli_uf, cli_uf_nf';

/** Confere o mapa vindo da tela: só campos conhecidos, colunas com nome válido; data e NF obrigatórias */
export function conferirMapaVendas(bruto: any): Record<CampoVenda, string> {
  const mapa = { ...MAPA_VENDAS_PADRAO };
  for (const d of DESTINOS_VENDA) {
    if (bruto?.[d.campo] === undefined) continue;
    const v = String(bruto[d.campo] ?? '').toLowerCase().split(',').map((c) => c.trim()).filter(Boolean);
    for (const c of v) if (!/^[a-z_][a-z0-9_]*$/.test(c)) throw erro(400, `${d.rotulo}: "${c}" não é um nome de coluna.`);
    mapa[d.campo] = v.join(', ');
  }
  for (const c of ['cod_integracao', 'nf_data'] as const) if (!mapa[c]) throw erro(400, `Informe a coluna do campo "${DESTINOS_VENDA.find((d) => d.campo === c)!.rotulo}".`);
  return mapa;
}

/** Uma linha do SQL das vendas no formato de vendas_produtos, pelo mapa (o padrão: as colunas do SQL padrão) */
export function converterVenda(l: Record<string, any>, mapa: Record<string, string> = MAPA_VENDAS_PADRAO) {
  /** A primeira coluna do mapa que veio preenchida */
  const valor = (campo: string) => {
    for (const c of String(mapa[campo] ?? '').split(',').map((x) => x.trim()).filter(Boolean)) {
      const v = l[c];
      if (v !== null && v !== undefined && String(v).trim() !== '') return v;
    }
    return null;
  };
  const out: Record<string, any> = {};
  for (const d of DESTINOS_VENDA) {
    const v = valor(d.campo);
    switch (d.tipo) {
      case 'codbm':
        out[d.campo] = v === null ? '' : `${PREFIXO}${String(v).trim()}`;
        break;
      case 'cnpj':
        out[d.campo] = digitos(v, 14) || '';
        break;
      case 'data':
        out[d.campo] = dataBm(v);
        break;
      case 'dec2':
        out[d.campo] = arred(v, 2);
        break;
      case 'dec3':
        out[d.campo] = arred(v, 3);
        break;
      case 'sn':
        out[d.campo] = String(v ?? '').trim().toUpperCase() === 'S' ? 'S' : 'N';
        break;
      case 'uf':
        out[d.campo] = (texto(v, 2) ?? '').toUpperCase();
        break;
      default:
        out[d.campo] = texto(v, d.max) ?? '';
    }
  }
  if (!out.pro_descricao) out.pro_descricao = out.pro_cod_integracao ? `Produto ${out.pro_cod_integracao.slice(PREFIXO.length)}` : 'Produto';
  return out as Record<CampoVenda, any>;
}

/**
 * SQL padrão das vendas no BM: produtos das notas de venda do período (Tipo_Op 1, 2 ou 5, como no relatório de vendas
 * do bmsoft). As canceladas também vêm, marcadas em vendas_produtos.cancelado. Marcadores: :data_de e :data_ate (trocados pelas datas, entre aspas: o DBISAM
 * compara a data com o texto) e :ultimo (paginação pelo ID, que vai como parâmetro). Pode ser trocado pela empresa
 * (config integracoes/sql-vendas, na janela do Importar BM das vendas)
 */
export const SQL_VENDAS_PADRAO = `SELECT P.ID,
       P.ID_NF AS cod_integracao,
       M.Geracao_Data AS nf_data,
       M.Numero AS nf_numero,
       M.CFOP AS nf_cfop,
       M.Total_Nota AS nf_valor_total,
       M.Cliente_Doc AS cli_cnpj,
       C.CPFCNPJ AS cli_cnpj_cadastro,
       M.Cliente_Nome AS cli_nome,
       C.Cidade AS cli_cidade,
       C.Bairro AS cli_bairro,
       C.UF AS cli_uf,
       M.UF AS cli_uf_nf,
       M.ID_Vendedor AS ven_cod_integracao,
       V.Nome AS ven_nome,
       P.ID_Produto AS pro_cod_integracao,
       R.Descricao AS pro_descricao,
       R.Marca AS pro_marca,
       R.Classe AS pro_classe,
       K.Descricao AS pro_classe_descricao,
       P.Qtdade AS pro_qtdade,
       P.Un AS pro_un,
       P.Preco_Venda AS pro_preco_venda,
       P.Valor_Contabil AS pro_valor_total,
       P.Custo_Total AS pro_custo_unit,
       M.Cancelado AS cancelado
  FROM NFPRODUTOS P
  JOIN NFMESTRE M ON M.ID = P.ID_NF
  LEFT JOIN PESSOAS C ON C.ID = M.ID_Cliente
  LEFT JOIN VENDEDORES V ON V.ID = M.ID_Vendedor
  LEFT JOIN PRODUTOSPRINCIPAL R ON R.ID = P.ID_Produto
  LEFT JOIN PRODUTOSCLASSE K ON K.Classe = R.Classe
 WHERE P.ID > :ultimo AND M.Geracao_Data >= :data_de AND M.Geracao_Data <= :data_ate
   AND (M.Tipo_Op = '1' OR M.Tipo_Op = '2' OR M.Tipo_Op = '5')
 ORDER BY P.ID TOP ${PAGINA}`;

/** Colunas que o SQL das vendas deve devolver (os nomes dos campos de vendas_produtos, sem diferença de maiúsculas); ID, cod_integracao e nf_data são obrigatórias */
export const COLUNAS_SQL_VENDAS = ['id', ...DESTINOS_VENDA.map((d) => d.campo), 'cli_cnpj_cadastro', 'cli_uf_nf'];
const OBRIGATORIAS_SQL_VENDAS = ['id', 'cod_integracao', 'nf_data'];

/** Confere o SQL digitado: um SELECT só, com os marcadores do período e da paginação */
export function conferirSqlVendas(bruto: unknown): string {
  const sql = String(bruto ?? '').trim().replace(/;\s*$/, '');
  if (!sql) throw erro(400, 'Escreva o SQL das vendas.');
  if (sql.length > 20_000) throw erro(400, 'SQL grande demais.');
  if (!/^select\b/i.test(sql)) throw erro(400, 'O SQL precisa ser um SELECT.');
  if (sql.includes(';')) throw erro(400, 'Use um comando só (sem ";").');
  for (const m of [':ultimo', ':data_de', ':data_ate']) if (!sql.toLowerCase().includes(m)) throw erro(400, `O SQL precisa usar o marcador ${m}.`);
  return sql;
}

/** Datas do período no lugar dos marcadores (já conferidas: aaaa-mm-dd) */
export const sqlComPeriodo = (sql: string, de: string, ate: string) => sql.replace(/:data_de\b/gi, `'${de}'`).replace(/:data_ate\b/gi, `'${ate}'`);

const CHAVE_SQL_VENDAS = 'sql-vendas';

/** SQL das vendas da empresa (o gravado; sem ele, o padrão) */
async function sqlVendasDa(empresaId: string) {
  const cfg = await lerConfig(empresaId, GRUPO, CHAVE_SQL_VENDAS);
  const mapa = cfg?.mapa ? conferirMapaVendas(cfg.mapa) : MAPA_VENDAS_PADRAO;
  return {
    sql: cfg?.sql ? String(cfg.sql) : SQL_VENDAS_PADRAO,
    padrao: !cfg?.sql,
    mapa,
    mapaPadrao: !cfg?.mapa,
  };
}

/** Grava o SQL e/ou o mapa das vendas (o que não vier fica como está; null = volta ao padrão) */
async function gravarConfigVendas(empresaId: string, mudanca: { sql?: string | null; mapa?: Record<string, string> | null }) {
  const atual = (await lerConfig(empresaId, GRUPO, CHAVE_SQL_VENDAS)) ?? {};
  const novo: any = { ...atual };
  if ('sql' in mudanca) {
    if (mudanca.sql && mudanca.sql !== SQL_VENDAS_PADRAO) novo.sql = mudanca.sql;
    else delete novo.sql;
  }
  if ('mapa' in mudanca) {
    if (mudanca.mapa && JSON.stringify(mudanca.mapa) !== JSON.stringify(MAPA_VENDAS_PADRAO)) novo.mapa = mudanca.mapa;
    else delete novo.mapa;
  }
  const valor = JSON.stringify(Object.keys(novo).length ? novo : null);
  const [existe] = await pool.query<any[]>('SELECT id FROM crm_config WHERE empresa_id = ? AND grupo = ? AND chave = ? LIMIT 1', [empresaId, GRUPO, CHAVE_SQL_VENDAS]);
  if (existe.length) await pool.query('UPDATE crm_config SET valor = ? WHERE id = ?', [valor, existe[0].id]);
  else await pool.query('INSERT INTO crm_config (empresa_id, grupo, chave, valor) VALUES (?, ?, ?, ?)', [empresaId, GRUPO, CHAVE_SQL_VENDAS, valor]);
}

