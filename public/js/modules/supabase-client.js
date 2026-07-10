import { SUPABASE_CONFIG } from './config.js';

let supabaseClient = window.__supabaseClient || null;
let supabaseClientPromise = window.__supabaseClientPromise || null;

export function getSupabaseConfig() {
    return {
        url: window?.SUPABASE_URL || window?.SUPABASE_CONFIG?.url || SUPABASE_CONFIG.url || '',
        anonKey: window?.SUPABASE_ANON_KEY || window?.SUPABASE_CONFIG?.anonKey || SUPABASE_CONFIG.anonKey || '',
        season: window?.ACTIVE_SEASON || window?.SUPABASE_CONFIG?.season || SUPABASE_CONFIG.season || ''
    };
}

/**
 * Obtiene la season activa
 * Intenta obtenerla de la competición actual si está disponible, 
 * si no, usa la configuración global
 * @returns {string} Season activa
 */
export function getActiveSeason() {
    // Intentar obtener la season de la competición actual si está disponible en el contexto
    // (sin hacer llamadas async para mantener compatibilidad)
    try {
        // Si hay una competición actual en el contexto de la URL o en window
        if (window.__currentCompetition && window.__currentCompetition.season) {
            return window.__currentCompetition.season;
        }
        
        // Si hay un competitionId en el contexto, intentar obtener la season del caché
        if (window.__currentCompetitionId) {
            // Nota: Esto requiere que la competición esté previamente cargada
            // Para obtener la season de forma asíncrona, usar getActiveSeasonFromCompetition()
        }
    } catch (e) {
        // Si falla, continuar con el fallback
        console.debug('Error obteniendo season de competición actual:', e);
    }
    
    // Fallback: usar la configuración global
    const { season } = getSupabaseConfig();
    return season;
}

/**
 * Obtiene la season activa desde la competición actual (versión async)
 * Esta función intenta obtener la season de la competición actual desde la base de datos
 * @returns {Promise<string>} Season activa
 */
export async function getActiveSeasonFromCompetition() {
    try {
        const { getCurrentCompetition } = await import('./competitions.js');
        const comp = await getCurrentCompetition();
        if (comp && comp.season) {
            // Cachear en window para que getActiveSeason() pueda usarlo
            if (!window.__currentCompetition) {
                window.__currentCompetition = {};
            }
            window.__currentCompetition.season = comp.season;
            return comp.season;
        }
    } catch (e) {
        console.debug('Error obteniendo season de competición actual (async):', e);
    }
    
    // Fallback: usar la configuración global
    const { season } = getSupabaseConfig();
    return season;
}

export async function loadSupabaseFactory() {
    const cdnUrls = [
        // 1º intento: esm.sh (muy estable para ESM)
        'https://esm.sh/@supabase/supabase-js@2.49.1',
        // 2º intento: jsDelivr (el que tenías antes)
        'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.49.1/+esm'
    ];

    let createClient = null;
    let lastError = null;

    for (const url of cdnUrls) {
        try {
            const mod = await import(url);
            createClient = mod.createClient;
            if (createClient) break;
        } catch (err) {
            console.warn('No se pudo cargar la librería de BD desde', url, err);
            lastError = err;
        }
    }

    if (!createClient) {
        console.error('No se pudo cargar la librería de BD desde ningún CDN', lastError);
        throw new Error('No se puede conectar con el backend en este momento.');
    }

    return createClient;
}

// Modo PGlite-en-navegador (sin backend Node/PostgREST). Se activa con ?pglite=1
// (persiste en localStorage) y se desactiva con ?pglite=0. Por defecto: supabase-js.
export function usePglite() {
    // En Tauri (app de escritorio) no hay servidor/PostgREST → siempre PGlite.
    if (typeof window !== 'undefined' && (window.__TAURI__ || window.__TAURI_INTERNALS__)) return true;
    try {
        const q = new URLSearchParams(location.search).get('pglite');
        if (q === '1') { localStorage.setItem('use-pglite', '1'); return true; }
        if (q === '0') { localStorage.removeItem('use-pglite'); return false; }
        return localStorage.getItem('use-pglite') === '1';
    } catch { return false; }
}

export async function getSupabaseClient() {
    if (supabaseClient) return supabaseClient;
    if (supabaseClientPromise) return supabaseClientPromise;

    supabaseClientPromise = (async () => {
        if (usePglite()) {
            const { createPgliteClient } = await import('./pglite-client.js');
            supabaseClient = createPgliteClient();
            window.__supabaseClient = supabaseClient;
            return supabaseClient;
        }
        const createClient = await loadSupabaseFactory();

        const { url, anonKey } = getSupabaseConfig();
        if (!url || !anonKey) throw new Error('Falta configuración de BD');

        supabaseClient = createClient(url, anonKey);
        // Keep exposing globally for other non-modular scripts if they access via global var directly (unlikely if they use AppUtils, but good for debug)
        window.__supabaseClient = supabaseClient;
        return supabaseClient;
    })();

    window.__supabaseClientPromise = supabaseClientPromise;
    return supabaseClientPromise;
}
