/**
 * Módulo para cargar y aplicar temas de competiciones dinámicamente
 * Se encarga de obtener el tema de una competición y aplicarlo a la página actual
 */

import { getCompetitionById } from './competition-data.js';
import { getTheme, applyTheme, mergeThemeColors } from './competition-themes.js';

// =====================================================
// Estado global
// =====================================================

let currentCompetitionTheme = null;
let defaultThemeBackup = null;

// Clave para localStorage
const THEME_CACHE_KEY = 'competition_theme_cache';
const THEME_CACHE_EXPIRY = 1000 * 60 * 60 * 24; // 24 horas

// =====================================================
// Funciones principales
// =====================================================

/**
 * Carga y aplica el tema de una competición
 * @param {number|string} competitionId - ID de la competición
 * @param {boolean} skipCache - Si es true, no usar caché (para forzar actualización)
 * @returns {Promise<boolean>} true si se aplicó correctamente
 */
export async function loadCompetitionTheme(competitionId, skipCache = false) {
  try {
    if (!competitionId) {
      console.warn('No se proporcionó competitionId, usando tema por defecto');
      return false;
    }

    // Guardar tema por defecto la primera vez
    if (!defaultThemeBackup) {
      defaultThemeBackup = getDefaultThemeColors();
    }

    // Intentar cargar desde caché si no se debe saltar
    if (!skipCache) {
      const cached = getCachedTheme(competitionId);
      if (cached) {
        applyTheme(cached.colors);
        if (cached.logoUrl) {
          updateCompetitionLogo(cached.logoUrl);
        }
        document.body.classList.add('themed-competition');
        document.body.setAttribute('data-theme', cached.presetName);
        
        currentCompetitionTheme = cached;
        
        // Actualizar en background sin bloquear
        updateThemeInBackground(competitionId);
        return true;
      }
    }

    // Obtener datos de la competición
    const competition = await getCompetitionById(competitionId);
    
    if (!competition) {
      console.warn(`No se encontró competición con ID ${competitionId}`);
      return false;
    }

    // Obtener tema base (preset)
    const presetName = competition.theme_preset || 'default';
    const baseTheme = getTheme(presetName);
    let themeColors = baseTheme.colors;

    // Mezclar con colores personalizados si existen
    if (competition.theme_colors) {
      themeColors = mergeThemeColors(themeColors, competition.theme_colors);
    }

    // Aplicar tema
    applyTheme(themeColors);

    // Actualizar logo si existe
    if (competition.logo_url) {
      updateCompetitionLogo(competition.logo_url);
    }

    // Guardar tema actual
    currentCompetitionTheme = {
      competitionId,
      presetName,
      colors: themeColors,
      logoUrl: competition.logo_url
    };

    // Guardar en caché
    saveThemeToCache(competitionId, currentCompetitionTheme);

    // Guardar como última competición visitada
    try {
      localStorage.setItem('last_competition_id', competitionId.toString());
    } catch (e) {
      console.warn('No se pudo guardar último ID de competición:', e);
    }

    // Añadir clase al body para posible customización CSS adicional
    document.body.classList.add('themed-competition');
    document.body.setAttribute('data-theme', presetName);

    return true;

  } catch (error) {
    console.error('Error cargando tema de competición:', error);
    return false;
  }
}

/**
 * Actualiza el logo del header con el logo de la competición
 * @param {string} logoUrl - URL del logo
 */
export function updateCompetitionLogo(logoUrl) {
  if (!logoUrl) return;

  const logoImg = document.querySelector('.site-header .logo');
  
  if (logoImg) {
    // Guardar logo original si no lo hemos hecho
    if (!logoImg.dataset.originalSrc) {
      logoImg.dataset.originalSrc = logoImg.src;
    }
    
    // Actualizar src del logo
    logoImg.src = logoUrl;
    logoImg.alt = 'Logo de la competición';
    
    // Añadir clase para posible estilo específico
    logoImg.classList.add('competition-logo');
  }
}

/**
 * Restaura el logo original del header
 */
export function restoreOriginalLogo() {
  const logoImg = document.querySelector('.site-header .logo');
  
  if (logoImg && logoImg.dataset.originalSrc) {
    logoImg.src = logoImg.dataset.originalSrc;
    logoImg.alt = 'Logo Torneo';
    logoImg.classList.remove('competition-logo');
  }
}

/**
 * Restaura el tema por defecto de la aplicación
 */
export function restoreDefaultTheme() {
  if (defaultThemeBackup) {
    const root = document.documentElement;
    
    Object.entries(defaultThemeBackup).forEach(([key, value]) => {
      root.style.setProperty(key, value);
    });
  }

  // Restaurar logo original
  restoreOriginalLogo();

  // Eliminar clases del body
  document.body.classList.remove('themed-competition');
  document.body.removeAttribute('data-theme');

  currentCompetitionTheme = null;
}

/**
 * Obtiene el tema actual aplicado
 * @returns {Object|null} Información del tema actual o null
 */
export function getCurrentTheme() {
  return currentCompetitionTheme;
}

/**
 * Verifica si hay un tema personalizado aplicado
 * @returns {boolean}
 */
export function hasCustomThemeApplied() {
  return currentCompetitionTheme !== null;
}

/**
 * Pre-carga el tema de una competición sin aplicarlo
 * Útil para vistas previas
 * @param {number|string} competitionId - ID de la competición
 * @returns {Promise<Object|null>} Datos del tema o null
 */
export async function preloadCompetitionTheme(competitionId) {
  try {
    const competition = await getCompetitionById(competitionId);
    
    if (!competition) {
      return null;
    }

    const presetName = competition.theme_preset || 'default';
    const baseTheme = getTheme(presetName);
    let themeColors = baseTheme.colors;

    if (competition.theme_colors) {
      themeColors = mergeThemeColors(themeColors, competition.theme_colors);
    }

    return {
      competitionId,
      presetName,
      themeName: baseTheme.name,
      colors: themeColors,
      logoUrl: competition.logo_url,
      hasCustomColors: !!competition.theme_colors
    };

  } catch (error) {
    console.error('Error precargando tema:', error);
    return null;
  }
}

/**
 * Aplica un tema temporalmente para vista previa
 * @param {string} presetName - Nombre del preset
 * @param {Object} customColors - Colores personalizados (opcional)
 */
export function applyThemePreview(presetName, customColors = null) {
  // Guardar tema actual si no lo hemos hecho
  if (!defaultThemeBackup) {
    defaultThemeBackup = getDefaultThemeColors();
  }

  const baseTheme = getTheme(presetName);
  const themeColors = mergeThemeColors(baseTheme.colors, customColors);

  applyTheme(themeColors);

  // Añadir atributo de preview
  document.body.setAttribute('data-theme-preview', presetName);
}

/**
 * Cancela la vista previa y restaura el tema anterior
 */
export function cancelThemePreview() {
  document.body.removeAttribute('data-theme-preview');

  if (currentCompetitionTheme) {
    // Restaurar tema de la competición
    applyTheme(currentCompetitionTheme.colors);
  } else {
    // Restaurar tema por defecto
    restoreDefaultTheme();
  }
}

// =====================================================
// Funciones de caché
// =====================================================

/**
 * Guarda el tema en localStorage
 * @param {number} competitionId - ID de la competición
 * @param {Object} themeData - Datos del tema
 */
function saveThemeToCache(competitionId, themeData) {
  try {
    const cache = {
      [competitionId]: {
        ...themeData,
        timestamp: Date.now()
      }
    };
    
    // Obtener caché existente y agregar/actualizar
    const existing = localStorage.getItem(THEME_CACHE_KEY);
    if (existing) {
      const parsed = JSON.parse(existing);
      cache[competitionId] = {
        ...themeData,
        timestamp: Date.now()
      };
      Object.assign(parsed, cache);
      localStorage.setItem(THEME_CACHE_KEY, JSON.stringify(parsed));
    } else {
      localStorage.setItem(THEME_CACHE_KEY, JSON.stringify(cache));
    }
  } catch (error) {
    console.warn('Error guardando tema en caché:', error);
  }
}

/**
 * Obtiene el tema desde localStorage
 * @param {number} competitionId - ID de la competición
 * @returns {Object|null} Datos del tema o null si no existe o expiró
 */
function getCachedTheme(competitionId) {
  try {
    const cached = localStorage.getItem(THEME_CACHE_KEY);
    if (!cached) return null;
    
    const parsed = JSON.parse(cached);
    const themeData = parsed[competitionId];
    
    if (!themeData) return null;
    
    // Verificar si expiró
    const age = Date.now() - themeData.timestamp;
    if (age > THEME_CACHE_EXPIRY) {
      // Expiró, eliminar del caché
      delete parsed[competitionId];
      localStorage.setItem(THEME_CACHE_KEY, JSON.stringify(parsed));
      return null;
    }
    
    return themeData;
  } catch (error) {
    console.warn('Error obteniendo tema desde caché:', error);
    return null;
  }
}

/**
 * Limpia el caché de temas
 * @param {number} competitionId - ID específico o null para limpiar todo
 */
export function clearThemeCache(competitionId = null) {
  try {
    if (competitionId === null) {
      localStorage.removeItem(THEME_CACHE_KEY);
    } else {
      const cached = localStorage.getItem(THEME_CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        delete parsed[competitionId];
        localStorage.setItem(THEME_CACHE_KEY, JSON.stringify(parsed));
      }
    }
  } catch (error) {
    console.warn('Error limpiando caché:', error);
  }
}

/**
 * Actualiza el tema en background sin bloquear la UI
 * @param {number} competitionId - ID de la competición
 */
async function updateThemeInBackground(competitionId) {
  try {
    const competition = await getCompetitionById(competitionId);
    if (!competition) return;
    
    const presetName = competition.theme_preset || 'default';
    const baseTheme = getTheme(presetName);
    let themeColors = baseTheme.colors;
    
    if (competition.theme_colors) {
      themeColors = mergeThemeColors(themeColors, competition.theme_colors);
    }
    
    const newTheme = {
      competitionId,
      presetName,
      colors: themeColors,
      logoUrl: competition.logo_url
    };
    
    // Verificar si cambió
    const cached = getCachedTheme(competitionId);
    if (cached && JSON.stringify(cached.colors) === JSON.stringify(themeColors) && 
        cached.logoUrl === competition.logo_url) {
      // No cambió, solo actualizar timestamp
      saveThemeToCache(competitionId, newTheme);
      return;
    }
    
    // Cambió, aplicar nuevos estilos
    applyTheme(themeColors);
    if (competition.logo_url) {
      updateCompetitionLogo(competition.logo_url);
    }
    saveThemeToCache(competitionId, newTheme);
    currentCompetitionTheme = newTheme;
    
  } catch (error) {
    console.warn('Error actualizando tema en background:', error);
  }
}

// =====================================================
// Funciones auxiliares
// =====================================================

/**
 * Obtiene los colores actuales del tema desde las variables CSS
 * @returns {Object} Objeto con las variables CSS y sus valores
 */
function getDefaultThemeColors() {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  
  const variables = [
    '--bg',
    '--bg-elevated',
    '--card',
    '--border-subtle',
    '--text',
    '--muted',
    '--accent',
    '--accent-soft',
    '--accent-hover'
  ];

  const colors = {};
  variables.forEach(varName => {
    colors[varName] = style.getPropertyValue(varName).trim();
  });

  return colors;
}

/**
 * Genera CSS inline para un tema (útil para emails o exportación)
 * @param {Object} themeColors - Colores del tema
 * @returns {string} String con declaraciones CSS
 */
export function generateInlineThemeCSS(themeColors) {
  const cssVars = [];
  
  const mapping = {
    primary: '--accent',
    secondary: '--accent-hover',
    accent: '--accent',
    bg: '--bg',
    bgElevated: '--bg-elevated',
    card: '--card',
    border: '--border-subtle',
    text: '--text',
    muted: '--muted',
    accentSoft: '--accent-soft'
  };

  Object.entries(themeColors).forEach(([key, value]) => {
    const cssVar = mapping[key];
    if (cssVar) {
      cssVars.push(`${cssVar}: ${value}`);
    }
  });

  return cssVars.join('; ');
}

/**
 * Verifica si el navegador soporta variables CSS personalizadas
 * @returns {boolean}
 */
export function supportsCSSVariables() {
  return window.CSS && window.CSS.supports && window.CSS.supports('--test', '0');
}

/**
 * Hook para ejecutar código cuando cambia el tema
 * @param {Function} callback - Función a ejecutar cuando cambie el tema
 * @returns {Function} Función para desuscribirse
 */
let themeChangeCallbacks = [];

export function onThemeChange(callback) {
  if (typeof callback === 'function') {
    themeChangeCallbacks.push(callback);
  }

  // Retornar función para desuscribirse
  return () => {
    themeChangeCallbacks = themeChangeCallbacks.filter(cb => cb !== callback);
  };
}

/**
 * Notifica a todos los listeners que el tema ha cambiado
 * @param {Object} themeData - Datos del nuevo tema
 */
function notifyThemeChange(themeData) {
  themeChangeCallbacks.forEach(callback => {
    try {
      callback(themeData);
    } catch (error) {
      console.error('Error en callback de cambio de tema:', error);
    }
  });
}

// Modificar loadCompetitionTheme para notificar cambios
const originalLoadCompetitionTheme = loadCompetitionTheme;
export { originalLoadCompetitionTheme };

// Sobrescribir para añadir notificación
export async function loadCompetitionThemeWithNotification(competitionId) {
  const result = await loadCompetitionTheme(competitionId);
  
  if (result && currentCompetitionTheme) {
    notifyThemeChange(currentCompetitionTheme);
  }
  
  return result;
}

// =====================================================
// Inicialización automática
// =====================================================

/**
 * Intenta cargar el tema automáticamente desde el contexto de la URL
 * Busca parámetros como ?comp=slug o data attributes
 */
export async function autoloadThemeFromContext() {
  try {
    // Intentar obtener del parámetro URL
    const urlParams = new URLSearchParams(window.location.search);
    const compSlug = urlParams.get('comp');
    
    if (compSlug) {
      // Si hay slug, intentar obtener la competición
      const { getCurrentCompetitionId } = await import('./competitions.js');
      const competitionId = await getCurrentCompetitionId();
      
      if (competitionId) {
        await loadCompetitionTheme(competitionId);
        return true;
      }
    }

    // Intentar obtener del data attribute del body
    const bodyCompId = document.body.getAttribute('data-competition-id');
    if (bodyCompId) {
      await loadCompetitionTheme(bodyCompId);
      return true;
    }

    return false;

  } catch (error) {
    console.warn('Error en autoload de tema:', error);
    return false;
  }
}

