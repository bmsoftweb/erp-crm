import './utils/origemMaster'; // antes das telas: guarda a sessão vinda do Master (?master=1#sessao=…)
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import { AceiteProposta } from './components/AceiteProposta';
import './index.css';
import { instalarSelecaoAoFocar } from './utils/selecaoAoFocar';

instalarSelecaoAoFocar();

// Link público de aceite da proposta (/p/<token>): tela própria, sem login
const aceite = /^\/p\/([A-Za-z0-9_-]+)\/?$/.exec(window.location.pathname);

// CRM como PWA (instalável): manifesto e service worker só no CRM em si (não no link de aceite).
// No modo dev o service worker atrapalharia o Vite
if (!aceite) {
  document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'manifest', href: '/manifest.webmanifest' }));
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((e) => console.warn('Service worker:', e));
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>{aceite ? <AceiteProposta token={aceite[1]} /> : <App />}</StrictMode>,
);
