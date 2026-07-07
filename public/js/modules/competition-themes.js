/**
 * Módulo de temas para competiciones
 * Gestiona los temas predefinidos y permite personalización de colores
 */

// =====================================================
// Temas predefinidos
// =====================================================

export const COMPETITION_THEMES = {
  default: {
    name: 'Por Defecto',
    description: 'Tema estándar de la liga',
    colors: {
      primary: '#1fbf4a',
      secondary: '#1aa03a', 
      accent: '#1fbf4a',
      bg: '#050812',
      bgElevated: '#101522',
      card: '#151a22',
      border: '#202735',
      text: '#e8eef9',
      muted: '#9fb3c8',
      accentSoft: 'rgba(31, 191, 74, 0.15)'
    }
  },
  christmas: {
    name: 'Navidad',
    description: 'Tema festivo navideño',
    colors: {
      primary: '#d42f2f',      // Rojo navideño más brillante
      secondary: '#146b3a',     // Verde pino más intenso
      accent: '#ffd700',        // Dorado brillante (estrella)
      bg: '#0f1c18',           // Fondo verde oscuro navideño
      bgElevated: '#1a2e26',   // Verde oscuro elevado
      card: '#234d3f',         // Verde medio para cards
      border: '#3d7a5e',       // Verde claro para bordes
      text: '#fff5e6',         // Blanco cálido (nieve)
      muted: '#b8d4c8',        // Verde claro suave
      accentSoft: 'rgba(212, 47, 47, 0.18)'
    }
  },
  halloween: {
    name: 'Halloween',
    description: 'Tema oscuro y terrorífico',
    colors: {
      primary: '#ff6b1a',
      secondary: '#1a1a1a',
      accent: '#ff4500',
      bg: '#0d0a08',
      bgElevated: '#1a1512',
      card: '#221e1a',
      border: '#3a3530',
      text: '#f5e6d3',
      muted: '#b39a82',
      accentSoft: 'rgba(255, 107, 26, 0.15)'
    }
  }
};

// =====================================================
// Funciones principales
// =====================================================

/**
 * Obtiene la configuración de un tema predefinido
 * @param {string} presetName - Nombre del tema ('default', 'christmas', 'halloween')
 * @returns {Object} Configuración del tema
 */
export function getTheme(presetName = 'default') {
  const theme = COMPETITION_THEMES[presetName];
  
  if (!theme) {
    console.warn(`Tema "${presetName}" no encontrado, usando tema por defecto`);
    return COMPETITION_THEMES.default;
  }
  
  return theme;
}

/**
 * Mezcla los colores de un tema predefinido con personalizaciones
 * @param {Object} baseColors - Colores base del tema predefinido
 * @param {Object} customColors - Colores personalizados {primary, secondary, accent}
 * @returns {Object} Colores mezclados
 */
export function mergeThemeColors(baseColors, customColors) {
  if (!customColors) {
    return baseColors;
  }
  
  const merged = { ...baseColors };
  
  // Aplicar personalizaciones solo para primary, secondary, accent
  if (customColors.primary) {
    merged.primary = customColors.primary;
  }
  
  if (customColors.secondary) {
    merged.secondary = customColors.secondary;
  }
  
  if (customColors.accent) {
    merged.accent = customColors.accent;
    // Actualizar también accentSoft con transparencia
    merged.accentSoft = hexToRgba(customColors.accent, 0.15);
  }
  
  return merged;
}

/**
 * Aplica un tema al DOM modificando las variables CSS
 * @param {Object} colors - Objeto con los colores del tema
 */
export function applyTheme(colors) {
  const root = document.documentElement;
  
  // Mapeo de camelCase a kebab-case para variables CSS
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
  
  // Aplicar cada color como variable CSS
  Object.entries(colors).forEach(([key, value]) => {
    const cssVar = cssVariables[key];
    if (cssVar) {
      root.style.setProperty(cssVar, value);
    }
  });
}

/**
 * Obtiene los colores actuales del tema aplicado
 * @returns {Object} Colores actuales
 */
export function getCurrentThemeColors() {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  
  return {
    primary: style.getPropertyValue('--accent').trim(),
    secondary: style.getPropertyValue('--accent-hover').trim(),
    accent: style.getPropertyValue('--accent').trim(),
    bg: style.getPropertyValue('--bg').trim(),
    bgElevated: style.getPropertyValue('--bg-elevated').trim(),
    card: style.getPropertyValue('--card').trim(),
    border: style.getPropertyValue('--border-subtle').trim(),
    text: style.getPropertyValue('--text').trim(),
    muted: style.getPropertyValue('--muted').trim(),
    accentSoft: style.getPropertyValue('--accent-soft').trim()
  };
}

/**
 * Restaura el tema por defecto
 */
export function resetTheme() {
  applyTheme(COMPETITION_THEMES.default.colors);
}

/**
 * Obtiene la lista de todos los temas disponibles
 * @returns {Array} Array de objetos {id, name, description}
 */
export function getAvailableThemes() {
  return Object.entries(COMPETITION_THEMES).map(([id, theme]) => ({
    id,
    name: theme.name,
    description: theme.description
  }));
}

/**
 * Valida que un objeto de colores personalizados tenga el formato correcto
 * @param {Object} colors - Colores a validar
 * @returns {boolean} true si es válido
 */
export function validateCustomColors(colors) {
  if (!colors || typeof colors !== 'object') {
    return false;
  }
  
  // Solo permitir primary, secondary, accent
  const allowedKeys = ['primary', 'secondary', 'accent'];
  const keys = Object.keys(colors);
  
  if (keys.length === 0) {
    return false;
  }
  
  // Verificar que todas las claves sean permitidas
  if (!keys.every(key => allowedKeys.includes(key))) {
    return false;
  }
  
  // Verificar que todos los valores sean strings con formato hexadecimal
  return Object.values(colors).every(value => 
    typeof value === 'string' && /^#[0-9A-Fa-f]{6}$/.test(value)
  );
}

// =====================================================
// Funciones auxiliares
// =====================================================

/**
 * Convierte camelCase a kebab-case
 * @param {string} str - String en camelCase
 * @returns {string} String en kebab-case
 */
function camelToKebab(str) {
  return str.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * Convierte color hexadecimal a rgba con transparencia
 * @param {string} hex - Color en formato #RRGGBB
 * @param {number} alpha - Valor de transparencia (0-1)
 * @returns {string} Color en formato rgba()
 */
function hexToRgba(hex, alpha = 1) {
  // Eliminar el # si está presente
  hex = hex.replace('#', '');
  
  // Convertir a RGB
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Genera un tema de vista previa con los colores especificados
 * @param {string} presetName - Nombre del preset
 * @param {Object} customColors - Colores personalizados (opcional)
 * @returns {Object} Objeto con información de vista previa
 */
export function generateThemePreview(presetName, customColors = null) {
  const theme = getTheme(presetName);
  const finalColors = mergeThemeColors(theme.colors, customColors);
  
  return {
    name: theme.name,
    description: theme.description,
    colors: finalColors,
    swatches: [
      { name: 'Primario', color: finalColors.primary },
      { name: 'Secundario', color: finalColors.secondary },
      { name: 'Acento', color: finalColors.accent }
    ]
  };
}

