import { getSupabaseClient } from './supabase-client.js';

/**
 * Module for fetching club palmares data (team and player awards)
 */

/**
 * Get league_team_id from nickname and competition_id
 * @param {string} nickname - Team nickname
 * @param {number} competitionId - Competition ID
 * @returns {Promise<number|null>} League team ID or null
 */
export async function getLeagueTeamIdFromNickname(nickname, competitionId) {
    try {
        const supabase = await getSupabaseClient();
        if (!supabase) return null;

        const { data, error } = await supabase
            .from('league_teams')
            .select('id')
            .eq('competition_id', competitionId)
            .ilike('nickname', nickname)
            .limit(1)
            .maybeSingle();

        if (error) {
            console.error('Error getting league_team_id:', error);
            return null;
        }

        return data?.id || null;
    } catch (err) {
        console.error('Error getting league_team_id:', err);
        return null;
    }
}

/**
 * Get jornadas where the team was MVP (winner, not just participated)
 * @param {number} leagueTeamId - League team ID
 * @param {number} competitionId - Competition ID
 * @param {string} season - Season
 * @returns {Promise<Array>} Array of jornadas where team won MVP
 */
export async function getTeamMvpJornadas(leagueTeamId, competitionId, season) {
    try {
        const supabase = await getSupabaseClient();
        if (!supabase) return [];

        // Get all jornadas for this competition/season
        const { data: allJornadas, error: jornadasError } = await supabase
            .from('mvp_jornada')
            .select('jornada')
            .eq('competition_id', competitionId)
            .eq('season', season)
            .order('jornada', { ascending: true });

        if (jornadasError || !allJornadas) {
            console.error('Error getting jornadas:', jornadasError);
            return [];
        }

        const uniqueJornadas = [...new Set(allJornadas.map(m => m.jornada))];

        const results = [];

        // For each jornada, find the team with highest mvp_score
        for (const jornada of uniqueJornadas) {
            const { data: jornadaMvps, error: mvpError } = await supabase
                .from('mvp_jornada')
                .select('league_team_id, mvp_score')
                .eq('competition_id', competitionId)
                .eq('season', season)
                .eq('jornada', jornada)
                .order('mvp_score', { ascending: false })
                .limit(1);

            if (mvpError || !jornadaMvps || jornadaMvps.length === 0) continue;

            const winner = jornadaMvps[0];
            
            // Only include if this team is the winner
            if (winner.league_team_id === leagueTeamId) {
                results.push({
                    jornada,
                    mvp_score: winner.mvp_score
                });
            }
        }

        return results.sort((a, b) => a.jornada - b.jornada);
    } catch (err) {
        console.error('Error getting team MVP jornadas:', err);
        return [];
    }
}

/**
 * Get periods where the team was MVP of the month
 * @param {number} leagueTeamId - League team ID
 * @param {number} competitionId - Competition ID
 * @param {string} season - Season
 * @returns {Promise<Array>} Array of periods with MVP info
 */
export async function getTeamMvpMonths(leagueTeamId, competitionId, season) {
    try {
        const supabase = await getSupabaseClient();
        if (!supabase) return [];

        const { data, error } = await supabase
            .from('monthly_awards')
            .select('period_number, start_jornada, end_jornada, coach_avg_mvp_score')
            .eq('coach_league_team_id', leagueTeamId)
            .eq('competition_id', competitionId)
            .eq('season', season)
            .eq('is_period_complete', true)
            .order('period_number', { ascending: true });

        if (error) {
            console.error('Error getting team MVP months:', error);
            return [];
        }

        return data || [];
    } catch (err) {
        console.error('Error getting team MVP months:', err);
        return [];
    }
}

/**
 * Get players from the team who were best player of jornada
 * @param {number} leagueTeamId - League team ID
 * @param {number} competitionId - Competition ID
 * @param {string} season - Season
 * @returns {Promise<Array>} Array of best players by jornada
 */
export async function getTeamBestPlayersJornada(leagueTeamId, competitionId, season) {
    try {
        const supabase = await getSupabaseClient();
        if (!supabase) return [];

        const { data: matchesData, error: matchesError } = await supabase
            .from('matches')
            .select('round_id')
            .eq('competition_id', competitionId)
            .eq('season', season)
            .eq('is_played', true)
            .not('round_id', 'is', null);

        if (matchesError || !matchesData) return [];

        const uniqueJornadas = [...new Set(matchesData.map(m => m.round_id))].sort((a, b) => a - b);
        const results = [];

        for (const jornada of uniqueJornadas) {
            const { data: bestPlayer, error } = await supabase.rpc('get_best_player_jornada', {
                p_competition_id: competitionId,
                p_season: season,
                p_jornada: jornada
            });

            if (!error && bestPlayer && bestPlayer.length > 0) {
                const player = bestPlayer[0];
                if (player.league_team_id === leagueTeamId) {
                    results.push({
                        jornada,
                        player_id: player.player_id,
                        player_name: player.player_name,
                        player_position: player.player_position,
                        avg_rating: player.avg_rating,
                        matches_count: player.matches_count
                    });
                }
            }
        }

        return results;
    } catch (err) {
        console.error('Error getting team best players jornada:', err);
        return [];
    }
}

/**
 * Get players from the team who were best player of the month
 * @param {number} leagueTeamId - League team ID (to filter players)
 * @param {number} competitionId - Competition ID
 * @param {string} season - Season
 * @returns {Promise<Array>} Array of best players by month
 */
export async function getTeamBestPlayersMonth(leagueTeamId, competitionId, season) {
    try {
        const supabase = await getSupabaseClient();
        if (!supabase) return [];

        // Get all monthly awards
        const { data: monthlyAwards, error: awardsError } = await supabase.rpc('get_monthly_awards', {
            p_competition_id: competitionId,
            p_season: season
        });

        if (awardsError || !monthlyAwards) {
            console.error('Error getting monthly awards:', awardsError);
            return [];
        }

        // Filter awards where player belongs to this team
        // We need to check if the player belongs to the team by checking player_club_memberships
        const results = [];

        for (const award of monthlyAwards) {
            if (!award.player_id) continue;

            // Get player's current club for this season
            const { data: membership, error: membershipError } = await supabase
                .from('player_club_memberships')
                .select('club_id')
                .eq('player_id', award.player_id)
                .eq('season', season)
                .eq('is_current', true)
                .limit(1)
                .maybeSingle();

            if (membershipError || !membership) continue;

            // Check if this club_id matches the league_team's club_id
            const { data: leagueTeam, error: teamError } = await supabase
                .from('league_teams')
                .select('club_id')
                .eq('id', leagueTeamId)
                .eq('competition_id', competitionId)
                .single();

            if (teamError || !leagueTeam) continue;

            if (membership.club_id === leagueTeam.club_id) {
                results.push({
                    period_number: award.period_number,
                    start_jornada: award.start_jornada,
                    end_jornada: award.end_jornada,
                    player_id: award.player_id,
                    player_name: award.player_name,
                    player_avg_rating: award.player_avg_rating,
                    player_matches_count: award.player_matches_count
                });
            }
        }

        return results;
    } catch (err) {
        console.error('Error getting team best players month:', err);
        return [];
    }
}

/**
 * Get players from the team who have been in Best XI, with count of times
 * @param {number} leagueTeamId - League team ID
 * @param {number} competitionId - Competition ID
 * @param {string} season - Season
 * @returns {Promise<Array>} Array of players with Best XI count
 */
export async function getTeamBestXiPlayers(leagueTeamId, competitionId, season) {
    try {
        const supabase = await getSupabaseClient();
        if (!supabase) return [];

        // Get league_team's club_id
        const { data: leagueTeam, error: teamError } = await supabase
            .from('league_teams')
            .select('club_id')
            .eq('id', leagueTeamId)
            .eq('competition_id', competitionId)
            .single();

        if (teamError || !leagueTeam) {
            console.error('Error getting league team:', teamError);
            return [];
        }

        const clubId = leagueTeam.club_id;

        // Get all Best XI entries for this competition/season
        const { data: bestXiData, error: bestXiError } = await supabase
            .from('best_xi_jornada')
            .select('player_id, jornada, position, avg_rating')
            .eq('competition_id', competitionId)
            .eq('season', season)
            .order('jornada', { ascending: true });

        if (bestXiError || !bestXiData) {
            console.error('Error getting Best XI data:', bestXiError);
            return [];
        }

        // Get player IDs that belong to this club
        const playerIds = [...new Set(bestXiData.map(b => b.player_id))];

        if (playerIds.length === 0) return [];

        // Get players' club memberships for this season
        const { data: memberships, error: membershipsError } = await supabase
            .from('player_club_memberships')
            .select('player_id')
            .in('player_id', playerIds)
            .eq('club_id', clubId)
            .eq('season', season)
            .eq('is_current', true);

        if (membershipsError) {
            console.error('Error getting memberships:', membershipsError);
            return [];
        }

        const teamPlayerIds = new Set((memberships || []).map(m => m.player_id));

        // Filter Best XI entries to only team players and count
        const playerCounts = new Map();

        for (const entry of bestXiData) {
            if (teamPlayerIds.has(entry.player_id)) {
                if (!playerCounts.has(entry.player_id)) {
                    playerCounts.set(entry.player_id, {
                        player_id: entry.player_id,
                        count: 0,
                        jornadas: [],
                        positions: new Set()
                    });
                }
                const playerData = playerCounts.get(entry.player_id);
                playerData.count++;
                playerData.jornadas.push(entry.jornada);
                playerData.positions.add(entry.position);
            }
        }

        // Get player names
        const teamPlayerIdsArray = Array.from(playerCounts.keys());
        if (teamPlayerIdsArray.length === 0) return [];

        const { data: players, error: playersError } = await supabase
            .from('players')
            .select('id, name, position')
            .in('id', teamPlayerIdsArray);

        if (playersError) {
            console.error('Error getting players:', playersError);
            return [];
        }

        const playersMap = new Map((players || []).map(p => [p.id, p]));

        // Build result array
        const results = Array.from(playerCounts.entries()).map(([playerId, data]) => {
            const player = playersMap.get(playerId);
            return {
                player_id: playerId,
                player_name: player?.name || 'Unknown',
                player_position: player?.position || null,
                count: data.count,
                jornadas: data.jornadas.sort((a, b) => a - b),
                positions: Array.from(data.positions)
            };
        });

        // Sort by count descending, then by player name
        results.sort((a, b) => {
            if (b.count !== a.count) return b.count - a.count;
            return a.player_name.localeCompare(b.player_name);
        });

        return results;
    } catch (err) {
        console.error('Error getting team Best XI players:', err);
        return [];
    }
}

/**
 * Get competition titles for the team
 * @param {number} leagueTeamId - League team ID
 * @param {number} competitionId - Competition ID
 * @returns {Promise<Object>} Object with team titles
 */
export async function getTeamCompetitionTitles(leagueTeamId, competitionId) {
    try {
        const supabase = await getSupabaseClient();
        if (!supabase) return null;

        // First check if competition is finished
        const { data: competition, error: compError } = await supabase
            .from('competitions')
            .select('status, season')
            .eq('id', competitionId)
            .single();

        if (compError || !competition || competition.status !== 'finished') {
            return null; // Competition not finished
        }

        // Get palmares for this competition
        const { data: palmares, error: palmaresError } = await supabase
            .from('competition_palmares')
            .select('*')
            .eq('competition_id', competitionId)
            .eq('season', competition.season)
            .limit(1)
            .maybeSingle();

        if (palmaresError || !palmares) {
            return null; // No palmares found
        }

        // Check which titles this team has
        const titles = {
            winner: palmares.winner_team_id === leagueTeamId,
            runner_up: palmares.runner_up_team_id === leagueTeamId,
            top_scorer_team: palmares.top_scorer_team_id === leagueTeamId,
            best_defense_team: palmares.best_defense_team_id === leagueTeamId,
            most_possession_team: palmares.most_possession_team_id === leagueTeamId,
            cleanest_team: palmares.cleanest_team_id === leagueTeamId,
            most_accurate_passes_team: palmares.most_accurate_passes_team_id === leagueTeamId,
            most_efficient_shooting_team: palmares.most_efficient_shooting_team_id === leagueTeamId,
            most_effective_defense_team: palmares.most_effective_defense_team_id === leagueTeamId,
            mvp_team: palmares.mvp_team_id === leagueTeamId
        };

        // Check if team has any titles
        const hasAnyTitle = Object.values(titles).some(v => v === true);

        return hasAnyTitle ? titles : null;
    } catch (err) {
        console.error('Error getting team competition titles:', err);
        return null;
    }
}

