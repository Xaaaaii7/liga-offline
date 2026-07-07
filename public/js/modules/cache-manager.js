/**
 * Módulo de gestión de caché con localStorage
 * Proporciona funciones para cachear datos de liga.html con invalidación inteligente
 */

const CACHE_VERSION = '1.0';
const CACHE_PREFIX = 'liga_cache_';
const MAX_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 días
const DEFAULT_MAX_AGE_MS = 15 * 60 * 1000; // 15 minutos por defecto

/**
 * Genera una clave de caché única
 * @param {string} prefix - Prefijo del tipo de dato (ej: 'teams_form', 'mvp_jornada')
 * @param {number|null} competitionId - ID de la competición
 * @param {...any} params - Parámetros adicionales para la clave
 * @returns {string} Clave de caché
 */
export function getCacheKey(prefix, competitionId, ...params) {
    const parts = [CACHE_PREFIX, prefix];
    if (competitionId !== null && competitionId !== undefined) {
        parts.push(`comp_${competitionId}`);
    }
    if (params.length > 0) {
        parts.push(...params.map(p => String(p)));
    }
    return parts.join('_');
}

/**
 * Obtiene el timestamp del último partido actualizado para una competición
 * @param {number} competitionId - ID de la competición
 * @returns {Promise<number|null>} Timestamp del último partido o null si hay error
 */
export async function getLastMatchTimestamp(competitionId) {
    if (!competitionId) return null;
    
    try {
        const { getSupabaseClient } = await import('./supabase-client.js');
        const supabase = await getSupabaseClient();
        if (!supabase) return null;

        const { data, error } = await supabase
            .from('matches')
            .select('updated_at')
            .eq('competition_id', competitionId)
            .not('updated_at', 'is', null)
            .order('updated_at', { ascending: false })
            .limit(1)
            .single();

        if (error || !data) return null;
        
        return new Date(data.updated_at).getTime();
    } catch (err) {
        console.warn('[CacheManager] Error obteniendo último timestamp de partido:', err);
        return null;
    }
}

/**
 * Lee datos del caché de localStorage
 * @param {string} key - Clave del caché
 * @param {number} maxAgeMs - Edad máxima del caché en milisegundos (default: 15 min)
 * @param {number|null} competitionId - ID de la competición para verificar nuevos partidos
 * @returns {Promise<any|null>} Datos cacheados o null si no hay caché válido
 */
export async function getCachedData(key, maxAgeMs = DEFAULT_MAX_AGE_MS, competitionId = null) {
    if (typeof localStorage === 'undefined') {
        return null; // localStorage no disponible (SSR, etc.)
    }

    try {
        const cachedStr = localStorage.getItem(key);
        if (!cachedStr) return null;

        const cached = JSON.parse(cachedStr);
        
        // Verificar versión
        if (cached.version !== CACHE_VERSION) {
            console.debug(`[CacheManager] Caché ${key} tiene versión antigua, invalidando`);
            localStorage.removeItem(key);
            return null;
        }

        // Verificar edad del caché
        const now = Date.now();
        const age = now - cached.timestamp;
        if (age > maxAgeMs) {
            console.debug(`[CacheManager] Caché ${key} expirado (edad: ${Math.round(age / 1000)}s)`);
            localStorage.removeItem(key);
            return null;
        }

        // Verificar si hay nuevos partidos (solo si se proporciona competitionId)
        if (competitionId !== null && cached.lastMatchTimestamp !== undefined) {
            const currentLastMatch = await getLastMatchTimestamp(competitionId);
            if (currentLastMatch !== null && currentLastMatch > cached.lastMatchTimestamp) {
                console.debug(`[CacheManager] Caché ${key} invalidado por nuevos partidos`);
                localStorage.removeItem(key);
                return null;
            }
        }

        return cached.data;
    } catch (err) {
        console.warn(`[CacheManager] Error leyendo caché ${key}:`, err);
        // Limpiar caché corrupto
        try {
            localStorage.removeItem(key);
        } catch (e) {
            // Ignorar errores al limpiar
        }
        return null;
    }
}

/**
 * Guarda datos en el caché de localStorage
 * @param {string} key - Clave del caché
 * @param {any} data - Datos a cachear
 * @param {number|null} competitionId - ID de la competición
 * @param {Object} metadata - Metadatos adicionales
 */
export async function setCachedData(key, data, competitionId = null, metadata = {}) {
    if (typeof localStorage === 'undefined') {
        return; // localStorage no disponible
    }

    try {
        const lastMatchTimestamp = competitionId !== null 
            ? await getLastMatchTimestamp(competitionId)
            : null;

        const cacheEntry = {
            data,
            timestamp: Date.now(),
            competitionId,
            lastMatchTimestamp,
            version: CACHE_VERSION,
            ...metadata
        };

        localStorage.setItem(key, JSON.stringify(cacheEntry));
    } catch (err) {
        // Si hay error (p. ej., quota exceeded), intentar limpiar cachés antiguos
        if (err.name === 'QuotaExceededError') {
            console.warn('[CacheManager] localStorage lleno, limpiando cachés antiguos');
            await cleanupOldCaches();
            // Intentar de nuevo
            try {
                const lastMatchTimestamp = competitionId !== null 
                    ? await getLastMatchTimestamp(competitionId)
                    : null;
                const cacheEntry = {
                    data,
                    timestamp: Date.now(),
                    competitionId,
                    lastMatchTimestamp,
                    version: CACHE_VERSION,
                    ...metadata
                };
                localStorage.setItem(key, JSON.stringify(cacheEntry));
            } catch (retryErr) {
                console.warn(`[CacheManager] Error guardando caché ${key} después de limpiar:`, retryErr);
            }
        } else {
            console.warn(`[CacheManager] Error guardando caché ${key}:`, err);
        }
    }
}

/**
 * Invalida cachés que coincidan con un patrón
 * @param {string} pattern - Patrón de clave (ej: 'teams_form_comp_1_*')
 */
export function invalidateCache(pattern) {
    if (typeof localStorage === 'undefined') return;

    try {
        const keysToRemove = [];
        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(CACHE_PREFIX)) {
                // Convertir patrón con * a regex
                const regexPattern = pattern
                    .replace(/\*/g, '.*')
                    .replace(/\?/g, '.');
                const regex = new RegExp(`^${regexPattern}$`);
                
                if (regex.test(key)) {
                    keysToRemove.push(key);
                }
            }
        }

        keysToRemove.forEach(key => {
            localStorage.removeItem(key);
            console.debug(`[CacheManager] Caché invalidado: ${key}`);
        });

        return keysToRemove.length;
    } catch (err) {
        console.warn(`[CacheManager] Error invalidando caché con patrón ${pattern}:`, err);
        return 0;
    }
}

/**
 * Invalida todos los cachés relacionados con una competición
 * @param {number} competitionId - ID de la competición
 */
export function invalidateOnNewMatches(competitionId) {
    if (!competitionId) return;

    // getCacheKey ya incluye el prefijo, así que usamos los mismos prefijos
    const patterns = [
        getCacheKey('teams_form', competitionId, '*'),
        getCacheKey('goleador_momento', competitionId, '*'),
        getCacheKey('mvp_jornada', competitionId, '*'),
        getCacheKey('mvp_temporada', competitionId, '*'),
        getCacheKey('pichichi', competitionId, '*'),
        getCacheKey('clasificacion', competitionId, '*'),
        getCacheKey('curiosidad', competitionId, '*')
    ];

    let totalInvalidated = 0;
    patterns.forEach(pattern => {
        totalInvalidated += invalidateCache(pattern);
    });

    console.log(`[CacheManager] Invalidados ${totalInvalidated} cachés para competición ${competitionId}`);
    return totalInvalidated;
}

/**
 * Limpia cachés antiguos (> 7 días)
 */
export function cleanupOldCaches() {
    if (typeof localStorage === 'undefined') return;

    try {
        const now = Date.now();
        const keysToRemove = [];

        for (let i = 0; i < localStorage.length; i++) {
            const key = localStorage.key(i);
            if (key && key.startsWith(CACHE_PREFIX)) {
                try {
                    const cachedStr = localStorage.getItem(key);
                    if (cachedStr) {
                        const cached = JSON.parse(cachedStr);
                        const age = now - cached.timestamp;
                        if (age > MAX_CACHE_AGE_MS) {
                            keysToRemove.push(key);
                        }
                    }
                } catch (e) {
                    // Si no se puede parsear, eliminar
                    keysToRemove.push(key);
                }
            }
        }

        keysToRemove.forEach(key => {
            localStorage.removeItem(key);
        });

        if (keysToRemove.length > 0) {
            console.log(`[CacheManager] Limpiados ${keysToRemove.length} cachés antiguos`);
        }

        return keysToRemove.length;
    } catch (err) {
        console.warn('[CacheManager] Error limpiando cachés antiguos:', err);
        return 0;
    }
}

/**
 * Verifica si el caché está obsoleto basándose en nuevos partidos
 * @param {string} cacheKey - Clave del caché
 * @param {number|null} competitionId - ID de la competición
 * @returns {Promise<boolean>} true si el caché está obsoleto
 */
export async function shouldInvalidateCache(cacheKey, competitionId) {
    if (!competitionId) return false;

    try {
        const cachedStr = localStorage.getItem(cacheKey);
        if (!cachedStr) return true; // No hay caché, considerar obsoleto

        const cached = JSON.parse(cachedStr);
        if (cached.lastMatchTimestamp === undefined) return true; // Caché sin timestamp

        const currentLastMatch = await getLastMatchTimestamp(competitionId);
        if (currentLastMatch === null) return false; // No se puede verificar

        return currentLastMatch > cached.lastMatchTimestamp;
    } catch (err) {
        console.warn(`[CacheManager] Error verificando invalidación de ${cacheKey}:`, err);
        return true; // En caso de error, considerar obsoleto
    }
}

// Limpiar cachés antiguos al cargar el módulo
if (typeof window !== 'undefined') {
    cleanupOldCaches();
}

