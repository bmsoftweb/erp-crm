import { salvarSessao, type Sessao } from './session';
import { CHAVE_TEMA } from './theme';

/**
 * CRM aberto pelo BM-Master (entrada automática: /api/entrar → /?master=1&tema=…#sessao=…), como no erp-estoque.
 * Roda antes das telas (import no topo do main.tsx): guarda a sessão que veio depois do "#" (só nesta aba), aplica o
 * tema do Master e limpa o endereço. Ao Sair, fecha a aba do Master em vez de ir para o login (fecharNoMaster).
 */
const CHAVE = 'bm_origem_master';

try {
  const url = new URL(window.location.href);
  if (url.searchParams.get('master') === '1') {
    sessionStorage.setItem(CHAVE, '1');
    const tema = url.searchParams.get('tema');
    if (tema === 'light' || tema === 'dark') localStorage.setItem(CHAVE_TEMA, tema);
    const sessao = /^#sessao=([A-Za-z0-9_-]+)$/.exec(url.hash)?.[1];
    if (sessao) {
      const bytes = Uint8Array.from(atob(sessao.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
      salvarSessao(JSON.parse(new TextDecoder().decode(bytes)) as Sessao, false);
    }
    url.searchParams.delete('master');
    url.searchParams.delete('tema');
    window.history.replaceState(window.history.state, '', url.pathname + url.search);
  }
} catch {
  // sem storage ou sessão inválida: segue para o login
}

/**
 * Depois do logout: dentro do Master (iframe) pede para ele fechar a aba; numa aba do navegador aberta pelo Master,
 * fecha a aba. Devolve false quando o CRM não veio do Master (segue para o login).
 */
export function fecharNoMaster(): boolean {
  try {
    if (sessionStorage.getItem(CHAVE) !== '1') return false;
  } catch {
    return false;
  }
  if (window.parent !== window) {
    window.parent.postMessage({ tipo: 'bm:fechar-modulo' }, '*'); // sem dado sigiloso: só o pedido de fechar
    return true;
  }
  if (window.opener) window.close();
  return false;
}
