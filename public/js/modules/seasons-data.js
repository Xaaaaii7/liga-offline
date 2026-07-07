/**
 * Catálogo de temporadas (tabla `seasons`).
 *
 * - Una sola temporada activa a la vez (constraint en BD).
 * - El nombre de la temporada (`name`) sigue siendo el string que viaja en
 *   `competitions.season`, `league_teams.season`, etc. — esta tabla es solo
 *   un catálogo y un flag de "activa".
 *
 * Tolerante a fallos: si la tabla aún no existe (pre-migration) o RLS
 * bloquea, las funciones devuelven valores conservadores y la app sigue
 * funcionando con el string del config como antes.
 */

import { getSupabaseClient } from './supabase-client.js';
import { SUPABASE_CONFIG } from './config.js';

let cachedActiveName = null;
let cachedActiveLoadedAt = 0;
const ACTIVE_TTL_MS = 60_000; // 1 minuto

/**
 * Lista todas las temporadas, ordenadas por nombre desc (la más reciente arriba).
 * @returns {Promise<Array<{id:number, name:string, is_active:boolean, created_at:string}>>}
 */
export async function listSeasons() {
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from('seasons')
    .select('id, name, is_active, created_at')
    .order('name', { ascending: false });
  if (error) {
    console.warn('[seasons-data] No se pudo listar temporadas:', error.message);
    return [];
  }
  return data || [];
}

/**
 * Devuelve el nombre de la temporada activa.
 * Fallback al string de config si no hay tabla / fila activa.
 * @param {boolean} useCache  Si true (default), respeta el TTL del caché.
 * @returns {Promise<string>}
 */
export async function getActiveSeasonName(useCache = true) {
  if (useCache && cachedActiveName && (Date.now() - cachedActiveLoadedAt) < ACTIVE_TTL_MS) {
    return cachedActiveName;
  }
  try {
    const supabase = await getSupabaseClient();
    const { data, error } = await supabase
      .from('seasons')
      .select('name')
      .eq('is_active', true)
      .maybeSingle();
    if (error) throw error;
    if (data?.name) {
      cachedActiveName = data.name;
      cachedActiveLoadedAt = Date.now();
      // Mantener compat con getActiveSeason() síncrono.
      window.ACTIVE_SEASON = data.name;
      return data.name;
    }
  } catch (e) {
    console.debug('[seasons-data] fallback a config para active season:', e?.message || e);
  }
  return SUPABASE_CONFIG.season || '';
}

/**
 * Crea una nueva temporada. Si activate=true, además la marca como activa.
 * @param {string} name
 * @param {boolean} activate
 * @returns {Promise<{success:boolean, season?:object, error?:string}>}
 */
export async function createSeason(name, activate = false) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return { success: false, error: 'El nombre es obligatorio.' };

  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from('seasons')
    .insert({ name: trimmed, is_active: false })
    .select()
    .single();
  if (error) {
    console.error('[seasons-data] insert seasons:', error);
    return { success: false, error: error.message };
  }

  if (activate) {
    const result = await setActiveSeason(data.id);
    if (!result.success) return result;
  }

  // Invalidar caché de la activa.
  cachedActiveName = null;
  cachedActiveLoadedAt = 0;

  return { success: true, season: data };
}

/**
 * Marca una temporada como la activa (atomico: usa la función SQL).
 * @param {number} seasonId
 * @returns {Promise<{success:boolean, error?:string}>}
 */
export async function setActiveSeason(seasonId) {
  const supabase = await getSupabaseClient();
  const { error } = await supabase.rpc('set_active_season', { p_season_id: seasonId });
  if (error) {
    console.error('[seasons-data] set_active_season:', error);
    return { success: false, error: error.message };
  }
  // Invalidar caché.
  cachedActiveName = null;
  cachedActiveLoadedAt = 0;
  // Forzar recarga del caché en window.ACTIVE_SEASON.
  await getActiveSeasonName(false);
  return { success: true };
}
