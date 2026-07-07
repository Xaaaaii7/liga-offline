import { getSupabaseClient } from './supabase-client.js';
import { getCurrentCompetitionId } from './competitions.js';

/**
 * Carga valoraciones de jugadores desde la vista
 * @param {number|null} competitionId - ID de competición
 * @param {string|null} position - Filtrar por posición (GK, DEF, MID, FWD)
 * @param {number} limit - Límite de resultados (default: 30)
 * @returns {Promise<Array>} Array de valoraciones
 */
export async function loadPlayerRatings(competitionId = null, position = null, limit = 30) {
  const supabase = await getSupabaseClient();
  
  let finalCompetitionId = competitionId;
  if (!finalCompetitionId) {
    try {
      finalCompetitionId = await getCurrentCompetitionId();
    } catch (e) {
      console.warn('No se pudo obtener competition_id:', e);
      return [];
    }
  }

  // Verificar que finalCompetitionId sea un número válido
  // Convertir a número y verificar que no sea NaN, null, undefined, o la cadena "null"
  const parsedId = parseInt(finalCompetitionId);
  if (!finalCompetitionId || 
      finalCompetitionId === 'null' || 
      finalCompetitionId === 'undefined' ||
      isNaN(parsedId) || 
      parsedId <= 0) {
    console.error('competition_id inválido:', finalCompetitionId);
    return [];
  }

  let query = supabase
    .from('player_ratings_avg')
    .select('*')
    .eq('competition_id', parsedId)
    .order('bayesian_rating', { ascending: false })
    .limit(limit);

  // Filtrar por posición si se especifica
  if (position) {
    query = query.ilike('position', `%${position}%`);
  }

  const { data, error } = await query;

  if (error) {
    console.error('Error cargando valoraciones:', error);
    return [];
  }

  return data || [];
}

/**
 * Clasifica posición del jugador
 * Misma lógica exacta que posGroup() en club.js
 * @param {string} position - Posición del jugador
 * @returns {string} - 'GK', 'DEF', 'MID', 'FWD' o null
 */
export function classifyPosition(position) {
  const p = (position || "").toLowerCase();
  
  // Porteros: "goalkeeper" o "portero"
  if (p.includes("goalkeeper") || p.includes("portero")) {
    return "GK";
  }
  
  // Defensas: "defence", "back", "centre-back", o "defensa"
  if (p.includes("defence") || p.includes("back") || 
      p.includes("centre-back") || p.includes("defensa")) {
    return "DEF";
  }
  
  // Centrocampistas: "midfield", "medio", o "mid"
  if (p.includes("midfield") || p.includes("medio") || p.includes("mid")) {
    return "MID";
  }
  
  // Delanteros: "offence", "forward", "wing", "striker", o "delantero"
  if (p.includes("offence") || p.includes("forward") || 
      p.includes("wing") || p.includes("striker") || 
      p.includes("delantero")) {
    return "FWD";
  }
  
  // Si no coincide con ninguna, devolver null (equivalente a "Otros" en club.js)
  return null;
}

/**
 * Nombre en español de la posición
 * @param {string} positionCode - Código de posición (GK, DEF, MID, FWD)
 * @returns {string} Nombre en español
 */
export function getPositionName(positionCode) {
  const names = {
    'GK': 'Portero',
    'DEF': 'Defensa',
    'MID': 'Centrocampista',
    'FWD': 'Delantero'
  };
  return names[positionCode] || 'Centrocampista';
}

