/**
 * Script de precarga de tema
 * Se ejecuta ANTES de renderizar la página para evitar el flash de contenido sin estilo
 * Debe incluirse en el <head> de forma sincrónica (sin defer/async)
 */

(function() {
  // Obtener slug de la competición desde la URL
  function getCompetitionSlugFromURL() {
    const params = new URLSearchParams(window.location.search);
    return params.get('comp');
  }

  // Obtener ID de competición desde localStorage (último visitado)
  function getLastVisitedCompetitionId() {
    try {
      const lastComp = localStorage.getItem('last_competition_id');
      return lastComp ? parseInt(lastComp, 10) : null;
    } catch (e) {
      return null;
    }
  }

  // Obtener tema desde caché
  function getCachedTheme(competitionId) {
    try {
      const THEME_CACHE_KEY = 'competition_theme_cache';
      const cached = localStorage.getItem(THEME_CACHE_KEY);
      if (!cached) return null;
      
      const parsed = JSON.parse(cached);
      const themeData = parsed[competitionId];
      
      if (!themeData) return null;
      
      // Verificar si expiró (24 horas)
      const THEME_CACHE_EXPIRY = 1000 * 60 * 60 * 24;
      const age = Date.now() - themeData.timestamp;
      if (age > THEME_CACHE_EXPIRY) {
        return null;
      }
      
      return themeData;
    } catch (error) {
      return null;
    }
  }

  // Aplicar tema inmediatamente
  function applyThemeImmediate(colors) {
    const root = document.documentElement;
    
    const cssVariables = {
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
    
    Object.entries(colors).forEach(([key, value]) => {
      const cssVar = cssVariables[key];
      if (cssVar && value) {
        root.style.setProperty(cssVar, value);
      }
    });
  }

  // Intentar aplicar tema desde caché
  try {
    // Prioridad 1: Competición específica en la URL
    const slug = getCompetitionSlugFromURL();
    
    if (slug) {
      // Intentar obtener ID desde el slug (necesitaríamos un mapeo en localStorage)
      // Por ahora, usar el último ID visitado si coincide
      const lastId = getLastVisitedCompetitionId();
      if (lastId) {
        const theme = getCachedTheme(lastId);
        if (theme && theme.colors) {
          applyThemeImmediate(theme.colors);
          document.body.setAttribute('data-theme', theme.presetName || 'default');
          document.body.classList.add('themed-competition');
        }
      }
    } else {
      // Sin competición específica, intentar usar la última visitada
      const lastId = getLastVisitedCompetitionId();
      if (lastId) {
        const theme = getCachedTheme(lastId);
        if (theme && theme.colors) {
          applyThemeImmediate(theme.colors);
          document.body.setAttribute('data-theme', theme.presetName || 'default');
          document.body.classList.add('themed-competition');
        }
      }
    }
  } catch (error) {
    // Silenciosamente fallar y usar tema por defecto
    console.debug('No se pudo precargar tema:', error);
  }
})();

























