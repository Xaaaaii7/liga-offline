/**
 * Módulo para gestionar permisos y creación de competiciones
 */

import { getSupabaseClient } from './supabase-client.js';
import { getCurrentUser, getCurrentProfile } from './auth.js';

/**
 * Verifica si el usuario actual es super admin
 * @returns {Promise<boolean>}
 */
export async function isSuperAdmin() {
    const profile = await getCurrentProfile();
    return !!(profile && profile.is_super_admin === true);
}

/**
 * Verifica si el usuario actual puede crear una competición del tipo especificado
 * @param {string} competitionType - Tipo de competición: 'league', 'cup', 'mixed'
 * @returns {Promise<{canCreate: boolean, reason?: string, requiredCoins?: number, userCoins?: number}>}
 */
export async function canCreateCompetition(competitionType) {
    const user = await getCurrentUser();
    if (!user) {
        return { canCreate: false, reason: 'Debes estar logueado para crear competiciones' };
    }

    const profile = await getCurrentProfile();
    if (!profile) {
        return { canCreate: false, reason: 'No se pudo obtener el perfil del usuario' };
    }

    // Super admin puede crear cualquier competición sin coste
    if (profile.is_super_admin) {
        return { canCreate: true, userCoins: profile.coins || 0, requiredCoins: 0 };
    }

    // Determinar monedas requeridas
    let requiredCoins = 0;
    if (competitionType === 'league') {
        requiredCoins = 2;
    } else if (competitionType === 'cup' || competitionType === 'mixed') {
        requiredCoins = 1;
    } else if (competitionType === 'ranked') {
        requiredCoins = 0; // Ranked es gratis
    } else {
        return { canCreate: false, reason: 'Tipo de competición no válido' };
    }

    const userCoins = profile.coins || 0;

    if (userCoins < requiredCoins) {
        return {
            canCreate: false,
            reason: `No tienes suficientes monedas. Necesitas ${requiredCoins} moneda${requiredCoins > 1 ? 's' : ''} y tienes ${userCoins}`,
            requiredCoins,
            userCoins
        };
    }

    return { canCreate: true, requiredCoins, userCoins };
}

/**
 * Verifica si el usuario actual es admin de una competición específica
 * @param {number} competitionId - ID de la competición
 * @returns {Promise<boolean>}
 */
export async function isCompetitionAdmin(competitionId) {
    const user = await getCurrentUser();
    if (!user) return false;

    const supabase = await getSupabaseClient();

    try {
        // Usar la función de la base de datos
        const { data, error } = await supabase.rpc('is_competition_admin', {
            comp_id: competitionId,
            user_uuid: user.id
        });

        if (error) {
            console.warn('Error verificando admin de competición:', error);
            // Fallback: verificar manualmente
            return await isCompetitionAdminFallback(competitionId, user.id);
        }

        return data === true;
    } catch (e) {
        console.warn('Error en is_competition_admin:', e);
        return await isCompetitionAdminFallback(competitionId, user.id);
    }
}

/**
 * Fallback para verificar admin de competición sin usar función RPC
 * @param {number} competitionId
 * @param {string} userId
 * @returns {Promise<boolean>}
 */
async function isCompetitionAdminFallback(competitionId, userId) {
    const supabase = await getSupabaseClient();

    // Verificar super admin
    const { data: profile } = await supabase
        .from('profiles')
        .select('is_super_admin')
        .eq('id', userId)
        .maybeSingle();

    if (profile?.is_super_admin) {
        return true;
    }

    // Verificar creator
    const { data: competition } = await supabase
        .from('competitions')
        .select('creator_id')
        .eq('id', competitionId)
        .maybeSingle();

    if (competition?.creator_id === userId) {
        return true;
    }

    // Verificar admin explícito
    const { data: admin } = await supabase
        .from('competition_admins')
        .select('id')
        .eq('competition_id', competitionId)
        .eq('user_id', userId)
        .maybeSingle();

    return !!admin;
}

/**
 * Crea una nueva competición
 * @param {Object} competitionData - Datos de la competición
 * @param {string} competitionData.name - Nombre de la competición
 * @param {string} competitionData.slug - Slug único
 * @param {string} competitionData.season - Temporada (ej: '2025-26')
 * @param {string} competitionData.competition_type - Tipo: 'league', 'cup', 'mixed'
 * @param {string} competitionData.league_format - Formato de liga: 'single_round', 'double_round' (solo si es league o mixed) - Se usa para construir type_config
 * @param {string} competitionData.cup_format - Formato de copa: 'single_match', 'double_match_except_final' (solo si es cup o mixed) - Se usa para construir type_config
 * @param {number} competitionData.num_groups - Número de grupos (solo si es mixed) - Se usa para construir type_config
 * @param {string} competitionData.description - Descripción opcional
 * @param {boolean} competitionData.is_official - Si es oficial
 * @param {Object} competitionData.config - Configuración adicional en JSON (para campos extra como has_third_place_match)
 * @returns {Promise<{success: boolean, competition?: Object, error?: string}>}
 */
export async function createCompetition(competitionData) {
    const user = await getCurrentUser();
    if (!user) {
        return { success: false, error: 'Debes estar logueado para crear competiciones' };
    }

    // Verificar permisos
    const canCreate = await canCreateCompetition(competitionData.competition_type);
    if (!canCreate.canCreate) {
        return { success: false, error: canCreate.reason };
    }

    const supabase = await getSupabaseClient();

    try {
        // Construir type_config según el tipo de competición
        let typeConfig = {};

        if (competitionData.competition_type === 'league') {
            typeConfig = {
                format: competitionData.league_format || 'double_round',
                points_win: competitionData.league_points_win !== undefined ? competitionData.league_points_win : 3,
                points_draw: competitionData.league_points_draw !== undefined ? competitionData.league_points_draw : 1,
                points_loss: competitionData.league_points_loss !== undefined ? competitionData.league_points_loss : 0,
                tiebreaker: competitionData.league_tiebreaker && competitionData.league_tiebreaker.length > 0
                    ? competitionData.league_tiebreaker
                    : ['points', 'goal_difference', 'goals_for', 'head_to_head']
            };
        } else if (competitionData.competition_type === 'cup') {
            typeConfig = {
                format: competitionData.cup_format || 'single_match',
                has_third_place_match: competitionData.cup_has_third_place_match || false,
                is_double_elimination: competitionData.cup_is_double_elimination || false,
                away_goals_rule: competitionData.cup_away_goals_rule !== undefined ? competitionData.cup_away_goals_rule : true,
                extra_time: competitionData.cup_extra_time !== undefined ? competitionData.cup_extra_time : true,
                penalties: competitionData.cup_penalties !== undefined ? competitionData.cup_penalties : true
            };
        } else if (competitionData.competition_type === 'mixed') {
            typeConfig = {
                num_groups: competitionData.num_groups || 4,
                teams_per_group: competitionData.teams_per_group || 4,
                qualifiers_per_group: competitionData.qualifiers_per_group || 2,
                group_phase_format: competitionData.league_format || 'double_round',
                knockout_format: competitionData.cup_format || 'double_match_except_final',
                points_win: competitionData.mixed_points_win !== undefined ? competitionData.mixed_points_win : 3,
                points_draw: competitionData.mixed_points_draw !== undefined ? competitionData.mixed_points_draw : 1,
                points_loss: competitionData.mixed_points_loss !== undefined ? competitionData.mixed_points_loss : 0,
                tiebreaker: competitionData.mixed_tiebreaker && competitionData.mixed_tiebreaker.length > 0
                    ? competitionData.mixed_tiebreaker
                    : ['points', 'goal_difference', 'goals_for', 'head_to_head'],
                is_double_elimination: competitionData.mixed_is_double_elimination || false,
                has_third_place_match: competitionData.mixed_has_third_place_match || false,
                away_goals_rule: competitionData.mixed_away_goals_rule !== undefined ? competitionData.mixed_away_goals_rule : true,
                extra_time: competitionData.mixed_extra_time !== undefined ? competitionData.mixed_extra_time : true,
                penalties: competitionData.mixed_penalties !== undefined ? competitionData.mixed_penalties : true,
                groups: []
            };
        } else if (competitionData.competition_type === 'ranked') {
            typeConfig = {
                initial_rating: competitionData.ranked_initial_rating || 1000,
                k_factor: competitionData.ranked_k_factor || 100,
                allow_draws: competitionData.ranked_allow_draws !== false
            };
        }

        // Validar max_teams - siempre debe tener un valor, por defecto 2
        let maxTeams = 2; // Valor por defecto (mínimo)

        if (competitionData.max_teams !== undefined && competitionData.max_teams !== null) {
            const maxTeamsNum = parseInt(competitionData.max_teams, 10);
            if (isNaN(maxTeamsNum) || maxTeamsNum < 2) {
                return { success: false, error: 'El máximo de equipos debe ser al menos 2.' };
            }
            if (maxTeamsNum > 32) {
                return { success: false, error: 'El máximo de equipos no puede ser mayor a 32.' };
            }
            maxTeams = maxTeamsNum;
        }

        // Preparar datos de la competición
        const newCompetition = {
            name: competitionData.name,
            slug: competitionData.slug,
            season: competitionData.season,
            competition_type: competitionData.competition_type,
            status: 'draft', // Iniciar como borrador
            creator_id: user.id,
            is_official: competitionData.is_official || false,
            description: competitionData.description || null,
            is_public: competitionData.is_public !== undefined ? competitionData.is_public : true,
            max_teams: maxTeams,
            type_config: typeConfig
        };

        // Añadir config adicional si existe (para campos que no van en type_config)
        if (competitionData.config) {
            newCompetition.config = competitionData.config;
        }

        // Crear la competición
        const { data: competition, error: createError } = await supabase
            .from('competitions')
            .insert(newCompetition)
            .select()
            .single();

        if (createError) {
            console.error('Error creando competición:', createError);
            return { success: false, error: `Error creando competición: ${createError.message}` };
        }

        // Consumir monedas (excepto super admin)
        const profile = await getCurrentProfile();
        if (!profile?.is_super_admin) {
            const requiredCoins = canCreate.requiredCoins || 0;
            if (requiredCoins > 0) {
                const { error: coinsError } = await supabase
                    .from('profiles')
                    .update({ coins: (profile.coins || 0) - requiredCoins })
                    .eq('id', user.id);

                if (coinsError) {
                    console.error('Error consumiendo monedas:', coinsError);
                    // No fallar la creación, solo loguear el error
                }
            }
        }

        // NOTA: El calendario se generará cuando se añadan equipos a la competición
        // No se genera automáticamente aquí para permitir que el admin configure primero

        return { success: true, competition };
    } catch (e) {
        console.error('Excepción creando competición:', e);
        return { success: false, error: `Error inesperado: ${e.message}` };
    }
}

/**
 * Genera el calendario de una competición después de que se hayan añadido equipos
 * @param {number} competitionId - ID de la competición
 * @param {Array<number>} teamIds - Array de league_team_ids
 * @param {Object} [options] - Opciones del calendario
 * @param {string} [options.startDate] - YYYY-MM-DD, fecha de inicio de la jornada 1
 * @returns {Promise<{success: boolean, matchesCreated?: number, error?: string}>}
 */
export async function generateScheduleForCompetition(competitionId, teamIds, options = {}) {
    const supabase = await getSupabaseClient();

    // Obtener datos de la competición
    const { data: competition, error: compError } = await supabase
        .from('competitions')
        .select('*')
        .eq('id', competitionId)
        .single();

    if (compError || !competition) {
        return { success: false, error: 'No se pudo obtener la competición' };
    }

    // Importar y usar el generador de calendarios
    const { generateCompetitionSchedule } = await import('./competition-schedule-generator.js');
    return await generateCompetitionSchedule(competitionId, competition, teamIds, options);
}

/**
 * Obtiene las monedas del usuario actual
 * @returns {Promise<number>}
 */
export async function getUserCoins() {
    const profile = await getCurrentProfile();
    return profile?.coins || 0;
}

/**
 * Obtiene todas las competiciones donde el usuario actual es admin
 * Incluye competiciones donde es creator, admin explícito, o super admin (todas)
 * @returns {Promise<Array>} Array de competiciones con información de admin
 */
export async function getUserAdminCompetitions() {
    const user = await getCurrentUser();
    if (!user) return [];

    const supabase = await getSupabaseClient();
    const profile = await getCurrentProfile();

    // Si es super admin, devolver todas las competiciones
    if (profile?.is_super_admin) {
        const { data: allCompetitions, error } = await supabase
            .from('competitions')
            .select('id, name, slug, season, competition_type, status, creator_id')
            .order('created_at', { ascending: false });

        if (error) {
            console.error('Error obteniendo competiciones (super admin):', error);
            return [];
        }

        return (allCompetitions || []).map(comp => ({
            ...comp,
            is_creator: comp.creator_id === user.id,
            is_super_admin: true
        }));
    }

    // Obtener competiciones donde es creator
    const { data: creatorCompetitions, error: creatorError } = await supabase
        .from('competitions')
        .select('id, name, slug, season, competition_type, status, creator_id')
        .eq('creator_id', user.id)
        .order('created_at', { ascending: false });

    if (creatorError) {
        console.error('Error obteniendo competiciones como creator:', creatorError);
    }

    // Obtener competiciones donde es admin explícito
    const { data: adminCompetitions, error: adminError } = await supabase
        .from('competition_admins')
        .select(`
            competition_id,
            competition:competitions(id, name, slug, season, competition_type, status, creator_id)
        `)
        .eq('user_id', user.id);

    if (adminError) {
        console.error('Error obteniendo competiciones como admin:', adminError);
    }

    // Combinar y deduplicar
    const competitionsMap = new Map();

    // Añadir competiciones donde es creator
    (creatorCompetitions || []).forEach(comp => {
        competitionsMap.set(comp.id, {
            ...comp,
            is_creator: true,
            is_super_admin: false
        });
    });

    // Añadir competiciones donde es admin explícito (sin sobrescribir si ya está como creator)
    (adminCompetitions || []).forEach(item => {
        if (item.competition && !competitionsMap.has(item.competition.id)) {
            competitionsMap.set(item.competition.id, {
                ...item.competition,
                is_creator: item.competition.creator_id === user.id,
                is_super_admin: false
            });
        }
    });

    return Array.from(competitionsMap.values());
}

/**
 * Verifica si el usuario actual puede actualizar la apariencia (tema y logo) de una competición
 * Solo el creador de la competición o un super admin pueden hacerlo
 * @param {number} competitionId - ID de la competición
 * @returns {Promise<{canUpdate: boolean, reason?: string}>}
 */
export async function canUpdateCompetitionAppearance(competitionId) {
    const user = await getCurrentUser();
    if (!user) {
        return { canUpdate: false, reason: 'Debes estar logueado para actualizar la apariencia' };
    }

    const profile = await getCurrentProfile();
    if (!profile) {
        return { canUpdate: false, reason: 'No se pudo obtener el perfil del usuario' };
    }

    // Super admin puede actualizar cualquier competición
    if (profile.is_super_admin) {
        return { canUpdate: true };
    }

    // Verificar si es admin de la competición
    const isAdmin = await isCompetitionAdmin(competitionId);
    if (isAdmin) {
        return { canUpdate: true };
    }

    return { canUpdate: false, reason: 'No tienes permisos para actualizar la apariencia de esta competición' };
}

