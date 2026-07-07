/**
 * Módulo helper para estadísticas globales
 * Funciones para obtener y agregar datos de competiciones (excluyendo ranked) con filtros opcionales
 */

import { getSupabaseClient } from './supabase-client.js';

/**
 * Obtiene competiciones excluyendo ranked con filtros opcionales
 * @param {Object} filters - Filtros opcionales
 * @param {string|null} filters.season - Filtrar por temporada (null o '' = todas)
 * @param {boolean|null} filters.is_official - true=oficiales, false=no oficiales, null=todas
 * @returns {Promise<Array>} Array de objetos competition con id, name, slug, season, competition_type, is_official
 */
export async function getCompetitionsExcludingRanked(filters = {}) {
  const supabase = await getSupabaseClient();
  
  let query = supabase
    .from('competitions')
    .select('id, name, slug, season, competition_type, is_official')
    .neq('competition_type', 'ranked')
    .order('created_at', { ascending: false });

  // Filtro por temporada
  if (filters.season && filters.season !== '') {
    query = query.eq('season', filters.season);
  }

  // Filtro por tipo de competición (oficial/no oficial)
  // Solo aplicar filtro si is_official tiene un valor booleano (true o false)
  // Si es null o undefined, no filtrar (mostrar todas)
  if (filters.is_official === true || filters.is_official === false) {
    query = query.eq('is_official', filters.is_official);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error obteniendo competiciones:', error);
    return [];
  }
  
  if (data) {
    const oficiales = data.filter(c => c.is_official === true).length;
    const noOficiales = data.filter(c => c.is_official === false).length;
    console.log('[Global Stats Helpers] Competiciones encontradas:', data.length, {
      oficiales: oficiales,
      noOficiales: noOficiales,
      filtroAplicado: filters.is_official,
      ids: data.map(c => ({ id: c.id, is_official: c.is_official, name: c.name }))
    });
  }

  if (error) {
    console.error('Error obteniendo competiciones:', error);
    return [];
  }

  return data || [];
}

/**
 * Obtiene los IDs de competiciones excluyendo ranked con filtros
 * @param {Object} filters - Mismos filtros que getCompetitionsExcludingRanked
 * @returns {Promise<Array<number>>} Array de IDs
 */
export async function getCompetitionIdsExcludingRanked(filters = {}) {
  const competitions = await getCompetitionsExcludingRanked(filters);
  return competitions.map(c => c.id).filter(Boolean);
}

/**
 * Obtiene todas las temporadas disponibles de competiciones (excluyendo ranked)
 * @param {Object} filters - Filtros opcionales para tipo de competición
 * @param {boolean|null} filters.is_official - true=oficiales, false=no oficiales, null=todas
 * @returns {Promise<Array<string>>} Array de temporadas únicas ordenadas (más reciente primero)
 */
export async function getAvailableSeasons(filters = {}) {
  const supabase = await getSupabaseClient();
  
  let query = supabase
    .from('competitions')
    .select('season')
    .neq('competition_type', 'ranked')
    .not('season', 'is', null);

  // Filtro por tipo de competición
  if (filters.is_official !== null && filters.is_official !== undefined) {
    query = query.eq('is_official', filters.is_official);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error obteniendo temporadas:', error);
    return [];
  }

  // Obtener temporadas únicas y ordenarlas (más reciente primero)
  const seasons = [...new Set((data || []).map(c => c.season).filter(Boolean))];
  return seasons.sort((a, b) => b.localeCompare(a)); // Orden descendente
}

/**
 * Obtiene todas las competiciones oficiales excluyendo ranked (compatibilidad hacia atrás)
 * @returns {Promise<Array>} Array de objetos competition
 */
export async function getOfficialCompetitionsExcludingRanked() {
  return getCompetitionsExcludingRanked({ is_official: true });
}

/**
 * Obtiene los IDs de todas las competiciones oficiales excluyendo ranked (compatibilidad hacia atrás)
 * @returns {Promise<Array<number>>} Array de IDs
 */
export async function getOfficialCompetitionIdsExcludingRanked() {
  return getCompetitionIdsExcludingRanked({ is_official: true });
}

