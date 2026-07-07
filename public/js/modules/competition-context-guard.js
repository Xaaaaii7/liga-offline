/**
 * Guardrail de Contexto de Competición
 * Valida automáticamente que las páginas tengan el contexto correcto
 */

import { getCompetitionFromURL, redirectTo } from './competition-context.js';
import { getCurrentPageName, getPageZone } from './navigation-zones.js';

/**
 * Valida que la página actual tenga el contexto de competición correcto
 * @returns {Promise<boolean>} true si el contexto es válido, false si se redirigió
 */
export async function validateCompetitionContext() {
  const currentPage = getCurrentPageName();
  const zone = getPageZone(currentPage);
  const compSlug = getCompetitionFromURL();
  
  console.log('[Context Guard] Validating:', { page: currentPage, zone: zone.name, hasComp: !!compSlug });
  
  // Si la página requiere competición pero no tiene el parámetro
  if (zone.requiresComp && !compSlug) {
    console.warn('[Context Guard] Page requires competition context but none found. Redirecting...');
    await redirectToCompetitionSelection(currentPage);
    return false;
  }
  
  // Si la página NO permite competición pero tiene el parámetro
  if (!zone.allowComp && compSlug) {
    console.warn('[Context Guard] Page does not allow competition context. Cleaning URL...');
    removeCompetitionFromURL();
    return true;
  }
  
  console.log('[Context Guard] Context is valid');
  return true;
}

/**
 * Redirige al usuario a la página de selección de competición
 * Guarda la página de destino para volver después
 * @param {string} returnPage - Página a la que volver después de seleccionar
 */
async function redirectToCompetitionSelection(returnPage) {
  // Guardar la página de destino en sessionStorage
  sessionStorage.setItem('competition_return_page', returnPage);
  
  // Mostrar mensaje al usuario
  const message = document.createElement('div');
  message.className = 'context-guard-message';
  message.innerHTML = `
    <div style="
      position: fixed;
      top: 50%;
      left: 50%;
      transform: translate(-50%, -50%);
      background: white;
      padding: 2rem;
      border-radius: 8px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.3);
      z-index: 10000;
      text-align: center;
      max-width: 400px;
    ">
      <h3 style="margin: 0 0 1rem 0; color: var(--primary);">
        Selecciona una Competición
      </h3>
      <p style="margin: 0 0 1.5rem 0; color: var(--text);">
        Esta página requiere que selecciones una competición primero.
      </p>
      <p style="margin: 0; font-size: 0.875rem; color: var(--muted);">
        Redirigiendo a la lista de competiciones...
      </p>
    </div>
    <div style="
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.5);
      z-index: 9999;
    "></div>
  `;
  
  document.body.appendChild(message);
  
  // Redirigir después de un breve delay
  setTimeout(() => {
    redirectTo('competitions.html');
  }, 1500);
}

/**
 * Elimina el parámetro comp de la URL sin recargar
 */
function removeCompetitionFromURL() {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.has('comp')) {
    urlParams.delete('comp');
    const newUrl = window.location.pathname + (urlParams.toString() ? '?' + urlParams.toString() : '');
    window.history.replaceState({}, '', newUrl);
    console.log('[Context Guard] Removed comp parameter from URL');
  }
}

/**
 * Verifica si hay una página de retorno guardada y construye la URL
 * Útil después de seleccionar una competición
 * @param {string} competitionSlug - Slug de la competición seleccionada
 * @returns {string|null} URL de retorno o null
 */
export function getReturnURL(competitionSlug) {
  const returnPage = sessionStorage.getItem('competition_return_page');
  if (!returnPage) return null;
  
  // Limpiar el storage
  sessionStorage.removeItem('competition_return_page');
  
  // Construir URL con el contexto
  const url = new URL(returnPage, window.location.origin);
  url.searchParams.set('comp', competitionSlug);
  
  return url.pathname + url.search;
}

/**
 * Inicializa el guardrail de contexto
 * Debe ejecutarse al inicio de cada página
 */
export async function initContextGuard() {
  try {
    const isValid = await validateCompetitionContext();
    
    // Si es válido, verificar si hay una página de retorno
    if (isValid) {
      const compSlug = getCompetitionFromURL();
      if (compSlug) {
        const returnURL = getReturnURL(compSlug);
        if (returnURL && returnURL !== window.location.pathname + window.location.search) {
          console.log('[Context Guard] Returning to saved page:', returnURL);
          window.location.href = returnURL;
        }
      }
    }
    
    return isValid;
  } catch (error) {
    console.error('[Context Guard] Error validating context:', error);
    return true; // No bloquear en caso de error
  }
}

