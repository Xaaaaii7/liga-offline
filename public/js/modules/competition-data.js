/**
 * Módulo para cargar y gestionar datos de competiciones
 * Funciones para interactuar con la tabla competitions y competition_teams
 * 
 * NOTA: Las competiciones ahora incluyen campos de tematización:
 * - theme_preset: Tema predefinido ('default', 'christmas', 'halloween')
 * - theme_colors: Colores personalizados en JSONB (primary, secondary, accent)
 * - logo_url: URL del logo personalizado en Supabase Storage
 * 
 * Todos los select('*') y joins con competitions(*) incluyen automáticamente
 * estos campos, por lo que están disponibles en los objetos de competición retornados.
 */

import { getSupabaseClient } from './supabase-client.js';
import { getCurrentUser, getCurrentProfile } from './auth.js';
import { getUserIdFromAuthUuid } from './user-helpers.js';

/**
 * Obtiene una competición por su slug
 * @param {string} slug - Slug de la competición
 * @returns {Promise<Object|null>} Datos de la competición o null si no existe
 */
export async function getCompetitionBySlug(slug) {
  if (!slug) return null;

  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from('competitions')
    .select('*')
    .eq('slug', slug)
    .maybeSingle();

  if (error) {
    console.error('Error obteniendo competición por slug:', error);
    return null;
  }

  return data;
}

/**
 * Obtiene una competición por su ID
 * @param {number} id - ID de la competición
 * @returns {Promise<Object|null>} Datos de la competición o null si no existe
 */
export async function getCompetitionById(id) {
  if (!id) return null;

  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from('competitions')
    .select('*')
    .eq('id', id)
    .maybeSingle();

  if (error) {
    console.error('Error obteniendo competición por ID:', error);
    return null;
  }

  return data;
}

/**
 * Obtiene todas las competiciones con filtros opcionales
 * @param {Object} filters - Filtros opcionales
 * @param {boolean} filters.is_public - Solo competiciones públicas
 * @param {boolean} filters.is_official - Solo competiciones oficiales
 * @param {string} filters.season - Filtrar por temporada
 * @param {string} filters.status - Filtrar por estado (draft, open, active, finished)
 * @returns {Promise<Array>} Array de competiciones
 */
export async function getCompetitions(filters = {}) {
  const supabase = await getSupabaseClient();
  let query = supabase
    .from('competitions')
    .select('*')
    .order('created_at', { ascending: false });

  if (filters.is_public !== undefined) {
    query = query.eq('is_public', filters.is_public);
  }

  if (filters.is_official !== undefined) {
    query = query.eq('is_official', filters.is_official);
  }

  if (filters.season) {
    query = query.eq('season', filters.season);
  }

  if (filters.status) {
    query = query.eq('status', filters.status);
  }

  if (filters.competition_type) {
    query = query.eq('competition_type', filters.competition_type);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error obteniendo competiciones:', error);
    return [];
  }

  return data || [];
}

/**
 * Obtiene las competiciones en las que está inscrito el usuario actual
 * @param {string|null} authUserId - UUID del usuario de auth.users (si es null, intenta obtenerlo del usuario actual)
 * @returns {Promise<Array>} Array de competiciones con información de inscripción
 */
export async function getUserCompetitions(authUserId = null) {
  const supabase = await getSupabaseClient();
  
  // Si no se proporciona authUserId, intentar obtenerlo del usuario actual
  if (!authUserId) {
    const user = await getCurrentUser();
    if (!user) return [];
    authUserId = user.id; // UUID de auth.users
  }

  // Super admin: tiene visibilidad sobre todas las competiciones, devolver todas.
  const profile = await getCurrentProfile();
  if (profile?.is_super_admin) {
    const { data: allComps, error: allErr } = await supabase
      .from('competitions')
      .select('*')
      .order('created_at', { ascending: false });

    if (allErr) {
      console.error('Error cargando competiciones para super admin:', allErr);
      return [];
    }

    // Marcar todas como "active" desde el punto de vista del super admin para que
    // los renderizados que usan inscription_status no las descarten.
    return (allComps || []).map(c => ({
      ...c,
      inscription_status: 'super_admin',
      joined_at: null
    }));
  }

  // Obtener users.id (INTEGER) desde el UUID
  const usersId = await getUserIdFromAuthUuid(authUserId);
  
  if (!usersId) {
    console.warn('getUserCompetitions: Usuario no tiene entrada en tabla users');
    return [];
  }

  // Buscar en competition_teams usando users.id (INTEGER)
  const { data, error } = await supabase
    .from('competition_teams')
    .select(`
      id,
      status,
      joined_at,
      competition:competitions(*)
    `)
    .eq('user_id', usersId)
    .in('status', ['approved', 'active', 'pending'])
    .order('joined_at', { ascending: false });

  if (error) {
    console.error('Error obteniendo competiciones del usuario:', error);
    return [];
  }

  // Filtrar y mapear resultados
  return (data || [])
    .filter(item => item.competition) // Solo incluir si tiene competición
    .map(item => ({
      ...item.competition,
      inscription_status: item.status,
      joined_at: item.joined_at
    }));
}

/**
 * Obtiene la competición activa del usuario (primera competición activa inscrita)
 * @returns {Promise<Object|null>} Competición activa o null
 */
export async function getActiveCompetition() {
  const competitions = await getUserCompetitions();
  const active = competitions.find(c => c.status === 'active');
  return active || competitions[0] || null;
}

/**
 * Verifica si un usuario está inscrito en una competición
 * @param {number} competitionId - ID de la competición
 * @param {string|null} authUserId - UUID del usuario de auth.users (si es null, usa el usuario actual)
 * @returns {Promise<boolean>} True si está inscrito
 */
export async function isUserInCompetition(competitionId, authUserId = null) {
  if (!competitionId) return false;

  const user = authUserId ? { id: authUserId } : await getCurrentUser();
  if (!user) return false;

  // Obtener users.id (INTEGER) desde el UUID
  const usersId = await getUserIdFromAuthUuid(user.id);
  
  if (!usersId) {
    console.warn('isUserInCompetition: Usuario no tiene entrada en tabla users');
    return false;
  }

  const supabase = await getSupabaseClient();
  
  // Buscar en competition_teams a través de league_teams
  // competition_teams NO tiene user_id, solo league_team_id
  const { data, error } = await supabase
    .from('competition_teams')
    .select(`
      id,
      league_team:league_teams!inner(user_id)
    `)
    .eq('competition_id', competitionId)
    .eq('league_team.user_id', usersId)
    .in('status', ['approved', 'active', 'pending'])
    .maybeSingle();

  if (error) {
    console.error('Error verificando inscripción:', error);
    return false;
  }

  return !!data;
}

/**
 * Obtiene los equipos inscritos en una competición
 * @param {number} competitionId - ID de la competición
 * @returns {Promise<Array>} Array de equipos con información
 */
export async function getCompetitionTeams(competitionId) {
  if (!competitionId) return [];

  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from('competition_teams')
    .select(`
      id,
      status,
      joined_at,
      league_team:league_teams(
        id,
        nickname,
        display_name,
        club:clubs(id, name)
      )
    `)
    .eq('competition_id', competitionId)
    .in('status', ['approved', 'active'])
    .order('joined_at', { ascending: true });

  if (error) {
    console.error('Error obteniendo equipos de competición:', error);
    return [];
  }

  return data || [];
}

