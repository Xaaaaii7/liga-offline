// Funciones nuevas para la entrada manual de resultado (Fase 1b de
// liga-offline). match_team_stats/match_player_ratings no tienen equivalente
// en `lliga` (allí solo llegan por OCR). goal_events/match_red_cards/
// match_yellow_cards SÍ tienen funciones de guardado en `resultados-data.js`
// (saveScorersToSupabase/saveRedCardsFull/saveYellowCardsFull), pero están
// atadas a un `scorerState` en memoria pensado para el flujo de edición de
// `partido.js` (límites de goles sincronizados con matches.home_goals,
// side 'local'/'visitante', inicialización desde datos ya existentes) — para
// una entrada en limpio es más simple y robusto reimplementar aquí inserts
// directos con la misma forma final en BD, sin esa máquina de estados.
import { getSupabaseClient } from './supabase-client.js';

const getSupa = async () => getSupabaseClient();

/**
 * Guarda (upsert) las stats de equipo de un partido para un league_team.
 * @param {string} matchId - matches.id (texto)
 * @param {{match_uuid:number, competition_id:number, season:string}} meta
 * @param {number} leagueTeamId
 * @param {Object} stats - subconjunto de columnas de match_team_stats
 *   (possession, shots, shots_on_target, goals, fouls, offsides, corners,
 *   free_kicks, passes, passes_completed, crosses, interceptions, tackles,
 *   saves, red_cards). Los campos ausentes quedan NULL.
 */
export const saveMatchTeamStats = async (matchId, meta, leagueTeamId, stats) => {
    const supa = await getSupa();
    const { error } = await supa
        .from('match_team_stats')
        .upsert({
            match_id: matchId,
            match_uuid: meta.match_uuid,
            league_team_id: leagueTeamId,
            competition_id: meta.competition_id,
            season: meta.season,
            ...stats,
        }, { onConflict: 'match_id,league_team_id' });

    if (error) {
        console.error('Error guardando match_team_stats:', error);
        return { ok: false, msg: error.message || 'Error guardando stats de equipo' };
    }
    return { ok: true };
};

/**
 * Guarda (upsert) las valoraciones por jugador de un equipo en un partido.
 * @param {string} matchId
 * @param {{match_uuid:number, competition_id:number, season:string}} meta
 * @param {number} leagueTeamId
 * @param {Array<{player_id:number|null, player_name:string, rating:number}>} ratings
 */
export const saveMatchPlayerRatings = async (matchId, meta, leagueTeamId, ratings) => {
    const supa = await getSupa();
    const rows = ratings
        .filter(r => r.rating != null && r.rating !== '')
        .map(r => ({
            match_id: matchId,
            match_uuid: meta.match_uuid,
            league_team_id: leagueTeamId,
            competition_id: meta.competition_id,
            season: meta.season,
            player_id: r.player_id ?? null,
            player_name: r.player_name,
            rating: Number(r.rating),
            is_synthetic: false,
        }));

    if (!rows.length) return { ok: true };

    const { error } = await supa
        .from('match_player_ratings')
        .upsert(rows, { onConflict: 'match_uuid,league_team_id,player_name' });

    if (error) {
        console.error('Error guardando match_player_ratings:', error);
        return { ok: false, msg: error.message || 'Error guardando valoraciones' };
    }
    return { ok: true };
};

/**
 * Inserta los goles de un equipo en goal_events.
 * @param {Array<{player_id:number, minute:number|null}>} goals
 */
export const saveGoalEvents = async (matchId, meta, leagueTeamId, goals) => {
    const rows = (goals || []).filter(g => g.player_id).map(g => ({
        match_id: matchId,
        match_uuid: meta.match_uuid,
        league_team_id: leagueTeamId,
        player_id: g.player_id,
        minute: g.minute ?? null,
        event_type: 'goal',
        competition_id: meta.competition_id,
        season: meta.season,
    }));
    if (!rows.length) return { ok: true };

    const supa = await getSupa();
    const { error } = await supa.from('goal_events').insert(rows);
    if (error) {
        console.error('Error guardando goal_events:', error);
        return { ok: false, msg: error.message || 'Error guardando goleadores' };
    }
    return { ok: true };
};

/**
 * Inserta tarjetas rojas de un equipo en match_red_cards.
 * @param {Array<{player_id:number, minute:number|null}>} cards
 */
export const saveRedCards = async (matchId, meta, leagueTeamId, cards) => {
    const rows = (cards || []).filter(c => c.player_id).map(c => ({
        match_id: matchId,
        match_uuid: meta.match_uuid,
        league_team_id: leagueTeamId,
        player_id: c.player_id,
        minute: c.minute ?? null,
        competition_id: meta.competition_id,
        season: meta.season,
    }));
    if (!rows.length) return { ok: true };

    const supa = await getSupa();
    const { error } = await supa.from('match_red_cards').insert(rows);
    if (error) {
        console.error('Error guardando match_red_cards:', error);
        return { ok: false, msg: error.message || 'Error guardando tarjetas rojas' };
    }
    return { ok: true };
};

/**
 * Inserta tarjetas amarillas de un equipo en match_yellow_cards.
 * @param {Array<{player_id:number, minute:number|null}>} cards
 */
export const saveYellowCards = async (matchId, meta, leagueTeamId, cards) => {
    const rows = (cards || []).filter(c => c.player_id).map(c => ({
        match_id: matchId,
        match_uuid: meta.match_uuid,
        league_team_id: leagueTeamId,
        player_id: c.player_id,
        minute: c.minute ?? null,
        competition_id: meta.competition_id,
        season: meta.season,
    }));
    if (!rows.length) return { ok: true };

    const supa = await getSupa();
    const { error } = await supa.from('match_yellow_cards').insert(rows);
    if (error) {
        console.error('Error guardando match_yellow_cards:', error);
        return { ok: false, msg: error.message || 'Error guardando tarjetas amarillas' };
    }
    return { ok: true };
};
