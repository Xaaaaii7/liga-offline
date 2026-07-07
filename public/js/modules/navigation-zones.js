/**
 * Módulo de Zonas de Navegación
 * Define qué páginas pertenecen a cada zona y sus reglas de contexto de competición
 */

export const NAVIGATION_ZONES = {
  GLOBAL: {
    name: 'GLOBAL',
    pages: ['index.html', 'competitions.html', 'dashboard.html', 'login.html', 'register.html', 'reset-password.html', 'palmares.html', 'estadisticas-globales.html', 'jugadores-globales.html', 'pichichi-globales.html', 'noticias-globales.html', 'managers.html', 'manager.html', 'entidades.html', 'entidad.html', 'jugador.html', 'selecciones.html', 'seleccion.html', 'arbitros.html', 'arbitro.html', 'periodistas.html', 'periodista.html', 'comunicados.html'],
    requiresComp: false,
    allowComp: false,
    description: 'Páginas globales que no requieren contexto de competición'
  },
  COMPETITION: {
    name: 'COMPETITION',
    pages: [
      'liga.html',
      'clasificacion.html',
      'resultados.html',
      'partido.html',
      'jornada.html',
      'club.html',
      'pichichi.html',
      'clubs.html',
      'jugadores.html',
      'noticias.html',
      'reglas.html',
      'directos.html',
      'estadisticas.html',
      'competicion-palmares.html',
      'calculadora.html',
      'quiniela.html',
      'sorteo.html'
    ],
    requiresComp: true,
    allowComp: true,
    description: 'Páginas que requieren estar dentro de una competición'
  },
  ADMIN: {
    name: 'ADMIN',
    pages: [
      'manage-competition.html'
    ],
    requiresComp: true,
    allowComp: true,
    description: 'Páginas de administración que requieren slug ?comp= (mismo flujo que la zona pública)'
  },
  ADMIN_GLOBAL: {
    name: 'ADMIN_GLOBAL',
    pages: [
      'admin.html',
      'create-competition.html'
    ],
    requiresComp: false,
    allowComp: false,
    description: 'Páginas de administración global (sin contexto de competición fijo)'
  }
};

/**
 * Obtiene el nombre de la página actual
 * @returns {string} Nombre del archivo HTML actual
 */
export function getCurrentPageName() {
  const path = window.location.pathname;
  const fileName = path.split('/').pop() || 'index.html';
  return fileName.toLowerCase();
}

/**
 * Extrae el nombre de página desde una URL
 * @param {string} url - URL completa o relativa
 * @returns {string} Nombre del archivo
 */
export function extractPageName(url) {
  try {
    const urlObj = new URL(url, window.location.origin);
    const fileName = urlObj.pathname.split('/').pop() || 'index.html';
    return fileName.toLowerCase();
  } catch (e) {
    // Si falla el parsing, intentar extraer directamente
    const match = url.match(/([^\/\?#]+\.html)/i);
    return match ? match[1].toLowerCase() : 'index.html';
  }
}

/**
 * Obtiene la zona a la que pertenece una página
 * @param {string} pageName - Nombre de la página (ej: 'clasificacion.html')
 * @returns {Object|null} Objeto de zona o null si no se encuentra
 */
export function getPageZone(pageName) {
  if (!pageName) {
    pageName = getCurrentPageName();
  }

  pageName = pageName.toLowerCase();

  for (const [zoneName, zoneConfig] of Object.entries(NAVIGATION_ZONES)) {
    if (zoneConfig.pages.includes(pageName)) {
      return zoneConfig;
    }
  }

  // Si no se encuentra, asumir GLOBAL (más seguro)
  return NAVIGATION_ZONES.GLOBAL;
}

/**
 * Verifica si una página requiere contexto de competición
 * @param {string} pageName - Nombre de la página
 * @returns {boolean}
 */
export function pageRequiresCompetition(pageName) {
  const zone = getPageZone(pageName);
  return zone ? zone.requiresComp : false;
}

/**
 * Verifica si una página permite contexto de competición
 * @param {string} pageName - Nombre de la página
 * @returns {boolean}
 */
export function pageAllowsCompetition(pageName) {
  const zone = getPageZone(pageName);
  return zone ? zone.allowComp : false;
}

/**
 * Verifica si estamos en una página de zona de competición
 * @returns {boolean}
 */
export function isInCompetitionZone() {
  const zone = getPageZone(getCurrentPageName());
  return zone.name === 'COMPETITION' || zone.name === 'ADMIN';
}

/**
 * Verifica si estamos en una zona global
 * @returns {boolean}
 */
export function isInGlobalZone() {
  const zone = getPageZone(getCurrentPageName());
  return zone.name === 'GLOBAL' || zone.name === 'ADMIN_GLOBAL';
}

/**
 * Obtiene todas las páginas que requieren contexto de competición
 * @returns {string[]} Array de nombres de páginas
 */
export function getCompetitionPages() {
  const pages = [];
  for (const zone of Object.values(NAVIGATION_ZONES)) {
    if (zone.requiresComp) {
      pages.push(...zone.pages);
    }
  }
  return pages;
}

/**
 * Obtiene todas las páginas globales (sin contexto)
 * @returns {string[]} Array de nombres de páginas
 */
export function getGlobalPages() {
  const pages = [];
  for (const zone of Object.values(NAVIGATION_ZONES)) {
    if (!zone.allowComp) {
      pages.push(...zone.pages);
    }
  }
  return pages;
}

