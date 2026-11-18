import 'dotenv/config';
import express, { NextFunction, Request, Response } from 'express';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { pool, checkDbHealth } from './db.js';
import { FILIAL_LIBERADA } from './erp.js';
import { createCrudRouter } from './crud.js';
import { createCrmRouter } from './crm.js';
import { createConfigRouter } from './config.js';
import { createImportArquivoRouter } from './importarquivo.js';
import { createEnderecosRouter } from './enderecos.js';
import { createParticipantesRouter } from './participantes.js';
import { createAtividadeBotRouter, rodarBotAtividades } from './atividadeBot.js';
import { createCampanhasRouter } from './campanhas.js';
import { createConversasRouter } from './conversas.js';
import { createJornadaRouter, retomarJornadas } from './jornada.js';
import { createContratosRouter, createWebhookD4SignRouter, rotinaContratos } from './contratos.js';
import { enviarPendentes, receberAvisoEvolution } from './whatsapp.js';
import { enviarAutomaticas } from './automaticas.js';
import { responderComBot } from './chatbot.js';
import { verificarInatividade } from './inatividade.js';
import { enviarEmailsCampanha, marcarRespondido } from './campanhas.js';
import { tratarRespostaPesquisa } from './pesquisa.js';
import { createAceiteRouter } from './aceite.js';
import { createFotosRouter } from './fotos.js';
import { createAnexosRouter } from './anexos.js';
import { createNotificacoesRouter } from './notificacoes.js';
import { createConsultasRouter } from './consultas.js';
import { createAgendaGoogleRouter, createRetornoAgendaGoogleRouter, sincronizarAgendas } from './agendaGoogle.js';
import { createLeadsRouter } from './leads.js';
import { createProspeccaoRouter } from './prospeccao.js';
import { waitUntil } from '@vercel/functions';
import { lerPermissoes, prepararPermissoes } from './permissoes.js';
import { PERFIS } from './schema.js';

// ==========================================================
// Sessão: token "usuarioId.empresaId.expiracao.assinatura" (HMAC-SHA256); a filial é escolhida no login
// ==========================================================
const SEGREDO =
  process.env.SESSION_SECRET ||
  (console.warn('SESSION_SECRET não definido: as sessões expiram a cada reinício do servidor.'),
  crypto.randomBytes(32).toString('hex'));
const VALIDADE_MS = 30 * 24 * 60 * 60 * 1000;

const assinar = (dados: string) => crypto.createHmac('sha256', SEGREDO).update(dados).digest('base64url');

function emitirToken(usuarioId: number, empresaId: number): string {
  const dados = `${usuarioId}.${empresaId}.${Date.now() + VALIDADE_MS}`;
  return `${dados}.${assinar(dados)}`;
}

/** Usuário e filial do token, ou null se inválido/expirado */
function lerToken(token: string): { usuarioId: number; empresaId: number } | null {
  const [id, empresa, exp, assinatura] = String(token || '').split('.');
  if (!id || !empresa || !exp || !assinatura) return null;
  const esperada = assinar(`${id}.${empresa}.${exp}`);
  if (esperada.length !== assinatura.length || !crypto.timingSafeEqual(Buffer.from(esperada), Buffer.from(assinatura))) return null;
  if (Number(exp) < Date.now()) return null;
  return { usuarioId: Number(id), empresaId: Number(empresa) };
}

/** Validação de senha tolerante a bases legadas: bcrypt, texto puro, MD5, SHA-256 e SHA-1 */
function verifyPasswordMatch(inputPassword: string, storedHash: string): boolean {
  if (!storedHash || storedHash.trim() === '') return false;
  if (/^\$2[aby]\$/.test(storedHash)) {
    try {
      if (bcrypt.compareSync(inputPassword, storedHash)) return true;
    } catch {
      // segue para os demais formatos
    }
  }
  if (inputPassword === storedHash) return true;
  for (const alg of ['md5', 'sha256', 'sha1']) {
    if (crypto.createHash(alg).update(inputPassword).digest('hex') === storedHash.toLowerCase()) return true;
  }
  return false;
}

const usuarioPublico = (u: any) => ({
  id: String(u.id),
  nome: u.nome,
  email: u.email,
  cargo: u.cargo || PERFIS.find((p) => p.value === u.tipo)?.label || 'Vendedor',
  tipo: u.tipo,
  // Opções do menu que acessa (null = todas); a tela esconde as outras e o servidor recusa
  permissoes: lerPermissoes(u.permissoes),
});

/**
 * Usuário ativo do ERP numa filial liberada, com o perfil do CRM naquela filial (crm_usuarios).
 * Sem perfil no CRM: nível super/admin do ERP entra como administrador, os demais como vendedor.
 * O primeiro "?" é a filial.
 */
const SQL_USUARIO_EMPRESA = `
  SELECT u.id, u.login, COALESCE(NULLIF(u.nome, ''), u.login) AS nome, u.email, u.senha_hash, u.cargo,
         COALESCE(cu.tipo, IF(u.nivel IN ('super', 'admin'), 'admin', 'client')) AS tipo, cu.permissoes, cu.departamento_id,
         e.id AS empresa_id, COALESCE(NULLIF(e.nome_fantasia, ''), e.razao_social) AS empresa_nome
    FROM sys_usuarios u
    JOIN sys_empresas e ON e.id = ? AND ${FILIAL_LIBERADA}
    LEFT JOIN crm_usuarios cu ON cu.usuario_id = u.id AND cu.empresa_id = e.id
   WHERE u.ativo = 1`;

/** Filiais em que o usuário pode entrar */
async function filiaisDoUsuario(usuarioId: number): Promise<{ id: string; nome: string }[]> {
  const [rows] = await pool.query<any[]>(
    `SELECT e.id, COALESCE(NULLIF(e.nome_fantasia, ''), e.razao_social) AS nome
       FROM sys_usuarios u JOIN sys_empresas e ON ${FILIAL_LIBERADA}
      WHERE u.id = ? ORDER BY e.id`,
    [usuarioId],
  );
  return rows.map((r) => ({ id: String(r.id), nome: r.nome }));
}

/** Erro de acesso no login: a mensagem vai para o usuário */
class ErroAcesso extends Error {
  constructor(public status: number, mensagem: string) {
    super(mensagem);
  }
}

/**
 * Endereço de volta para o Master (em erro na entrada automática): só o do MASTER_URL do .env (separados por vírgula;
 * sem ele, localhost), para o link não servir de redirecionamento para outro site
 */
function voltaDoMaster(v: unknown): URL | null {
  try {
    const url = new URL(String(v || ''));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const permitidas = (process.env.MASTER_URL || '').split(',').map((x) => x.trim()).filter(Boolean);
    const ok = permitidas.length ? permitidas.some((x) => new URL(x).origin === url.origin) : ['localhost', '127.0.0.1'].includes(url.hostname);
    return ok ? url : null;
  } catch {
    return null;
  }
}

/** App Express com todas as rotas /api. Local: server.ts adiciona o Vite e o listen; Vercel: api/index.ts */
export function createApp() {
  const app = express();
  // Documentos de contrato e arquivos das conversas (base64) passam do limite normal de 2 MB
  const jsonNormal = express.json({ limit: '2mb' });
  const jsonDocumentos = express.json({ limit: '25mb' });
  const comArquivo = /^\/api\/(contratos\/\d+\/documentos|whatsapp\/conversas\/\d+|jornada\/arquivos)$/;
  app.use((req, res, next) => (comArquivo.test(req.path) ? jsonDocumentos : jsonNormal)(req, res, next));

  // ==========================================================
  // 0. Login do ERP (sys_usuarios.login ou e-mail) + senha; com mais de uma filial, o usuário escolhe.
  //    A mesma conferência serve à entrada vinda do BM-Master (/api/entrar)
  // ==========================================================
  /** Confere usuário e senha (grava a senha no primeiro acesso) e devolve o usuário e as filiais liberadas */
  async function autenticar(loginBruto: unknown, senhaBruta: unknown) {
    const login = String(loginBruto || '').trim().toLowerCase();
    const senha = typeof senhaBruta === 'string' ? senhaBruta : '';
    if (!login) throw new ErroAcesso(400, 'Informe o seu usuário.');

    const [usuarios] = await pool.query<any[]>(
      'SELECT id, senha_hash FROM sys_usuarios WHERE ativo = 1 AND (LOWER(TRIM(login)) = ? OR LOWER(TRIM(email)) = ?) LIMIT 1',
      [login, login],
    );
    if (!usuarios.length) throw new ErroAcesso(401, `O usuário "${login}" não foi localizado ou está inativo.`);
    const u = usuarios[0];

    // Senha em branco no banco = primeiro acesso: grava o que foi digitado em bcrypt
    const senhaEmBranco = !u.senha_hash || String(u.senha_hash).trim() === '' || String(u.senha_hash).toUpperCase() === 'NULL';
    if (senhaEmBranco) {
      if (senha.trim().length < 4) throw new ErroAcesso(401, 'Primeiro acesso: defina uma senha com pelo menos 4 caracteres.');
      await pool.query('UPDATE sys_usuarios SET senha_hash = ? WHERE id = ?', [bcrypt.hashSync(senha, 10), u.id]);
    } else {
      if (!verifyPasswordMatch(senha, u.senha_hash)) throw new ErroAcesso(401, 'Senha incorreta para o usuário informado.');
      // Reescreve senhas em formato legado no padrão bcrypt
      if (!/^\$2[aby]\$/.test(String(u.senha_hash))) {
        await pool.query('UPDATE sys_usuarios SET senha_hash = ? WHERE id = ?', [bcrypt.hashSync(senha, 10), u.id]).catch(() => {});
      }
    }

    const filiais = await filiaisDoUsuario(Number(u.id));
    if (!filiais.length) throw new ErroAcesso(403, 'Nenhuma empresa liberada para este usuário.');
    return { id: Number(u.id), primeiroAcesso: senhaEmBranco, filiais };
  }

  /** Sessão do usuário na filial: o token e os dados que o navegador guarda */
  async function abrirSessao(usuarioId: number, empresaId: string) {
    const [rows] = await pool.query<any[]>(`${SQL_USUARIO_EMPRESA} AND u.id = ? LIMIT 1`, [empresaId, usuarioId]);
    const s = rows[0];
    return { token: emitirToken(usuarioId, Number(empresaId)), usuario: usuarioPublico(s), empresa: { id: String(s.empresa_id), nome: s.empresa_nome } };
  }

  app.post('/api/login', async (req: Request, res: Response) => {
    try {
      const { email, senha, empresa } = req.body || {};
      const a = await autenticar(email, senha);

      // Filial: a escolhida na tela, ou a única liberada; com várias e nenhuma escolhida, a tela pergunta
      const pediu = empresa != null && empresa !== '';
      const escolhida = pediu ? a.filiais.find((f) => f.id === String(empresa)) : a.filiais.length === 1 ? a.filiais[0] : undefined;
      if (!escolhida) {
        if (pediu) return res.status(403).json({ success: false, error: 'Empresa não liberada para este usuário.' });
        return res.json({ success: false, escolherEmpresa: true, filiais: a.filiais });
      }

      res.json({
        success: true,
        primeiroAcesso: a.primeiroAcesso,
        message: a.primeiroAcesso ? 'Primeiro acesso: sua senha foi registrada e criptografada com bcrypt.' : undefined,
        ...(await abrirSessao(a.id, escolhida.id)),
      });
    } catch (err: any) {
      if (err instanceof ErroAcesso) return res.status(err.status).json({ success: false, error: err.message });
      res.status(500).json({ success: false, error: err.message });
    }
  });

  /**
   * Entrada vinda do BM-Master (lançador de módulos), sem a tela de login, como no erp-estoque
   * (sys_modulos.url = <crm>/api/entrar):
   *   GET /api/entrar?user=base64(login:senha)&e=<empresa>&g=<grupo>&tema=<light|dark>&volta=<endereço do Master>
   * Confere o usuário como o login e abre a sessão na empresa pedida (a principal do usuário) quando liberada, senão
   * na primeira liberada. Vai para /?master=1 com a sessão depois do "#" (não chega ao servidor nem aos logs; o
   * navegador a guarda e limpa o endereço: src/utils/origemMaster.ts). Em erro, volta para o Master com ?erro=.
   */
  app.get('/api/entrar', async (req: Request, res: Response) => {
    const volta = voltaDoMaster(req.query.volta);
    try {
      const credencial = Buffer.from(String(req.query.user || ''), 'base64').toString('utf8');
      const i = credencial.indexOf(':');
      if (i < 1) throw new ErroAcesso(400, 'Acesso inválido: abra o módulo pelo Master.');
      const a = await autenticar(credencial.slice(0, i), credencial.slice(i + 1));
      const f = a.filiais.find((x) => x.id === String(req.query.e ?? '')) ?? a.filiais[0];
      const sessao = Buffer.from(JSON.stringify(await abrirSessao(a.id, f.id))).toString('base64url');
      const tema = req.query.tema === 'light' || req.query.tema === 'dark' ? `&tema=${req.query.tema}` : '';
      res.redirect(302, `/?master=1${tema}#sessao=${sessao}`);
    } catch (err: any) {
      const mensagem = err instanceof ErroAcesso ? err.message : 'Erro ao entrar no CRM. Tente novamente.';
      if (!(err instanceof ErroAcesso)) console.error('Entrada pelo Master:', err);
      if (volta) {
        volta.searchParams.set('erro', `CRM: ${mensagem}`);
        return res.redirect(302, volta.toString());
      }
      res.status(err instanceof ErroAcesso ? err.status : 500).type('text/plain').send(mensagem);
    }
  });

  app.get('/api/db/status', async (_req: Request, res: Response) => {
    res.json(await checkDbHealth());
  });

  // Aviso da D4Sign sobre as assinaturas (público: a D4Sign não tem sessão)
  app.use(createWebhookD4SignRouter());

  // Aceite da proposta pelo link enviado ao cliente (público: o token do link identifica a proposta)
  app.use(createAceiteRouter());

  // Volta da autorização do Google Agenda (pública: o state cifrado identifica a empresa)
  app.use(createRetornoAgendaGoogleRouter());

  // Avisos da Evolution (mensagens recebidas, entrega e leitura). Público: o token do endereço
  // identifica a empresa. Processa antes de responder (na Vercel a função congela depois)
  app.post('/api/webhooks/evolution/:token', async (req: Request, res: Response) => {
    try {
      const novas = await receberAvisoEvolution(req.params.token, req.body);
      // Chatbot em segundo plano (na Vercel, waitUntil mantém a função viva): a espera de 1 a 30 s
      // e a IA não seguram a resposta à Evolution
      // Resposta de pesquisa de satisfação é tratada antes (não aciona o bot nem a jornada)
      for (const n of novas) {
        waitUntil(
          (async () => {
            // Resposta a uma campanha (disparo dos últimos 15 dias): o disparo fica "respondeu"
            await marcarRespondido(n.empresaId, n.telefone).catch((err) => console.error(`Campanhas: respondeu (${n.telefone}): ${err.message}`));
            if (await tratarRespostaPesquisa(n)) return;
            await responderComBot(n);
          })().catch((err) => console.error(`Chatbot: ${err.message}`)),
        );
      }
      res.json({ ok: true });
    } catch (err: any) {
      if (!err.status) console.error(`Evolution webhook: ${err.message}`);
      res.status(err.status || 500).json({ error: err.message });
    }
  });

  // Rotinas chamadas pelo cron da Vercel (vercel.json), que envia "Authorization: Bearer CRON_SECRET".
  // Fora da Vercel elas rodam pelo setInterval do server.ts.
  const cron = (tarefa: () => Promise<unknown>) => async (req: Request, res: Response) => {
    const segredo = process.env.CRON_SECRET;
    const recebido = String(req.header('authorization') || '');
    const esperado = `Bearer ${segredo}`;
    if (!segredo || recebido.length !== esperado.length || !crypto.timingSafeEqual(Buffer.from(recebido), Buffer.from(esperado))) {
      return res.status(401).json({ error: 'Não autorizado.' });
    }
    try {
      res.json({ success: true, resultado: await tarefa() });
    } catch (err: any) {
      console.error(`Cron ${req.path}: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  };
  // A função tem até 60 s: campanhas até 25 s, automáticas até 20 s; o resto fica para o minuto seguinte
  // Inatividade em paralelo com o resto
  app.get(
    '/api/cron/whatsapp',
    cron(async () => {
      // Google Agenda só a cada 10 minutos: conectar nela é o mais lento do ciclo
      // e cada minuto da função conta no consumo da Vercel
      const decimo = new Date().getMinutes() % 10 === 0;
      // Bot das atividades também em paralelo: cada contato espera a IA
      const [inatividade, atividadesBot, agendaGoogle, resto] = await Promise.all([
        verificarInatividade(),
        rodarBotAtividades(45_000),
        // Google Agenda da empresa, nos dois sentidos (server/agendaGoogle.ts)
        decimo ? sincronizarAgendas(25_000).catch((e) => `falhou: ${e.message}`) : 'a cada 10 min',
        (async () => ({
          campanhas: await enviarPendentes(50, 25_000),
          emails: await enviarEmailsCampanha(50, 20_000),
          automaticas: await enviarAutomaticas(20_000),
          jornadas: await retomarJornadas(20_000),
        }))(),
      ]);
      return { ...resto, inatividade, atividadesBot, agendaGoogle };
    }),
  );
  // De hora em hora: a rotina dos contratos
  app.get('/api/cron/contratos', cron(rotinaContratos));

  // ==========================================================
  // Daqui para baixo, toda rota /api exige um token válido
  // ==========================================================
  // A filial vem do token assinado (escolhida no login) e é conferida a cada requisição:
  // usuário desativado ou sem acesso à filial perde o acesso na hora.
  app.use('/api', async (req: Request, res: Response, next: NextFunction) => {
    const token = String(req.header('authorization') || '').replace(/^Bearer\s+/i, '');
    const sessao = lerToken(token);
    if (!sessao) return res.status(401).json({ error: 'Sessão expirada. Entre novamente.' });
    const { usuarioId } = sessao;
    try {
      const [rows] = await pool.query<any[]>(`${SQL_USUARIO_EMPRESA} AND u.id = ? LIMIT 1`, [sessao.empresaId, usuarioId]);
      if (!rows.length) {
        return res.status(401).json({ valida: false, error: 'Seu usuário foi desativado ou está sem empresa. Fale com o administrador.' });
      }
      res.locals.usuarioId = usuarioId;
      res.locals.usuario = rows[0];
      res.locals.empresaId = String(rows[0].empresa_id);
      next();
    } catch (err: any) {
      // Falha de banco não derruba a sessão: o painel já mostra o banco como indisponível
      res.status(503).json({ valida: null, error: err.message });
    }
  });

  /** Revalidação da sessão guardada no navegador (a checagem em si é o middleware acima) */
  app.get('/api/sessao', (_req: Request, res: Response) => {
    const u = res.locals.usuario;
    res.json({ valida: true, usuario: usuarioPublico(u), empresa: { id: String(u.empresa_id), nome: u.empresa_nome } });
  });

  /** Troca da própria senha (ícone ao lado do nome, no menu): confere a atual antes */
  app.post('/api/minha-senha', async (req: Request, res: Response) => {
    try {
      const u = res.locals.usuario;
      const { atual, nova } = req.body || {};
      const semSenha = !u.senha_hash || String(u.senha_hash).trim() === '' || String(u.senha_hash).toUpperCase() === 'NULL';
      if (!semSenha && !verifyPasswordMatch(String(atual ?? ''), u.senha_hash)) return res.status(400).json({ error: 'A senha atual não confere.' });
      if (typeof nova !== 'string' || nova.length < 4) return res.status(400).json({ error: 'A nova senha precisa ter pelo menos 4 caracteres.' });
      await pool.query('UPDATE sys_usuarios SET senha_hash = ? WHERE id = ?', [bcrypt.hashSync(nova, 10), u.id]);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  });

  // Permissões de acesso de um usuário (Usuários › Permissões): só administradores
  app.put('/api/usuarios/:id/permissoes', async (req: Request, res: Response) => {
    try {
      if (res.locals.usuario?.tipo !== 'admin') return res.status(403).json({ error: 'Somente administradores alteram permissões.' });
      const permissoes = prepararPermissoes(req.body?.permissoes ?? null);
      // Só usuário com acesso a esta filial; o perfil do CRM na filial é criado se ainda não existir
      const [r] = await pool.query<any>(
        `INSERT INTO crm_usuarios (usuario_id, empresa_id, tipo, permissoes)
         SELECT u.id, e.id, IF(u.nivel IN ('super', 'admin'), 'admin', 'client'), ?
           FROM sys_usuarios u JOIN sys_empresas e ON e.id = ? AND ${FILIAL_LIBERADA}
          WHERE u.id = ?
         ON DUPLICATE KEY UPDATE permissoes = VALUES(permissoes)`,
        [permissoes === null ? null : JSON.stringify(permissoes), res.locals.empresaId, Number(req.params.id) || 0],
      );
      if (!r.affectedRows) return res.status(404).json({ error: 'Usuário não encontrado.' });
      res.json({ success: true, permissoes });
    } catch (err: any) {
      res.status(err.status || 400).json({ error: err.message });
    }
  });

  // Preferências das listas (larguras e ordem das colunas), guardadas por usuário em sys_usuarios.config_listas,
  // que os outros módulos do ERP também usam: o CRM lê e grava só a chave "crm" do JSON
  app.get('/api/config-listas', async (_req: Request, res: Response) => {
    try {
      const [rows] = await pool.query<any[]>('SELECT config_listas FROM sys_usuarios WHERE id = ?', [res.locals.usuarioId]);
      let config: Record<string, unknown> = {};
      try {
        config = JSON.parse(rows[0]?.config_listas || '{}')?.crm || {};
      } catch {
        // conteúdo inválido no banco não impede o painel de abrir
      }
      res.json(config);
    } catch (err: any) {
      res.status(503).json({ error: err.message });
    }
  });

  app.put('/api/config-listas', async (req: Request, res: Response) => {
    const corpo = req.body;
    if (!corpo || typeof corpo !== 'object' || Array.isArray(corpo)) {
      return res.status(400).json({ error: 'Configuração inválida.' });
    }
    const texto = JSON.stringify(corpo);
    if (texto.length > 60000) return res.status(413).json({ error: 'Configuração muito grande.' });
    try {
      await pool.query(
        `UPDATE sys_usuarios
            SET config_listas = JSON_SET(IF(JSON_VALID(config_listas), config_listas, '{}'), '$.crm', CAST(? AS JSON))
          WHERE id = ?`,
        [texto, res.locals.usuarioId],
      );
      res.json({ success: true });
    } catch (err: any) {
      res.status(503).json({ error: err.message });
    }
  });

  // Cadastro de usuários: só administradores (um vendedor não pode se promover)
  app.use('/api/crud/usuarios', (_req: Request, res: Response, next: NextFunction) => {
    if (res.locals.usuario.tipo !== 'admin') return res.status(403).json({ error: 'Somente administradores gerenciam usuários.' });
    next();
  });

  app.use('/api', createConfigRouter());
  app.use('/api', createAgendaGoogleRouter());
  app.use('/api', createProspeccaoRouter());
  app.use('/api', createLeadsRouter());
  app.use('/api', createFotosRouter());
  app.use('/api', createAnexosRouter());
  app.use('/api', createNotificacoesRouter());
  app.use('/api', createConsultasRouter());
  app.use('/api', createImportArquivoRouter());
  app.use('/api', createEnderecosRouter());
  app.use('/api', createParticipantesRouter());
  app.use('/api', createAtividadeBotRouter());
  app.use('/api', createCampanhasRouter());
  app.use('/api', createConversasRouter());
  app.use('/api', createJornadaRouter());
  app.use('/api', createContratosRouter());
  app.use('/api', createCrmRouter());
  app.use('/api', createCrudRouter());

  return app;
}
