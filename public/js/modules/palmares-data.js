import { getSupabaseClient } from './supabase-client.js';

/**
 * Module for managing competition palmares (honors/awards) data
 */

// Get Supabase client
const getSupa = async () => {
    return await getSupabaseClient();
};

/**
 * Get palmares for a specific competition
 * @param {number} competitionId - Competition ID
 * @returns {Promise<Object|null>} Palmares data with team and player names
 */
export const getPalmaresByCompetition = async (competitionId) => {
    try {
        const supa = await getSupa();
        if (!supa) return null;

        // Get competition season first to filter correctly
        const { data: competition, error: compError } = await supa
            .from('competitions')
            .select('season')
            .eq('id', competitionId)
            .single();

        if (compError) {
            console.error('Error getting competition season:', compError);
            // Fallback: try without season filter
        }

        // First, get the palmares record (filter by competition_id and season if available)
        let query = supa
            .from('competition_palmares')
            .select('*')
            .eq('competition_id', competitionId);

        // If we have the competition season, filter by it
        if (competition?.season) {
            query = query.eq('season', competition.season);
        }

        // Order by created_at desc to get the most recent if multiple exist, then limit to 1
        query = query.order('created_at', { ascending: false }).limit(1);

        const { data: palmaresData, error } = await query.maybeSingle();

        // Handle the result
        let palmares = palmaresData;
        
        // If no result found with season filter, try without season filter to get most recent
        if (!palmares && !error && competition?.season) {
            const { data: allPalmares, error: allError } = await supa
                .from('competition_palmares')
                .select('*')
                .eq('competition_id', competitionId)
                .order('created_at', { ascending: false })
                .limit(1)
                .maybeSingle();

            if (!allError && allPalmares) {
                palmares = allPalmares;
            }
        }

        if (error) {
            if (error.code === 'PGRST116') {
                // No palmares found
                return null;
            }
            console.error('Error getting palmares:', error);
            return null;
        }

        if (!palmares) return null;

        // Now fetch related teams and players separately
        const teamIds = [
            palmares.winner_team_id,
            palmares.runner_up_team_id,
            palmares.top_scorer_team_id,
            palmares.best_defense_team_id,
            palmares.most_possession_team_id,
            palmares.cleanest_team_id,
            palmares.most_accurate_passes_team_id,
            palmares.most_efficient_shooting_team_id,
            palmares.most_effective_defense_team_id,
            palmares.mvp_team_id
        ].filter(id => id !== null);

        const playerIds = [
            palmares.top_scorer_player_id,
            palmares.mvp_player_id,
            palmares.best_defender_player_id,
            palmares.best_midfielder_player_id,
            palmares.best_forward_player_id,
            palmares.best_goalkeeper_player_id,
            palmares.golden_boy_player_id
        ].filter(id => id !== null);

        // Fetch teams (incluyendo user_id y club_id para resolver el nickname
        // del manager y el escudo del club).
        let teams = {};
        if (teamIds.length > 0) {
            const { data: teamsData } = await supa
                .from('league_teams')
                .select('id, nickname, display_name, user_id, club_id')
                .in('id', teamIds);

            if (teamsData) {
                // Mapa de user_id -> users.nickname para los managers de los equipos premiados
                const userIds = [...new Set(teamsData.map(t => t.user_id).filter(Boolean))];
                let userNickMap = {};
                if (userIds.length > 0) {
                    const { data: usersData } = await supa
                        .from('users')
                        .select('id, nickname')
                        .in('id', userIds);
                    (usersData || []).forEach(u => { userNickMap[u.id] = u.nickname; });
                }

                // Mapa de club_id -> {name, crest_url} para el escudo
                const clubIds = [...new Set(teamsData.map(t => t.club_id).filter(Boolean))];
                let clubMap = {};
                if (clubIds.length > 0) {
                    const { data: clubsData } = await supa
                        .from('clubs')
                        .select('id, name, crest_url')
                        .in('id', clubIds);
                    (clubsData || []).forEach(c => { clubMap[c.id] = c; });
                }

                teamsData.forEach(team => {
                    teams[team.id] = {
                        ...team,
                        userNickname: team.user_id ? (userNickMap[team.user_id] || null) : null,
                        club: team.club_id ? (clubMap[team.club_id] || null) : null
                    };
                });
            }
        }

        // Fetch players
        let players = {};
        if (playerIds.length > 0) {
            const { data: playersData } = await supa
                .from('players')
                .select('id, name')
                .in('id', playerIds);

            if (playersData) {
                playersData.forEach(player => {
                    players[player.id] = player;
                });
            }
        }

        // Attach team and player objects to palmares
        return {
            ...palmares,
            winner_team: teams[palmares.winner_team_id] || null,
            runner_up_team: teams[palmares.runner_up_team_id] || null,
            top_scorer_team: teams[palmares.top_scorer_team_id] || null,
            best_defense_team: teams[palmares.best_defense_team_id] || null,
            most_possession_team: teams[palmares.most_possession_team_id] || null,
            cleanest_team: teams[palmares.cleanest_team_id] || null,
            most_accurate_passes_team: teams[palmares.most_accurate_passes_team_id] || null,
            most_efficient_shooting_team: teams[palmares.most_efficient_shooting_team_id] || null,
            most_effective_defense_team: teams[palmares.most_effective_defense_team_id] || null,
            mvp_team: teams[palmares.mvp_team_id] || null,
            top_scorer_player: players[palmares.top_scorer_player_id] || null,
            mvp_player: players[palmares.mvp_player_id] || null,
            best_defender_player: players[palmares.best_defender_player_id] || null,
            best_midfielder_player: players[palmares.best_midfielder_player_id] || null,
            best_forward_player: players[palmares.best_forward_player_id] || null,
            best_goalkeeper_player: players[palmares.best_goalkeeper_player_id] || null,
            golden_boy_player: players[palmares.golden_boy_player_id] || null
        };
    } catch (err) {
        console.error('Error getting palmares:', err);
        return null;
    }
};

/**
 * Get Best XI for a palmares
 * @param {number} palmaresId - Palmares ID
 * @returns {Promise<Array>} Best XI players grouped by position
 */
export const getBestEleven = async (palmaresId) => {
    try {
        const supa = await getSupa();
        if (!supa) return [];

        // First, get competition_id from palmares
        const { data: palmaresData, error: palmaresError } = await supa
            .from('competition_palmares')
            .select('competition_id')
            .eq('id', palmaresId)
            .single();

        if (palmaresError || !palmaresData) {
            console.error('Error getting competition_id from palmares:', palmaresError);
            // Fallback: try without team info
            const { data, error } = await supa
                .from('competition_best_eleven')
                .select(`
            *,
            player:players(id, name, position)
          `)
                .eq('palmares_id', palmaresId)
                .order('position')
                .order('position_order');

            if (error) throw error;
            return data || [];
        }

        const competitionId = palmaresData.competition_id;

        // Get Best XI with player info
        const { data, error } = await supa
            .from('competition_best_eleven')
            .select(`
        *,
        player:players(id, name, position)
      `)
            .eq('palmares_id', palmaresId)
            .order('position')
            .order('position_order');

        if (error) throw error;

        if (!data || data.length === 0) return [];

        // Get team info for each player from player_ratings_avg
        const playerIds = data.map(item => item.player_id).filter(Boolean);
        if (playerIds.length === 0) return data;

        const { data: playerRatings, error: ratingsError } = await supa
            .from('player_ratings_avg')
            .select('player_id, league_team_id, team_nickname')
            .eq('competition_id', competitionId)
            .in('player_id', playerIds);

        if (ratingsError) {
            console.warn('Error getting team info for players:', ratingsError);
            return data;
        }

        // Create a map of player_id -> team info
        const teamMap = new Map();
        (playerRatings || []).forEach(rating => {
            if (rating.player_id && rating.league_team_id) {
                // Use the most recent team (if multiple, last one wins)
                teamMap.set(rating.player_id, {
                    league_team_id: rating.league_team_id,
                    team_nickname: rating.team_nickname
                });
            }
        });

        // Enrich each Best XI entry with team info
        const enrichedData = data.map(item => {
            const teamInfo = item.player_id ? teamMap.get(item.player_id) : null;
            return {
                ...item,
                team: teamInfo ? {
                    league_team_id: teamInfo.league_team_id,
                    nickname: teamInfo.team_nickname
                } : null
            };
        });

        return enrichedData;
    } catch (err) {
        console.error('Error getting best eleven:', err);
        return [];
    }
};

/**
 * Get all palmares for finished competitions
 * @returns {Promise<Array>} List of all palmares with competition info
 */
export const getAllPalmares = async () => {
    try {
        const supa = await getSupa();
        if (!supa) {
            console.error('[Palmares Data] Supabase client not available');
            return [];
        }

        console.log('[Palmares Data] Fetching finished competitions...');
        // First get all finished competitions
        const { data: finishedCompetitions, error: compError } = await supa
            .from('competitions')
            .select('id, name, status')
            .eq('status', 'finished');

        if (compError) {
            console.error('[Palmares Data] Error fetching finished competitions:', compError);
            throw compError;
        }

        console.log('[Palmares Data] Finished competitions:', finishedCompetitions);

        if (!finishedCompetitions || finishedCompetitions.length === 0) {
            console.log('[Palmares Data] No finished competitions found');
            return [];
        }

        const competitionIds = finishedCompetitions.map(c => c.id);
        console.log('[Palmares Data] Competition IDs:', competitionIds);

        // Then get palmares for those competitions
        console.log('[Palmares Data] Fetching palmares for finished competitions...');
        const { data, error } = await supa
            .from('competition_palmares')
            .select(`
        *,
        competition:competitions(id, name, season, competition_type, status),
        winner_team:league_teams!winner_team_id(id, nickname, display_name),
        runner_up_team:league_teams!runner_up_team_id(id, nickname, display_name),
        top_scorer_team:league_teams!top_scorer_team_id(id, nickname, display_name),
        best_defense_team:league_teams!best_defense_team_id(id, nickname, display_name),
        most_possession_team:league_teams!most_possession_team_id(id, nickname, display_name),
        cleanest_team:league_teams!cleanest_team_id(id, nickname, display_name),
        most_accurate_passes_team:league_teams!most_accurate_passes_team_id(id, nickname, display_name),
        most_efficient_shooting_team:league_teams!most_efficient_shooting_team_id(id, nickname, display_name),
        most_effective_defense_team:league_teams!most_effective_defense_team_id(id, nickname, display_name),
        mvp_team:league_teams!mvp_team_id(id, nickname, display_name),
        top_scorer_player:players!top_scorer_player_id(id, name),
        mvp_player:players!mvp_player_id(id, name),
        best_defender_player:players!best_defender_player_id(id, name),
        best_midfielder_player:players!best_midfielder_player_id(id, name),
        best_forward_player:players!best_forward_player_id(id, name),
        best_goalkeeper_player:players!best_goalkeeper_player_id(id, name),
        golden_boy_player:players!golden_boy_player_id(id, name)
      `)
            .in('competition_id', competitionIds)
            .order('season', { ascending: false })
            .order('created_at', { ascending: false });

        if (error) {
            console.error('[Palmares Data] Error fetching palmares:', error);
            throw error;
        }

        console.log('[Palmares Data] Palmares found:', data);
        return data || [];
    } catch (err) {
        console.error('[Palmares Data] Error getting all palmares:', err);
        return [];
    }
};

/**
 * Save palmares for a competition
 * @param {Object} palmaresData - Palmares data to save
 * @returns {Promise<Object>} Result with success status and palmares ID
 */
export const savePalmares = async (palmaresData) => {
    try {
        const supa = await getSupa();
        if (!supa) {
            return { success: false, error: 'Supabase client not available' };
        }

        const { data, error } = await supa
            .from('competition_palmares')
            .upsert(palmaresData, {
                onConflict: 'competition_id,season'
            })
            .select()
            .single();

        if (error) throw error;

        return { success: true, palmares: data };
    } catch (err) {
        console.error('Error saving palmares:', err);
        return { success: false, error: err.message };
    }
};

/**
 * Save Best XI for a palmares
 * @param {number} palmaresId - Palmares ID
 * @param {Array} players - Array of player objects with player_id, position, position_order
 * @returns {Promise<Object>} Result with success status
 */
export const saveBestEleven = async (palmaresId, players) => {
    try {
        const supa = await getSupa();
        if (!supa) {
            return { success: false, error: 'Supabase client not available' };
        }

        // Delete existing Best XI for this palmares
        await supa
            .from('competition_best_eleven')
            .delete()
            .eq('palmares_id', palmaresId);

        // Insert new Best XI
        const bestElevenData = players.map(p => ({
            palmares_id: palmaresId,
            player_id: p.player_id,
            position: p.position,
            position_order: p.position_order
        }));

        const { error } = await supa
            .from('competition_best_eleven')
            .insert(bestElevenData);

        if (error) throw error;

        return { success: true };
    } catch (err) {
        console.error('Error saving best eleven:', err);
        return { success: false, error: err.message };
    }
};

/**
 * Delete palmares for a competition
 * @param {number} competitionId - Competition ID
 * @returns {Promise<Object>} Result with success status
 */
export const deletePalmares = async (competitionId) => {
    try {
        const supa = await getSupa();
        if (!supa) {
            return { success: false, error: 'Supabase client not available' };
        }

        const { error } = await supa
            .from('competition_palmares')
            .delete()
            .eq('competition_id', competitionId);

        if (error) throw error;

        return { success: true };
    } catch (err) {
        console.error('Error deleting palmares:', err);
        return { success: false, error: err.message };
    }
};

/**
 * Check if palmares exists for a competition
 * @param {number} competitionId - Competition ID
 * @returns {Promise<boolean>} True if palmares exists
 */
export const palmaresExists = async (competitionId) => {
    try {
        const palmares = await getPalmaresByCompetition(competitionId);
        return palmares !== null;
    } catch (err) {
        console.error('Error checking palmares existence:', err);
        return false;
    }
};

/**
 * Get monthly awards for a competition
 * @param {number} competitionId - Competition ID
 * @returns {Promise<Array>} List of monthly awards
 */
export const getMonthlyAwards = async (competitionId) => {
    try {
        const supa = await getSupa();
        if (!supa) return [];

        // Get competition season first
        const { data: competition, error: compError } = await supa
            .from('competitions')
            .select('season')
            .eq('id', competitionId)
            .single();

        if (compError || !competition?.season) {
            console.error('Error getting competition season:', compError);
            return [];
        }

        const season = competition.season;

        // Call the SQL function to get monthly awards
        const { data, error } = await supa.rpc('get_monthly_awards', {
            p_competition_id: competitionId,
            p_season: season
        });

        if (error) {
            console.error('Error getting monthly awards:', error);
            console.error('Error details:', {
                code: error?.code,
                message: error?.message,
                details: error?.details,
                hint: error?.hint
            });
            return [];
        }

        console.log('[getMonthlyAwards] Monthly awards retrieved:', data?.length || 0, 'awards');
        if (data && data.length > 0) {
            console.log('[getMonthlyAwards] Sample award:', data[0]);
        }

        return data || [];
    } catch (err) {
        console.error('Error getting monthly awards:', err);
        return [];
    }
};