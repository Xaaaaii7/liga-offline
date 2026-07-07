import { getSupabaseClient } from './supabase-client.js';
import { computeClasificacion } from './stats-calc.js';
import { getPichichiRows } from './stats-data.js';
import { normalizeText } from './utils.js';

/**
 * Module for calculating palmares automatically from competition data
 */

const getSupa = async () => {
    return await getSupabaseClient();
};

/**
 * Create a map of normalized team names to league_team_id
 * @param {number} competitionId - Competition ID
 * @returns {Promise<Map>} Map of normalized team name -> league_team_id
 */
const createTeamNameMap = async (competitionId) => {
    const supa = await getSupa();
    if (!supa) return new Map();

    const { data: teams, error } = await supa
        .from('league_teams')
        .select('id, nickname, display_name')
        .eq('competition_id', competitionId);

    if (error) {
        console.error('Error loading league_teams for name mapping:', error);
        return new Map();
    }

    const nameMap = new Map();
    (teams || []).forEach(team => {
        // Map both nickname and display_name to the same league_team_id
        if (team.nickname) {
            const normalizedNickname = normalizeText(team.nickname);
            if (normalizedNickname) {
                nameMap.set(normalizedNickname, team.id);
            }
        }
        if (team.display_name) {
            const normalizedDisplayName = normalizeText(team.display_name);
            if (normalizedDisplayName) {
                nameMap.set(normalizedDisplayName, team.id);
            }
        }
    });

    return nameMap;
};

/**
 * Calculate winner and runner-up from classification or final match
 * @param {number} competitionId - Competition ID
 * @returns {Promise<Object>} Winner and runner-up team IDs
 */
const calculateWinnerAndRunnerUp = async (competitionId) => {
    try {
        const supa = await getSupa();
        if (!supa) {
            return { winner_team_id: null, runner_up_team_id: null };
        }

        // Get competition type
        const { data: competition, error: compError } = await supa
            .from('competitions')
            .select('competition_type')
            .eq('id', competitionId)
            .single();

        if (compError) throw compError;

        const competitionType = competition?.competition_type;

        // For cup or mixed competitions, check for final match
        if (competitionType === 'cup' || competitionType === 'mixed') {
            const { data: finalMatch, error: finalError } = await supa
                .from('matches')
                .select('home_league_team_id, away_league_team_id, home_goals, away_goals, has_penalties, penalties_winner_id')
                .eq('competition_id', competitionId)
                .eq('is_cup_final', true)
                .single();

            if (!finalError && finalMatch) {
                let winner_team_id = null;
                let runner_up_team_id = null;

                // Determine winner
                if (finalMatch.has_penalties && finalMatch.penalties_winner_id) {
                    // Winner decided by penalties
                    winner_team_id = finalMatch.penalties_winner_id;
                    runner_up_team_id = finalMatch.home_league_team_id === winner_team_id
                        ? finalMatch.away_league_team_id
                        : finalMatch.home_league_team_id;
                } else if (finalMatch.home_goals !== null && finalMatch.away_goals !== null) {
                    // Winner decided by regular goals
                    if (finalMatch.home_goals > finalMatch.away_goals) {
                        winner_team_id = finalMatch.home_league_team_id;
                        runner_up_team_id = finalMatch.away_league_team_id;
                    } else if (finalMatch.away_goals > finalMatch.home_goals) {
                        winner_team_id = finalMatch.away_league_team_id;
                        runner_up_team_id = finalMatch.home_league_team_id;
                    }
                }

                return { winner_team_id, runner_up_team_id };
            }
        }

        // For league competitions or if no final match found, use classification
        const clasificacion = await computeClasificacion(null, { competitionId });
        if (!clasificacion || clasificacion.length < 1) {
            return { winner_team_id: null, runner_up_team_id: null };
        }

        // Create team name to league_team_id map
        const teamNameMap = await createTeamNameMap(competitionId);
        const resolveTeamId = (teamName) => {
            if (!teamName) return null;
            const normalized = normalizeText(teamName);
            return teamNameMap.get(normalized) || null;
        };

        const winner = clasificacion[0];
        const runnerUp = clasificacion.length > 1 ? clasificacion[1] : null;

        return {
            winner_team_id: winner ? resolveTeamId(winner.nombre) : null,
            runner_up_team_id: runnerUp ? resolveTeamId(runnerUp.nombre) : null
        };
    } catch (err) {
        console.error('Error calculating winner and runner-up:', err);
        return { winner_team_id: null, runner_up_team_id: null };
    }
};

/**
 * Get top team from a stats table by a specific metric
 * @param {number} competitionId - Competition ID
 * @param {string} table - Table name
 * @param {string} orderBy - Column to order by
 * @param {boolean} ascending - Order direction
 * @returns {Promise<number|null>} Team ID
 */
const getTopTeamByMetric = async (competitionId, table, orderBy, ascending = false) => {
    try {
        const supa = await getSupa();
        if (!supa) return null;

        const { data, error } = await supa
            .from(table)
            .select('league_team_id')
            .eq('competition_id', competitionId)
            .order(orderBy, { ascending })
            .limit(1)
            .single();

        if (error) {
            if (error.code === 'PGRST116') return null; // No data
            throw error;
        }

        return data?.league_team_id || null;
    } catch (err) {
        console.error(`Error getting top team from ${table}:`, err);
        return null;
    }
};

/**
 * Calculate team awards
 * @param {number} competitionId - Competition ID
 * @returns {Promise<Object>} Team awards
 */
export const calculateTeamAwards = async (competitionId) => {
    try {
        const supa = await getSupa();
        if (!supa) return {};

        // Winner and runner-up from classification
        const { winner_team_id, runner_up_team_id } = await calculateWinnerAndRunnerUp(competitionId);

        // Get classification for other metrics
        const clasificacion = await computeClasificacion(null, { competitionId });

        // Create team name to league_team_id map
        const teamNameMap = await createTeamNameMap(competitionId);

        // Helper function to resolve league_team_id from team name
        const resolveTeamId = (teamName) => {
            if (!teamName) return null;
            const normalized = normalizeText(teamName);
            return teamNameMap.get(normalized) || null;
        };

        // Top scorer team (most goals for)
        const topScorerTeam = clasificacion.length > 0
            ? clasificacion.reduce((max, team) => (team.gf > max.gf ? team : max), clasificacion[0])
            : null;

        // Best defense team (least goals against)
        const bestDefenseTeam = clasificacion.length > 0
            ? clasificacion.reduce((min, team) => (team.gc < min.gc ? team : min), clasificacion[0])
            : null;

        // Query team stats from the view team_stats_rankings
        const { data: teamStatsRankings, error: statsError } = await supa
            .from('team_stats_rankings')
            .select('league_team_id, posesion_media, fair_play_ratio, precision_pase, indice_tiro_combinado, efectividad_defensiva')
            .eq('competition_id', competitionId);

        if (statsError) {
            console.error('Error loading team_stats_rankings:', statsError);
            throw statsError;
        }

        // Find winners using the pre-calculated metrics from the view
        let mostPossessionTeam = null;
        let cleanestTeam = null;
        let mostAccuratePassesTeam = null;
        let mostEfficientShootingTeam = null;

        let maxPossession = -1;
        let maxFairPlayRatio = -Infinity;
        let maxPassAccuracy = -1;
        let maxShootingIndex = -1;

        (teamStatsRankings || []).forEach(stat => {
            const teamId = stat.league_team_id;

            // Most possession team (using posesion_media from view, already normalized 0-1)
            if (stat.posesion_media !== null && stat.posesion_media > maxPossession) {
                maxPossession = stat.posesion_media;
                mostPossessionTeam = teamId;
            }

            // Cleanest team (using fair_play_ratio from view: (entradas + 1) / (faltas + 5 * rojas + 1))
            // Higher ratio is better (more tackles relative to fouls and red cards)
            if (stat.fair_play_ratio !== null && stat.fair_play_ratio > maxFairPlayRatio) {
                maxFairPlayRatio = stat.fair_play_ratio;
                cleanestTeam = teamId;
            }

            // Most accurate passes team (using precision_pase from view)
            if (stat.precision_pase !== null && stat.precision_pase > maxPassAccuracy) {
                maxPassAccuracy = stat.precision_pase;
                mostAccuratePassesTeam = teamId;
            }

            // Most efficient shooting team (using indice_tiro_combinado from view)
            if (stat.indice_tiro_combinado !== null && stat.indice_tiro_combinado > maxShootingIndex) {
                maxShootingIndex = stat.indice_tiro_combinado;
                mostEfficientShootingTeam = teamId;
            }
        });

        // Most effective defense (lowest goals conceded per shots on target faced)
        // Use efectividad_defensiva from the view (lower is better)
        let mostEffectiveDefenseTeam = null;
        let minDefenseRatio = Infinity;

        if (teamStatsRankings) {
            teamStatsRankings.forEach(stat => {
                if (stat.efectividad_defensiva !== null && stat.efectividad_defensiva < minDefenseRatio) {
                    minDefenseRatio = stat.efectividad_defensiva;
                    mostEffectiveDefenseTeam = stat.league_team_id;
                }
            });
        }

        // Fallback to best defense team if no stats available
        if (!mostEffectiveDefenseTeam && bestDefenseTeam) {
            mostEffectiveDefenseTeam = resolveTeamId(bestDefenseTeam.nombre);
        }

        // MVP team (from mvp_temporada view - team with highest average MVP)
        const { data: mvpTemporadaData, error: mvpError } = await supa
            .from('mvp_temporada')
            .select('league_team_id, mvp_avg')
            .eq('competition_id', competitionId)
            .order('mvp_avg', { ascending: false })
            .limit(1)
            .maybeSingle();

        let mvpTeamId = null;
        if (!mvpError && mvpTemporadaData) {
            mvpTeamId = mvpTemporadaData.league_team_id;
        }

        // Fallback al cálculo anterior si no hay datos en la vista
        const mvpTeam = mvpTeamId ? null : (clasificacion.length > 0
            ? clasificacion.reduce((max, team) => {
                const score = (team.gf * 2) + (team.pts * 3) - team.gc;
                const maxScore = (max.gf * 2) + (max.pts * 3) - max.gc;
                return score > maxScore ? team : max;
            }, clasificacion[0])
            : null);

        return {
            winner_team_id,
            runner_up_team_id,
            top_scorer_team_id: topScorerTeam ? resolveTeamId(topScorerTeam.nombre) : null,
            best_defense_team_id: bestDefenseTeam ? resolveTeamId(bestDefenseTeam.nombre) : null,
            most_possession_team_id: mostPossessionTeam,
            cleanest_team_id: cleanestTeam,
            most_accurate_passes_team_id: mostAccuratePassesTeam,
            most_efficient_shooting_team_id: mostEfficientShootingTeam,
            most_effective_defense_team_id: mostEffectiveDefenseTeam,
            mvp_team_id: mvpTeamId || (mvpTeam ? resolveTeamId(mvpTeam.nombre) : null)
        };
    } catch (err) {
        console.error('Error calculating team awards:', err);
        return {};
    }
};

/**
 * Calculate individual player awards
 * @param {number} competitionId - Competition ID
 * @returns {Promise<Object>} Player awards
 */
export const calculatePlayerAwards = async (competitionId) => {
    try {
        const supa = await getSupa();
        if (!supa) return {};

        // Top scorer (Pichichi) - using goleadores view
        const pichichiRows = await getPichichiRows(competitionId);
        const topScorer = pichichiRows.length > 0 ? pichichiRows[0] : null;
        
        // Extract player_id from topScorer (now included in getPichichiRows)
        const topScorerPlayerId = topScorer?.player_id || null;

        // Get competition type and start_date to apply minimum matches filter and calculate age
        let competitionType = null;
        let competitionStartDate = null;
        try {
            const { data: comp, error: compError } = await supa
                .from('competitions')
                .select('competition_type, start_date')
                .eq('id', competitionId)
                .single();
            
            if (!compError && comp) {
                competitionType = comp.competition_type;
                competitionStartDate = comp.start_date;
            }
        } catch (e) {
            console.warn('Error obteniendo tipo de competición:', e);
        }

        // Get player ratings - bayesian_rating con mínimo de partidos (liga 3, copa 2)
        let query = supa
            .from('player_ratings_avg')
            .select('*')
            .eq('competition_id', competitionId)
            .order('bayesian_rating', { ascending: false });
        if (competitionType === 'league') query = query.gte('matches_count', 3);
        else if (competitionType === 'cup') query = query.gte('matches_count', 2);
        const { data: playerRatingsRaw, error } = await query;

        if (error) {
            console.error('Error fetching player ratings:', error);
            // Continue without player ratings
        }

        // Mismo orden que estadisticas.js: bayesian_rating ?? avg_rating, desempate por matches_count.
        // Imprescindible: la BD ordena solo por bayesian_rating y mete los NULLs primero en DESC.
        const sortPlayers = (a, b) => {
            const ratingA = a.bayesian_rating ?? a.avg_rating ?? -Infinity;
            const ratingB = b.bayesian_rating ?? b.avg_rating ?? -Infinity;
            if (ratingB !== ratingA) return ratingB - ratingA;
            return (b.matches_count || 0) - (a.matches_count || 0);
        };
        const playerRatings = (playerRatingsRaw || []).slice().sort(sortPlayers);

        // MVP player (highest average rating)
        const mvpPlayer = playerRatings.length > 0 ? playerRatings[0] : null;

        // Best by position - using classifyPosition logic
        let classifyPosition;
        try {
            const playerRatingsModule = await import('./player-ratings-data.js');
            classifyPosition = playerRatingsModule?.classifyPosition;
            if (typeof classifyPosition !== 'function') {
                throw new Error('classifyPosition is not a function');
            }
        } catch (err) {
            console.error('Error importing classifyPosition:', err);
            // Fallback: misma lógica que posGroup() en club.js
            classifyPosition = (position) => {
                const p = (position || "").toLowerCase();
                // Porteros: "goalkeeper" o "portero"
                if (p.includes("goalkeeper") || p.includes("portero")) return 'GK';
                // Defensas: "defence", "back", "centre-back", o "defensa"
                if (p.includes("defence") || p.includes("back") || 
                    p.includes("centre-back") || p.includes("defensa")) return 'DEF';
                // Centrocampistas: "midfield", "medio", o "mid"
                if (p.includes("midfield") || p.includes("medio") || p.includes("mid")) return 'MID';
                // Delanteros: "offence", "forward", "wing", "striker", o "delantero"
                if (p.includes("offence") || p.includes("forward") || 
                    p.includes("wing") || p.includes("striker") || 
                    p.includes("delantero")) return 'FWD';
                // Si no coincide con ninguna, devolver null (equivalente a "Otros" en club.js)
                return null;
            };
        }

        const defenders = playerRatings.filter(p => classifyPosition(p.position) === 'DEF');
        const midfielders = playerRatings.filter(p => classifyPosition(p.position) === 'MID');
        const forwards = playerRatings.filter(p => classifyPosition(p.position) === 'FWD');
        const goalkeepers = playerRatings.filter(p => classifyPosition(p.position) === 'GK');

        const bestDefender = defenders.length > 0 ? defenders[0] : null;
        const bestMidfielder = midfielders.length > 0 ? midfielders[0] : null;
        const bestForward = forwards.length > 0 ? forwards[0] : null;
        const bestGoalkeeper = goalkeepers.length > 0 ? goalkeepers[0] : null;

        // Calculate Golden Boy (best young player 21 years or less)
        let goldenBoyPlayerId = null;
        if (playerRatings && playerRatings.length > 0) {
            try {
                // Get player IDs from ratings
                const playerIds = playerRatings.map(p => p.player_id).filter(Boolean);
                
                if (playerIds.length > 0) {
                    // Get players with date_of_birth
                    const { data: playersData, error: playersError } = await supa
                        .from('players')
                        .select('id, date_of_birth')
                        .in('id', playerIds)
                        .not('date_of_birth', 'is', null);
                    
                    if (!playersError && playersData) {
                        // Calculate age for each player based on competition start date
                        // Use competition start_date if available, otherwise use today
                        const referenceDate = competitionStartDate ? new Date(competitionStartDate) : new Date();

                        // Set de player_ids con ≤21 años en la fecha de referencia
                        const eligibleIds = new Set();
                        playersData.forEach(player => {
                            if (!player.date_of_birth) return;
                            const birthDate = new Date(player.date_of_birth);
                            let age = referenceDate.getFullYear() - birthDate.getFullYear();
                            const monthDiff = referenceDate.getMonth() - birthDate.getMonth();
                            if (monthDiff < 0 || (monthDiff === 0 && referenceDate.getDate() < birthDate.getDate())) {
                                age--;
                            }
                            if (age <= 21) eligibleIds.add(player.id);
                        });

                        // playerRatings ya viene ordenado por bayesian_rating ?? avg_rating
                        // y desempate por matches_count, así que el Golden Boy es el primer
                        // jugador de esa lista que sea elegible por edad.
                        const goldenBoy = playerRatings.find(r => eligibleIds.has(r.player_id));
                        if (goldenBoy) {
                            goldenBoyPlayerId = goldenBoy.player_id;
                        }
                    }
                }
            } catch (goldenBoyError) {
                console.warn('Error calculating Golden Boy:', goldenBoyError);
            }
        }

        return {
            top_scorer_player_id: topScorerPlayerId,
            top_scorer_goals: topScorer ? parseInt(topScorer.Goles || 0) : null,
            mvp_player_id: mvpPlayer?.player_id || null,
            best_defender_player_id: bestDefender?.player_id || null,
            best_midfielder_player_id: bestMidfielder?.player_id || null,
            best_forward_player_id: bestForward?.player_id || null,
            best_goalkeeper_player_id: bestGoalkeeper?.player_id || null,
            golden_boy_player_id: goldenBoyPlayerId
        };
    } catch (err) {
        console.error('Error calculating player awards:', err);
        return {};
    }
};

/**
 * Calculate Best XI (team of the league)
 * @param {number} competitionId - Competition ID
 * @returns {Promise<Array>} Best XI players
 */
export const calculateBestEleven = async (competitionId) => {
    try {
        const supa = await getSupa();
        if (!supa) return [];

        // Get competition type for minimum matches filter
        let competitionType = null;
        try {
            const { data: comp, error: compError } = await supa
                .from('competitions')
                .select('competition_type')
                .eq('id', competitionId)
                .single();
            if (!compError && comp) competitionType = comp.competition_type;
        } catch (e) {
            console.warn('Error obteniendo tipo de competición para Best XI:', e);
        }

        // Get player ratings - bayesian_rating con mínimo de partidos (liga 3, copa 2)
        let query = supa
            .from('player_ratings_avg')
            .select('*')
            .eq('competition_id', competitionId)
            .order('bayesian_rating', { ascending: false });
        if (competitionType === 'league') query = query.gte('matches_count', 3);
        else if (competitionType === 'cup') query = query.gte('matches_count', 2);
        const { data: playerRatings, error } = await query;

        if (error) {
            console.error('Error fetching player ratings for Best XI:', error);
            return [];
        }

        if (!playerRatings || playerRatings.length === 0) return [];

        // Obtener goles de cada jugador para desempate
        const playerIds = playerRatings.map(p => p.player_id).filter(Boolean);
        const playerGoalsMap = new Map();
        
        if (playerIds.length > 0) {
            try {
                const { data: goalsData, error: goalsError } = await supa
                    .from('goal_events')
                    .select('player_id, match:matches!inner(competition_id)')
                    .in('player_id', playerIds)
                    .neq('event_type', 'own_goal')
                    .eq('match.competition_id', competitionId);

                if (!goalsError && goalsData) {
                    goalsData.forEach(goal => {
                        if (goal.player_id) {
                            const currentGoals = playerGoalsMap.get(goal.player_id) || 0;
                            playerGoalsMap.set(goal.player_id, currentGoals + 1);
                        }
                    });
                }
            } catch (goalsErr) {
                console.warn('Error obteniendo goles para desempate en Best XI:', goalsErr);
            }
        }

        // Función de ordenamiento con desempate por goles (usar bayesian_rating)
        const ratingVal = (p) => p.bayesian_rating ?? p.avg_rating;
        const sortByRatingAndGoals = (a, b) => {
            if (ratingVal(b) !== ratingVal(a)) return ratingVal(b) - ratingVal(a);
            // 2. Si empate, por goles descendente
            const goalsA = playerGoalsMap.get(a.player_id) || 0;
            const goalsB = playerGoalsMap.get(b.player_id) || 0;
            if (goalsB !== goalsA) {
                return goalsB - goalsA;
            }
            // 3. Finalmente por player_id ascendente (para consistencia)
            return a.player_id - b.player_id;
        };

        const bestEleven = [];
        let classifyPosition;
        try {
            const playerRatingsModule = await import('./player-ratings-data.js');
            classifyPosition = playerRatingsModule?.classifyPosition;
            if (typeof classifyPosition !== 'function') {
                throw new Error('classifyPosition is not a function');
            }
        } catch (err) {
            console.error('Error importing classifyPosition:', err);
            // Fallback: misma lógica que posGroup() en club.js
            classifyPosition = (position) => {
                const p = (position || "").toLowerCase();
                // Porteros: "goalkeeper" o "portero"
                if (p.includes("goalkeeper") || p.includes("portero")) return 'GK';
                // Defensas: "defence", "back", "centre-back", o "defensa"
                if (p.includes("defence") || p.includes("back") || 
                    p.includes("centre-back") || p.includes("defensa")) return 'DEF';
                // Centrocampistas: "midfield", "medio", o "mid"
                if (p.includes("midfield") || p.includes("medio") || p.includes("mid")) return 'MID';
                // Delanteros: "offence", "forward", "wing", "striker", o "delantero"
                if (p.includes("offence") || p.includes("forward") || 
                    p.includes("wing") || p.includes("striker") || 
                    p.includes("delantero")) return 'FWD';
                // Si no coincide con ninguna, devolver null (equivalente a "Otros" en club.js)
                return null;
            };
        }

        // 1 Goalkeeper
        const goalkeepers = playerRatings.filter(p => classifyPosition(p.position) === 'GK');
        goalkeepers.sort(sortByRatingAndGoals);
        if (goalkeepers.length > 0) {
            bestEleven.push({
                player_id: goalkeepers[0].player_id,
                position: 'GK',
                position_order: 1
            });
        }

        // 4 Defenders
        const defenders = playerRatings.filter(p => classifyPosition(p.position) === 'DEF');
        defenders.sort(sortByRatingAndGoals);
        defenders.slice(0, 4).forEach((player, index) => {
            bestEleven.push({
                player_id: player.player_id,
                position: 'DEF',
                position_order: index + 1
            });
        });

        // 3 Midfielders
        const midfielders = playerRatings.filter(p => classifyPosition(p.position) === 'MID');
        midfielders.sort(sortByRatingAndGoals);
        midfielders.slice(0, 3).forEach((player, index) => {
            bestEleven.push({
                player_id: player.player_id,
                position: 'MID',
                position_order: index + 1
            });
        });

        // 3 Forwards
        const forwards = playerRatings.filter(p => classifyPosition(p.position) === 'FWD');
        forwards.sort(sortByRatingAndGoals);
        forwards.slice(0, 3).forEach((player, index) => {
            bestEleven.push({
                player_id: player.player_id,
                position: 'FWD',
                position_order: index + 1
            });
        });

        return bestEleven;
    } catch (err) {
        console.error('Error calculating best eleven:', err);
        return [];
    }
};

/**
 * Generate complete palmares for a competition
 * @param {number} competitionId - Competition ID
 * @param {string} season - Season
 * @returns {Promise<Object>} Complete palmares data
 */
export const generatePalmares = async (competitionId, season) => {
    try {
        console.log(`Generating palmares for competition ${competitionId}, season ${season}`);

        const teamAwards = await calculateTeamAwards(competitionId);
        const playerAwards = await calculatePlayerAwards(competitionId);

        const palmares = {
            competition_id: competitionId,
            season,
            ...teamAwards,
            ...playerAwards,
            auto_generated: true
        };

        console.log('Generated palmares:', palmares);
        return palmares;
    } catch (err) {
        console.error('Error generating palmares:', err);
        throw err;
    }
};
