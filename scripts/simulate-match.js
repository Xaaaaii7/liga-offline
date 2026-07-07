// Node 18 no trae WebSocket global (supabase-js reciente lo exige al crear
// el cliente, aunque no usemos realtime) - polyfill mínimo con `ws`.
if (typeof globalThis.WebSocket === 'undefined') {
  const { WebSocket } = await import('ws');
  globalThis.WebSocket = WebSocket;
}

import { createClient } from '@supabase/supabase-js';
import { SUPABASE_CONFIG } from '../public/js/modules/config.js';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// ─────────────────────────────────────────────────────────────────────
// Usage:
//   node scripts/simulate-match.js match <matchId> [outputPath]
//   node scripts/simulate-match.js teams <competitionId> <home> <away> [outputPath]
//
// <home>/<away> admite: id numérico de league_team, nickname de usuario, nickname o display_name de league_team.
// Salida: fichero SQL listo para ejecutar contra la BD.

const args = process.argv.slice(2);
const mode = args[0];
if (!['match', 'teams'].includes(mode)) {
    console.error('Usage:');
    console.error('  node scripts/simulate-match.js match <matchId> [outputPath]');
    console.error('  node scripts/simulate-match.js teams <competitionId> <home> <away> [outputPath]');
    process.exit(1);
}

const sb = createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey, {
    auth: { autoRefreshToken: false, persistSession: false }
});

// ──────────────────── Helpers matemáticos ──────────────────────────
const sum = xs => xs.reduce((a, b) => a + b, 0);
const mean = xs => xs.length ? sum(xs) / xs.length : 0;
const stdev = xs => {
    if (xs.length < 2) return 0;
    const m = mean(xs);
    return Math.sqrt(sum(xs.map(x => (x - m) ** 2)) / (xs.length - 1));
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const randn = () => {
    let u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const poisson = (lambda) => {
    if (lambda <= 0) return 0;
    const L = Math.exp(-lambda);
    let k = 0, p = 1;
    do { k++; p *= Math.random(); } while (p > L);
    return k - 1;
};
const sampleWeighted = (items, weights) => {
    const total = sum(weights);
    if (total <= 0) return items[Math.floor(Math.random() * items.length)];
    let r = Math.random() * total;
    for (let i = 0; i < items.length; i++) {
        r -= weights[i];
        if (r <= 0) return items[i];
    }
    return items[items.length - 1];
};
const sampleBeta = (a, b) => {
    // Aproximación mediante ratio de gammas; para los a,b que usamos vale
    const sampleGamma = (k) => {
        if (k < 1) return sampleGamma(k + 1) * Math.pow(Math.random(), 1 / k);
        const d = k - 1 / 3;
        const c = 1 / Math.sqrt(9 * d);
        while (true) {
            let x, v;
            do { x = randn(); v = 1 + c * x; } while (v <= 0);
            v = v ** 3;
            const u = Math.random();
            if (u < 1 - 0.0331 * (x ** 4)) return d * v;
            if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
        }
    };
    const x = sampleGamma(a);
    const y = sampleGamma(b);
    return x / (x + y);
};

// Corrección Dixon-Coles para marcadores bajos
const dcCorrection = (lh, la, rho = -0.1) => {
    // Devuelve matriz 2x2 de pesos correctivos para (0-0, 0-1, 1-0, 1-1)
    return {
        '0-0': 1 - lh * la * rho,
        '1-0': 1 + la * rho,
        '0-1': 1 + lh * rho,
        '1-1': 1 - rho
    };
};
const poissonPmf = (k, lambda) => {
    if (lambda <= 0) return k === 0 ? 1 : 0;
    let p = Math.exp(-lambda);
    for (let i = 1; i <= k; i++) p *= lambda / i;
    return p;
};
const sampleDcScore = (lh, la, rho = -0.1, maxGoals = 8) => {
    const probs = [];
    const dc = dcCorrection(lh, la, rho);
    for (let h = 0; h <= maxGoals; h++) {
        for (let a = 0; a <= maxGoals; a++) {
            const key = `${h}-${a}`;
            const corr = dc[key] ?? 1;
            probs.push({ h, a, p: poissonPmf(h, lh) * poissonPmf(a, la) * Math.max(0, corr) });
        }
    }
    const totalP = sum(probs.map(x => x.p));
    const r = Math.random() * totalP;
    let acc = 0;
    for (const x of probs) {
        acc += x.p;
        if (r <= acc) return { homeGoals: x.h, awayGoals: x.a };
    }
    return { homeGoals: probs[probs.length - 1].h, awayGoals: probs[probs.length - 1].a };
};

// ──────────────────── Helpers SQL ──────────────────────────────────
const sqlStr = (s) => {
    if (s === null || s === undefined) return 'NULL';
    return `'${String(s).replace(/'/g, "''")}'`;
};
const sqlNum = (n) => (n === null || n === undefined || Number.isNaN(n)) ? 'NULL' : String(n);

// ──────────────────── Resolución de equipos ────────────────────────
const resolveLeagueTeam = async (ident, competitionId) => {
    // 1) Si es numérico
    if (/^\d+$/.test(String(ident))) {
        const id = parseInt(ident, 10);
        const { data } = await sb
            .from('league_teams')
            .select('id, nickname, display_name, club_id, user_id, competition_id')
            .eq('id', id)
            .maybeSingle();
        if (data && data.competition_id === competitionId) return data;
        if (data) throw new Error(`league_team ${id} pertenece a competición ${data.competition_id}, no ${competitionId}`);
    }

    const str = String(ident);

    // 2) Como nickname de usuario → league_team en esa competición
    const { data: user } = await sb
        .from('users')
        .select('id, nickname')
        .ilike('nickname', str)
        .maybeSingle();
    if (user) {
        const { data: lt } = await sb
            .from('league_teams')
            .select('id, nickname, display_name, club_id, user_id, competition_id')
            .eq('user_id', user.id)
            .eq('competition_id', competitionId)
            .maybeSingle();
        if (lt) return lt;
    }

    // 3) Como nickname/display_name de league_team
    const { data: lts } = await sb
        .from('league_teams')
        .select('id, nickname, display_name, club_id, user_id, competition_id')
        .eq('competition_id', competitionId)
        .or(`nickname.ilike.${str},display_name.ilike.${str}`);
    if (lts && lts.length === 1) return lts[0];
    if (lts && lts.length > 1) throw new Error(`Ambigüedad: ${lts.length} equipos coinciden con "${str}" en competición ${competitionId}`);

    throw new Error(`No se encontró equipo/usuario "${str}" en competición ${competitionId}`);
};

// ──────────────────── Carga de histórico ───────────────────────────
const loadTeamHistory = async (teamId, competitionId) => {
    const { data } = await sb
        .from('matches')
        .select('id, match_uuid, home_league_team_id, away_league_team_id, home_goals, away_goals, match_date, resolved_administratively')
        .eq('competition_id', competitionId)
        .or(`home_league_team_id.eq.${teamId},away_league_team_id.eq.${teamId}`)
        .not('home_goals', 'is', null)
        .not('away_goals', 'is', null);
    return (data || [])
        .filter(m => m.resolved_administratively !== true)
        .map(m => {
            const isHome = m.home_league_team_id === teamId;
            return {
                matchId: m.id,
                matchUuid: m.match_uuid,
                gf: isHome ? m.home_goals : m.away_goals,
                ga: isHome ? m.away_goals : m.home_goals,
                oppId: isHome ? m.away_league_team_id : m.home_league_team_id,
                date: m.match_date,
            };
        })
        .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
};

// Dado un league_team_id, devuelve TODOS los league_team_ids del mismo usuario
// en todas las competiciones. Si no tiene user_id, devuelve solo el propio.
const expandToAllUserTeams = async (teamId) => {
    const { data: lt } = await sb
        .from('league_teams')
        .select('id, user_id')
        .eq('id', teamId)
        .maybeSingle();
    if (!lt?.user_id) return [teamId];
    const { data: allTeams } = await sb
        .from('league_teams')
        .select('id')
        .eq('user_id', lt.user_id);
    return (allTeams || []).map(t => t.id);
};

const loadH2HAllCompetitions = async (teamIdsA, teamIdsB) => {
    // Cruce: partidos donde cualquier team de A juega contra cualquier team de B
    if (!teamIdsA.length || !teamIdsB.length) return [];
    const aList = teamIdsA.join(',');
    const bList = teamIdsB.join(',');
    const { data } = await sb
        .from('matches')
        .select('id, match_uuid, competition_id, season, home_league_team_id, away_league_team_id, home_goals, away_goals, match_date, resolved_administratively')
        .or(`and(home_league_team_id.in.(${aList}),away_league_team_id.in.(${bList})),and(home_league_team_id.in.(${bList}),away_league_team_id.in.(${aList}))`)
        .not('home_goals', 'is', null)
        .not('away_goals', 'is', null);
    return (data || []).filter(m => m.resolved_administratively !== true);
};

const loadTeamStatsForMatches = async (matchUuids, teamId) => {
    if (!matchUuids.length) return [];
    const { data } = await sb
        .from('match_team_stats')
        .select('match_uuid, league_team_id, possession, shots, shots_on_target, fouls, offsides, corners, free_kicks, passes, passes_completed, crosses, interceptions, tackles, saves, red_cards')
        .in('match_uuid', matchUuids)
        .eq('league_team_id', teamId);
    return data || [];
};

// Carga stats de AMBOS equipos (home y away) para los match_uuids dados
const loadAllStatsForMatches = async (matchUuids) => {
    if (!matchUuids.length) return [];
    const { data } = await sb
        .from('match_team_stats')
        .select('match_uuid, league_team_id, shots, shots_on_target')
        .in('match_uuid', matchUuids);
    return data || [];
};

const loadRedCardsHistory = async (teamId, competitionId) => {
    const { data } = await sb
        .from('match_red_cards')
        .select('match_uuid, league_team_id, player_id, minute')
        .eq('league_team_id', teamId)
        .eq('competition_id', competitionId);
    return data || [];
};

const loadPlayerRedCardsAllComps = async (playerIds) => {
    if (!playerIds.length) return {};
    const { data } = await sb
        .from('match_red_cards')
        .select('player_id, match_uuid')
        .in('player_id', playerIds);
    const counts = {};
    (data || []).forEach(r => { counts[r.player_id] = (counts[r.player_id] || 0) + 1; });
    return counts;
};

const loadSquad = async (clubId, season) => {
    const { data: memberships } = await sb
        .from('player_club_memberships')
        .select('player_id, season, is_current')
        .eq('club_id', clubId)
        .eq('season', season);
    const ids = (memberships || []).map(m => m.player_id);
    if (!ids.length) return [];
    const { data: players } = await sb.from('players').select('id, name, position').in('id', ids);
    return players || [];
};

const loadPlayerGoalsAllComps = async (playerIds) => {
    if (!playerIds.length) return {};
    const { data } = await sb
        .from('goal_events')
        .select('player_id, season, competition_id')
        .eq('event_type', 'goal')
        .in('player_id', playerIds);
    const counts = {};
    (data || []).forEach(g => {
        counts[g.player_id] ||= { total: 0, currentSeason: 0 };
        counts[g.player_id].total++;
    });
    return { raw: data || [], counts };
};

const loadPlayerRatingsAllComps = async (playerIds, season) => {
    if (!playerIds.length) return { avg: {}, matches: {}, currentSeasonMatches: {} };
    const { data } = await sb
        .from('match_player_ratings')
        .select('player_id, rating, season, league_team_id')
        .in('player_id', playerIds);
    const byId = {};
    (data || []).forEach(r => {
        if (r.rating == null) return;
        byId[r.player_id] ||= { ratings: [], matches: 0, currentSeasonMatches: 0 };
        byId[r.player_id].ratings.push(r.rating);
        byId[r.player_id].matches++;
        if (r.season === season) byId[r.player_id].currentSeasonMatches++;
    });
    const avg = {}, matches = {}, currentSeasonMatches = {};
    for (const [pid, v] of Object.entries(byId)) {
        avg[pid] = mean(v.ratings);
        matches[pid] = v.matches;
        currentSeasonMatches[pid] = v.currentSeasonMatches;
    }
    return { avg, matches, currentSeasonMatches };
};

// ──────────────────── Cálculos del modelo ──────────────────────────
const computeFormFactor = (history, kind, lastN = 5) => {
    if (!history.length) return 1;
    const recent = history.slice(0, lastN);
    const weights = recent.map((_, i) => Math.exp(-0.2 * i));
    const totalW = sum(weights);
    const recentWeighted = recent.reduce((a, h, i) => a + h[kind] * weights[i], 0) / totalW;
    const overall = mean(history.map(h => h[kind]));
    if (overall <= 0) return 1;
    return clamp(recentWeighted / overall, 0.6, 1.5);
};

const computeH2HFactor = (h2h, teamIdsA) => {
    if (!h2h.length) return { mulA: 1, mulB: 1, count: 0 };
    const setA = new Set(teamIdsA);
    // Peso por recencia (decay por match_date descendente)
    const ordered = [...h2h].sort((a, b) => String(b.match_date || '').localeCompare(String(a.match_date || '')));
    let wSum = 0, gfA = 0, gfB = 0;
    ordered.forEach((m, i) => {
        const w = Math.exp(-0.5 * i);
        const aIsHome = setA.has(m.home_league_team_id);
        const aGoals = aIsHome ? m.home_goals : m.away_goals;
        const bGoals = aIsHome ? m.away_goals : m.home_goals;
        gfA += aGoals * w;
        gfB += bGoals * w;
        wSum += w;
    });
    const avgA = gfA / wSum;
    const avgB = gfB / wSum;
    const avgBoth = (avgA + avgB) / 2 || 1;
    return {
        mulA: clamp(avgA / avgBoth, 0.75, 1.25),
        mulB: clamp(avgB / avgBoth, 0.75, 1.25),
        count: h2h.length
    };
};

const positionPriors = {
    Attacker: { goalRate: 0.35, cardWeight: 0.7 },
    Offence: { goalRate: 0.35, cardWeight: 0.7 },
    Forward: { goalRate: 0.35, cardWeight: 0.7 },
    Midfielder: { goalRate: 0.08, cardWeight: 1.0 },
    Midfield: { goalRate: 0.08, cardWeight: 1.0 },
    Defender: { goalRate: 0.03, cardWeight: 1.5 },
    Defence: { goalRate: 0.03, cardWeight: 1.5 },
    Goalkeeper: { goalRate: 0.0, cardWeight: 0.2 },
};
const priorFor = (pos) => positionPriors[pos] || { goalRate: 0.1, cardWeight: 1.0 };

// ──────────────────── Main ──────────────────────────────────────────
(async () => {
    let matchId, matchUuid, competitionId, season, homeId, awayId, roundType;
    let existingMatch = false;
    let outputPath = null;
    let homeTeam, awayTeam;

    if (mode === 'match') {
        const mid = args[1];
        outputPath = args[2] || null;
        if (!mid) { console.error('Falta matchId'); process.exit(1); }
        const { data: m } = await sb
            .from('matches')
            .select('id, match_uuid, competition_id, season, home_league_team_id, away_league_team_id, home_goals, away_goals, round_type')
            .eq('id', mid).maybeSingle();
        if (!m) { console.error('Partido no encontrado:', mid); process.exit(1); }
        if (m.home_goals != null || m.away_goals != null) {
            console.error('El partido ya tiene resultado'); process.exit(1);
        }
        matchId = m.id; matchUuid = m.match_uuid; competitionId = m.competition_id;
        season = m.season; homeId = m.home_league_team_id; awayId = m.away_league_team_id;
        roundType = m.round_type; existingMatch = true;
    } else {
        // teams
        const compArg = args[1], hArg = args[2], aArg = args[3];
        outputPath = args[4] || null;
        if (!compArg || !hArg || !aArg) {
            console.error('Uso: teams <competitionId> <home> <away> [outputPath]'); process.exit(1);
        }
        competitionId = parseInt(compArg, 10);
        if (!Number.isFinite(competitionId)) { console.error('competitionId inválido'); process.exit(1); }
        homeTeam = await resolveLeagueTeam(hArg, competitionId);
        awayTeam = await resolveLeagueTeam(aArg, competitionId);
        if (homeTeam.id === awayTeam.id) { console.error('Home y away deben ser distintos'); process.exit(1); }
        homeId = homeTeam.id; awayId = awayTeam.id;

        const { data: comp } = await sb
            .from('competitions')
            .select('id, season, competition_type')
            .eq('id', competitionId).maybeSingle();
        if (!comp) { console.error('Competición no encontrada'); process.exit(1); }
        season = comp.season;
        if (comp.competition_type === 'ranked') roundType = 'ranked';
        else if (comp.competition_type === 'cup') roundType = 'cup';
        else roundType = null;

        matchId = `sim_${competitionId}_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`;
        matchUuid = null; // se resolverá en SQL vía RETURNING
    }

    // Cargar equipos si aún no los tenemos (modo match)
    if (!homeTeam || !awayTeam) {
        const { data: teams } = await sb
            .from('league_teams')
            .select('id, nickname, display_name, club_id, user_id')
            .in('id', [homeId, awayId]);
        homeTeam = teams.find(t => t.id === homeId);
        awayTeam = teams.find(t => t.id === awayId);
    }
    const teamLabel = (t) => t.nickname || t.display_name || `team-${t.id}`;

    // ─── Histórico de equipos (en competición) ──────────────────────
    const homeHist = await loadTeamHistory(homeId, competitionId);
    const awayHist = await loadTeamHistory(awayId, competitionId);
    const homeUuids = homeHist.map(h => h.matchUuid).filter(Boolean);
    const awayUuids = awayHist.map(h => h.matchUuid).filter(Boolean);
    const homeTs = await loadTeamStatsForMatches(homeUuids, homeId);
    const awayTs = await loadTeamStatsForMatches(awayUuids, awayId);
    const tsByUuidHome = new Map(homeTs.map(r => [r.match_uuid, r]));
    const tsByUuidAway = new Map(awayTs.map(r => [r.match_uuid, r]));

    // ─── Media de la competición (para shrinkage y normalización) ─
    // Usamos todos los partidos de la competición ya jugados
    const { data: allCompMatches } = await sb
        .from('matches')
        .select('home_league_team_id, away_league_team_id, home_goals, away_goals, resolved_administratively')
        .eq('competition_id', competitionId)
        .not('home_goals', 'is', null)
        .not('away_goals', 'is', null);
    const cleanCompMatches = (allCompMatches || []).filter(m => m.resolved_administratively !== true);
    const leagueGoalAvg = cleanCompMatches.length
        ? mean(cleanCompMatches.flatMap(m => [m.home_goals, m.away_goals]))
        : 1.3;

    // ─── PPG por equipo (métrica de nivel) ─────────────────────────
    const teamPoints = new Map();
    cleanCompMatches.forEach(m => {
        const homePts = m.home_goals > m.away_goals ? 3 : m.home_goals === m.away_goals ? 1 : 0;
        const awayPts = m.away_goals > m.home_goals ? 3 : m.home_goals === m.away_goals ? 1 : 0;
        teamPoints.set(m.home_league_team_id, [...(teamPoints.get(m.home_league_team_id) || []), homePts]);
        teamPoints.set(m.away_league_team_id, [...(teamPoints.get(m.away_league_team_id) || []), awayPts]);
    });
    const ppgById = {};
    let ptsTotal = 0, matchesTotal = 0;
    for (const [id, arr] of teamPoints) {
        ppgById[id] = mean(arr);
        ptsTotal += sum(arr);
        matchesTotal += arr.length;
    }
    const leaguePPG = matchesTotal > 0 ? ptsTotal / matchesTotal : 1.3;
    const teamStrength = (teamId) => ppgById[teamId] ?? leaguePPG;

    // ─── Medias de liga para tiros y tiros a puerta ────────────────
    const { data: allLeagueStats } = await sb
        .from('match_team_stats')
        .select('shots, shots_on_target')
        .eq('competition_id', competitionId);
    const leagueAvgShots = (allLeagueStats || []).length
        ? mean((allLeagueStats || []).map(r => r.shots).filter(v => v != null))
        : 11;
    const leagueAvgSoT = (allLeagueStats || []).length
        ? mean((allLeagueStats || []).map(r => r.shots_on_target).filter(v => v != null))
        : 4;
    const leagueSotRate = leagueAvgShots > 0 ? leagueAvgSoT / leagueAvgShots : 0.35;
    const leagueConvRate = leagueAvgSoT > 0 ? leagueGoalAvg / leagueAvgSoT : 0.30;

    // ─── Cadena: cargar tiros propios y del rival en cada partido ──
    const allUuids = [...new Set([...homeUuids, ...awayUuids])];
    const allStatsRows = await loadAllStatsForMatches(allUuids);
    const shotsByUuidTeam = new Map(); // `${uuid}|${teamId}` -> { shots, sot }
    for (const r of allStatsRows) {
        shotsByUuidTeam.set(`${r.match_uuid}|${r.league_team_id}`, {
            shots: r.shots ?? null,
            sot: r.shots_on_target ?? null,
        });
    }
    const enrichChain = (history, selfId) => history
        .map(h => {
            const own = shotsByUuidTeam.get(`${h.matchUuid}|${selfId}`);
            const opp = shotsByUuidTeam.get(`${h.matchUuid}|${h.oppId}`);
            if (!own || !opp || own.shots == null || opp.shots == null) return null;
            return {
                ...h,
                shots: own.shots, sot: own.sot ?? 0,
                oppShots: opp.shots, oppSot: opp.sot ?? 0,
            };
        })
        .filter(Boolean);
    const homeChain = enrichChain(homeHist, homeId);
    const awayChain = enrichChain(awayHist, awayId);

    // Ponderación por similitud de PPG del rival histórico con el rival actual
    const normChain = (chain, currentOppId, k = 1.0) => {
        if (!chain.length) return {
            shots: leagueAvgShots, sot: leagueAvgSoT, goals: leagueGoalAvg,
            oppShots: leagueAvgShots, oppSot: leagueAvgSoT, oppGoals: leagueGoalAvg,
            effectiveN: 0,
        };
        const currentStrength = teamStrength(currentOppId);
        const samples = chain.map(h => ({
            ...h,
            w: Math.exp(-k * Math.abs(teamStrength(h.oppId) - currentStrength)),
        }));
        const wSum = sum(samples.map(s => s.w));
        if (wSum <= 0) return {
            shots: leagueAvgShots, sot: leagueAvgSoT, goals: leagueGoalAvg,
            oppShots: leagueAvgShots, oppSot: leagueAvgSoT, oppGoals: leagueGoalAvg,
            effectiveN: 0,
        };
        const wAvg = (key) => sum(samples.map(s => (s[key] || 0) * s.w)) / wSum;
        return {
            shots: wAvg('shots'),
            sot: wAvg('sot'),
            goals: wAvg('gf'),
            oppShots: wAvg('oppShots'),
            oppSot: wAvg('oppSot'),
            oppGoals: wAvg('ga'),
            effectiveN: (wSum * wSum) / sum(samples.map(s => s.w * s.w)),
        };
    };
    const homeNorm = normChain(homeChain, awayId);
    const awayNorm = normChain(awayChain, homeId);

    // Shrinkage hacia la media de liga
    const shrink = (value, N, prior, alpha = 8) => (value * N + prior * alpha) / (N + alpha);
    const blendLeague = (norm) => ({
        shots: shrink(norm.shots, norm.effectiveN, leagueAvgShots),
        sot: shrink(norm.sot, norm.effectiveN, leagueAvgSoT),
        goals: shrink(norm.goals, norm.effectiveN, leagueGoalAvg),
        oppShots: shrink(norm.oppShots, norm.effectiveN, leagueAvgShots),
        oppSot: shrink(norm.oppSot, norm.effectiveN, leagueAvgSoT),
        oppGoals: shrink(norm.oppGoals, norm.effectiveN, leagueGoalAvg),
        effectiveN: norm.effectiveN,
    });
    const homeS = blendLeague(homeNorm);
    const awayS = blendLeague(awayNorm);

    // ── Cadena: tiros esperados, p(tiro a puerta), p(a puerta→gol) ──
    // Combinación: ataque × defensa_rival_permitida, normalizado a media de liga.
    let E_shots_home = leagueAvgShots * (homeS.shots / leagueAvgShots) * (awayS.oppShots / leagueAvgShots);
    let E_shots_away = leagueAvgShots * (awayS.shots / leagueAvgShots) * (homeS.oppShots / leagueAvgShots);

    const homeSotProb = clamp(
        (homeS.sot / Math.max(homeS.shots, 0.1)) * (awayS.oppSot / Math.max(awayS.oppShots, 0.1)) / leagueSotRate,
        0.15, 0.75
    );
    const awaySotProb = clamp(
        (awayS.sot / Math.max(awayS.shots, 0.1)) * (homeS.oppSot / Math.max(homeS.oppShots, 0.1)) / leagueSotRate,
        0.15, 0.75
    );
    const homeConvProb = clamp(
        (homeS.goals / Math.max(homeS.sot, 0.1)) * (awayS.oppGoals / Math.max(awayS.oppSot, 0.1)) / leagueConvRate,
        0.08, 0.60
    );
    const awayConvProb = clamp(
        (awayS.goals / Math.max(awayS.sot, 0.1)) * (homeS.oppGoals / Math.max(homeS.oppSot, 0.1)) / leagueConvRate,
        0.08, 0.60
    );

    // Forma (aplicada a tiros esperados)
    const formHome = computeFormFactor(homeHist, 'gf');
    const formAwayDef = computeFormFactor(awayHist, 'ga');
    const formAway = computeFormFactor(awayHist, 'gf');
    const formHomeDef = computeFormFactor(homeHist, 'ga');
    E_shots_home *= (formHome + formAwayDef) / 2;
    E_shots_away *= (formAway + formHomeDef) / 2;

    // H2H (todas competiciones no-ranked, agregando todos los league_team del mismo usuario)
    const homeUserTeamIds = await expandToAllUserTeams(homeId);
    const awayUserTeamIds = await expandToAllUserTeams(awayId);
    const { data: rankedComps } = await sb
        .from('competitions')
        .select('id')
        .eq('competition_type', 'ranked');
    const rankedCompIds = new Set((rankedComps || []).map(c => c.id));
    const h2hRaw = await loadH2HAllCompetitions(homeUserTeamIds, awayUserTeamIds);
    const h2hMatches = h2hRaw.filter(m => !rankedCompIds.has(m.competition_id));
    const h2h = computeH2HFactor(h2hMatches, homeUserTeamIds);
    E_shots_home *= h2h.mulA;
    E_shots_away *= h2h.mulB;

    // Elo (si ranked)
    let eloHome = null, eloAway = null;
    if (roundType === 'ranked') {
        const { data: elos } = await sb
            .from('ranked_ratings')
            .select('league_team_id, rating')
            .eq('competition_id', competitionId)
            .in('league_team_id', [homeId, awayId]);
        eloHome = elos?.find(e => e.league_team_id === homeId)?.rating ?? null;
        eloAway = elos?.find(e => e.league_team_id === awayId)?.rating ?? null;
        if (eloHome != null && eloAway != null) {
            E_shots_home *= Math.pow(10, (eloHome - eloAway) / 800);
            E_shots_away *= Math.pow(10, (eloAway - eloHome) / 800);
        }
    }

    E_shots_home = clamp(E_shots_home, 2, 35);
    E_shots_away = clamp(E_shots_away, 2, 35);
    const E_shots_home_pre = E_shots_home;
    const E_shots_away_pre = E_shots_away;

    // ─── Plantilla y XI ─────────────────────────────────────────────
    const homeSquad = await loadSquad(homeTeam.club_id, season);
    const awaySquad = await loadSquad(awayTeam.club_id, season);

    const homePlayerIds = homeSquad.map(p => p.id);
    const awayPlayerIds = awaySquad.map(p => p.id);
    const allPlayerIds = [...homePlayerIds, ...awayPlayerIds];

    const { counts: goalCountsByPlayer } = await loadPlayerGoalsAllComps(allPlayerIds);
    const playerGoalMatches = {}; // player_id -> matches played (approx = rating rows)
    const ratingsData = await loadPlayerRatingsAllComps(allPlayerIds, season);
    const redCardCountsByPlayer = await loadPlayerRedCardsAllComps(allPlayerIds);

    const enrichPlayer = (p) => {
        const matches = ratingsData.matches[p.id] || 0;
        const currentSeasonMatches = ratingsData.currentSeasonMatches[p.id] || 0;
        const avgRating = ratingsData.avg[p.id] ?? null;
        const goals = goalCountsByPlayer[p.id]?.total || 0;
        const reds = redCardCountsByPlayer[p.id] || 0;
        const prior = priorFor(p.position);
        const alpha = 5;
        const goalRate = matches > 0
            ? (goals + alpha * prior.goalRate) / (matches + alpha)
            : prior.goalRate;
        const redRate = matches > 0
            ? (reds + alpha * 0.03) / (matches + alpha)
            : 0.03;
        // Rating base con shrinkage
        const baseRating = avgRating != null
            ? (avgRating * matches + 6.5 * 5) / (matches + 5)
            : 6.5;
        return {
            ...p, matches, currentSeasonMatches, avgRating, baseRating,
            goals, goalRate, redRate, priorCardWeight: prior.cardWeight,
        };
    };

    const homeEnriched = homeSquad.map(enrichPlayer);
    const awayEnriched = awaySquad.map(enrichPlayer);

    // XI titular: priorizar apariciones temporada actual en esta competición.
    // Si no hay datos suficientes, caer a apariciones globales.
    const pickStarters = (players) => {
        const weightFor = (p) => p.currentSeasonMatches * 3 + p.matches;
        const sorted = [...players].sort((a, b) => weightFor(b) - weightFor(a) || (b.baseRating - a.baseRating));
        const gk = sorted.find(p => p.position === 'Goalkeeper');
        const field = sorted.filter(p => p.position !== 'Goalkeeper').slice(0, 10);
        return [gk, ...field].filter(Boolean).slice(0, 11);
    };
    const homeStarters = pickStarters(homeEnriched);
    const awayStarters = pickStarters(awayEnriched);

    // ─── Tarjetas rojas (antes de goles) ────────────────────────────
    const homeRedHist = await loadRedCardsHistory(homeId, competitionId);
    const awayRedHist = await loadRedCardsHistory(awayId, competitionId);
    const homeRedsPerMatchRaw = homeHist.length ? homeRedHist.length / homeHist.length : 0;
    const awayRedsPerMatchRaw = awayHist.length ? awayRedHist.length / awayHist.length : 0;
    const compRedsPerMatch = cleanCompMatches.length
        ? ((homeRedHist.length + awayRedHist.length + /* proxy */ 0) / Math.max(1, cleanCompMatches.length)) * 0.5
        : 0.15;
    const homeRedLambda = shrink(homeRedsPerMatchRaw, homeHist.length, compRedsPerMatch);
    const awayRedLambda = shrink(awayRedsPerMatchRaw, awayHist.length, compRedsPerMatch);

    const sampleReds = (lambda, starters) => {
        let count = poisson(lambda);
        count = Math.min(count, 2);
        if (!count || !starters.length) return [];
        const reds = [];
        const available = [...starters];
        for (let i = 0; i < count; i++) {
            if (!available.length) break;
            const weights = available.map(p => p.redRate * p.priorCardWeight);
            const picked = sampleWeighted(available, weights);
            // minuto con sesgo a segundo tiempo: Beta(2, 1.5)*90
            const minute = clamp(Math.round(sampleBeta(2, 1.5) * 90), 1, 90);
            reds.push({ player: picked, minute });
            // remover para evitar roja doble al mismo jugador
            available.splice(available.indexOf(picked), 1);
        }
        return reds.sort((a, b) => a.minute - b.minute);
    };
    const homeReds = sampleReds(homeRedLambda, homeStarters);
    const awayReds = sampleReds(awayRedLambda, awayStarters);

    // Ajustar tiros esperados por expulsión: factor sobre tiempo restante
    const applyRedFactor = (shots, ownReds, oppReds) => {
        let factor = 1;
        for (const r of ownReds) factor *= (r.minute + (90 - r.minute) * 0.70) / 90;
        for (const r of oppReds) factor *= (r.minute + (90 - r.minute) * 1.20) / 90;
        return clamp(shots * factor, 1, 40);
    };
    E_shots_home = applyRedFactor(E_shots_home, homeReds, awayReds);
    E_shots_away = applyRedFactor(E_shots_away, awayReds, homeReds);

    // ─── Muestreo cadena: tiros → a puerta → goles ───────────────
    const sampleBinomial = (n, p) => {
        if (n <= 0 || p <= 0) return 0;
        if (p >= 1) return n;
        let k = 0;
        for (let i = 0; i < n; i++) if (Math.random() < p) k++;
        return k;
    };
    const shotsHomeSim = poisson(E_shots_home);
    const shotsAwaySim = poisson(E_shots_away);
    const sotHomeSim = sampleBinomial(shotsHomeSim, homeSotProb);
    const sotAwaySim = sampleBinomial(shotsAwaySim, awaySotProb);
    const homeGoals = sampleBinomial(sotHomeSim, homeConvProb);
    const awayGoals = sampleBinomial(sotAwaySim, awayConvProb);

    // ─── Goleadores ────────────────────────────────────────────────
    const pickScorers = (starters, nGoals, reds) => {
        if (!nGoals || !starters.length) return [];
        const expelledBefore = (minute) => reds.filter(r => r.minute <= minute).map(r => r.player.id);
        const result = [];
        for (let i = 0; i < nGoals; i++) {
            // minuto aleatorio (no correlacionado con rojas pero evitaremos expulsados hasta ese minuto)
            const minute = clamp(Math.floor(Math.random() * 90) + 1, 1, 93);
            const expelled = new Set(expelledBefore(minute));
            const available = starters.filter(p => !expelled.has(p.id));
            if (!available.length) continue;
            const weights = available.map(p => p.goalRate);
            const picked = sampleWeighted(available, weights);
            result.push({ player: picked, minute });
        }
        return result.sort((a, b) => a.minute - b.minute);
    };
    const homeScorers = pickScorers(homeStarters, homeGoals, homeReds);
    const awayScorers = pickScorers(awayStarters, awayGoals, awayReds);

    // ─── Stats de equipo ────────────────────────────────────────────
    // shots y shots_on_target vienen YA de la cadena (coherentes con los goles).
    // El resto de campos se muestrean del histórico del equipo.
    const collectHist = (tsMap, uuids, field) =>
        uuids.map(u => tsMap.get(u)?.[field]).filter(v => v != null && !Number.isNaN(v));

    const histFields = ['possession', 'fouls', 'offsides', 'corners', 'free_kicks', 'passes', 'passes_completed', 'crosses', 'interceptions', 'tackles', 'saves'];
    const fieldRanges = {
        possession: [20, 80], shots: [0, 40], shots_on_target: [0, 25], fouls: [0, 30],
        offsides: [0, 15], corners: [0, 20], free_kicks: [0, 30],
        passes: [50, 900], passes_completed: [30, 850], crosses: [0, 40],
        interceptions: [0, 50], tackles: [0, 50], saves: [0, 20],
    };
    const sampleTeamStats = (tsMap, uuids, chainShots, chainSot) => {
        const out = { shots: chainShots, shots_on_target: chainSot };
        for (const f of histFields) {
            const arr = collectHist(tsMap, uuids, f);
            const m = arr.length ? mean(arr) : (fieldRanges[f][0] + fieldRanges[f][1]) / 4;
            const s = arr.length > 1 ? stdev(arr) : m * 0.25;
            let v = m + randn() * s * 0.35;
            const [lo, hi] = fieldRanges[f];
            v = clamp(v, lo, hi);
            out[f] = f === 'possession' ? v : Math.round(v);
        }
        out._histMean = Object.fromEntries(histFields.map(f => [f, mean(collectHist(tsMap, uuids, f)) || 0]));
        return out;
    };
    const homeStats = sampleTeamStats(tsByUuidHome, homeUuids, shotsHomeSim, sotHomeSim);
    const awayStats = sampleTeamStats(tsByUuidAway, awayUuids, shotsAwaySim, sotAwaySim);

    // Normalizar posesión a 100
    const totalPos = homeStats.possession + awayStats.possession;
    if (totalPos > 0) {
        const hPos = Math.round((homeStats.possession / totalPos) * 100);
        homeStats.possession = hPos; awayStats.possession = 100 - hPos;
    } else {
        homeStats.possession = 50; awayStats.possession = 50;
    }

    // Acoplar pases/crosses/interceptions con posesión
    const couplePossession = (stats, side) => {
        const baseline = stats._histMean.possession || 50;
        if (baseline <= 0) return;
        const ratio = stats.possession / baseline;
        stats.passes = Math.round(clamp(stats.passes * ratio, fieldRanges.passes[0], fieldRanges.passes[1]));
        stats.passes_completed = Math.round(clamp(stats.passes_completed * ratio, fieldRanges.passes_completed[0], fieldRanges.passes_completed[1]));
        stats.crosses = Math.round(clamp(stats.crosses * ratio, fieldRanges.crosses[0], fieldRanges.crosses[1]));
    };
    couplePossession(homeStats, 'home');
    couplePossession(awayStats, 'away');

    // Coherencia: goles ≤ tiros_a_puerta ≤ tiros lo asegura la propia cadena.
    // Sólo ajustamos pases completados (no > 88% de pases) y paradas.
    const fixCoherence = (s) => {
        if (s.passes_completed > Math.floor(s.passes * 0.88)) s.passes_completed = Math.floor(s.passes * 0.85);
    };
    fixCoherence(homeStats);
    fixCoherence(awayStats);
    homeStats.saves = Math.max(homeStats.saves, awayStats.shots_on_target - awayGoals);
    awayStats.saves = Math.max(awayStats.saves, homeStats.shots_on_target - homeGoals);
    homeStats.red_cards = homeReds.length;
    awayStats.red_cards = awayReds.length;

    // ─── Ratings por jugador ────────────────────────────────────────
    const result = homeGoals > awayGoals ? 'HOME' : awayGoals > homeGoals ? 'AWAY' : 'DRAW';
    const buildRatings = (starters, scorers, reds, isHome) => {
        const goalsBy = {};
        scorers.forEach(s => goalsBy[s.player.id] = (goalsBy[s.player.id] || 0) + 1);
        const redsBy = {};
        reds.forEach(r => redsBy[r.player.id] = r.minute);
        const teamResult = result === 'DRAW' ? 'D' : ((result === 'HOME') === isHome ? 'W' : 'L');
        return starters.map(p => {
            let r = p.baseRating + randn() * 0.5;
            if (teamResult === 'W') r += 0.3;
            else if (teamResult === 'L') r -= 0.3;
            const g = goalsBy[p.id] || 0;
            if (g > 0) r += 0.6 * g;
            if (p.position === 'Goalkeeper') {
                const saves = isHome ? homeStats.saves : awayStats.saves;
                const conceded = isHome ? awayGoals : homeGoals;
                r += (saves - conceded * 0.6) * 0.04;
            }
            if (redsBy[p.id] != null) {
                r -= redsBy[p.id] < 30 ? 1.2 : 0.8;
            }
            r = clamp(r, 3.0, 10.0);
            return { ...p, rating: Math.round(r * 10) / 10, goalsScored: g, redMinute: redsBy[p.id] ?? null };
        });
    };
    const homeRated = buildRatings(homeStarters, homeScorers, homeReds, true);
    const awayRated = buildRatings(awayStarters, awayScorers, awayReds, false);

    // ─── Generar SQL ────────────────────────────────────────────────
    const sql = [];
    const header = [];
    header.push(`-- Simulated match: ${teamLabel(homeTeam)} ${homeGoals} - ${awayGoals} ${teamLabel(awayTeam)}`);
    header.push(`-- Mode: ${mode} | competition_id=${competitionId} | season=${season} | round_type=${roundType ?? 'NULL'}`);
    header.push(`-- Cadena ${teamLabel(homeTeam)}: tiros_esp=${E_shots_home.toFixed(1)} (pre-rojas ${E_shots_home_pre.toFixed(1)}), p(a_puerta)=${(homeSotProb * 100).toFixed(0)}%, p(gol|a_puerta)=${(homeConvProb * 100).toFixed(0)}% → muestra tiros=${shotsHomeSim}, a_puerta=${sotHomeSim}, goles=${homeGoals}`);
    header.push(`-- Cadena ${teamLabel(awayTeam)}: tiros_esp=${E_shots_away.toFixed(1)} (pre-rojas ${E_shots_away_pre.toFixed(1)}), p(a_puerta)=${(awaySotProb * 100).toFixed(0)}%, p(gol|a_puerta)=${(awayConvProb * 100).toFixed(0)}% → muestra tiros=${shotsAwaySim}, a_puerta=${sotAwaySim}, goles=${awayGoals}`);
    header.push(`-- Partidos competición: home=${homeHist.length} (Nef=${homeNorm.effectiveN.toFixed(1)}), away=${awayHist.length} (Nef=${awayNorm.effectiveN.toFixed(1)}) | H2H global: ${h2h.count} | Elo: ${eloHome ?? 'n/a'}/${eloAway ?? 'n/a'}`);
    header.push(`-- PPG: ${teamLabel(homeTeam)}=${teamStrength(homeId).toFixed(2)}, ${teamLabel(awayTeam)}=${teamStrength(awayId).toFixed(2)} (liga=${leaguePPG.toFixed(2)}, ponderación por similitud k=1.0)`);
    header.push(`-- Liga: avg_goles=${leagueGoalAvg.toFixed(2)}, avg_tiros=${leagueAvgShots.toFixed(1)}, avg_a_puerta=${leagueAvgSoT.toFixed(1)} (SoT%=${(leagueSotRate * 100).toFixed(0)}, conv%=${(leagueConvRate * 100).toFixed(0)})`);
    if (homeReds.length) header.push(`-- ROJAS ${teamLabel(homeTeam)}: ${homeReds.map(r => `${r.player.name}(${r.minute}')`).join(', ')}`);
    if (awayReds.length) header.push(`-- ROJAS ${teamLabel(awayTeam)}: ${awayReds.map(r => `${r.player.name}(${r.minute}')`).join(', ')}`);
    if (homeScorers.length) header.push(`-- GOLES ${teamLabel(homeTeam)}: ${homeScorers.map(s => `${s.player.name}(${s.minute}')`).join(', ')}`);
    if (awayScorers.length) header.push(`-- GOLES ${teamLabel(awayTeam)}: ${awayScorers.map(s => `${s.player.name}(${s.minute}')`).join(', ')}`);
    sql.push(header.join('\n'), '');

    if (mode === 'match') {
        sql.push('BEGIN;', '');
        sql.push(`-- 1. Actualizar matches`);
        sql.push(`UPDATE matches SET home_goals = ${homeGoals}, away_goals = ${awayGoals} WHERE id = ${sqlStr(matchId)};`);
        sql.push('');
        sql.push(`-- 2. match_team_stats`);
        sql.push(teamStatsInsert(homeId, homeStats, homeGoals, matchId, matchUuid, competitionId, false));
        sql.push(teamStatsInsert(awayId, awayStats, awayGoals, matchId, matchUuid, competitionId, false));
        if (homeScorers.length + awayScorers.length > 0) {
            sql.push('', `-- 3. goal_events`);
            sql.push(goalEventsInsert([...homeScorers.map(s => ({ ...s, teamId: homeId })), ...awayScorers.map(s => ({ ...s, teamId: awayId }))], matchId, matchUuid, competitionId, season, false));
        }
        if (homeReds.length + awayReds.length > 0) {
            sql.push('', `-- 4. match_red_cards`);
            sql.push(redCardsInsert([...homeReds.map(r => ({ ...r, teamId: homeId })), ...awayReds.map(r => ({ ...r, teamId: awayId }))], matchId, matchUuid, competitionId, season, false));
        }
        sql.push('', `-- 5. match_player_ratings`);
        sql.push(ratingsInsert([
            ...homeRated.map(p => ({ ...p, teamId: homeId })),
            ...awayRated.map(p => ({ ...p, teamId: awayId })),
        ], matchId, matchUuid, competitionId, season, false));
        sql.push('', 'COMMIT;');
    } else {
        // modo teams: usar DO $$ con RETURNING
        sql.push('BEGIN;', '');
        sql.push('DO $$');
        sql.push('DECLARE');
        sql.push('  v_match_uuid integer;');
        sql.push(`  v_match_id   text := ${sqlStr(matchId)};`);
        sql.push('BEGIN');
        sql.push(`  INSERT INTO matches (id, competition_id, season, home_league_team_id, away_league_team_id, round_type, home_goals, away_goals)`);
        sql.push(`  VALUES (v_match_id, ${competitionId}, ${sqlStr(season)}, ${homeId}, ${awayId}, ${roundType ? sqlStr(roundType) : 'NULL'}, ${homeGoals}, ${awayGoals})`);
        sql.push(`  RETURNING match_uuid INTO v_match_uuid;`);
        sql.push('');
        sql.push(teamStatsInsert(homeId, homeStats, homeGoals, null, null, competitionId, true));
        sql.push(teamStatsInsert(awayId, awayStats, awayGoals, null, null, competitionId, true));
        if (homeScorers.length + awayScorers.length > 0) {
            sql.push('');
            sql.push(goalEventsInsert([...homeScorers.map(s => ({ ...s, teamId: homeId })), ...awayScorers.map(s => ({ ...s, teamId: awayId }))], null, null, competitionId, season, true));
        }
        if (homeReds.length + awayReds.length > 0) {
            sql.push('');
            sql.push(redCardsInsert([...homeReds.map(r => ({ ...r, teamId: homeId })), ...awayReds.map(r => ({ ...r, teamId: awayId }))], null, null, competitionId, season, true));
        }
        sql.push('');
        sql.push(ratingsInsert([
            ...homeRated.map(p => ({ ...p, teamId: homeId })),
            ...awayRated.map(p => ({ ...p, teamId: awayId })),
        ], null, null, competitionId, season, true));
        sql.push('END $$;', '');
        sql.push('COMMIT;');
    }

    // Escribir fichero
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const defaultPath = resolve(process.cwd(), `scripts/output/simulate-${ts}.sql`);
    const finalPath = outputPath ? resolve(outputPath) : defaultPath;
    const dir = dirname(finalPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(finalPath, sql.join('\n') + '\n', 'utf8');
    console.log(`\nSimulación generada: ${teamLabel(homeTeam)} ${homeGoals}-${awayGoals} ${teamLabel(awayTeam)}`);
    console.log(`SQL escrito en: ${finalPath}`);
})();

// ──────────────────── Builders SQL ──────────────────────────────────
function teamStatsInsert(teamId, s, goals, matchId, matchUuid, competitionId, useVars) {
    const matchIdExpr = useVars ? 'v_match_id' : sqlStr(matchId);
    const matchUuidExpr = useVars ? 'v_match_uuid' : sqlNum(matchUuid);
    const indent = useVars ? '  ' : '';
    return `${indent}INSERT INTO match_team_stats (match_id, match_uuid, league_team_id, competition_id,
${indent}  possession, shots, shots_on_target, goals, fouls, offsides,
${indent}  corners, free_kicks, passes, passes_completed, crosses,
${indent}  interceptions, tackles, saves, red_cards)
${indent}VALUES (${matchIdExpr}, ${matchUuidExpr}, ${teamId}, ${competitionId},
${indent}  ${s.possession}, ${s.shots}, ${s.shots_on_target}, ${goals}, ${s.fouls}, ${s.offsides},
${indent}  ${s.corners}, ${s.free_kicks}, ${s.passes}, ${s.passes_completed}, ${s.crosses},
${indent}  ${s.interceptions}, ${s.tackles}, ${s.saves}, ${s.red_cards});`;
}

function goalEventsInsert(events, matchId, matchUuid, competitionId, season, useVars) {
    const matchIdExpr = useVars ? 'v_match_id' : sqlStr(matchId);
    const matchUuidExpr = useVars ? 'v_match_uuid' : sqlNum(matchUuid);
    const indent = useVars ? '  ' : '';
    const values = events.map(e =>
        `${indent}  (${matchIdExpr}, ${matchUuidExpr}, ${e.teamId}, ${e.player.id}, ${e.minute}, 'goal', ${competitionId}, ${sqlStr(season)})`
    ).join(',\n');
    return `${indent}INSERT INTO goal_events (match_id, match_uuid, league_team_id, player_id, minute, event_type, competition_id, season)
${indent}VALUES
${values};`;
}

function redCardsInsert(reds, matchId, matchUuid, competitionId, season, useVars) {
    const matchIdExpr = useVars ? 'v_match_id' : sqlStr(matchId);
    const matchUuidExpr = useVars ? 'v_match_uuid' : sqlNum(matchUuid);
    const indent = useVars ? '  ' : '';
    const values = reds.map(r =>
        `${indent}  (${matchIdExpr}, ${matchUuidExpr}, ${r.teamId}, ${r.player.id}, ${r.minute}, ${competitionId}, ${sqlStr(season)})`
    ).join(',\n');
    return `${indent}INSERT INTO match_red_cards (match_id, match_uuid, league_team_id, player_id, minute, competition_id, season)
${indent}VALUES
${values};`;
}

function ratingsInsert(rows, matchId, matchUuid, competitionId, season, useVars) {
    const matchIdExpr = useVars ? 'v_match_id' : sqlStr(matchId);
    const matchUuidExpr = useVars ? 'v_match_uuid' : sqlNum(matchUuid);
    const indent = useVars ? '  ' : '';
    const values = rows.map(p =>
        `${indent}  (${matchUuidExpr}, ${matchIdExpr}, ${p.teamId}, ${p.id}, ${sqlStr(p.name)}, ${p.rating}, ${competitionId}, ${sqlStr(season)})`
    ).join(',\n');
    return `${indent}INSERT INTO match_player_ratings (match_uuid, match_id, league_team_id, player_id, player_name, rating, competition_id, season)
${indent}VALUES
${values};`;
}
