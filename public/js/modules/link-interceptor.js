/**
 * Interceptor de Enlaces
 * Intercepta clicks en enlaces para validar y preservar el contexto de competición
 */

import { getCompetitionFromURL, buildURLWithCompetition, redirectTo } from './competition-context.js';
import { getCurrentPageName, getPageZone, extractPageName } from './navigation-zones.js';

/**
 * Verifica si un enlace es interno (mismo dominio)
 * @param {string} href - URL del enlace
 * @returns {boolean}
 */
function isInternalLink(href) {
  try {
    const url = new URL(href, window.location.origin);
    return url.origin === window.location.origin;
  } catch (e) {
    // Si es una URL relativa, es interna
    return !href.startsWith('http://') && !href.startsWith('https://') && !href.startsWith('//');
  }
}

/**
 * Muestra confirmación al usuario antes de salir del contexto
 * @param {string} competitionName - Nombre de la competición actual
 * @returns {boolean} true si el usuario confirma, false si cancela
 */
function showExitConfirmation(competitionName = 'la competición') {
  const confirmed = confirm(
    `¿Estás seguro de que quieres salir del contexto de ${competitionName}?\n\n` +
    'Perderás el contexto actual y volverás a la vista global.'
  );
  
  return confirmed;
}

/**
 * Configura el interceptor de enlaces
 * Debe ejecutarse después de que el DOM esté listo
 */
export function setupLinkInterceptor() {
  console.log('[Link Interceptor] Setting up link interceptor');
  
  document.addEventListener('click', async (e) => {
    // Buscar el enlace más cercano
    const link = e.target.closest('a[href]');
    
    // Si no es un enlace, ignorar
    if (!link) return;
    
    const href = link.getAttribute('href');
    
    // Ignorar enlaces vacíos, anchors, javascript:, mailto:, tel:, etc.
    if (!href || href === '#' || href.startsWith('#') || 
        href.startsWith('javascript:') || href.startsWith('mailto:') || 
        href.startsWith('tel:')) {
      return;
    }
    
    // Ignorar enlaces externos
    if (!isInternalLink(href)) {
      return;
    }
    
    // Ignorar si el enlace tiene data-no-intercept
    if (link.hasAttribute('data-no-intercept')) {
      return;
    }
    
    // Obtener información de zonas
    const currentPage = getCurrentPageName();
    const currentZone = getPageZone(currentPage);
    const targetPage = extractPageName(href);
    const targetZone = getPageZone(targetPage);
    
    console.log('[Link Interceptor] Click detected:', {
      from: currentPage,
      to: targetPage,
      fromZone: currentZone.name,
      toZone: targetZone.name
    });
    
    // Si salimos de una zona que requiere comp a una que no lo permite
    if (currentZone.requiresComp && !targetZone.allowComp) {
      // Obtener nombre de la competición para el mensaje
      let competitionName = 'la competición';
      try {
        const { getCurrentCompetition } = await import('./competitions.js');
        const competition = await getCurrentCompetition();
        if (competition) {
          competitionName = competition.name;
        }
      } catch (err) {
        console.debug('[Link Interceptor] Could not get competition name:', err);
      }
      
      // Pedir confirmación
      const confirmed = showExitConfirmation(competitionName);
      if (!confirmed) {
        e.preventDefault();
        console.log('[Link Interceptor] Navigation cancelled by user');
        return;
      }
      
      console.log('[Link Interceptor] User confirmed exit from competition context');
    }
    
    // Si vamos a una página que requiere comp
    if (targetZone.requiresComp) {
      const compSlug = getCompetitionFromURL();
      const linkHasComp = href.includes('comp=');
      
      // Si tenemos comp en la URL actual pero el enlace no lo tiene
      if (compSlug && !linkHasComp) {
        e.preventDefault();
        const correctedURL = buildURLWithCompetition(targetPage, compSlug);
        console.log('[Link Interceptor] Correcting URL to include comp:', correctedURL);
        window.location.href = correctedURL;
        return;
      }
      
      // Si no tenemos comp y el enlace tampoco, redirigir a selección
      if (!compSlug && !linkHasComp) {
        e.preventDefault();
        console.log('[Link Interceptor] No competition context, redirecting to selection');
        sessionStorage.setItem('competition_return_page', targetPage);
        redirectTo('competitions.html');
        return;
      }
    }
  });
  
  console.log('[Link Interceptor] Link interceptor active');
}

/**
 * Desactiva el interceptor de enlaces
 * Útil para testing o casos especiales
 */
export function disableLinkInterceptor() {
  // No hay forma directa de remover un listener sin referencia
  // Pero podemos marcar que está desactivado
  window.__linkInterceptorDisabled = true;
  console.log('[Link Interceptor] Link interceptor disabled');
}

/**
 * Reactiva el interceptor de enlaces
 */
export function enableLinkInterceptor() {
  window.__linkInterceptorDisabled = false;
  console.log('[Link Interceptor] Link interceptor enabled');
}

