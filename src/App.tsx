import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Usuario, ResourceDef, DashboardData, RegistroCrud, FiltroAvancado } from './types';
import {
  setTokenSessao,
  setAoExpirarSessao,
  fetchResources,
  fetchDashboard,
  invalidateOptions,
  validarSessao,
  fetchNaoVistas,
  fetchMinhasAtividades,
  atividadesGravadasAqui,
  type Notificacao,
} from './services/api';
import { destravarSom, tocarAviso } from './utils/som';
import { lerConfigLista, limparConfigListas, salvarConfigLista } from './utils/configListas';
import { Sidebar } from './components/Sidebar';
import { Header } from './components/Header';
import { NotificacoesSino } from './components/NotificacoesSino';
import { ConsultasView } from './components/ConsultasView';
import { LoginView } from './components/LoginView';
import { Dashboard } from './components/Dashboard';
import { CrudView } from './components/CrudView';
import { Kanban } from './components/Kanban';
import { NegocioFicha } from './components/NegocioFicha';
import { DocumentoEditor } from './components/DocumentoEditor';
import { BotaoImportarArquivo } from './components/ImportarArquivoModal';
import { BotaoClonar } from './components/BotaoClonar';
import { BotaoReverter } from './components/BotaoReverter';
import { BotaoImprimir } from './components/BotaoImprimir';
import { AcaoCampanha, BotaoEnviarDisparo } from './components/AcoesCampanha';
import { NaoRespondidos } from './components/NaoRespondidos';
import { BotaoEnviar } from './components/BotaoEnviar';
import { BotaoLinkAceite } from './components/BotaoLinkAceite';
import { BotaoNovaVersao } from './components/BotaoNovaVersao';
import { AcaoConversaBot, ConversaBot } from './components/ConversaBot';
import { AcaoConcluir, BotaoConcluirRapido } from './components/ConcluirAtividade';
import { KeyRound } from 'lucide-react';
import { ConverterLead } from './components/ConverterLead';
import { Prospeccao } from './components/Prospeccao';
import { ContratoDocumentos } from './components/ContratoDocumentos';
import { BotaoGerarContrato } from './components/BotaoGerarContrato';
import { ConfiguracoesView } from './components/ConfiguracoesView';
import { ConversasView, PedidoConversa } from './components/ConversasView';
import { BotaoWhatsApp } from './components/BotaoWhatsApp';
import { BotaoPermissoes } from './components/PermissoesUsuario';
import { gruposDoMenu, podeAcessar, podeImportar, type ItemMenu } from './utils/menu';
import { ThemeMode, getInitialTheme, applyTheme } from './utils/theme';
import { Sessao, lerSessao, salvarSessao, limparSessao, atualizarSessao } from './utils/session';
import { fecharNoMaster } from './utils/origemMaster';
import { repetirConsulta } from './utils/intervalo';

export default function App() {
  // ----------------------------------------------------------
  // Tema claro / escuro
  // ----------------------------------------------------------
  const [theme, setTheme] = useState<ThemeMode>(() => getInitialTheme());
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);
  const handleToggleTheme = useCallback(() => setTheme((prev) => (prev === 'dark' ? 'light' : 'dark')), []);

  // ----------------------------------------------------------
  // Sessão (token assinado pelo servidor, guardado no navegador)
  // ----------------------------------------------------------
  const [sessao, setSessao] = useState<Sessao | null>(() => {
    const s = lerSessao();
    // O token precisa estar no cliente HTTP antes da primeira chamada
    setTokenSessao(s?.token ?? null);
    return s;
  });
  const usuario: Usuario | null = sessao?.usuario ?? null;

  // ----------------------------------------------------------
  // Navegação e estado geral
  // ----------------------------------------------------------
  const [activeTab, setActiveTab] = useState<string>('kanban');
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const [resources, setResources] = useState<ResourceDef[]>([]);
  const [recordCounts, setRecordCounts] = useState<Record<string, number>>({});
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [isDashboardLoading, setIsDashboardLoading] = useState(false);
  const [dashboardError, setDashboardError] = useState<string | null>(null);

  const [refreshToken, setRefreshToken] = useState(0);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => setToastMessage(null), 4000);
  }, []);

  /** Mensagens do WhatsApp recebidas e ainda não vistas (etiqueta do menu Conversas) */
  const [naoVistas, setNaoVistas] = useState(0);
  /** Conversas passadas ao meu departamento que já tocaram o aviso (telefone + quando) */
  const avisadasRef = useRef(new Set<string>());
  /** Última conversa transferida para mim já avisada (null = ainda não carregou: sem campainha na abertura) */
  const ultimaTransferidaWa = useRef<number | null>(null);
  /** Mensagens de cliente esperando a minha resposta que já tocaram a campainha */
  const esperandoAvisadas = useRef(new Set<number>());
  const atualizarNaoVistas = useCallback(() => {
    fetchNaoVistas()
      .then((r) => {
        setNaoVistas(r.total);
        // Cliente encaminhado ao meu departamento: aviso sonoro em qualquer tela, uma vez por encaminhamento
        const novas = (r.encaminhadas ?? []).filter((e) => !avisadasRef.current.has(`${e.telefone}|${e.desde}`));
        novas.forEach((e) => avisadasRef.current.add(`${e.telefone}|${e.desde}`));
        if (novas.length) {
          tocarAviso('campainha');
          const e = novas[0];
          showToast(`${e.nome || `+${e.telefone}`} aguardando atendimento no ${e.departamento}${novas.length > 1 ? ` (e mais ${novas.length - 1})` : ''}. Veja em Conversas.`);
        }
        // Conversa transferida para mim: campainha
        const tr = r.transferida;
        if (tr && ultimaTransferidaWa.current !== null && tr.id > ultimaTransferidaWa.current) {
          tocarAviso('campainha');
          showToast(`Conversa de ${tr.nome || `+${tr.telefone}`} transferida para você${tr.de ? ` por ${tr.de}` : ''}. Veja no Whatsapp.`);
          setRefreshToken((t) => t + 1);
        }
        ultimaTransferidaWa.current = Math.max(ultimaTransferidaWa.current ?? 0, tr?.id ?? 0);
        // Cliente esperando a minha resposta há X minutos: campainha, uma vez por mensagem
        const esp = (r.esperando ?? []).filter((e) => !esperandoAvisadas.current.has(e.id));
        esp.forEach((e) => esperandoAvisadas.current.add(e.id));
        if (esp.length) {
          tocarAviso('campainha');
          showToast(`${esp[0].nome || `+${esp[0].telefone}`} está esperando a sua resposta${esp.length > 1 ? ` (e mais ${esp.length - 1})` : ''}. Veja no Whatsapp.`);
        }
      })
      .catch(() => {}); // sem a tabela ou sem conexão: fica sem etiqueta
  }, [showToast]);
  useEffect(() => destravarSom(), []);
  // Sem permissão para Conversas: sem etiqueta de não vistas nem aviso sonoro
  const veConversas = podeAcessar(sessao?.usuario ?? null, 'conversas');
  useEffect(() => {
    if (!sessao || !veConversas) return;
    atualizarNaoVistas();
    // Também com a aba em segundo plano (aí a cada 30 s): o aviso sonoro não pode esperar a pessoa voltar
    return repetirConsulta(atualizarNaoVistas, 15_000);
  }, [sessao, veConversas, atualizarNaoVistas]);

  /** Atividades pendentes que executo ou do meu departamento, já conhecidas (null = ainda não carregou: sem aviso na abertura) */
  const minhasAtividades = useRef<Set<number> | null>(null);
  const atualizarMinhasAtividades = useCallback(() => {
    fetchMinhasAtividades()
      .then((lista) => {
        const conhecidas = minhasAtividades.current;
        minhasAtividades.current = new Set(lista.map((a) => a.id));
        // Nova para mim (criada por outra pessoa ou passada para mim); as que eu mesmo gravei não avisam
        const novas = conhecidas ? lista.filter((a) => !conhecidas.has(a.id) && !atividadesGravadasAqui.has(a.id)) : [];
        if (!novas.length) return;
        const a = novas[0];
        const quando = a.vencimento ? ` para ${a.vencimento}${a.hora ? ` às ${a.hora}` : ''}` : '';
        const texto = `${a.assunto}${quando}${novas.length > 1 ? ` (e mais ${novas.length - 1})` : ''}`;
        const titulo = a.departamento ? `Nova atividade para o ${a.departamento}` : 'Nova atividade para você';
        tocarAviso('campainha');
        showToast(`${titulo}: ${texto}. Veja em Atividades.`);
        setRefreshToken((t) => t + 1);
        // Navegador em outra janela ou aba: notificação do sistema; o clique traz o CRM para a frente em Atividades
        if (document.hidden && 'Notification' in window && Notification.permission === 'granted') {
          const n = new Notification(titulo, { body: texto, tag: `atividade-${a.id}` });
          n.onclick = () => {
            window.focus();
            setActiveTab('atividades');
            n.close();
          };
        }
      })
      .catch(() => {}); // sem conexão: tenta na próxima
  }, [showToast]);
  useEffect(() => {
    if (!sessao) return;
    if ('Notification' in window && Notification.permission === 'default') void Notification.requestPermission();
    atualizarMinhasAtividades();
    // Também com a aba em segundo plano (a cada 30 s): é justamente quando a pessoa está em outra tela
    return repetirConsulta(atualizarMinhasAtividades, 15_000);
  }, [sessao, atualizarMinhasAtividades]);

  // Tela sem permissão (ex.: o Funil, que abre primeiro): vai para a primeira opção do menu que o usuário acessa
  useEffect(() => {
    const u = sessao?.usuario ?? null;
    if (!u || !resources.length) return;
    const ids = gruposDoMenu(resources).flatMap((g) => g.itens.map((i) => i.id));
    if ((ids.includes(activeTab) || activeTab === 'usuarios') && !podeAcessar(u, activeTab)) {
      const primeira = ids.find((id) => podeAcessar(u, id));
      if (primeira) setActiveTab(primeira);
    }
  }, [sessao, resources, activeTab]);

  /** Atividade WhatsApp clicada na ficha do negócio: a tela Conversas abre o número do cliente */
  const [pedidoConversa, setPedidoConversa] = useState<PedidoConversa | null>(null);

  /** Motivo exibido na tela de login quando a sessão é recusada */
  const [avisoLogin, setAvisoLogin] = useState<string | null>(null);

  /** Troca de tela; o gatilho do botão "Novo" zera para a tela nova não abrir uma inclusão sozinha */
  /** Filtros com que um cadastro abre quando outra tela leva até ele (ex.: Prospecção → Leads) */
  const [filtroInicial, setFiltroInicial] = useState<{ tela: string; filtros: FiltroAvancado[]; seq: number } | null>(null);

  // Navegação normal (menu etc.) abre sem filtro herdado
  const navegar = useCallback((tab: string) => {
    setFiltroInicial(null);
    setRegistroInicial(null);
    setActiveTab(tab);
  }, []);

  const navegarFiltrado = useCallback(
    (tab: string, filtros: FiltroAvancado[]) => {
      navegar(tab);
      setFiltroInicial({ tela: tab, filtros, seq: Date.now() });
    },
    [navegar],
  );

  /** Registro que um cadastro abre em edição quando outra tela leva até ele (ex.: atividade → contrato ou negócio) */
  const [registroInicial, setRegistroInicial] = useState<{ tela: string; id: string | number; seq: number } | null>(null);
  const navegarRegistro = useCallback(
    (tab: string, id: string | number) => {
      navegar(tab);
      setRegistroInicial({ tela: tab, id, seq: Date.now() });
    },
    [navegar],
  );
  /** Conversa do Bot aberta pelo duplo clique na atividade */
  const [conversaBotId, setConversaBotId] = useState<string | null>(null);

  /** Abre a tela Conversas no número de uma atividade WhatsApp, de uma pessoa ou de um contato */
  const pedirConversa = useCallback(
    (de: Omit<PedidoConversa, 'seq'>) => {
      setPedidoConversa({ ...de, seq: Date.now() });
      navegar('conversas');
    },
    [navegar],
  );

  /** Clique numa notificação da campainha: abre a tela do link, no registro quando dá */
  const abrirNotificacao = useCallback(
    (n: Notificacao) => {
      const [tela, param] = (n.link ?? '').split('|');
      if (!tela) return;
      if (tela === 'conversas' && param) pedirConversa({ telefone: param });
      else if (['atividades', 'avaliacoes'].includes(tela) && n.registro_id) navegarRegistro(tela, n.registro_id);
      else navegar(tela);
    },
    [navegar, navegarRegistro, pedirConversa],
  );

  const handleLogout = useCallback(() => {
    setSessao(null);
    setResources([]);
    setDashboard(null);
    setRecordCounts({});
    setActiveTab('kanban');
    invalidateOptions();
    setTokenSessao(null);
    limparConfigListas();
    limparSessao();
  }, []);

  // Qualquer 401 da API (token expirado, usuário desativado) volta para o login
  useEffect(() => {
    setAoExpirarSessao((msg) => {
      handleLogout();
      setAvisoLogin(msg);
    });
    return () => setAoExpirarSessao(null);
  }, [handleLogout]);

  // Sessão guardada no navegador é conferida ao abrir e ao voltar para a aba: o usuário pode ter
  // sido desativado ou ter as permissões alteradas (o menu esconde o que ele não acessa)
  useEffect(() => {
    if (!sessao) return;
    const conferir = () =>
      validarSessao().then(({ valida, error, usuario: atual }) => {
        if (valida === false) {
          handleLogout();
          setAvisoLogin(error || 'Sua sessão expirou. Entre novamente.');
        } else if (atual) {
          setSessao((s) => {
            if (!s || JSON.stringify(s.usuario) === JSON.stringify(atual)) return s;
            const nova = { ...s, usuario: atual };
            atualizarSessao(nova);
            return nova;
          });
        }
      });
    conferir();
    window.addEventListener('focus', conferir);
    return () => window.removeEventListener('focus', conferir);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessao?.token]);

  // Metadados dos recursos
  useEffect(() => {
    if (!sessao) return;
    let alive = true;
    fetchResources()
      .then((list) => alive && setResources(list))
      .catch((err) => console.warn('Falha ao carregar os metadados dos recursos:', err));
    return () => {
      alive = false;
    };
  }, [sessao?.token]);

  const loadDashboard = useCallback(async () => {
    if (!sessao) return;
    setIsDashboardLoading(true);
    setDashboardError(null);
    try {
      setDashboard(await fetchDashboard());
    } catch (err: any) {
      setDashboardError(err.message || 'Falha ao carregar os indicadores.');
    } finally {
      setIsDashboardLoading(false);
    }
  }, [sessao?.token]);

  useEffect(() => {
    if (activeTab === 'dashboard') {
      loadDashboard();
    }
  }, [activeTab, loadDashboard, refreshToken]);

  const handleCountChange = useCallback((resourceName: string, total: number) => {
    setRecordCounts((prev) => (prev[resourceName] === total ? prev : { ...prev, [resourceName]: total }));
  }, []);

  /** Opções favoritas do menu (até 3), por usuário em usuarios.config_listas: estrela no menu, atalho no topo */
  const [favoritos, setFavoritos] = useState<string[]>([]);
  useEffect(() => {
    if (sessao) lerConfigLista('_menu').then((c) => setFavoritos(c.favoritos ?? []));
  }, [sessao?.token]);
  const alternarFavorito = (id: string) => {
    if (!favoritos.includes(id) && favoritos.length >= 3) return showToast('Já há 3 favoritas: tire a estrela de uma antes.');
    const novos = favoritos.includes(id) ? favoritos.filter((f) => f !== id) : [...favoritos, id];
    setFavoritos(novos);
    salvarConfigLista('_menu', { favoritos: novos });
  };
  const itensFavoritos = useMemo(() => {
    const itens: ItemMenu[] = gruposDoMenu(resources).flatMap((g) => g.itens);
    const u = resources.find((r) => r.name === 'usuarios');
    if (u) itens.push({ id: u.name, label: u.label, descricao: u.description, icone: KeyRound });
    return favoritos.map((id) => itens.find((i) => i.id === id)).filter((i): i is ItemMenu => Boolean(i) && podeAcessar(sessao?.usuario ?? null, i!.id));
  }, [favoritos, resources, sessao]);

  const activeResource = useMemo(() => resources.find((r) => r.name === activeTab) || null, [resources, activeTab]);

  // Telas visitadas continuam montadas (escondidas): ao voltar, o formulário, os filtros e a rolagem estão como ficaram.
  // ponytail: no máximo MAX_TELAS (a usada há mais tempo é desmontada); as escondidas seguem consultando o servidor
  const MAX_TELAS = 8;
  const [usoTelas, setUsoTelas] = useState<string[]>([]);
  // Outro usuário (ou novo login): não remonta as telas de quem saiu
  useEffect(() => setUsoTelas([]), [sessao?.usuario.id]);
  useEffect(() => {
    setUsoTelas((u) => [activeTab, ...u.filter((t) => t !== activeTab)].slice(0, MAX_TELAS));
  }, [activeTab]);
  // Tela escondida que volta a aparecer recarrega (lista, combos): o que mudou em outra tela (ex.: segmento criado na
  // Prospecção, leads incluídos) aparece. Filtros, página e formulários abertos continuam como estavam.
  const [voltas, setVoltas] = useState<Record<string, number>>({});
  const telaAnterior = useRef(activeTab);
  useEffect(() => {
    if (telaAnterior.current === activeTab) return;
    telaAnterior.current = activeTab;
    // Primeira visita: a tela monta agora e já carrega sozinha
    if (usoTelas.includes(activeTab)) setVoltas((v) => ({ ...v, [activeTab]: (v[activeTab] ?? 0) + 1 }));
  }, [activeTab, usoTelas]);
  const telasMontadas = useMemo(
    () => (usoTelas.includes(activeTab) ? usoTelas : [activeTab, ...usoTelas]).slice(0, MAX_TELAS).sort(),
    [usoTelas, activeTab],
  );
  const resourceNegocios = useMemo(() => resources.find((r) => r.name === 'negocios'), [resources]);

  /** Telas cujo registro abre num editor próprio, no lugar do formulário genérico */
  const renderEditor = useCallback(
    (nome: string) => (record: RegistroCrud | null, fechar: () => void, aoGravar: () => void) => {
      if (nome === 'negocios') {
        // Inclusão usa o formulário genérico; um negócio existente abre a ficha completa
        return record ? (
          <NegocioFicha
            negocioId={record.id}
            resource={resourceNegocios}
            onFechar={fechar}
            onAlterado={aoGravar}
            onToast={showToast}
            onConversar={pedirConversa}
          />
        ) : null;
      }
      if (nome === 'propostas' || nome === 'pedidos') {
        return <DocumentoEditor tipo={nome} id={record?.id ?? null} onFechar={fechar} onGravado={aoGravar} onToast={showToast} />;
      }
      return null;
    },
    [resourceNegocios, showToast, pedirConversa],
  );

  // ----------------------------------------------------------
  // 1. Tela de login
  // ----------------------------------------------------------
  if (!sessao || !usuario) {
    return (
      <LoginView
        avisoInicial={avisoLogin}
        theme={theme}
        onToggleTheme={handleToggleTheme}
        onLoginSuccess={(novoUsuario, empresa, token, lembrar) => {
          const nova = { usuario: novoUsuario, empresa, token };
          setTokenSessao(token);
          setSessao(nova);
          setActiveTab('kanban');
          salvarSessao(nova, lembrar);
          setAvisoLogin(null);
          showToast(`Bem-vindo, ${novoUsuario.nome}!`);
        }}
      />
    );
  }

  // ----------------------------------------------------------
  // 2. Aplicação
  // ----------------------------------------------------------
  const TITULOS: Record<string, [string, string]> = {
    dashboard: ['Painel de Vendas', 'Indicadores do funil, follow-ups, propostas e pedidos'],
    kanban: ['Funil de Vendas', 'Arraste os negócios entre as etapas; solte em Ganho ou Perdido para encerrar'],
    configuracoes: ['Configurações', 'Preferências da empresa, por grupo'],
    conversas: ['Whatsapp', 'Mensagens do WhatsApp da empresa'],
    prospeccao: ['Prospecção', 'Busque empresas no Google Maps por segmento e região e inclua as qualificadas como leads'],
    consultas: ['Consultas', 'Pergunte sobre os seus dados em português: a IA consulta o banco e mostra o resultado em tabela'],
  };
  const [headerTitle, headerSubtitle] = activeResource
    ? [activeResource.label, activeResource.description]
    : TITULOS[activeTab] || ['BM-CRM', ''];

  /** Conteúdo de uma tela; as telas abertas recentemente ficam montadas (escondidas) para voltar no ponto em que parou */
  const conteudoTela = (tela: string) =>
    // Campanhas: os não respondidos em cima da lista (só quando houver)
    tela === 'campanhas' ? (
      <>
        <NaoRespondidos refreshToken={refreshToken + (voltas.campanhas ?? 0)} onConversa={(telefone) => pedirConversa({ telefone })} />
        {conteudoBase('campanhas')}
      </>
    ) : (
      conteudoBase(tela)
    );

  /** Enviar agora e Ver conversa: na lista dos Disparos */
  const acoesDisparo = (row: RegistroCrud, recarregar: () => void) => (
    <>
      <BotaoEnviarDisparo registro={row} onEnviado={recarregar} onToast={showToast} />
      {row.canal === 'whatsapp' && (
        <BotaoWhatsApp temNumero={Boolean(row.destino)} titulo="Ver conversa" onAbrir={() => pedirConversa({ telefone: row.destino as string })} />
      )}
    </>
  );

  const conteudoBase = (tela: string) => {
    const activeTab = tela;
    const activeResource = resources.find((r) => r.name === tela) || null;
    return (
      activeTab === 'kanban' ? (
        <main className="flex-1 flex flex-col min-h-0 w-full">
          <Kanban
            resourceNegocios={resourceNegocios}
            refreshToken={refreshToken + (voltas[tela] ?? 0)}
            onToast={showToast}
            onConversar={pedirConversa}
          />
        </main>
      ) : activeTab === 'conversas' ? (
        <main className="flex-1 flex flex-col min-h-0 w-full">
          <ConversasView refreshToken={refreshToken + (voltas[tela] ?? 0)} onVisto={atualizarNaoVistas} pedido={pedidoConversa} onToast={showToast} />
        </main>
      ) : activeTab === 'consultas' ? (
        <main className="flex-1 flex flex-col min-h-0 w-full">
          <ConsultasView admin={usuario?.tipo === 'admin'} />
        </main>
      ) : activeTab === 'prospeccao' ? (
        <main className="flex-1 flex flex-col min-h-0 w-full">
          <Prospeccao onToast={showToast} onVerLeads={(id) => navegarFiltrado('leads', [{ field: 'prospeccao_busca_id', op: 'eq', value: id }])} />
        </main>
      ) : activeTab === 'configuracoes' ? (
        <main className="flex-1 flex flex-col min-h-0 w-full">
          <ConfiguracoesView usuario={usuario} onToast={showToast} />
        </main>
      ) : activeResource ? (
        <main className="flex-1 flex flex-col min-h-0 w-full">
          <CrudView
            key={activeResource.name}
            resource={activeResource}
            allResources={resources}
            refreshToken={refreshToken + (voltas[tela] ?? 0)}
            onToast={showToast}
            onCountChange={handleCountChange}
            onNavigate={navegar}
            usuario={usuario}
            filtrosIniciais={filtroInicial?.tela === activeResource.name ? filtroInicial : null}
            registroInicial={registroInicial?.tela === activeResource.name ? registroInicial : null}
            renderEditor={renderEditor(activeResource.name)}
            acoesLista={
              // Importar do arquivo: só gerentes e administradores
              !podeImportar(usuario)
                ? undefined
                : activeResource.name === 'pessoas'
                ? (recarregar) => (
                    <>
                      <BotaoImportarArquivo onImportado={recarregar} />
                    </>
                  )
                : activeResource.name === 'vendas_produtos'
                    ? (recarregar) => (
                        <>
                          <BotaoImportarArquivo tipo="vendas" onImportado={recarregar} />
                        </>
                      )
                    : undefined
            }
            acoesEmMenu={['propostas', 'pedidos', 'campanhas', 'atividades'].includes(activeResource.name)}
            aoDuploClique={
              activeResource.name === 'atividades'
                ? (row) => {
                    // Abre a rotina que gerou a atividade: conversa do Bot, conversa do WhatsApp, contrato
                    // ou negócio (Retorno Envio e as manuais); sem nenhum deles, abre a edição
                    if (Number(row.executor_bot) === 1) {
                      setConversaBotId(String(row.id));
                      return true;
                    }
                    if ((row.tipo === 'whatsapp' || row.origem === 'pendencia') && podeAcessar(usuario, 'conversas')) {
                      pedirConversa({ atividadeId: row.id as string });
                      return true;
                    }
                    if (row.contrato_id && podeAcessar(usuario, 'contratos')) {
                      navegarRegistro('contratos', row.contrato_id as string);
                      return true;
                    }
                    if (row.negocio_id && podeAcessar(usuario, 'negocios')) {
                      navegarRegistro('negocios', row.negocio_id as string);
                      return true;
                    }
                    return false;
                  }
                : undefined
            }
            colunaInicial={
              activeResource.name === 'atividades'
                ? {
                    titulo: 'Concluir',
                    render: (row, { recarregar }) => (
                      <BotaoConcluirRapido registro={row} onFeito={() => (showToast('Atividade concluída.'), recarregar())} />
                    ),
                  }
                : undefined
            }
            acoesLinha={
              activeResource.name === 'propostas' || activeResource.name === 'pedidos'
                ? (row, { abrir, recarregar }) => (
                    <>
                      <BotaoImprimir
                        tipo={activeResource.name as 'propostas' | 'pedidos'}
                        registro={row}
                        onToast={showToast}
                      />
                      <BotaoEnviar
                        tipo={activeResource.name as 'propostas' | 'pedidos'}
                        registro={row}
                        onRecarregar={recarregar}
                        onToast={showToast}
                      />
                      {activeResource.name === 'propostas' && <BotaoLinkAceite registro={row} onToast={showToast} />}
                      {activeResource.name === 'propostas' && (
                        <BotaoNovaVersao registro={row} onAbrir={abrir} onRecarregar={recarregar} onToast={showToast} />
                      )}
                      {activeResource.name === 'propostas' && row.status === 'aceita' && (
                        <BotaoGerarContrato registro={row} onAbrirContratos={() => navegar('contratos')} onToast={showToast} />
                      )}
                      {/* TEMPORÁRIO (testes): Reverter, só para o administrador */}
                      {activeResource.name === 'propostas' && usuario?.tipo === 'admin' && (row.status === 'aceita' || row.status === 'recusada') && (
                        <BotaoReverter registro={row} onRecarregar={recarregar} onToast={showToast} />
                      )}
                      <BotaoClonar
                        tipo={activeResource.name as 'propostas' | 'pedidos'}
                        registro={row}
                        onAbrir={abrir}
                        onRecarregar={recarregar}
                        onToast={showToast}
                      />
                    </>
                  )
                : activeResource.name === 'leads'
                  ? (row, { recarregar }) => <ConverterLead registro={row} onConvertido={recarregar} onToast={showToast} />
                : activeResource.name === 'contratos'
                  ? (row, { recarregar }) => <ContratoDocumentos registro={row} onRecarregar={recarregar} onToast={showToast} />
                : activeResource.name === 'campanhas'
                  ? (row, { recarregar }) => (
                      <AcaoCampanha
                        registro={row}
                        onRecarregar={recarregar}
                        onToast={showToast}
                        onDisparos={() => navegarFiltrado('campanha_disparos', [{ field: 'campanha_id', op: 'eq', value: String(row.id) }])}
                      />
                    )
                : activeResource.name === 'campanha_disparos'
                  ? (row, { recarregar }) => acoesDisparo(row, recarregar)
                  : activeResource.name === 'pessoas'
                    ? (row) => <BotaoWhatsApp temNumero={Boolean(row.whatsapp || row.telefone)} onAbrir={() => pedirConversa({ pessoaId: row.id as string })} />
                    : activeResource.name === 'usuarios'
                      ? (row, { recarregar }) => <BotaoPermissoes usuario={row} resources={resources} onRecarregar={recarregar} onToast={showToast} />
                      : activeResource.name === 'atividades'
                        ? (row, { recarregar }) => {
                            const pendente = !Number(row.concluida);
                            // Menu "...": Concluir (pendente), Conversa do Bot; Editar e Excluir vêm depois
                            return (
                              <>
                                {pendente && <AcaoConcluir registro={row} onFeito={() => (showToast('Atividade concluída.'), recarregar())} />}
                                {Number(row.executor_bot) === 1 && <AcaoConversaBot atividadeId={row.id as string} />}
                              </>
                            );
                          }
                        : undefined
            }
            acoesDetalhe={(recurso, row) =>
              recurso === 'pessoas_contatos' ? (
                <BotaoWhatsApp temNumero={Boolean(row.whatsapp || row.celular || row.telefone)} onAbrir={() => pedirConversa({ contatoId: row.id as string })} />
              ) : null
            }
          />
        </main>
      ) : (
        <main className="flex-1 overflow-y-auto min-h-0 w-full">
          <div className="px-4 sm:px-6 lg:px-8 py-6">
            {activeTab === 'dashboard' ? (
              <Dashboard data={dashboard} isLoading={isDashboardLoading} error={dashboardError} onNavigate={navegar} />
            ) : (
              <div className="py-24 text-center text-sm text-stone-500 dark:text-stone-400">Carregando a estrutura da tela…</div>
            )}
          </div>
        </main>
      )
    );
  };

  return (
    <div className="h-screen overflow-hidden bg-stone-100/70 dark:bg-stone-950 text-stone-900 dark:text-stone-100 flex font-sans antialiased selection:bg-blue-600 selection:text-white">
      {conversaBotId && <ConversaBot atividadeId={conversaBotId} onFechar={() => setConversaBotId(null)} />}
      {toastMessage && (
        <div className="fixed bottom-5 right-5 z-[70] bg-stone-900 text-white text-xs font-semibold py-3 px-4 rounded-xl shadow-2xl border border-stone-800 flex items-center gap-2.5">
          <span className="w-2 h-2 rounded-full bg-emerald-400" />
          <span>{toastMessage}</span>
        </div>
      )}

      <Sidebar
        // Disparos é aba MDI de Campanhas (fora do menu): Campanhas continua marcada e volta para ela
        activeTab={activeTab === 'campanha_disparos' ? 'campanhas' : activeTab}
        setActiveTab={navegar}
        resources={resources}
        recordCounts={recordCounts}
        naoVistas={naoVistas}
        usuario={usuario}
        onLogout={() => {
          handleLogout();
          // Aberto pelo Master: fecha a aba do módulo lá em vez de ficar no login
          fecharNoMaster();
        }}
        isOpenMobile={isMobileSidebarOpen}
        onCloseMobile={() => setIsMobileSidebarOpen(false)}
        favoritos={favoritos}
        onAlternarFavorito={alternarFavorito}
      />

      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <Header
          empresaNome={sessao.empresa.nome}
          title={headerTitle}
          subtitle={headerSubtitle}
          onOpenMobileSidebar={() => setIsMobileSidebarOpen(true)}
          onRefresh={() => setRefreshToken((t) => t + 1)}
          sino={<NotificacoesSino onAbrir={abrirNotificacao} />}
          favoritos={itensFavoritos}
          onAbrirFavorito={navegar}
          activeTab={activeTab}
        />

        {telasMontadas.map((t) => (
          <div key={t} className={t === activeTab ? 'flex-1 flex flex-col min-h-0 min-w-0' : 'hidden'}>
            {conteudoTela(t)}
          </div>
        ))}
      </div>
    </div>
  );
}
