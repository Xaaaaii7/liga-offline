/**
 * Database Query Helpers
 * 
 * Módulo para centralizar queries comunes a Supabase y reducir código duplicado.
 * Requiere competition_id para tablas que lo soportan (sin fallback a season).
 */

import { getSupabaseClient } from './supabase-client.js';
import { getCurrentCompetitionId } from './competitions.js';

/**
 * Lista de tablas que tienen la columna competition_id
 * Se usa para aplicar el filtro automáticamente cuando sea apropiado
 * Exportado para que otros módulos puedan verificar si una tabla soporta competition_id
 */
export const TABLES_WITH_COMPETITION_ID = new Set([
    'matches',
    'rounds',
    'goal_events',
    'match_injuries',
    'match_red_cards',
    'match_team_stats',
    'noticias',
    'player_suspensions',
    'jornadas_config',
    'league_teams', // competition_id es NOT NULL: cada equipo pertenece a una competición específica
    'goleadores', // Vista que tiene competition_id
    'daily_curiosities', // Tiene competition_id
    'formations', // Tiene competition_id
    'match_yellow_cards' // Tiene competition_id
]);

/**
 * Query simple con filtro de competition_id automático
 * @param {string} table - Nombre de la tabla
 * @param {string} select - Columnas a seleccionar (formato Supabase)
 * @param {Object} options - Opciones adicionales
 * @param {number|null} options.competitionId - ID de competición (si null, intenta obtenerlo del contexto)
 * @param {boolean} options.autoCompetitionId - Si debe obtener competition_id automáticamente (default: true)
 * @param {boolean} options.requireCompetitionId - Si debe requerir competition_id para tablas que lo soportan (default: true)
 * @param {Object} options.filters - Filtros adicionales { column: value }
 * @param {Object} options.order - Ordenamiento { column: string, ascending: boolean }
 * @param {number} options.limit - Límite de resultados
 * @returns {Promise<Array>} Datos de la query
 * @throws {Error} Si hay error en la query o si se requiere competition_id y no se puede obtener
 */
export async function queryTable(table, select = '*', options = {}) {
    const {
        competitionId = null,
        autoCompetitionId = true,
        requireCompetitionId = true,
        filters = {},
        order = null,
        limit = null
    } = options;

    const supabase = await getSupabaseClient();
    let query = supabase.from(table).select(select);

    // Obtener competition_id automáticamente si no se proporciona y la tabla lo soporta
    let finalCompetitionId = competitionId;
    if (finalCompetitionId === null && autoCompetitionId && TABLES_WITH_COMPETITION_ID.has(table)) {
        try {
            finalCompetitionId = await getCurrentCompetitionId();
        } catch (e) {
            if (requireCompetitionId) {
                throw new Error(`No se pudo obtener competition_id para la tabla ${table}. Es obligatorio para esta tabla.`);
            }
            console.debug(`No se pudo obtener competition_id automáticamente para ${table}:`, e);
        }
    }

    // Para tablas que soportan competition_id, es obligatorio
    if (TABLES_WITH_COMPETITION_ID.has(table)) {
        if (finalCompetitionId === null && requireCompetitionId) {
            throw new Error(`competition_id es obligatorio para la tabla ${table} pero no se proporcionó ni se pudo obtener del contexto.`);
        }
        if (finalCompetitionId !== null) {
            query = query.eq('competition_id', finalCompetitionId);
        }
    }

    // Filtros adicionales
    for (const [column, value] of Object.entries(filters)) {
        if (value !== null && value !== undefined) {
            query = query.eq(column, value);
        }
    }

    // Ordenamiento
    if (order) {
        query = query.order(order.column, { ascending: order.ascending ?? true });
    }

    // Límite
    if (limit) {
        query = query.limit(limit);
    }

    const { data, error } = await query;

    if (error) {
        console.error(`Error querying ${table}:`, error);
        throw error;
    }

    return data || [];
}

/**
 * Query con múltiples filtros NOT NULL
 * Útil para obtener solo partidos jugados, etc.
 * @param {string} table - Nombre de la tabla
 * @param {string} select - Columnas a seleccionar
 * @param {string[]} notNullColumns - Columnas que no deben ser null
 * @param {Object} options - Opciones adicionales (igual que queryTable)
 * @returns {Promise<Array>}
 */
export async function queryTableNotNull(table, select, notNullColumns = [], options = {}) {
    const supabase = await getSupabaseClient();
    
    // Obtener competition_id automáticamente si no se proporciona
    let finalCompetitionId = options.competitionId;
    const requireCompetitionId = options.requireCompetitionId !== false;
    if (finalCompetitionId === null && options.autoCompetitionId !== false && TABLES_WITH_COMPETITION_ID.has(table)) {
        try {
            finalCompetitionId = await getCurrentCompetitionId();
        } catch (e) {
            if (requireCompetitionId) {
                throw new Error(`No se pudo obtener competition_id para la tabla ${table}. Es obligatorio para esta tabla.`);
            }
            console.debug(`No se pudo obtener competition_id automáticamente para ${table}:`, e);
        }
    }

    let query = supabase.from(table).select(select);

    // Para tablas que soportan competition_id, es obligatorio
    if (TABLES_WITH_COMPETITION_ID.has(table)) {
        if (finalCompetitionId === null && requireCompetitionId) {
            throw new Error(`competition_id es obligatorio para la tabla ${table} pero no se proporcionó ni se pudo obtener del contexto.`);
        }
        if (finalCompetitionId !== null) {
            query = query.eq('competition_id', finalCompetitionId);
        }
    }

    // Aplicar filtros NOT NULL
    for (const col of notNullColumns) {
        query = query.not(col, 'is', null);
    }

    // Filtros adicionales
    if (options.filters) {
        for (const [column, value] of Object.entries(options.filters)) {
            if (value !== null && value !== undefined) {
                query = query.eq(column, value);
            }
        }
    }

    // Ordenamiento
    if (options.order) {
        query = query.order(options.order.column, { ascending: options.order.ascending ?? true });
    }

    // Límite
    if (options.limit) {
        query = query.limit(options.limit);
    }

    const { data, error } = await query;

    if (error) {
        console.error(`Error querying ${table}:`, error);
        throw error;
    }

    return data || [];
}

/**
 * Query por ID único
 * @param {string} table - Nombre de la tabla
 * @param {string|number} id - ID del registro
 * @param {string} select - Columnas a seleccionar
 * @param {string} idColumn - Nombre de la columna ID (default: 'id')
 * @returns {Promise<Object|null>}
 */
export async function queryById(table, id, select = '*', idColumn = 'id') {
    const supabase = await getSupabaseClient();

    const { data, error } = await supabase
        .from(table)
        .select(select)
        .eq(idColumn, id)
        .single();

    if (error) {
        console.error(`Error querying ${table} by ${idColumn}:`, error);
        throw error;
    }

    return data;
}

/**
 * Carga equipos de la liga para la competición/temporada actual
 * (Wrapper específico, muy usado)
 * @param {Object} options - Opciones
 * @param {string} options.select - Columnas a seleccionar
 * @param {boolean} options.orderByNickname - Ordenar por nickname (default: true)
 * @param {number|null} options.competitionId - ID de competición (opcional)
 * @param {boolean} options.autoCompetitionId - Si debe obtener competition_id automáticamente (default: true)
 * @returns {Promise<Array>}
 */
export async function loadLeagueTeams(options = {}) {
    const {
        select = 'id, nickname, display_name',
        orderByNickname = true,
        competitionId = null,
        autoCompetitionId = true
    } = options;

    return queryTable('league_teams', select, {
        competitionId,
        autoCompetitionId,
        order: orderByNickname ? { column: 'nickname', ascending: true } : null
    });
}

/**
 * Carga partidos con relaciones a equipos
 * (Wrapper específico, muy usado)
 * @param {Object} options - Opciones adicionales
 * @param {string} options.select - Columnas a seleccionar
 * @param {number|null} options.competitionId - ID de competición (opcional)
 * @param {boolean} options.autoCompetitionId - Si debe obtener competition_id automáticamente (default: true)
 * @returns {Promise<Array>}
 */
export async function loadMatches(options = {}) {
    const defaultSelect = `
    id,
    season,
    competition_id,
    round_id,
    match_date,
    match_time,
    home_goals,
    away_goals,
    stream_url,
    home_league_team_id,
    away_league_team_id,
    home:league_teams!matches_home_league_team_id_fkey ( id, nickname, display_name ),
    away:league_teams!matches_away_league_team_id_fkey ( id, nickname, display_name )
  `;

    const { 
        select = defaultSelect, 
        competitionId = null,
        autoCompetitionId = true,
        ...restOptions 
    } = options;

    return queryTable('matches', select, {
        competitionId,
        autoCompetitionId,
        order: { column: 'round_id', ascending: true },
        ...restOptions
    });
}

/**
 * Helper para manejar errores de forma consistente
 * Ejecuta una función async y maneja errores de forma estándar
 * @param {Function} asyncFn - Función async a ejecutar
 * @param {Object} options - Opciones
 * @param {string} options.errorMessage - Mensaje de error customizado
 * @param {*} options.fallback - Valor de fallback si hay error (default: null)
 * @returns {Promise<*>}
 */
export async function withErrorHandling(asyncFn, options = {}) {
    const { errorMessage = 'Error en query', fallback = null } = options;

    try {
        return await asyncFn();
    } catch (err) {
        console.error(errorMessage, err);
        return fallback;
    }
}
