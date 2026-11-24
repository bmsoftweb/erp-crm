import nodemailer from 'nodemailer';
import { pool } from './db.js';

/**
 * Envio de e-mail por SMTP, pela conta da empresa gravada no BM-Master (sys_empresas_smtp: Grupos › Empresas ›
 * Configurações › E-mail). O CRM só lê. Conta comercial (propostas, pedidos, contratos, campanhas, Bot das
 * atividades): 'crm_comercial' ou, sem ela, a 'padrao'. Conta do suporte (chamados): 'crm_suporte', depois as mesmas.
 * ponytail: a leitura das respostas por IMAP (pesquisa de satisfação do bm-crm) ainda não foi portada; quando vier,
 * sys_empresas_smtp ganha imap_host/imap_porta.
 */

/** Conta de e-mail: comercial ou do suporte */
export type ContaEmail = 'comercial' | 'suporte';

const ORDEM: Record<ContaEmail, string[]> = {
  comercial: ['crm_comercial', 'padrao'],
  suporte: ['crm_suporte', 'crm_comercial', 'padrao'],
};

/** Transporte, remetente e endereço de resposta da conta da empresa */
async function transporteDa(empresaId: string, conta: ContaEmail = 'comercial') {
  const ordem = ORDEM[conta];
  const [[s]]: any = await pool.query(
    `SELECT host, porta, usuario, senha, remetente, responder_para, usa_ssl, usa_tls FROM sys_empresas_smtp
      WHERE empresa_id = ? AND finalidade IN (?) ORDER BY FIELD(finalidade, ?) LIMIT 1`,
    [empresaId, ordem, ordem],
  );
  if (!s?.host) throw new Error('E-mail não configurado: grave a conta de e-mail da empresa no BM-Master (Grupos › Empresas › Configurações › E-mail).');
  const porta = Number(s.porta) || (s.usa_ssl ? 465 : 587);
  const transporte = nodemailer.createTransport({
    host: s.host,
    port: porta,
    secure: !!s.usa_ssl || porta === 465,
    requireTLS: !!s.usa_tls && !s.usa_ssl,
    auth: s.usuario ? { user: s.usuario, pass: s.senha ?? '' } : undefined,
    connectionTimeout: 15_000,
  });
  return { transporte, from: s.remetente || s.usuario || undefined, replyTo: s.responder_para || undefined };
}

/** Envia; devolve o Message-ID (a resposta do cliente aponta para ele no In-Reply-To) */
export async function enviarEmail(
  empresaId: string,
  msg: { para: string; assunto: string; texto: string; anexos?: { nome: string; conteudo: Buffer }[] },
  conta: ContaEmail = 'comercial',
): Promise<string | null> {
  const { transporte, from, replyTo } = await transporteDa(empresaId, conta);
  const info = await transporte.sendMail({
    from,
    replyTo,
    to: msg.para,
    subject: msg.assunto,
    text: msg.texto,
    attachments: msg.anexos?.map((a) => ({ filename: a.nome, content: a.conteudo })),
  });
  return info.messageId ?? null;
}
