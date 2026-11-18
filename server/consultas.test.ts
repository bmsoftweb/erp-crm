import assert from 'node:assert';
import { conferirGrafico, preencherResposta } from './consultas.js';
import { isolarEmpresa, sqlExecutadoIa } from './selecaoIa.js';

// Cada tabela do FROM/JOIN vira só as linhas da filial e as colunas liberadas, mantendo o apelido
const COLS = { pessoas: ['id', 'nome', 'cidade'], funis: ['id', 'nome'], etapas: ['id', 'funil_id', 'nome'], negocios: ['id', 'pessoa_id'] };
const s = isolarEmpresa("SELECT p.nome AS `Nome` FROM pessoas p JOIN negocios n ON n.pessoa_id = p.id WHERE p.cidade LIKE '%from pessoas%'", 7, COLS);
assert.ok(s.startsWith('SELECT p.nome AS `Nome` FROM (SELECT `id`, `nome`, `cidade` FROM (SELECT x.*, 7 AS empresa_id FROM (SELECT p.id'), s);
assert.ok(s.includes(') AS p JOIN (SELECT `id`, `pessoa_id` FROM (SELECT * FROM crm_negocios WHERE empresa_id = 7) f) AS n ON'), s);
assert.ok(s.endsWith("WHERE p.cidade LIKE '%from pessoas%'"), s);
// Sem apelido: o apelido é o nome da tabela; palavra-chave depois do nome não vira apelido
assert.ok(isolarEmpresa('SELECT COUNT(*) FROM pessoas WHERE pessoas.id > 0', 7, COLS).includes(') f) AS pessoas WHERE pessoas.id > 0'));
assert.ok(isolarEmpresa('SELECT 1 FROM pessoas LEFT JOIN funis ON 1', 7, COLS).includes('AS pessoas LEFT JOIN'));
// Tabela sem empresa_id: pelas linhas do "pai" da filial
assert.ok(isolarEmpresa('SELECT nome FROM etapas', 7, COLS).includes('funil_id IN (SELECT id FROM crm_funis WHERE empresa_id = 7)'));
// Subconsulta também é isolada; sem colunas, todas
assert.ok(isolarEmpresa('SELECT 1 FROM funis f WHERE EXISTS (SELECT 1 FROM pessoas x)', 7).includes('(SELECT * FROM (SELECT x.*, 7 AS empresa_id FROM'));
// Recusa: tabela fora da lista (inclusive a real, crm_*), outro banco, vírgula
assert.throws(() => isolarEmpresa('SELECT * FROM empresas', 7, COLS), /tabelas do CRM/);
assert.throws(() => isolarEmpresa('SELECT * FROM crm_negocios', 7, COLS), /tabelas do CRM/);
assert.throws(() => isolarEmpresa('SELECT * FROM bmerp_000000.cad_pessoas', 7, COLS), /tabelas do CRM/);
assert.throws(() => isolarEmpresa('SELECT * FROM funis f, pessoas', 7, COLS), /JOIN/);
assert.throws(() => isolarEmpresa('SELECT senha FROM sys_usuarios', 7, COLS), /tabelas do CRM/);
// Seleção de campanha: :empresa trocado e tabelas isoladas
assert.ok(!/FROM pessoas p WHERE/.test(sqlExecutadoIa('SELECT p.id FROM pessoas p WHERE p.empresa_id = :empresa', 7)));
assert.ok(sqlExecutadoIa('SELECT p.id FROM pessoas p WHERE p.empresa_id = :empresa', 7).includes('p.empresa_id = 7'));

// Números da frase vêm do resultado
const r = { colunas: [{ nome: 'Total', tipo: 'numero' as const }], linhas: [[1234]], truncado: false };
assert.strictEqual(preencherResposta('Você tem {{Total}} clientes ({{linhas}} linha).', r), 'Você tem 1.234 clientes (1 linha).');
// Gráfico só com colunas do resultado; y precisa ser numérico; pizza fica com uma série
{
  const g = { colunas: [{ nome: 'Mês', tipo: 'texto' as const }, { nome: 'Total', tipo: 'numero' as const }, { nome: 'Qtd', tipo: 'numero' as const }], linhas: [['01/2026', 10, 2]], truncado: false };
  assert.deepStrictEqual(conferirGrafico({ tipo: 'linha', x: 'mês', y: ['Total', 'Nada'] }, g), { tipo: 'linha', x: 'Mês', y: ['Total'] });
  assert.deepStrictEqual(conferirGrafico({ tipo: 'pizza', x: 'Mês', y: ['Total', 'Qtd'] }, g)?.y, ['Total']);
  assert.strictEqual(conferirGrafico({ tipo: 'barras', x: 'Mês', y: ['Mês'] }, g), null);
  assert.strictEqual(conferirGrafico({ tipo: '3d', x: 'Mês', y: ['Total'] }, g), null);
}
console.log('consultas: ok');

// Opções da pergunta de volta: no mínimo 2, sem repetidas, no máximo 6
{
  const { conferirOpcoes } = await import('./consultas.js');
  assert.deepStrictEqual(conferirOpcoes({ lista: ['Por valor', ' Por valor ', 'Por quantidade'], multipla: true }), { lista: ['Por valor', 'Por quantidade'], multipla: true });
  assert.strictEqual(conferirOpcoes({ lista: ['Só uma'] }), null);
  assert.strictEqual(conferirOpcoes(null), null);
  assert.strictEqual(conferirOpcoes({ lista: ['1', '2', '3', '4', '5', '6', '7', '8'] })?.lista.length, 6);
}

// Gráfico só com pedido explícito
{
  const { PEDE_GRAFICO } = await import('./consultas.js');
  assert.ok(PEDE_GRAFICO.test('gráfico das vendas por mês') && PEDE_GRAFICO.test('em pizza, clientes por cidade'));
  assert.ok(!PEDE_GRAFICO.test('mostre os clientes de Ituporanga') && !PEDE_GRAFICO.test('vendas por linha de produto'));
}
