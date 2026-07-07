/**
 * Helpers de datos para la sección pública de árbitros.
 *
 * Stats agregadas on-the-fly desde matches + match_yellow_cards + match_red_cards
 * + match_team_stats. Si la ficha tarda en algún momento, materializar como
 * view (opcional).
 */

import { getSupabaseClient } from './supabase-client.js';

/**
 * Devuelve todos los árbitros con su recuento de partidos pitados (jugados).
 */
export async function loadAllReferees() {
    const supabase = await getSupabaseClient();

    const [refsRes, matchesRes] = await Promise.all([
        supabase.from('referees')
            .select('id, first_name, last_name, gender, birth_year, ethnicity, tier, nickname, archetype, lore_short, photo_url')
            .order('tier', { ascending: true })
            .order('last_name', { ascending: true }),
        supabase.from('matches')
            .select('referee_id')
            .not('referee_id', 'is', null)
            .eq('is_played', true),
    ]);

    if (refsRes.error) {
        console.error('[referees-data] referees query error', refsRes.error);
        return [];
    }
    const refs = refsRes.data || [];

    const matchCountByRef = new Map();
    for (const m of (matchesRes.data || [])) {
        matchCountByRef.set(m.referee_id, (matchCountByRef.get(m.referee_id) || 0) + 1);
    }

    return refs.map(r => ({
        ...r,
        matches_played: matchCountByRef.get(r.id) || 0,
    }));
}

/**
 * Devuelve un árbitro con stats agregadas y la historia completa de partidos
 * (con competición y equipos resueltos) para su ficha pública.
 *
 * @param {number} refId
 */
export async function loadRefereeWithStats(refId) {
    const supabase = await getSupabaseClient();

    const { data: ref, error: refErr } = await supabase
        .from('referees')
        .select('*')
        .eq('id', refId)
        .single();
    if (refErr || !ref) return null;

    const { data: matches, error: matchesErr } = await supabase
        .from('matches')
        .select(`
            id, match_uuid, season, round_id, match_date, match_time,
            home_goals, away_goals, competition_id,
            home_league_team_id, away_league_team_id,
            competition:competitions(id, name, slug, competition_type),
            home:league_teams!matches_home_league_team_id_fkey(id, nickname, display_name, clubs(name, crest_url)),
            away:league_teams!matches_away_league_team_id_fkey(id, nickname, display_name, clubs(name, crest_url))
        `)
        .eq('referee_id', refId)
        .eq('is_played', true)
        .order('match_date', { ascending: false });

    if (matchesErr) {
        console.error('[referees-data] matches query error', matchesErr);
        return { referee: ref, stats: emptyStats(), matches: [], breakdowns: emptyBreakdowns() };
    }

    const playedMatches = matches || [];
    // OJO: matches.id (text) NO es único; usar SIEMPRE match_uuid (integer) como
    // identificador real del partido. Cruzar por match_id text mezcla partidos
    // distintos que comparten el mismo id y contamina los conteos.
    const matchUuids = playedMatches.map(m => m.match_uuid).filter(u => u != null);

    let yellowsCount = 0;
    let redsCount = 0;
    let foulsTotal = 0;
    let offsidesTotal = 0;
    let foulsMatchesWithStats = 0;
    let offsidesMatchesWithStats = 0;

    if (matchUuids.length) {
        const [yRes, rRes, tsRes] = await Promise.all([
            supabase.from('match_yellow_cards').select('id', { count: 'exact', head: true }).in('match_uuid', matchUuids),
            supabase.from('match_red_cards').select('id', { count: 'exact', head: true }).in('match_uuid', matchUuids),
            supabase.from('match_team_stats').select('match_uuid, fouls, offsides').in('match_uuid', matchUuids),
        ]);
        yellowsCount = yRes.count || 0;
        redsCount = rRes.count || 0;

        // Sumar faltas y fueras de juego por partido (las dos filas suman el total
        // del partido). Solo contamos como "partido con stats" los que tienen al
        // menos una fila no-nula del campo correspondiente, para no diluir la media
        // con partidos sin datos.
        const foulsByMatch = new Map();
        const offsidesByMatch = new Map();
        for (const row of (tsRes.data || [])) {
            if (row.fouls != null) {
                foulsByMatch.set(row.match_uuid, (foulsByMatch.get(row.match_uuid) || 0) + row.fouls);
            }
            if (row.offsides != null) {
                offsidesByMatch.set(row.match_uuid, (offsidesByMatch.get(row.match_uuid) || 0) + row.offsides);
            }
        }
        for (const v of foulsByMatch.values()) foulsTotal += v;
        for (const v of offsidesByMatch.values()) offsidesTotal += v;
        foulsMatchesWithStats = foulsByMatch.size;
        offsidesMatchesWithStats = offsidesByMatch.size;
    }

    let homeWins = 0, awayWins = 0, draws = 0, totalGoals = 0;
    const teamAppearancesById = new Map();   // teamId -> { count, team }
    const teamWinsById = new Map();          // teamId -> { count, team }
    const compById = new Map();              // compId -> { count, competition }

    for (const m of playedMatches) {
        const hg = m.home_goals ?? 0;
        const ag = m.away_goals ?? 0;
        totalGoals += hg + ag;
        if (hg > ag) homeWins += 1;
        else if (ag > hg) awayWins += 1;
        else draws += 1;

        // Apariciones por equipo (cada equipo aparece una vez por partido)
        registerTeamAppearance(teamAppearancesById, m.home_league_team_id, m.home);
        registerTeamAppearance(teamAppearancesById, m.away_league_team_id, m.away);

        // Victorias por equipo
        if (hg > ag) registerTeamWin(teamWinsById, m.home_league_team_id, m.home);
        else if (ag > hg) registerTeamWin(teamWinsById, m.away_league_team_id, m.away);

        // Partidos por competición
        if (m.competition_id != null) {
            const prev = compById.get(m.competition_id);
            if (prev) prev.count += 1;
            else compById.set(m.competition_id, { count: 1, competition: m.competition || null });
        }
    }

    const played = playedMatches.length;
    const stats = {
        matches_played: played,
        home_wins: homeWins,
        away_wins: awayWins,
        draws,
        home_win_pct: played ? Math.round((homeWins / played) * 100) : 0,
        away_win_pct: played ? Math.round((awayWins / played) * 100) : 0,
        draw_pct: played ? Math.round((draws / played) * 100) : 0,
        yellows_total: yellowsCount,
        reds_total: redsCount,
        yellows_per_match: played ? +(yellowsCount / played).toFixed(2) : 0,
        reds_per_match: played ? +(redsCount / played).toFixed(2) : 0,
        goals_per_match: played ? +(totalGoals / played).toFixed(2) : 0,
        total_goals: totalGoals,
        fouls_total: foulsTotal,
        fouls_per_match: foulsMatchesWithStats ? +(foulsTotal / foulsMatchesWithStats).toFixed(2) : 0,
        offsides_total: offsidesTotal,
        offsides_per_match: offsidesMatchesWithStats ? +(offsidesTotal / offsidesMatchesWithStats).toFixed(2) : 0,
        fouls_sample_size: foulsMatchesWithStats,
        offsides_sample_size: offsidesMatchesWithStats,
    };

    const breakdowns = {
        topAppearances: rankMap(teamAppearancesById, 5),
        topWinners: rankMap(teamWinsById, 5),
        byCompetition: [...compById.values()]
            .sort((a, b) => b.count - a.count)
            .map(c => ({
                competition: c.competition,
                count: c.count,
            })),
    };

    return {
        referee: ref,
        stats,
        matches: playedMatches,
        breakdowns,
    };
}

function registerTeamAppearance(map, teamId, teamData) {
    if (teamId == null) return;
    const prev = map.get(teamId);
    if (prev) {
        prev.count += 1;
        if (!prev.team && teamData) prev.team = teamData;
    } else {
        map.set(teamId, { count: 1, team: teamData || null });
    }
}

function registerTeamWin(map, teamId, teamData) {
    if (teamId == null) return;
    const prev = map.get(teamId);
    if (prev) {
        prev.count += 1;
        if (!prev.team && teamData) prev.team = teamData;
    } else {
        map.set(teamId, { count: 1, team: teamData || null });
    }
}

function rankMap(map, limit) {
    return [...map.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, limit)
        .map(([teamId, v]) => ({
            team_id: teamId,
            team: v.team,
            count: v.count,
        }));
}

function emptyStats() {
    return {
        matches_played: 0,
        home_wins: 0, away_wins: 0, draws: 0,
        home_win_pct: 0, away_win_pct: 0, draw_pct: 0,
        yellows_total: 0, reds_total: 0,
        yellows_per_match: 0, reds_per_match: 0,
        goals_per_match: 0,
        total_goals: 0,
        fouls_total: 0, fouls_per_match: 0,
        offsides_total: 0, offsides_per_match: 0,
        fouls_sample_size: 0, offsides_sample_size: 0,
    };
}

function emptyBreakdowns() {
    return { topAppearances: [], topWinners: [], byCompetition: [] };
}

export function refereeFullName(ref) {
    return `${ref.first_name} ${ref.last_name}`.trim();
}

export function refereeAge(ref, referenceYear = new Date().getFullYear()) {
    return referenceYear - (ref.birth_year || referenceYear);
}

export function tierLabel(tier) {
    if (tier === 'voll') return 'Voll Damm';
    if (tier === 'estrella') return 'Estrella Damm';
    return tier;
}

export function teamDisplayName(team, fallback = '?') {
    if (!team) return fallback;
    return team.nickname || team.display_name || team.clubs?.name || fallback;
}
