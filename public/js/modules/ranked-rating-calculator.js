import { getSupabaseClient } from './supabase-client.js';

/**
 * Calcula el cambio de rating usando sistema ELO
 * @param {number} ratingA - Rating del equipo A
 * @param {number} ratingB - Rating del equipo B
 * @param {number} scoreA - Resultado del equipo A (1 = victoria, 0.5 = empate, 0 = derrota)
 * @param {number} kFactor - Factor K (default: 100)
 * @returns {{changeA: number, changeB: number}}
 */
export function calculateEloChange(ratingA, ratingB, scoreA, kFactor = 100) {
    // Calcular probabilidad esperada
    const expectedA = 1 / (1 + Math.pow(10, (ratingB - ratingA) / 400));
    const expectedB = 1 - expectedA;

    const scoreB = 1 - scoreA;

    // Calcular cambio de rating
    const changeA = Math.round(kFactor * (scoreA - expectedA));
    const changeB = Math.round(kFactor * (scoreB - expectedB));

    return { changeA, changeB };
}

/**
 * Actualiza los ratings después de un partido
 * @param {number} matchId - ID del partido
 * @param {number} competitionId - ID de la competición
 * @param {number} homeTeamId - ID equipo local
 * @param {number} awayTeamId - ID equipo visitante
 * @param {number} homeGoals - Goles del local
 * @param {number} awayGoals - Goles del visitante
 */
export async function updateRatingsAfterMatch(matchId, competitionId, homeTeamId, awayTeamId, homeGoals, awayGoals) {
    const supabase = await getSupabaseClient();

    // Obtener configuración
    const { data: competition } = await supabase
        .from('competitions')
        .select('type_config')
        .eq('id', competitionId)
        .single();

    const kFactor = competition?.type_config?.k_factor || 100;

    // Obtener ratings actuales
    const { data: ratings } = await supabase
        .from('ranked_ratings')
        .select('*')
        .eq('competition_id', competitionId)
        .in('league_team_id', [homeTeamId, awayTeamId]);

    const homeRating = ratings?.find(r => r.league_team_id === homeTeamId);
    const awayRating = ratings?.find(r => r.league_team_id === awayTeamId);

    if (!homeRating || !awayRating) {
        console.error('Ratings not found for teams');
        return;
    }

    // Determinar resultado
    let homeScore, awayScore;
    if (homeGoals > awayGoals) {
        homeScore = 1;
        awayScore = 0;
    } else if (homeGoals < awayGoals) {
        homeScore = 0;
        awayScore = 1;
    } else {
        homeScore = 0.5;
        awayScore = 0.5;
    }

    // Calcular cambios
    const { changeA: homeChange, changeB: awayChange } = calculateEloChange(
        homeRating.rating,
        awayRating.rating,
        homeScore,
        kFactor
    );

    const newHomeRating = homeRating.rating + homeChange;
    const newAwayRating = awayRating.rating + awayChange;

    // Actualizar ratings
    await supabase
        .from('ranked_ratings')
        .update({
            rating: newHomeRating,
            matches_played: homeRating.matches_played + 1,
            wins: homeRating.wins + (homeScore === 1 ? 1 : 0),
            losses: homeRating.losses + (homeScore === 0 ? 1 : 0),
            draws: homeRating.draws + (homeScore === 0.5 ? 1 : 0),
            goals_for: homeRating.goals_for + homeGoals,
            goals_against: homeRating.goals_against + awayGoals,
            goal_difference: (homeRating.goals_for + homeGoals) - (homeRating.goals_against + awayGoals),
            updated_at: new Date().toISOString()
        })
        .eq('id', homeRating.id);

    await supabase
        .from('ranked_ratings')
        .update({
            rating: newAwayRating,
            matches_played: awayRating.matches_played + 1,
            wins: awayRating.wins + (awayScore === 1 ? 1 : 0),
            losses: awayRating.losses + (awayScore === 0 ? 1 : 0),
            draws: awayRating.draws + (awayScore === 0.5 ? 1 : 0),
            goals_for: awayRating.goals_for + awayGoals,
            goals_against: awayRating.goals_against + homeGoals,
            goal_difference: (awayRating.goals_for + awayGoals) - (awayRating.goals_against + homeGoals),
            updated_at: new Date().toISOString()
        })
        .eq('id', awayRating.id);

    // Guardar historial
    await supabase
        .from('ranked_rating_history')
        .insert([
            {
                competition_id: competitionId,
                league_team_id: homeTeamId,
                match_uuid: matchId,
                rating_before: homeRating.rating,
                rating_after: newHomeRating,
                rating_change: homeChange
            },
            {
                competition_id: competitionId,
                league_team_id: awayTeamId,
                match_uuid: matchId,
                rating_before: awayRating.rating,
                rating_after: newAwayRating,
                rating_change: awayChange
            }
        ]);
}
