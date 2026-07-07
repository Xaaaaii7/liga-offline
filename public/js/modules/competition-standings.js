/**
 * Módulo para generar clasificaciones según el tipo de competición
 * 
 * IMPORTANTE: No modifica la lógica existente de clasificaciones de liga
 * Solo proporciona funciones helper para futuras implementaciones de Copa y Mixto
 */

import { getSupabaseClient } from './supabase-client.js';
import { queryTable } from './db-helpers.js';

/**
 * Obtiene la clasificación de una competición según su tipo
 * @param {number} competitionId - ID de la competición
 * @returns {Promise<{type: string, data: Object}>}
 */
export async function getCompetitionStandings(competitionId) {
    const supabase = await getSupabaseClient();

    // Obtener tipo de competición. Para mixed leemos también type_config porque
    // las opciones de eliminatoria (is_double_elimination, has_third_place_match,
    // points/tiebreaker, etc.) se persisten ahí, mientras que la composición
    // de los grupos se persiste en `config` (saveGroupsConfig).
    const { data: competition, error } = await supabase
        .from('competitions')
        .select('competition_type, config, type_config')
        .eq('id', competitionId)
        .single();

    if (error || !competition) {
        throw new Error('No se pudo obtener la competición');
    }

    const type = competition.competition_type;

    switch (type) {
        case 'league':
            return await getLeagueStandings(competitionId);
        case 'cup':
            return await getCupBracket(competitionId);
        case 'mixed': {
            // Merge: legacy config aporta `groups`, type_config aporta el resto.
            // type_config gana en colisión por ser la fuente de verdad actual.
            const merged = { ...(competition.config || {}), ...(competition.type_config || {}) };
            return await getMixedStandings(competitionId, merged);
        }
        case 'ranked':
            return await getRankedStandings(competitionId);
        default:
            throw new Error(`Tipo de competición no soportado: ${type}`);
    }
}

/**
 * Obtiene la clasificación de liga (usa la lógica existente)
 * @param {number} competitionId
 * @returns {Promise<{type: 'league', data: Array}>}
 */
async function getLeagueStandings(competitionId) {
    // NOTA: La lógica existente de clasificaciones de liga ya funciona
    // Esta función es un wrapper para mantener consistencia
    // En el futuro, se puede migrar aquí la lógica existente

    // Por ahora, retornamos un placeholder que indica que se debe usar la lógica existente
    return {
        type: 'league',
        data: {
            message: 'Usar lógica existente de clasificaciones',
            competitionId
        }
    };
}

/**
 * Obtiene el bracket/cuadro eliminatorio de una copa
 * @param {number} competitionId
 * @returns {Promise<{type: 'cup', data: Object}>}
 */
async function getCupBracket(competitionId) {
    const supabase = await getSupabaseClient();

    // Obtener configuración de la competición
    const { data: competition, error: compError } = await supabase
        .from('competitions')
        .select('type_config')
        .eq('id', competitionId)
        .single();

    const typeConfig = competition?.type_config || {};
    const hasThirdPlaceMatch = typeConfig.has_third_place_match || false;
    const penaltiesEnabled = typeConfig.penalties !== undefined ? typeConfig.penalties : true; // Por defecto true
    const awayGoalsRule = typeConfig.away_goals_rule !== undefined ? typeConfig.away_goals_rule : true; // Por defecto true
    const isDoubleElimination = typeConfig.is_double_elimination || false; // ✨ DOBLE ELIMINACIÓN

    // Obtener número total de equipos en la competición
    const { count: totalTeamsCount } = await supabase
        .from('competition_teams')
        .select('*', { count: 'exact', head: true })
        .eq('competition_id', competitionId)
        .in('status', ['approved', 'active']);

    const totalTeams = totalTeamsCount || 0;

    // ✨ Obtener todos los partidos de copa con bracket_type
    const matches = await queryTable('matches', `
        id,
        cup_round,
        cup_leg,
        bracket_type,
        is_cup_final,
        is_third_place_match,
        has_penalties,
        penalties_winner_id,
        home_league_team_id,
        away_league_team_id,
        home_goals,
        away_goals,
        home:league_teams!matches_home_league_team_id_fkey(id, nickname, display_name),
        away:league_teams!matches_away_league_team_id_fkey(id, nickname, display_name),
        penalties_winner:league_teams!matches_penalties_winner_id_fkey(id, nickname, display_name)
    `, {
        competitionId,
        filters: { round_type: 'cup' },
        order: { column: 'cup_round', ascending: true }
    });

    // ✨ DOBLE ELIMINACIÓN: Separar partidos por bracket_type
    if (isDoubleElimination) {
        const winnerMatches = matches.filter(m => m.bracket_type === 'winner');
        const loserMatches = matches.filter(m => m.bracket_type === 'loser');

        // Organizar partidos del Winner Bracket
        const winnerRounds = {};
        winnerMatches.forEach(match => {
            const round = match.cup_round || 1;
            if (!winnerRounds[round]) {
                winnerRounds[round] = [];
            }
            winnerRounds[round].push(match);
        });

        // Organizar partidos del Loser Bracket
        const loserRounds = {};
        loserMatches.forEach(match => {
            const round = match.cup_round || 1;
            if (!loserRounds[round]) {
                loserRounds[round] = [];
            }
            loserRounds[round].push(match);
        });

        // ✅ Construir brackets separados
        // Para Winner Bracket: usar totalTeams para generar estructura completa
        const winnerBracket = buildBracketFromMatches(winnerRounds, totalTeams, false, null, penaltiesEnabled, awayGoalsRule);

        // ✅ Para Loser Bracket: pasar -1 para indicar que solo debe mostrar rondas existentes
        // (el loser bracket no tiene estructura predecible desde el inicio)
        const loserBracket = buildBracketFromMatches(loserRounds, -1, false, null, penaltiesEnabled, awayGoalsRule);

        return {
            type: 'cup',
            data: {
                isDoubleElimination: true,
                winnerBracket,
                loserBracket,
                bracket: winnerBracket, // Para compatibilidad
                competitionId,
                totalTeams,
                penaltiesEnabled,
                awayGoalsRule
            }
        };
    }

    // Copa normal (sin doble eliminación)
    const rounds = {};
    let thirdPlaceMatch = null;

    matches.forEach(match => {
        // Separar partido del tercer puesto
        if (match.is_third_place_match) {
            thirdPlaceMatch = match;
        } else {
            const round = match.cup_round || 1;
            if (!rounds[round]) {
                rounds[round] = [];
            }
            rounds[round].push(match);
        }
    });

    // Determinar ganadores y construir el bracket (con totalTeams para generar rondas futuras)
    const bracket = buildBracketFromMatches(rounds, totalTeams, hasThirdPlaceMatch, thirdPlaceMatch, penaltiesEnabled, awayGoalsRule);

    return {
        type: 'cup',
        data: {
            rounds,
            bracket,
            competitionId,
            totalTeams,
            hasThirdPlaceMatch,
            penaltiesEnabled,
            awayGoalsRule
        }
    };
}

/**
 * Obtiene las clasificaciones de competición mixta (grupos + bracket)
 * @param {number} competitionId
 * @param {Object} config
 * @returns {Promise<{type: 'mixed', data: Object}>}
 */
async function getMixedStandings(competitionId, config) {
    // Obtener partidos de grupos
    const groupMatches = await queryTable('matches', `
        id,
        group_name,
        home_league_team_id,
        away_league_team_id,
        home_goals,
        away_goals,
        home:league_teams!matches_home_league_team_id_fkey(id, nickname, display_name),
        away:league_teams!matches_away_league_team_id_fkey(id, nickname, display_name)
    `, {
        competitionId,
        filters: { round_type: 'group' },
        order: { column: 'group_name', ascending: true }
    });

    // Calcular clasificaciones por grupo (pasar typeConfig completo para usar puntos y tiebreaker)
    const groupStandings = calculateGroupStandings(groupMatches, config?.groups || [], config, null);

    const penaltiesEnabled = config?.penalties !== undefined ? config.penalties : true;
    const awayGoalsRule = config?.away_goals_rule !== undefined ? config.away_goals_rule : true;
    const hasThirdPlaceMatch = config?.has_third_place_match || false;
    const isDoubleElimination = config?.is_double_elimination || false;

    // Obtener bracket de eliminatoria con los mismos campos que cup
    const knockoutMatches = await queryTable('matches', `
        id,
        cup_round,
        cup_leg,
        bracket_type,
        is_cup_final,
        is_third_place_match,
        has_penalties,
        penalties_winner_id,
        home_league_team_id,
        away_league_team_id,
        home_goals,
        away_goals,
        home:league_teams!matches_home_league_team_id_fkey(id, nickname, display_name),
        away:league_teams!matches_away_league_team_id_fkey(id, nickname, display_name),
        penalties_winner:league_teams!matches_penalties_winner_id_fkey(id, nickname, display_name)
    `, {
        competitionId,
        filters: { round_type: 'cup' },
        order: { column: 'cup_round', ascending: true }
    });

    if (isDoubleElimination) {
        const winnerMatches = knockoutMatches.filter(m => m.bracket_type === 'winner');
        const loserMatches = knockoutMatches.filter(m => m.bracket_type === 'loser');

        const winnerRounds = {};
        winnerMatches.forEach(match => {
            const round = match.cup_round || 1;
            if (!winnerRounds[round]) winnerRounds[round] = [];
            winnerRounds[round].push(match);
        });

        const loserRounds = {};
        loserMatches.forEach(match => {
            const round = match.cup_round || 1;
            if (!loserRounds[round]) loserRounds[round] = [];
            loserRounds[round].push(match);
        });

        const winnerBracket = winnerMatches.length > 0
            ? buildBracketFromMatches(winnerRounds, 0, false, null, penaltiesEnabled, awayGoalsRule)
            : null;
        // Loser bracket: -1 indica que solo se muestren rondas existentes (no tiene estructura predecible)
        const loserBracket = loserMatches.length > 0
            ? buildBracketFromMatches(loserRounds, -1, false, null, penaltiesEnabled, awayGoalsRule)
            : null;

        return {
            type: 'mixed',
            data: {
                groups: groupStandings,
                isDoubleElimination: true,
                winnerBracket,
                loserBracket,
                bracket: winnerBracket, // compat con consumidores que esperan `bracket`
                competitionId,
                penaltiesEnabled,
                awayGoalsRule
            }
        };
    }

    // Eliminatoria simple: separar partido del tercer puesto antes de montar el bracket
    const rounds = {};
    let thirdPlaceMatch = null;
    knockoutMatches.forEach(match => {
        if (match.is_third_place_match) {
            thirdPlaceMatch = match;
        } else {
            const round = match.cup_round || 1;
            if (!rounds[round]) rounds[round] = [];
            rounds[round].push(match);
        }
    });

    const bracket = knockoutMatches.length > 0
        ? buildBracketFromMatches(rounds, 0, hasThirdPlaceMatch, thirdPlaceMatch, penaltiesEnabled, awayGoalsRule)
        : null;

    return {
        type: 'mixed',
        data: {
            groups: groupStandings,
            bracket,
            hasThirdPlaceMatch,
            competitionId,
            penaltiesEnabled,
            awayGoalsRule
        }
    };
}

/**
 * Calcula las clasificaciones de los grupos
 * @param {Array} matches
 * @param {Array} groupsConfig
 * @param {Map} teamMap - Mapa de team_id -> team info (opcional)
 * @returns {Object}
 */
export function calculateGroupStandings(matches, groupsConfig, typeConfig = null, teamMap = null) {
    const standings = {};

    // Inicializar clasificaciones por grupo
    groupsConfig.forEach(group => {
        standings[group.name] = {};
        group.teams.forEach(teamId => {
            const teamInfo = teamMap ? teamMap.get(teamId) : null;
            standings[group.name][teamId] = {
                team_id: teamId,
                team_name: teamInfo?.display_name || teamInfo?.nickname || null,
                played: 0,
                won: 0,
                drawn: 0,
                lost: 0,
                goals_for: 0,
                goals_against: 0,
                goal_difference: 0,
                points: 0
            };
        });
    });

    // Procesar partidos
    matches.forEach(match => {
        if (!match.group_name || !match.home_goals || !match.away_goals) return;

        const group = standings[match.group_name];
        if (!group) return;

        const homeTeam = group[match.home_league_team_id];
        const awayTeam = group[match.away_league_team_id];

        if (!homeTeam || !awayTeam) return;

        // Actualizar estadísticas
        homeTeam.played++;
        awayTeam.played++;
        homeTeam.goals_for += match.home_goals;
        homeTeam.goals_against += match.away_goals;
        awayTeam.goals_for += match.away_goals;
        awayTeam.goals_against += match.home_goals;

        // ✅ Usar valores de type_config para puntos (si están disponibles)
        const pointsWin = typeConfig?.points_win ?? 3;
        const pointsDraw = typeConfig?.points_draw ?? 1;
        const pointsLoss = typeConfig?.points_loss ?? 0;

        if (match.home_goals > match.away_goals) {
            homeTeam.won++;
            homeTeam.points += pointsWin;
            awayTeam.lost++;
            awayTeam.points += pointsLoss;
        } else if (match.home_goals < match.away_goals) {
            awayTeam.won++;
            awayTeam.points += pointsWin;
            homeTeam.lost++;
            homeTeam.points += pointsLoss;
        } else {
            homeTeam.drawn++;
            awayTeam.drawn++;
            homeTeam.points += pointsDraw;
            awayTeam.points += pointsDraw;
        }

        homeTeam.goal_difference = homeTeam.goals_for - homeTeam.goals_against;
        awayTeam.goal_difference = awayTeam.goals_for - awayTeam.goals_against;
    });

    // ✅ Ordenar cada grupo usando criterios de desempate de type_config
    const tiebreaker = typeConfig?.tiebreaker ?? ['points', 'goal_difference', 'goals_for', 'head_to_head'];

    const sortedStandings = {};
    Object.keys(standings).forEach(groupName => {
        const group = standings[groupName];
        sortedStandings[groupName] = Object.values(group).sort((a, b) => {
            // Aplicar cada criterio de desempate en orden
            for (const criterion of tiebreaker) {
                if (criterion === 'points') {
                    if (b.points !== a.points) return b.points - a.points;
                } else if (criterion === 'goal_difference') {
                    if (b.goal_difference !== a.goal_difference) return b.goal_difference - a.goal_difference;
                } else if (criterion === 'goals_for') {
                    if (b.goals_for !== a.goals_for) return b.goals_for - a.goals_for;
                } else if (criterion === 'head_to_head') {
                    // TODO: Implementar head_to_head si es necesario
                    // Por ahora, continuar con el siguiente criterio
                }
            }
            // Si todos los criterios son iguales, mantener orden original
            return 0;
        });
    });

    return sortedStandings;
}

/**
 * Organiza partidos por ronda
 * @param {Array} matches
 * @returns {Object}
 */
function organizeMatchesByRound(matches) {
    const rounds = {};
    matches.forEach(match => {
        const round = match.cup_round || 1;
        if (!rounds[round]) {
            rounds[round] = [];
        }
        rounds[round].push(match);
    });
    return rounds;
}

/**
 * Construye el bracket desde los partidos organizados por rondas
 * Genera todas las rondas posibles aunque no tengan partidos aún
 * @param {Object} rounds - Partidos organizados por ronda
 * @param {number} totalTeams - Número total de equipos en la competición
 *                              - Si es > 0: genera estructura predecible
 *                              - Si es 0 o -1: solo muestra rondas existentes
 * @param {boolean} hasThirdPlaceMatch - Si se debe incluir partido del tercer puesto
 * @param {Object} thirdPlaceMatch - Partido del tercer puesto existente (si existe)
 * @param {boolean} penaltiesEnabled - Si los penaltis están habilitados en la configuración
 * @param {boolean} awayGoalsRule - Si la regla de goles fuera de casa está habilitada
 * @returns {Object}
 */
function buildBracketFromMatches(rounds, totalTeams = 0, hasThirdPlaceMatch = false, thirdPlaceMatch = null, penaltiesEnabled = true, awayGoalsRule = true) {
    const bracket = {
        rounds: [],
        final: null,
        thirdPlace: null
    };

    // ✅ Modo "solo rondas existentes" si totalTeams <= 0
    const onlyExistingRounds = totalTeams <= 0;

    // Calcular número total de rondas necesarias
    let numRounds = 0;
    if (totalTeams > 0) {
        // IMPORTANTE: Usar la potencia de 2 más cercana para calcular rondas
        // Esto es necesario cuando hay byes (equipos que no juegan la primera ronda)
        // 
        // Ejemplos:
        // - 6 equipos → 8 (potencia de 2) → 3 rondas
        // - 8 equipos → 8 (potencia de 2) → 3 rondas
        // - 5 equipos → 8 (potencia de 2) → 3 rondas
        // - 10 equipos → 16 (potencia de 2) → 4 rondas
        const nextPowerOf2 = Math.pow(2, Math.ceil(Math.log2(totalTeams)));
        let teams = nextPowerOf2;
        while (teams > 1) {
            numRounds++;
            teams = Math.floor(teams / 2);
        }
    } else {
        // ✅ Si solo mostramos rondas existentes, usar la ronda más alta
        const existingRounds = Object.keys(rounds).map(r => Number(r));
        numRounds = existingRounds.length > 0 ? Math.max(...existingRounds) : 0;
    }

    // Generar todas las rondas, incluyendo las que aún no tienen partidos
    for (let roundNum = 1; roundNum <= numRounds; roundNum++) {
        const roundMatches = rounds[roundNum] || [];
        const numMatchesInRound = roundMatches.length;
        const expectedMatches = Math.floor(totalTeams / Math.pow(2, roundNum));

        // Determinar si es la final
        const isFinal = roundNum === numRounds || (roundMatches.length > 0 && roundMatches[0]?.is_cup_final);

        // Si no hay partidos en esta ronda, generar partidos placeholder
        let matches = [];

        if (roundMatches.length > 0) {
            // Hay partidos reales, mapearlos
            // Si hay doble partido (ida y vuelta), agrupar por pareja de equipos
            const matchesByPair = new Map();

            roundMatches.forEach(match => {
                // Crear clave única para el emparejamiento (independiente del orden)
                // ✅ Incluir partidos incluso si tienen equipos NULL (para mostrar todo el cuadro)
                const team1 = match.home_league_team_id;
                const team2 = match.away_league_team_id;
                // Si ambos son NULL, usar el ID del partido como clave única
                const pairKey = (team1 && team2) 
                    ? `${Math.min(team1, team2)}-${Math.max(team1, team2)}`
                    : match.id;

                if (!matchesByPair.has(pairKey)) {
                    matchesByPair.set(pairKey, []);
                }
                matchesByPair.get(pairKey).push(match);
            });

            // Convertir a array de partidos, agrupando ida y vuelta si es necesario
            let eliminatoriaCounter = 1;
            matchesByPair.forEach((pairMatches, pairKey) => {
                // Ordenar por leg: first, second, final, null
                pairMatches.sort((a, b) => {
                    const legOrder = { 'first': 1, 'second': 2, 'final': 3, null: 0 };
                    return (legOrder[a.cup_leg] || 0) - (legOrder[b.cup_leg] || 0);
                });

                // Si hay múltiples partidos (ida y vuelta), usar el primero para mostrar
                // o combinar los resultados
                const primaryMatch = pairMatches[0];
                const hasTwoLegs = pairMatches.length > 1;

                // Obtener has_penalties y penalties_winner_id de cualquier partido de la eliminatoria (deberían ser iguales)
                let hasPenalties = pairMatches.some(m => m.has_penalties === true);
                let penaltiesWinnerId = pairMatches.find(m => m.penalties_winner_id)?.penalties_winner_id || null;
                let penaltiesWinner = pairMatches.find(m => m.penalties_winner)?.penalties_winner || null;

                // Calcular ganador: si hay doble partido, usar lógica de ida y vuelta
                let winner = null;
                let isTied = false;

                if (hasTwoLegs) {
                    const ida = pairMatches.find(m => m.cup_leg === 'first');
                    const vuelta = pairMatches.find(m => m.cup_leg === 'second');

                    if (ida && vuelta &&
                        ida.home_goals !== null && ida.away_goals !== null &&
                        vuelta.home_goals !== null && vuelta.away_goals !== null) {
                        // Calcular marcador agregado
                        const totalHome = ida.home_goals + vuelta.away_goals;
                        const totalAway = ida.away_goals + vuelta.home_goals;

                        if (totalHome > totalAway) {
                            winner = ida.home_league_team_id;
                        } else if (totalAway > totalHome) {
                            winner = ida.away_league_team_id;
                        } else {
                            // Empate en marcador agregado
                            isTied = true;

                            // Si la regla de goles fuera de casa está habilitada, aplicarla
                            if (awayGoalsRule) {
                                const awayGoalsHome = ida.away_goals;
                                const awayGoalsAway = vuelta.away_goals;

                                if (awayGoalsHome > awayGoalsAway) {
                                    winner = ida.home_league_team_id;
                                } else if (awayGoalsAway > awayGoalsHome) {
                                    winner = ida.away_league_team_id;
                                } else {
                                    // Empate total: si hay penaltis habilitados, el ganador se determina por penaltis
                                    if (penaltiesEnabled && hasPenalties && penaltiesWinnerId) {
                                        // El ganador es el que ganó los penaltis
                                        winner = penaltiesWinnerId;
                                    } else if (penaltiesEnabled && hasPenalties) {
                                        // Hay penaltis pero no se ha marcado el ganador aún
                                        winner = null;
                                    } else if (penaltiesEnabled) {
                                        // Penaltis habilitados pero aún no marcados
                                        winner = null;
                                    } else {
                                        // Penaltis deshabilitados: usar el ganador del segundo partido (vuelta) como fallback
                                        if (vuelta.home_goals > vuelta.away_goals) {
                                            winner = vuelta.home_league_team_id;
                                        } else if (vuelta.away_goals > vuelta.home_goals) {
                                            winner = vuelta.away_league_team_id;
                                        }
                                    }
                                }
                            } else {
                                // Regla de goles fuera de casa deshabilitada: ir directamente a penaltis o prórroga
                                if (penaltiesEnabled && hasPenalties && penaltiesWinnerId) {
                                    winner = penaltiesWinnerId;
                                } else if (penaltiesEnabled && hasPenalties) {
                                    winner = null;
                                } else if (penaltiesEnabled) {
                                    winner = null;
                                } else {
                                    // Sin penaltis ni regla de goles fuera: usar el ganador del segundo partido (vuelta)
                                    if (vuelta.home_goals > vuelta.away_goals) {
                                        winner = vuelta.home_league_team_id;
                                    } else if (vuelta.away_goals > vuelta.home_goals) {
                                        winner = vuelta.away_league_team_id;
                                    }
                                }
                            }
                        }
                    }
                } else {
                    winner = determineWinner(primaryMatch);
                    // Para partido único, verificar si hay empate
                    if (primaryMatch.home_goals !== null && primaryMatch.away_goals !== null) {
                        isTied = primaryMatch.home_goals === primaryMatch.away_goals;
                    }
                    // Para partido único, has_penalties y penalties_winner_id vienen del partido mismo
                    if (primaryMatch.has_penalties) {
                        hasPenalties = true;
                    }
                    if (primaryMatch.penalties_winner_id) {
                        penaltiesWinnerId = primaryMatch.penalties_winner_id;
                        penaltiesWinner = primaryMatch.penalties_winner;
                    }
                    // Si hay empate y penaltis habilitados, el ganador es el de los penaltis
                    if (isTied && penaltiesEnabled && hasPenalties && penaltiesWinnerId) {
                        winner = penaltiesWinnerId;
                    } else if (isTied && penaltiesEnabled && hasPenalties) {
                        // Empate con penaltis pero sin ganador aún
                        winner = null;
                    } else if (isTied && penaltiesEnabled) {
                        // Empate con penaltis habilitados pero no marcados
                        winner = null;
                    }
                }

                // ✅ Incluir partidos incluso si tienen equipos NULL
                // Si no hay equipos, mostrar "TBD" o "Por determinar"
                const homeTeam = primaryMatch.home || (primaryMatch.home_league_team_id ? null : {
                    nickname: 'TBD',
                    display_name: 'Por determinar'
                });
                const awayTeam = primaryMatch.away || (primaryMatch.away_league_team_id ? null : {
                    nickname: 'TBD',
                    display_name: 'Por determinar'
                });
                
                matches.push({
                    id: primaryMatch.id,
                    home_team: homeTeam,
                    away_team: awayTeam,
                    home_goals: primaryMatch.home_goals,
                    away_goals: primaryMatch.away_goals,
                    winner: winner,
                    leg: primaryMatch.cup_leg,
                    cup_round: primaryMatch.cup_round,  // IMPORTANTE: Para generación automática de rondas
                    round: roundNum,  // Número de ronda actual
                    eliminatoria_number: eliminatoriaCounter++,
                    all_legs: hasTwoLegs ? pairMatches : undefined,
                    has_penalties: hasPenalties,
                    penalties_winner_id: penaltiesWinnerId,
                    penalties_winner: penaltiesWinner,
                    is_tied: isTied,
                    penalties_enabled: penaltiesEnabled, // Pasar la configuración al bracket
                    // Guardar IDs de todos los partidos de la eliminatoria para poder actualizar has_penalties
                    eliminatoria_match_ids: pairMatches.map(m => m.id),
                    // Guardar IDs de los equipos para el selector de ganador de penaltis
                    home_team_id: primaryMatch.home_league_team_id,
                    away_team_id: primaryMatch.away_league_team_id
                });
            });

            // Ordenar por eliminatoria_number para mantener consistencia
            matches.sort((a, b) => a.eliminatoria_number - b.eliminatoria_number);
        } else {
            // ✅ Si estamos en modo "solo rondas existentes", saltar rondas vacías
            if (onlyExistingRounds) {
                // No generar placeholders para rondas sin partidos en brackets dinámicos (como Loser Bracket)
                continue;
            }

            // No hay partidos aún, generar placeholders
            // Calcular cuántos partidos debería haber en esta ronda
            const numPlaceholderMatches = expectedMatches > 0 ? expectedMatches : Math.floor(totalTeams / Math.pow(2, roundNum));

            for (let i = 0; i < numPlaceholderMatches; i++) {
                // Calcular qué eliminatorias de la ronda anterior alimentan esta
                const prevRound = roundNum - 1;

                // En la primera ronda, no hay referencias previas
                if (prevRound === 0) {
                    matches.push({
                        id: null,
                        home_team: null,
                        away_team: null,
                        home_goals: null,
                        away_goals: null,
                        winner: null,
                        leg: null,
                        eliminatoria_number: i + 1,
                        placeholder: true,
                        penalties_enabled: penaltiesEnabled // Pasar la configuración también a placeholders
                    });
                } else {
                    // Calcular qué eliminatorias de la ronda anterior se enfrentan
                    // En una copa estándar, el partido i de la ronda actual viene de:
                    // - Eliminatoria (2*i + 1) vs Eliminatoria (2*i + 2) de la ronda anterior
                    const elim1 = (2 * i) + 1;
                    const elim2 = (2 * i) + 2;

                    // Determinar el nombre de la ronda anterior para el texto
                    const prevRoundName = getRoundNameForPlaceholder(prevRound, totalTeams);

                    matches.push({
                        id: null,
                        home_team: {
                            nickname: `Ganador Eliminatoria ${elim1}`,
                            display_name: `Ganador Eliminatoria ${elim1}`
                        },
                        away_team: {
                            nickname: `Ganador Eliminatoria ${elim2}`,
                            display_name: `Ganador Eliminatoria ${elim2}`
                        },
                        home_goals: null,
                        away_goals: null,
                        winner: null,
                        leg: null,
                        eliminatoria_number: i + 1,
                        placeholder: true,
                        penalties_enabled: penaltiesEnabled // Pasar la configuración también a placeholders
                    });
                }
            }
        }

        // ✅ Solo añadir rondas que tienen partidos
        if (matches.length === 0) {
            continue;
        }

        const roundData = {
            round: roundNum,
            matches: matches
        };

        if (isFinal) {
            bracket.final = roundData;
        } else {
            bracket.rounds.push(roundData);
        }
    }

    // Generar partido del tercer puesto si está habilitado
    if (hasThirdPlaceMatch) {
        // El partido del tercer puesto enfrenta a los perdedores de las semifinales
        // Las semifinales son la penúltima ronda (antes de la final)
        const semifinalsRound = numRounds - 1;

        if (thirdPlaceMatch) {
            // Hay un partido del tercer puesto existente
            bracket.thirdPlace = {
                match: {
                    id: thirdPlaceMatch.id,
                    home_team: thirdPlaceMatch.home,
                    away_team: thirdPlaceMatch.away,
                    home_goals: thirdPlaceMatch.home_goals,
                    away_goals: thirdPlaceMatch.away_goals,
                    winner: determineWinner(thirdPlaceMatch),
                    leg: thirdPlaceMatch.cup_leg
                }
            };
        } else {
            // Generar placeholder para el partido del tercer puesto
            // Los perdedores de las semifinales 1 y 2
            bracket.thirdPlace = {
                match: {
                    id: null,
                    home_team: {
                        nickname: 'Perdedor Semifinal 1',
                        display_name: 'Perdedor Semifinal 1'
                    },
                    away_team: {
                        nickname: 'Perdedor Semifinal 2',
                        display_name: 'Perdedor Semifinal 2'
                    },
                    home_goals: null,
                    away_goals: null,
                    winner: null,
                    leg: null,
                    placeholder: true
                }
            };
        }
    }

    return bracket;
}

/**
 * Determina el ganador de un partido
 * @param {Object} match
 * @returns {number|null}
 */
function determineWinner(match) {
    if (match.home_goals === null || match.away_goals === null) {
        return null;
    }

    if (match.cup_leg === 'second') {
        // Para doble partido, se necesita la lógica de ida y vuelta
        // Por ahora, retornamos null (se calculará cuando se completen ambos partidos)
        return null;
    }

    if (match.home_goals > match.away_goals) {
        return match.home_league_team_id;
    } else if (match.away_goals > match.home_goals) {
        return match.away_league_team_id;
    }

    return null; // Empate (puede requerir prórroga/penaltis)
}

/**
 * Obtiene el nombre de la ronda para placeholders (helper interno)
 * @param {number} roundNum
 * @param {number} totalTeams
 * @returns {string}
 */
function getRoundNameForPlaceholder(roundNum, totalTeams) {
    const numTeams = Math.floor(totalTeams / Math.pow(2, roundNum - 1));
    const roundNames = {
        32: 'Dieciseisavos',
        16: 'Octavos',
        8: 'Cuartos',
        4: 'Semifinales',
        2: 'Final'
    };
    return roundNames[numTeams] || `Ronda ${roundNum}`;
}

/**
 * Obtiene la clasificación de una competición ranked
 * @param {number} competitionId
 * @returns {Promise<{type: 'ranked', data: {standings: Array, competitionId: number}}>}
 */
async function getRankedStandings(competitionId) {
    const supabase = await getSupabaseClient();

    const { data: standings, error } = await supabase
        .from('ranked_ratings')
        .select(`
            *,
            league_teams(id, nickname, display_name, logo_url)
        `)
        .eq('competition_id', competitionId)
        .order('rating', { ascending: false });

    if (error) {
        throw new Error('Error loading ranked standings');
    }

    return {
        type: 'ranked',
        data: {
            standings,
            competitionId
        }
    };
}

