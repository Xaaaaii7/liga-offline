/***
 * Banner de Contexto de Competición
 * Muestra un banner visual cuando el usuario está dentro de una competición
 */

import { getCurrentPageName, getPageZone } from './navigation-zones.js';
import { getCurrentCompetition } from './competitions.js';
import { escapeHtml } from './utils.js';

/**
 * Renderiza el banner de contexto de competición
 * Solo se muestra en páginas de zona COMPETITION
 */
export async function renderCompetitionContextBanner() {
  const zone = getPageZone(getCurrentPageName());
  
  // Solo mostrar en zonas que requieren competición
  if (!zone.requiresComp) {
    console.log('[Context Banner] Not in competition zone, skipping banner');
    return;
  }
  
  try {
    const competition = await getCurrentCompetition();
    if (!competition) {
      console.warn('[Context Banner] No competition found, skipping banner');
      return;
    }
    
    // Verificar si ya existe el banner
    const existingBanner = document.getElementById('competition-context-banner');
    if (existingBanner) {
      existingBanner.remove();
    }
    
    // Crear el banner
    const banner = document.createElement('div');
    banner.id = 'competition-context-banner';
    banner.className = 'competition-context-banner';
    banner.setAttribute('role', 'banner');
    banner.setAttribute('aria-label', `Navegando en ${competition.name}`);
    
    const icon = competition.is_official ? '🏆' : '⚽';
    
    banner.innerHTML = `
      <div class="banner-content">
        <span class="banner-icon" aria-hidden="true">${icon}</span>
        <span class="banner-text">
          Navegando en: <strong>${escapeHtml(competition.name)}</strong>
        </span>
        <a href="competitions.html" 
           class="banner-exit" 
           title="Salir del contexto de competición">
          Salir
        </a>
      </div>
    `;
    
    // Insertar al inicio del body
    document.body.insertBefore(banner, document.body.firstChild);
    
    console.log('[Context Banner] Banner rendered for:', competition.name);
    
    // Ajustar el padding del body para compensar el banner
    adjustBodyPadding();
    
  } catch (error) {
    console.error('[Context Banner] Error rendering banner:', error);
  }
}

/**
 * Ajusta el padding del body para compensar el banner sticky
 */
function adjustBodyPadding() {
  const banner = document.getElementById('competition-context-banner');
  if (banner) {
    const bannerHeight = banner.offsetHeight;
    document.body.style.paddingTop = `${bannerHeight}px`;
  }
}

/**
 * Elimina el banner de contexto
 */
export function removeCompetitionContextBanner() {
  const banner = document.getElementById('competition-context-banner');
  if (banner) {
    banner.remove();
    document.body.style.paddingTop = '';
    console.log('[Context Banner] Banner removed');
  }
}

/**
 * Actualiza el banner con nueva información de competición
 */
export async function updateCompetitionContextBanner() {
  removeCompetitionContextBanner();
  await renderCompetitionContextBanner();
}

