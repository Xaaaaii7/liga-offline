/**
 * Módulo principal de competiciones
 * Funciones de alto nivel para gestionar competiciones
 */

import { getCompetitionBySlug, getCompetitionById, getCompetitions, getUserCompetitions } from './competition-data.js';
import { getCompetitionFromURL, buildURLWithCompetition } from './competition-context.js';

/**
 * Obtiene el contexto de competición actual (desde URL o usuario activo)
 * Cachea el resultado en window.__currentCompetition para uso síncrono
 * @returns {Promise<Object|null>} Datos de la competición actual o null
 */
export async function getCurrentCompetition() {
  // Primero intentar desde URL
  const slug = getCompetitionFromURL();
  let competition = null;
  
  if (slug) {
    competition = await getCompetitionBySlug(slug);
  } else {
    // Si no hay en URL, obtener competición activa del usuario
    const { getActiveCompetition } = await import('./competition-data.js');
    competition = await getActiveCompetition();
  }
  
  // Cachear en window para que getActiveSeason() pueda usarlo de forma síncrona
  if (competition) {
    if (!window.__currentCompetition) {
      window.__currentCompetition = {};
    }
    window.__currentCompetition = competition;
    window.__currentCompetitionId = competition.id;
  } else {
    // Limpiar caché si no hay competición
    window.__currentCompetition = null;
    window.__currentCompetitionId = null;
  }
  
  return competition;
}

/**
 * Obtiene el ID de competición actual
 * @returns {Promise<number|null>} ID de la competición o null
 */
export async function getCurrentCompetitionId() {
  const competition = await getCurrentCompetition();
  return competition?.id || null;
}

/**
 * Obtiene competiciones públicas disponibles
 * @param {Object} options - Opciones de filtrado
 * @returns {Promise<Array>} Array de competiciones públicas
 */
export async function getPublicCompetitions(options = {}) {
  const filters = {
    is_public: true,
    ...options
  };

  return await getCompetitions(filters);
}

/**
 * Obtiene competiciones oficiales
 * @param {string|null} season - Temporada específica (opcional)
 * @returns {Promise<Array>} Array de competiciones oficiales
 */
export async function getOfficialCompetitions(season = null) {
  const filters = {
    is_official: true
  };

  if (season) {
    filters.season = season;
  }

  return await getCompetitions(filters);
}

/**
 * Verifica si el usuario tiene acceso a una competición
 * @param {number|string} competitionIdOrSlug - ID o slug de la competición
 * @returns {Promise<boolean>} True si tiene acceso
 */
export async function canUserAccessCompetition(competitionIdOrSlug) {
  let competition;
  
  if (typeof competitionIdOrSlug === 'number') {
    competition = await getCompetitionById(competitionIdOrSlug);
  } else {
    competition = await getCompetitionBySlug(competitionIdOrSlug);
  }

  if (!competition) return false;

  // Si es pública, cualquiera puede acceder
  if (competition.is_public) return true;

  // Si no es pública, verificar si el usuario está inscrito
  const { isUserInCompetition } = await import('./competition-data.js');
  return await isUserInCompetition(competition.id);
}

/**
 * Obtiene estadísticas básicas de una competición
 * @param {number} competitionId - ID de la competición
 * @returns {Promise<Object>} Estadísticas básicas
 */
export async function getCompetitionStats(competitionId) {
  if (!competitionId) {
    return {
      total_teams: 0,
      total_matches: 0,
      played_matches: 0,
      total_goals: 0
    };
  }

  const { getSupabaseClient } = await import('./supabase-client.js');
  const supabase = await getSupabaseClient();

  // Contar equipos
  const { count: teamCount } = await supabase
    .from('competition_teams')
    .select('*', { count: 'exact', head: true })
    .eq('competition_id', competitionId)
    .in('status', ['approved', 'active']);

  // Contar partidos
  const { count: matchCount } = await supabase
    .from('matches')
    .select('*', { count: 'exact', head: true })
    .eq('competition_id', competitionId);

  // Contar partidos jugados (incluye administrativos: tienen resultado y cuentan como jugados)
  const { count: playedCount } = await supabase
    .from('matches')
    .select('*', { count: 'exact', head: true })
    .eq('competition_id', competitionId)
    .not('home_goals', 'is', null)
    .not('away_goals', 'is', null);

  // Sumar goles (esto requiere una query más compleja, excluyendo administrativos)
  const { data: matches } = await supabase
    .from('matches')
    .select('home_goals, away_goals')
    .eq('competition_id', competitionId)
    .or('resolved_administratively.is.null,resolved_administratively.eq.false')
    .not('home_goals', 'is', null)
    .not('away_goals', 'is', null);

  const totalGoals = (matches || []).reduce((sum, m) => {
    return sum + (m.home_goals || 0) + (m.away_goals || 0);
  }, 0);

  return {
    total_teams: teamCount || 0,
    total_matches: matchCount || 0,
    played_matches: playedCount || 0,
    total_goals: totalGoals
  };
}

