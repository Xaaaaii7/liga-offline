import { getSupabaseClient, getActiveSeason } from './supabase-client.js';
import { SUPABASE_CONFIG } from './config.js';
import { getCurrentCompetitionId } from './competitions.js';
import { TABLES_WITH_COMPETITION_ID } from './db-helpers.js';

const getCoreStats = () => window.CoreStats || {};

const scorerState = {};
let jornadas = [];
let partidoMeta = {};
let jornadasLoaded = false;

// -----------------------------
// Base Helpers
// -----------------------------

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

export const getSupa = async () => {
    return await getSupabaseClient();
};

export const getActiveSeasonSafe = () => {
    if (typeof SUPABASE_CONFIG !== 'undefined' && SUPABASE_CONFIG.season) return SUPABASE_CONFIG.season;
    const cfg = (window.AppUtils && window.AppUtils.getSupabaseConfig) ? window.AppUtils.getSupabaseConfig() : {};
    return cfg.season || '';
};

// -----------------------------
// METEO: mapa nickname -> ciudad
// -----------------------------
// La ciudad sale del CLUB que el equipo tiene en la competición/temporada que
// se está viendo (clubs.city), no de una ciudad fija por manager. Así el clima
// sigue al club aunque el manager cambie de equipo entre temporadas.
let ciudadesConfig = {};

export const loadCitiesMap = async (competitionId = null) => {
    try {
        const supa = await getSupa();
        if (!supa) return;

        let q = supa.from('league_teams').select('nickname, club_id');
        if (competitionId != null) {
            q = q.eq('competition_id', competitionId);
        } else {
            q = q.eq('season', getActiveSeasonSafe());
        }

        const { data: teams, error } = await q;
        if (error || !teams || !teams.length) return;

        const clubIds = [...new Set(teams.map(t => t.club_id).filter(Boolean))];
        if (!clubIds.length) return;

        const { data: clubs, error: clubsErr } = await supa
            .from('clubs')
            .select('id, city')
            .in('id', clubIds);
        if (clubsErr || !clubs) return;

        const cityByClub = {};
        clubs.forEach(c => { if (c.city) cityByClub[c.id] = c.city; });

        ciudadesConfig = {};
        teams.forEach(t => {
            const city = cityByClub[t.club_id];
            if (t.nickname && city) ciudadesConfig[t.nickname] = city;
        });
    } catch (e) {
        console.warn('Error cargando ciudades de clubs:', e);
    }
};

export const getCityForKey = (keyName) => {
    if (!keyName) return null;
    return ciudadesConfig[keyName] || null;
};

// -----------------------------
// CoreStats Helpers
// -----------------------------
let statsIndex = {};
let statsIndexReady = false;
let statsIndexPromise = null;
let lastStatsIndexCompetitionId = null;

export const ensureStatsIndex = async (competitionId = null) => {
    // Invalidar caché si cambia el competitionId
    if (statsIndexReady && lastStatsIndexCompetitionId !== competitionId) {
        statsIndex = {};
        statsIndexReady = false;
        statsIndexPromise = null;
    }

    if (statsIndexReady && lastStatsIndexCompetitionId === competitionId) {
        return statsIndex;
    }

    if (!statsIndexPromise) {
        statsIndexPromise = getCoreStats().getStatsIndex(competitionId)
            .then(idx => {
                statsIndex = idx || {};
                statsIndexReady = true;
                lastStatsIndexCompetitionId = competitionId;
                return statsIndex;
            })
            .catch(e => {
                console.warn('Error getStatsIndex (lazy):', e);
                statsIndex = {};
                statsIndexReady = true;
                lastStatsIndexCompetitionId = competitionId;
                return statsIndex;
            });
    }
    return statsIndexPromise;
};

export const getResultados = async (competitionId = null) => {
    try {
        return await getCoreStats().getResultados(competitionId);
    } catch (e) {
        console.error('Error getResultados:', e);
        return [];
    }
};

// -----------------------------
// Match Data Loading
// -----------------------------

let lastCompetitionId = null;

/**
 * Carga información de goleadores y estado administrativo de los partidos
 * @param {number} competitionId - ID de la competición
 * @returns {Promise<Object>} Objeto con matchId como clave y datos como valor
 */
const loadMatchScorersInfo = async (competitionId = null) => {
    const supa = await getSupa();
    if (!supa) return {};

    try {
        // Cargar partidos con su estado administrativo y árbitro asignado
        let matchesQuery = supa
            .from('matches')
            .select('id, match_uuid, home_goals, away_goals, resolved_administratively, home_league_team_id, away_league_team_id, referee_id, referee:referees(id, first_name, last_name, nickname)');

        if (competitionId) {
            matchesQuery = matchesQuery.eq('competition_id', competitionId);
        }

        const { data: matches, error: matchesError } = await matchesQuery;

        if (matchesError) {
            console.warn('Error cargando información de partidos:', matchesError);
            return {};
        }

        if (!matches || !matches.length) return {};

        // Obtener todos los match_uuids
        const matchUuids = matches.map(m => m.match_uuid).filter(Boolean);

        if (!matchUuids.length) return {};

        // Cargar goal_events para estos partidos
        const { data: goalEvents, error: goalsError } = await supa
            .from('goal_events')
            .select('match_uuid, league_team_id')
            .in('match_uuid', matchUuids);

        if (goalsError) {
            console.warn('Error cargando goal_events:', goalsError);
        }

        // Contar goal_events por partido y equipo
        // No importa el event_type, simplemente contamos todos los eventos
        const scorersByMatch = {};
        (goalEvents || []).forEach(event => {
            const key = `${event.match_uuid}_${event.league_team_id}`;
            scorersByMatch[key] = (scorersByMatch[key] || 0) + 1;
        });

        // Construir objeto de retorno con información completa
        // Asegurar que se indexe tanto por número como por string para compatibilidad
        const matchInfo = {};
        matches.forEach(match => {
            const homeScorers = scorersByMatch[`${match.match_uuid}_${match.home_league_team_id}`] || 0;
            const awayScorers = scorersByMatch[`${match.match_uuid}_${match.away_league_team_id}`] || 0;

            const info = {
                resolvedAdministratively: match.resolved_administratively || false,
                homeGoals: match.home_goals,
                awayGoals: match.away_goals,
                homeScorers,
                awayScorers,
                missingHomeScorers: Math.max(0, (match.home_goals || 0) - homeScorers),
                missingAwayScorers: Math.max(0, (match.away_goals || 0) - awayScorers),
                refereeId: match.referee_id || null,
                refereeName: match.referee
                    ? [match.referee.first_name, match.referee.last_name].filter(Boolean).join(' ').trim()
                    : null,
                refereeNickname: match.referee?.nickname || null,
            };
            
            const matchId = match.id;
            
            // Indexar por número (tipo principal)
            const numericId = Number(matchId);
            if (Number.isFinite(numericId) && numericId > 0) {
                matchInfo[numericId] = info;
            }
            
            // También indexar por string para compatibilidad
            matchInfo[String(matchId)] = info;
            
            // Y por el valor original por si acaso
            if (matchId !== numericId && matchId !== String(matchId)) {
                matchInfo[matchId] = info;
            }
        });

        return matchInfo;
    } catch (e) {
        console.warn('Error en loadMatchScorersInfo:', e);
        return {};
    }
};

/**
 * Carga información de ratings de jugadores para los partidos
 * @param {number} competitionId - ID de la competición
 * @returns {Promise<Object>} Objeto con matchId como clave y hasRatings como valor
 */
const loadMatchRatingsInfo = async (competitionId = null) => {
    const supa = await getSupa();
    if (!supa) return {};

    try {
        // Cargar partidos
        let matchesQuery = supa
            .from('matches')
            .select('id, match_uuid');

        if (competitionId) {
            matchesQuery = matchesQuery.eq('competition_id', competitionId);
        }

        const { data: matches, error: matchesError } = await matchesQuery;

        if (matchesError) {
            console.warn('Error cargando información de partidos para ratings:', matchesError);
            return {};
        }

        if (!matches || !matches.length) return {};

        // Obtener todos los match_uuids
        const matchUuids = matches.map(m => m.match_uuid).filter(Boolean);

        if (!matchUuids.length) return {};

        // Cargar ratings para estos partidos
        const { data: ratings, error: ratingsError } = await supa
            .from('match_player_ratings')
            .select('match_uuid')
            .in('match_uuid', matchUuids);

        if (ratingsError) {
            console.warn('Error cargando ratings:', ratingsError);
            return {};
        }

        // Crear un Set de match_uuids que tienen ratings
        const matchUuidsWithRatings = new Set((ratings || []).map(r => r.match_uuid));

        // Construir objeto de retorno
        // Asegurar que se indexe tanto por número como por string para compatibilidad
        // También indexar por match_uuid para poder buscar cuando solo tenemos el uuid
        const matchInfo = {};
        const matchInfoByUuid = {}; // Mapa adicional por match_uuid
        matches.forEach(match => {
            const hasRatings = match.match_uuid ? matchUuidsWithRatings.has(match.match_uuid) : false;
            const matchId = match.id;
            const info = { hasRatings };
            
            // Indexar por número (tipo principal)
            const numericId = Number(matchId);
            if (Number.isFinite(numericId) && numericId > 0) {
                matchInfo[numericId] = info;
            }
            
            // También indexar por string para compatibilidad
            matchInfo[String(matchId)] = info;
            
            // Y por el valor original por si acaso
            if (matchId !== numericId && matchId !== String(matchId)) {
                matchInfo[matchId] = info;
            }
            
            // Indexar por match_uuid para búsqueda alternativa
            if (match.match_uuid) {
                matchInfoByUuid[match.match_uuid] = info;
                // También como número si el uuid es numérico
                const uuidNum = Number(match.match_uuid);
                if (Number.isFinite(uuidNum) && uuidNum > 0) {
                    matchInfoByUuid[uuidNum] = info;
                }
                matchInfoByUuid[String(match.match_uuid)] = info;
            }
        });

        // Combinar ambos mapas en uno solo para búsqueda unificada
        return { ...matchInfo, ...matchInfoByUuid };
    } catch (e) {
        console.warn('Error en loadMatchRatingsInfo:', e);
        return {};
    }
};

export const loadAllMatches = async (competitionId = null) => {
    // Invalidar caché si cambia el competitionId
    if (jornadasLoaded && lastCompetitionId === competitionId) {
        return { jornadas, partidoMeta };
    }

    // Obtener competition_id automáticamente si no se proporciona
    let finalCompetitionId = competitionId;
    if (finalCompetitionId === null) {
        try {
            finalCompetitionId = await getCurrentCompetitionId();
        } catch (e) {
            console.warn('No se pudo obtener competition_id automáticamente en loadAllMatches:', e);
        }
    }

    // Obtener season del contexto si está disponible
    let contextSeason = null;
    if (finalCompetitionId) {
        try {
            // Intentar obtener season de la competición actual
            const { getCurrentCompetition } = await import('./competitions.js');
            const comp = await getCurrentCompetition();
            if (comp && comp.season) {
                contextSeason = comp.season;
            } else {
                // Fallback a getActiveSeason
                contextSeason = getActiveSeason();
            }
        } catch (e) {
            contextSeason = getActiveSeason();
        }
    }

    let rawJornadas = [];
    try {
        rawJornadas = await getCoreStats().getResultados(finalCompetitionId);
    } catch (e) {
        console.error('Error getResultados:', e);
        rawJornadas = [];
    }

    if (!Array.isArray(rawJornadas)) rawJornadas = [];

    // Cargar información de goleadores y ratings
    const scorersInfo = await loadMatchScorersInfo(finalCompetitionId);
    const ratingsInfo = await loadMatchRatingsInfo(finalCompetitionId);

    const jornadasMap = new Map();
    partidoMeta = {};

    rawJornadas.forEach(j => {
        const numero = j.numero;
        const jornada = {
            numero,
            fecha: j.fecha,
            partidos: []
        };

        (j.partidos || []).forEach((p, idx) => {
            const pid = p.id != null ? p.id : `J${numero}-P${idx + 1}`;
            
            // Helper para buscar en un objeto indexado por match.id (número)
            // Intenta múltiples variaciones de la clave para asegurar compatibilidad
            const lookupMatchInfo = (infoObj, matchId) => {
                if (matchId == null) return {};
                
                // Intentar directamente con el valor tal cual
                let result = infoObj[matchId];
                if (result && Object.keys(result).length > 0) return result;
                
                // Intentar como número si es posible (por si matchId es string)
                const numericId = Number(matchId);
                if (Number.isFinite(numericId) && numericId > 0 && numericId !== matchId) {
                    result = infoObj[numericId];
                    if (result && Object.keys(result).length > 0) return result;
                }
                
                // Intentar como string (por si matchId es número)
                const stringId = String(matchId);
                if (stringId !== matchId) {
                    result = infoObj[stringId];
                    if (result && Object.keys(result).length > 0) return result;
                }
                
                return {};
            };
            
            // Buscar información de goleadores
            let matchScorersInfo = lookupMatchInfo(scorersInfo, p.id);
            // Fallback: intentar con pid si p.id no funcionó y pid es diferente
            if (Object.keys(matchScorersInfo).length === 0 && pid !== p.id) {
                matchScorersInfo = lookupMatchInfo(scorersInfo, pid);
                if (Object.keys(matchScorersInfo).length === 0) {
                    matchScorersInfo = scorersInfo[pid] || {};
                }
            }
            
            // Buscar información de ratings
            // Primero intentar por p.id (ID numérico de la base de datos)
            let matchRatingsInfo = lookupMatchInfo(ratingsInfo, p.id);
            
            // Si no se encontró y tenemos match_uuid, intentar buscar por match_uuid
            // Esto es especialmente importante para nuevos partidos donde p.id puede ser undefined
            if (Object.keys(matchRatingsInfo).length === 0 && p.match_uuid != null) {
                matchRatingsInfo = lookupMatchInfo(ratingsInfo, p.match_uuid);
            }
            
            // Fallback: intentar con pid si p.id no funcionó y pid es diferente
            if (Object.keys(matchRatingsInfo).length === 0 && pid !== p.id) {
                matchRatingsInfo = lookupMatchInfo(ratingsInfo, pid);
                if (Object.keys(matchRatingsInfo).length === 0) {
                    matchRatingsInfo = ratingsInfo[pid] || {};
                }
            }

            const partido = {
                id: pid,
                fecha: p.fecha || j.fecha,
                hora: p.hora || '',
                local: p.local,
                visitante: p.visitante,
                goles_local: isNum(p.goles_local) ? p.goles_local : null,
                goles_visitante: isNum(p.goles_visitante) ? p.goles_visitante : null,
                stream: p.stream || '',
                local_team_id: p.local_team_id || null,
                visitante_team_id: p.visitante_team_id || null,
                local_club_id: p.local_club_id || null,
                visitante_club_id: p.visitante_club_id || null,
                round_id: p.round_id || numero,
                competition_id: p.competition_id || finalCompetitionId || null,
                season: p.season || contextSeason || null,
                match_uuid: p.match_uuid || null,
                bracket_type: p.bracket_type || null,
                cup_leg: p.cup_leg || null,
                round_type: p.round_type || null,
                // Información de goleadores
                resolved_administratively: matchScorersInfo.resolvedAdministratively || false,
                missing_home_scorers: matchScorersInfo.missingHomeScorers || 0,
                missing_away_scorers: matchScorersInfo.missingAwayScorers || 0,
                // Información de ratings
                has_ratings: matchRatingsInfo.hasRatings || false,
                // Árbitro asignado
                arbitro_id: matchScorersInfo.refereeId || null,
                arbitro_nombre: matchScorersInfo.refereeName || null,
                arbitro_mote: matchScorersInfo.refereeNickname || null,
            };

            jornada.partidos.push(partido);

            partidoMeta[pid] = {
                id: pid,
                jornada: numero,
                fechaJornada: j.fecha,
                fecha: partido.fecha,
                hora: partido.hora,
                local: partido.local,
                visitante: partido.visitante,
                goles_local: partido.goles_local,
                goles_visitante: partido.goles_visitante,
                local_team_id: partido.local_team_id,
                visitante_team_id: partido.visitante_team_id,
                local_club_id: partido.local_club_id,
                visitante_club_id: partido.visitante_club_id,
                round_id: partido.round_id,
                competition_id: partido.competition_id,
                season: partido.season,
                match_uuid: partido.match_uuid,
                bracket_type: partido.bracket_type,
                cup_leg: partido.cup_leg,
                round_type: partido.round_type,
                resolved_administratively: partido.resolved_administratively,
                missing_home_scorers: partido.missing_home_scorers,
                missing_away_scorers: partido.missing_away_scorers,
                has_ratings: partido.has_ratings
            };
        });

        jornadasMap.set(numero, jornada);
    });

    jornadas = Array.from(jornadasMap.values()).sort((a, b) => (a.numero || 0) - (b.numero || 0));
    jornadasLoaded = true;
    lastCompetitionId = finalCompetitionId;

    return { jornadas, partidoMeta };
};

export const getJornadas = () => jornadas;
export const getPartidoMeta = (id) => partidoMeta[id];

// -----------------------------
// Scorer State Management
// -----------------------------
export const getScorerState = (matchId) => scorerState[matchId];

export const loadScorerStateForMatch = async (matchMeta) => {
    const matchId = matchMeta.id;
    if (!matchId) return null;

    if (scorerState[matchId]) return scorerState[matchId];

    const supa = await getSupa();
    if (!supa) return null;

    const season = getActiveSeasonSafe();
    const round = matchMeta.round_id || matchMeta.jornada || null;

    const localTeamId = matchMeta.local_team_id;
    const visitTeamId = matchMeta.visitante_team_id;

    let localClubId = matchMeta.local_club_id;
    let visitClubId = matchMeta.visitante_club_id;
    let localManagerNick = '';
    let visitManagerNick = '';

    if (!season || !localTeamId || !visitTeamId) {
        console.warn('Scorers: faltan season o league_team_id', {
            season, localTeamId, visitTeamId, localClubId, visitClubId, matchMeta
        });
        return null;
    }

    // Obtener competition_id del match si está disponible
    let competitionId = null;
    if (matchMeta.competition_id) {
        competitionId = matchMeta.competition_id;
    } else {
        try {
            competitionId = await getCurrentCompetitionId();
        } catch (e) {
            throw new Error('No se pudo obtener competition_id para league_teams. Es obligatorio.');
        }
    }

    let teamsQuery = supa
        .from('league_teams')
        .select('id, club_id, nickname, competition_id')
        .in('id', [localTeamId, visitTeamId]);

    // league_teams.competition_id es NOT NULL, así que filtramos directamente
    // competition_id es obligatorio para league_teams
    if (competitionId === null) {
        throw new Error('competition_id es obligatorio para league_teams pero no se proporcionó ni se pudo obtener del contexto.');
    }
    teamsQuery = teamsQuery.eq('competition_id', competitionId);

    const { data: teams, error: errTeams } = await teamsQuery;

    if (errTeams) {
        console.warn('Scorers: error cargando league_teams', errTeams);
        return null;
    }

    if (teams && teams.length) {
        for (const t of teams) {
            if (t.id === localTeamId) {
                if (!localClubId) {
                    localClubId = t.club_id;
                    matchMeta.local_club_id = localClubId;
                }
                localManagerNick = t.nickname || '';
            } else if (t.id === visitTeamId) {
                if (!visitClubId) {
                    visitClubId = t.club_id;
                    matchMeta.visitante_club_id = visitClubId;
                }
                visitManagerNick = t.nickname || '';
            }
        }
    }

    if (!localClubId || !visitClubId) {
        console.warn('Scorers: no se pudieron resolver club_ids', {
            season, localTeamId, visitTeamId, localClubId, visitClubId
        });
        return null;
    }

    const { data: memberships, error: errMem } = await supa
        .from('player_club_memberships')
        .select(`
        player_id,
        club_id,
        season,
        from_round,
        to_round,
        is_current,
        player:players(id, name, position),
        club:clubs(id, name)
      `)
        .eq('season', season)
        .in('club_id', [localClubId, visitClubId]);

    if (errMem) {
        console.warn('Error cargando memberships jugadores:', errMem);
        return null;
    }

    const inRound = (m) => {
        if (!round) return true;
        if (m.is_current) return true;
        const fr = m.from_round;
        const tr = m.to_round;
        if (fr != null && fr > round) return false;
        if (tr != null && tr < round) return false;
        return true;
    };

    const filteredMem = (memberships || []).filter(inRound);
    const playerMeta = {};
    const allPlayerIds = new Set();

    filteredMem.forEach(m => {
        const pid = m.player_id;
        if (!pid) return;
        allPlayerIds.add(pid);
        if (!playerMeta[pid]) {
            playerMeta[pid] = {
                id: pid,
                name: (m.player && m.player.name) || `Jugador ${pid}`,
                position: (m.player && m.player.position) || '',
                clubId: m.club_id,
                clubName: (m.club && m.club.name) || ''
            };
        }
    });

    const playerIdList = Array.from(allPlayerIds);
    const goalsByPlayerSeason = {};

    if (playerIdList.length) {
        // goal_events tiene competition_id directamente, así que filtramos por él
        // competition_id es obligatorio para goal_events
        if (competitionId === null) {
            console.warn('competition_id es obligatorio para goal_events pero no se proporcionó');
            // No hacer la consulta si no hay competition_id
        } else {
            const { data: evs, error: errEvs } = await supa
                .from('goal_events')
                .select(`
                    player_id,
                    event_type,
                    competition_id
                `)
                .eq('event_type', 'goal')
                .eq('competition_id', competitionId)
                .in('player_id', playerIdList);

            if (!errEvs && evs) {
                evs.forEach(ev => {
                    const pid = ev.player_id;
                    if (!pid) return;
                    goalsByPlayerSeason[pid] = (goalsByPlayerSeason[pid] || 0) + 1;
                });
            }
        }
    }

    const localPlayers = [];
    const visitPlayers = [];

    filteredMem.forEach(m => {
        const pid = m.player_id;
        if (!pid) return;
        const meta = playerMeta[pid];
        const base = {
            player_id: pid,
            name: meta.name,
            position: meta.position,
            clubName: meta.clubName,
            totalGoals: goalsByPlayerSeason[pid] || 0
        };
        if (m.club_id === localClubId) {
            localPlayers.push(base);
        } else if (m.club_id === visitClubId) {
            visitPlayers.push(base);
        }
    });

    const sortPlayers = (arr) => arr.sort((a, b) =>
        (b.totalGoals - a.totalGoals) ||
        a.name.localeCompare(b.name, 'es', { sensitivity: 'base' })
    );

    sortPlayers(localPlayers);
    sortPlayers(visitPlayers);

    // Cargar goal_events del partido por match_uuid (inequívoco) o match_id+competition_id como fallback
    let matchEventsQuery = supa
        .from('goal_events')
        .select(`
        id,
        match_id,
        league_team_id,
        player_id,
        minute,
        event_type,
        competition_id
      `)
        .in('event_type', ['goal', 'own_goal']);

    if (matchMeta.match_uuid != null) {
        matchEventsQuery = matchEventsQuery.eq('match_uuid', matchMeta.match_uuid);
    } else {
        matchEventsQuery = matchEventsQuery.eq('match_id', matchId);
        if (competitionId !== null && TABLES_WITH_COMPETITION_ID.has('goal_events')) {
            matchEventsQuery = matchEventsQuery.eq('competition_id', competitionId);
        }
    }

    const { data: matchEvents, error: errMatchEv } = await matchEventsQuery;

    if (errMatchEv) {
        console.warn('Error cargando goal_events del partido:', errMatchEv);
    }

    const aggGoals = { local: {}, visitante: {} };
    const aggRed = { local: [], visitante: [] };
    const goalsDetail = { local: [], visitante: [] };

    (matchEvents || []).forEach(ev => {
        const pid = ev.player_id;
        if (!pid && ev.event_type !== 'own_goal') return;

        const side = (ev.league_team_id === localTeamId)
            ? 'local'
            : (ev.league_team_id === visitTeamId ? 'visitante' : null);
        if (!side) return;

        if (ev.event_type === 'goal') {
            aggGoals[side][pid] = (aggGoals[side][pid] || 0) + 1;
            goalsDetail[side].push({
                event_id: ev.id || null,
                player_id: pid,
                minute: (ev.minute != null) ? ev.minute : null,
                event_type: 'goal'
            });
        } else if (ev.event_type === 'own_goal') {
            const ogKey = -1;
            aggGoals[side][ogKey] = (aggGoals[side][ogKey] || 0) + 1;
            goalsDetail[side].push({
                event_id: ev.id || null,
                player_id: -1,
                minute: (ev.minute != null) ? ev.minute : null,
                event_type: 'own_goal'
            });
        }
    });

    const sortDetail = (arr) => arr.sort((a, b) => {
        const am = (a.minute == null) ? Infinity : a.minute;
        const bm = (b.minute == null) ? Infinity : b.minute;
        return am - bm;
    });
    sortDetail(goalsDetail.local);
    sortDetail(goalsDetail.visitante);

    // Cargar match_red_cards del partido por match_uuid (inequívoco) o match_id+competition_id como fallback
    let redCardsQuery = supa
        .from('match_red_cards')
        .select('player_id, league_team_id, competition_id, minute');

    if (matchMeta.match_uuid != null) {
        redCardsQuery = redCardsQuery.eq('match_uuid', matchMeta.match_uuid);
    } else {
        redCardsQuery = redCardsQuery.eq('match_id', matchId);
        if (competitionId !== null && TABLES_WITH_COMPETITION_ID.has('match_red_cards')) {
            redCardsQuery = redCardsQuery.eq('competition_id', competitionId);
        }
    }

    const { data: redCardsEvents, error: errRed } = await redCardsQuery;

    if (errRed) {
        console.warn('Error cargando match_red_cards:', errRed);
    }

    (redCardsEvents || []).forEach(rc => {
        const entry = { pid: rc.player_id, minute: (rc.minute != null ? rc.minute : null) };
        if (rc.league_team_id === localTeamId) aggRed.local.push(entry);
        else if (rc.league_team_id === visitTeamId) aggRed.visitante.push(entry);
    });

    // Cargar match_yellow_cards del partido por match_uuid o match_id+competition_id como fallback
    let yellowCardsQuery = supa
        .from('match_yellow_cards')
        .select('player_id, league_team_id, minute');

    if (matchMeta.match_uuid != null) {
        yellowCardsQuery = yellowCardsQuery.eq('match_uuid', matchMeta.match_uuid);
    } else {
        yellowCardsQuery = yellowCardsQuery.eq('match_id', matchId);
        if (competitionId !== null) {
            yellowCardsQuery = yellowCardsQuery.eq('competition_id', competitionId);
        }
    }

    const { data: yellowCardsEvents, error: errYellow } = await yellowCardsQuery;

    if (errYellow) {
        console.warn('Error cargando match_yellow_cards:', errYellow);
    }

    const aggYellow = { local: [], visitante: [] };
    (yellowCardsEvents || []).forEach(yc => {
        const entry = { pid: yc.player_id, minute: (yc.minute != null ? yc.minute : null) };
        if (yc.league_team_id === localTeamId) aggYellow.local.push(entry);
        else if (yc.league_team_id === visitTeamId) aggYellow.visitante.push(entry);
    });

    // Cargar match_injuries del partido por match_uuid (inequívoco) o match_id+competition_id como fallback
    let injuriesQuery = supa
        .from('match_injuries')
        .select('player_id, league_team_id, competition_id');

    if (matchMeta.match_uuid != null) {
        injuriesQuery = injuriesQuery.eq('match_uuid', matchMeta.match_uuid);
    } else {
        injuriesQuery = injuriesQuery.eq('match_id', matchId);
        if (competitionId !== null && TABLES_WITH_COMPETITION_ID.has('match_injuries')) {
            injuriesQuery = injuriesQuery.eq('competition_id', competitionId);
        }
    }

    const { data: injuryEvents, error: errInj } = await injuriesQuery;

    if (errInj) {
        console.warn('Error cargando match_injuries:', errInj);
    }

    const aggInj = { local: [], visitante: [] };
    (injuryEvents || []).forEach(ev => {
        const pid = ev.player_id;
        if (ev.league_team_id === localTeamId) aggInj.local.push(pid);
        else if (ev.league_team_id === visitTeamId) aggInj.visitante.push(pid);
    });

    const buildSideArr = (side) => {
        const out = [];
        const counts = aggGoals[side] || {};
        Object.keys(counts).forEach(pidStr => {
            const pid = Number(pidStr);
            const goals = counts[pidStr];
            let meta;
            if (pid === -1) {
                meta = { name: 'Gol en propia' };
            } else {
                meta = playerMeta[pid] || { name: `Jugador ${pid}` };
            }
            out.push({
                player_id: pid,
                name: meta.name,
                goals
            });
        });
        out.sort((a, b) =>
            (b.goals - a.goals) ||
            a.name.localeCompare(b.name, 'es', { sensitivity: 'base' })
        );
        return out;
    };

    // Construye el array de tarjetas (rojas/amarillas) con minuto. Las entradas
    // llegan como { pid, minute }; se deduplica por jugador (una tarjeta por
    // jugador en el editor) conservando el minuto (prefiere uno no nulo).
    const buildCardArr = (entries) => {
        const out = [];
        const seen = new Map(); // pid -> índice en out
        (entries || []).forEach(({ pid, minute }) => {
            if (seen.has(pid)) {
                const i = seen.get(pid);
                if (out[i].minute == null && minute != null) out[i].minute = minute;
                return;
            }
            const meta = playerMeta[pid] || { name: `Jugador ${pid}` };
            seen.set(pid, out.length);
            out.push({ player_id: pid, name: meta.name, minute: (minute != null ? minute : null) });
        });
        out.sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
        return out;
    };

    const buildRedArr = (side) => buildCardArr(aggRed[side]);
    const buildYellowArr = (side) => buildCardArr(aggYellow[side]);

    const buildInjuriesArr = (side) => {
        const out = [];
        const pids = aggInj[side] || [];
        const uniquePids = [...new Set(pids)];
        uniquePids.forEach(pid => {
            const meta = playerMeta[pid] || { name: `Jugador ${pid}` };
            out.push({
                player_id: pid,
                name: meta.name
            });
        });
        out.sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
        return out;
    };

    const state = {
        meta: {
            ...matchMeta,
            local_club_id: localClubId,
            visitante_club_id: visitClubId
        },
        local: buildSideArr('local'),
        visitante: buildSideArr('visitante'),
        goalsDetailLocal: goalsDetail.local,
        goalsDetailVisitante: goalsDetail.visitante,
        redLocal: buildRedArr('local'),
        redVisitante: buildRedArr('visitante'),
        yellowLocal: buildYellowArr('local'),
        yellowVisitante: buildYellowArr('visitante'),
        injuriesLocal: buildInjuriesArr('local'),
        injuriesVisitante: buildInjuriesArr('visitante'),
        playersLocal: localPlayers,
        playersVisitante: visitPlayers,
        playerMeta,
        goalsByPlayerSeason,
        localManagerNick,
        visitManagerNick
    };

    scorerState[matchId] = state;
    return state;
};

// -----------------------------
// Modifiers
// -----------------------------

export const addGoalToState = (matchId, side, playerId, minute = null) => {
    const state = scorerState[matchId];
    if (!state) return { success: false };

    const limit = (side === 'local') ? state.meta.goles_local : state.meta.goles_visitante;
    const teamCols = state[side] || [];
    const currentTotal = teamCols.reduce((acc, p) => acc + p.goals, 0);

    if (typeof limit === 'number' && currentTotal >= limit) {
        return { success: false, error: `No puedes añadir más goles. El ${side === 'local' ? 'Local' : 'Visitante'} tiene ${limit} goles en total.` };
    }

    const arr = state[side] || (state[side] = []);
    const pid = Number(playerId);
    let item = arr.find(x => x.player_id === pid);
    if (!item) {
        const meta = (pid === -1)
            ? { name: 'Gol en propia' }
            : (state.playerMeta[pid] || { name: `Jugador ${pid}` });
        item = { player_id: pid, name: meta.name, goals: 0 };
        arr.push(item);
    }
    item.goals += 1;
    arr.sort((a, b) =>
        (b.goals - a.goals) ||
        a.name.localeCompare(b.name, 'es', { sensitivity: 'base' })
    );

    const detailKey = (side === 'local') ? 'goalsDetailLocal' : 'goalsDetailVisitante';
    if (!state[detailKey]) state[detailKey] = [];
    state[detailKey].push({
        event_id: null,
        player_id: pid,
        minute: (minute != null && Number.isFinite(Number(minute))) ? Number(minute) : null,
        event_type: (pid === -1) ? 'own_goal' : 'goal'
    });
    return { success: true };
};

export const changeGoalCount = (matchId, side, playerId, delta) => {
    const state = scorerState[matchId];
    if (!state) return { success: false };

    const arr = state[side] || (state[side] = []);
    const pid = Number(playerId);
    const idx = arr.findIndex(x => x.player_id === pid);
    if (idx === -1) return { success: false };

    if (delta > 0) {
        const limit = (side === 'local') ? state.meta.goles_local : state.meta.goles_visitante;
        const currentTotal = arr.reduce((acc, p) => acc + p.goals, 0);
        if (typeof limit === 'number' && currentTotal >= limit) {
            return { success: false, error: `Límite de goles alcanzado (${limit}).` };
        }
    }

    arr[idx].goals += delta;
    if (arr[idx].goals <= 0) {
        arr.splice(idx, 1);
    } else {
        arr.sort((a, b) =>
            (b.goals - a.goals) ||
            a.name.localeCompare(b.name, 'es', { sensitivity: 'base' })
        );
    }

    const detailKey = (side === 'local') ? 'goalsDetailLocal' : 'goalsDetailVisitante';
    if (!state[detailKey]) state[detailKey] = [];
    if (delta > 0) {
        state[detailKey].push({
            event_id: null,
            player_id: pid,
            minute: null,
            event_type: (pid === -1) ? 'own_goal' : 'goal'
        });
    } else if (delta < 0) {
        // Preferir borrar entradas sin minute (las añadidas a mano) antes que las que vienen del contenedor
        const det = state[detailKey];
        let removeIdx = det.findIndex(x => x.player_id === pid && x.minute == null);
        if (removeIdx === -1) removeIdx = det.findIndex(x => x.player_id === pid);
        if (removeIdx !== -1) det.splice(removeIdx, 1);
    }
    return { success: true };
};

export const removeScorer = (matchId, side, playerId) => {
    const state = scorerState[matchId];
    if (!state) return;
    const arr = state[side] || (state[side] = []);
    const pid = Number(playerId);
    const idx = arr.findIndex(x => x.player_id === pid);
    if (idx !== -1) arr.splice(idx, 1);

    const detailKey = (side === 'local') ? 'goalsDetailLocal' : 'goalsDetailVisitante';
    if (state[detailKey]) {
        state[detailKey] = state[detailKey].filter(x => x.player_id !== pid);
    }
};

export const setGoalMinute = (matchId, side, detailIndex, minute) => {
    const state = scorerState[matchId];
    if (!state) return { success: false };
    const detailKey = (side === 'local') ? 'goalsDetailLocal' : 'goalsDetailVisitante';
    const det = state[detailKey];
    if (!det || detailIndex < 0 || detailIndex >= det.length) return { success: false };

    if (minute === null || minute === '' || minute === undefined) {
        det[detailIndex].minute = null;
    } else {
        const m = Number(minute);
        if (!Number.isFinite(m) || m < 0) return { success: false, error: 'Minuto inválido' };
        det[detailIndex].minute = m;
    }
    return { success: true };
};

export const addRedCardToState = (matchId, side, playerId, minute = null) => {
    const state = scorerState[matchId];
    if (!state) return;

    // Asegurar que los arrays existan
    if (!state.redLocal) state.redLocal = [];
    if (!state.redVisitante) state.redVisitante = [];

    const arr = (side === 'local' ? state.redLocal : state.redVisitante);
    const pid = Number(playerId);
    if (arr.some(p => p.player_id === pid)) return;

    const meta = state.playerMeta[pid] || { name: `Jugador ${pid}` };
    const m = (minute != null && Number.isFinite(Number(minute))) ? Number(minute) : null;
    arr.push({ player_id: pid, name: meta.name, minute: m });
    arr.sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
};

export const setRedCardMinute = (matchId, side, playerId, minute) => {
    const state = scorerState[matchId];
    if (!state) return { success: false };
    const arr = (side === 'local' ? state.redLocal : state.redVisitante) || [];
    const item = arr.find(x => x.player_id === Number(playerId));
    if (!item) return { success: false };
    if (minute === null || minute === '' || minute === undefined) {
        item.minute = null;
    } else {
        const m = Number(minute);
        if (!Number.isFinite(m) || m < 0) return { success: false, error: 'Minuto inválido' };
        item.minute = m;
    }
    return { success: true };
};

export const removeRedCardFromState = (matchId, side, playerId) => {
    const state = scorerState[matchId];
    if (!state) return;
    
    // Asegurar que los arrays existan
    if (!state.redLocal) state.redLocal = [];
    if (!state.redVisitante) state.redVisitante = [];
    
    const arr = (side === 'local' ? state.redLocal : state.redVisitante);
    const pid = Number(playerId);
    const idx = arr.findIndex(x => x.player_id === pid);
    if (idx !== -1) arr.splice(idx, 1);
};

export const addYellowCardToState = (matchId, side, playerId, minute = null) => {
    const state = scorerState[matchId];
    if (!state) return;

    if (!state.yellowLocal) state.yellowLocal = [];
    if (!state.yellowVisitante) state.yellowVisitante = [];

    const arr = (side === 'local' ? state.yellowLocal : state.yellowVisitante);
    const pid = Number(playerId);
    if (arr.some(p => p.player_id === pid)) return;

    const meta = state.playerMeta[pid] || { name: `Jugador ${pid}` };
    const m = (minute != null && Number.isFinite(Number(minute))) ? Number(minute) : null;
    arr.push({ player_id: pid, name: meta.name, minute: m });
    arr.sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
};

export const setYellowCardMinute = (matchId, side, playerId, minute) => {
    const state = scorerState[matchId];
    if (!state) return { success: false };
    const arr = (side === 'local' ? state.yellowLocal : state.yellowVisitante) || [];
    const item = arr.find(x => x.player_id === Number(playerId));
    if (!item) return { success: false };
    if (minute === null || minute === '' || minute === undefined) {
        item.minute = null;
    } else {
        const m = Number(minute);
        if (!Number.isFinite(m) || m < 0) return { success: false, error: 'Minuto inválido' };
        item.minute = m;
    }
    return { success: true };
};

export const removeYellowCardFromState = (matchId, side, playerId) => {
    const state = scorerState[matchId];
    if (!state) return;

    if (!state.yellowLocal) state.yellowLocal = [];
    if (!state.yellowVisitante) state.yellowVisitante = [];

    const arr = (side === 'local' ? state.yellowLocal : state.yellowVisitante);
    const pid = Number(playerId);
    const idx = arr.findIndex(x => x.player_id === pid);
    if (idx !== -1) arr.splice(idx, 1);
};

export const addInjuryToState = (matchId, side, playerId) => {
    const state = scorerState[matchId];
    if (!state) return;
    
    // Asegurar que los arrays existan
    if (!state.injuriesLocal) state.injuriesLocal = [];
    if (!state.injuriesVisitante) state.injuriesVisitante = [];
    
    const arr = (side === 'local' ? state.injuriesLocal : state.injuriesVisitante);
    const pid = Number(playerId);
    if (arr.some(p => p.player_id === pid)) return;

    const meta = state.playerMeta[pid] || { name: `Jugador ${pid}` };
    arr.push({ player_id: pid, name: meta.name });
    arr.sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
};

export const removeInjuryFromState = (matchId, side, playerId) => {
    const state = scorerState[matchId];
    if (!state) return;
    
    // Asegurar que los arrays existan
    if (!state.injuriesLocal) state.injuriesLocal = [];
    if (!state.injuriesVisitante) state.injuriesVisitante = [];
    
    const arr = (side === 'local' ? state.injuriesLocal : state.injuriesVisitante);
    const pid = Number(playerId);
    const idx = arr.findIndex(x => x.player_id === pid);
    if (idx !== -1) arr.splice(idx, 1);
};

// -----------------------------
// Suspension Logic
// -----------------------------

// Helper: obtener competition_id de un match
const getMatchCompetitionId = async (matchId) => {
    const supa = await getSupa();
    if (!supa || !matchId) return null;

    try {
        const { data, error } = await supa
            .from('matches')
            .select('competition_id')
            .eq('id', matchId)
            .limit(1)
            .single();

        if (error || !data) return null;
        return data.competition_id || null;
    } catch (e) {
        console.warn(`Error obteniendo competition_id para match ${matchId}:`, e);
        return null;
    }
};

// Helper: obtener match_uuid de un match (opcionalmente por competición para desambiguar)
const getMatchUuid = async (matchId, competitionId = null) => {
    const supa = await getSupa();
    if (!supa || !matchId) return null;

    try {
        let query = supa
            .from('matches')
            .select('match_uuid')
            .eq('id', matchId);

        if (competitionId != null) {
            query = query.eq('competition_id', competitionId);
        }
        const { data, error } = await query.limit(1).single();

        if (error || !data) return null;
        return data.match_uuid || null;
    } catch (e) {
        console.warn(`Error obteniendo match_uuid para match ${matchId}:`, e);
        return null;
    }
};

/**
 * Guarda el resultado (goles) de un partido en matches. Para competiciones ranked
 * cualquier usuario autenticado puede actualizar (RLS). Usar match_uuid para el update.
 * @param {string} matchId - ID del partido (ej. J1-P1)
 * @param {Object} meta - Meta del partido (getPartidoMeta), debe tener match_uuid y competition_id
 * @param {number|null} homeGoals - Goles local
 * @param {number|null} awayGoals - Goles visitante
 * @returns {Promise<{ok: boolean, msg?: string}>}
 */
export const saveMatchResult = async (matchId, meta, homeGoals, awayGoals) => {
    const supa = await getSupa();
    if (!supa) return { ok: false, msg: 'No se pudo conectar a la base de datos' };

    let matchUuid = meta?.match_uuid != null ? meta.match_uuid : await getMatchUuid(matchId, meta?.competition_id ?? null);
    if (matchUuid == null) {
        return { ok: false, msg: 'El partido no tiene match_uuid asignado.' };
    }

    try {
        const { error } = await supa
            .from('matches')
            .update({
                home_goals: homeGoals,
                away_goals: awayGoals
            })
            .eq('match_uuid', matchUuid);

        if (error) {
            console.error('Error guardando resultado:', error);
            return { ok: false, msg: error.message || 'Error guardando resultado' };
        }
        return { ok: true };
    } catch (e) {
        console.error('Error en saveMatchResult:', e);
        return { ok: false, msg: e?.message || 'Error inesperado' };
    }
};

const getNextMatchForTeam = async (season, teamId, currentRoundId, competitionId = null,
                                    currentBracketType = null, currentCupLeg = null, currentRoundType = null) => {
    const supa = await getSupa();
    if (!supa) return null;

    const currentRoundNum = Number(currentRoundId);
    if (!isNum(currentRoundNum)) return null;

    // competition_id es obligatorio para matches
    if (competitionId === null) {
        throw new Error('competition_id es obligatorio para matches pero no se proporcionó.');
    }

    // Estrategia de búsqueda en orden de prioridad:
    // 1. Si es copa con ida ('first'), buscar vuelta ('second') en mismo round_id
    // 2. Si es copa con bracket_type, buscar siguiente round en mismo bracket
    // 3. Buscar siguiente round (comportamiento por defecto para ligas)

    // Intento 1: Buscar partido de vuelta en el mismo round (copas ida/vuelta)
    if (currentCupLeg === 'first' && currentRoundType === 'cup') {
        let query = supa
            .from('matches')
            .select('id, match_uuid, round_id, cup_leg, bracket_type')
            .or(`home_league_team_id.eq.${teamId},away_league_team_id.eq.${teamId}`)
            .eq('round_id', currentRoundNum)
            .eq('cup_leg', 'second')
            .eq('competition_id', competitionId);

        if (currentBracketType) {
            query = query.eq('bracket_type', currentBracketType);
        }

        query = query.order('round_id', { ascending: true }).limit(1);
        const { data, error } = await query.maybeSingle();
        if (data) return { id: data.id, match_uuid: data.match_uuid };
    }

    // Intento 2: Buscar siguiente partido en el mismo bracket (copas de doble eliminación)
    if (currentBracketType && currentRoundType === 'cup') {
        let query = supa
            .from('matches')
            .select('id, match_uuid, round_id, bracket_type')
            .or(`home_league_team_id.eq.${teamId},away_league_team_id.eq.${teamId}`)
            .gt('round_id', currentRoundNum)
            .eq('bracket_type', currentBracketType)
            .eq('competition_id', competitionId)
            .order('round_id', { ascending: true })
            .limit(1);

        const { data, error } = await query.maybeSingle();
        if (data) return { id: data.id, match_uuid: data.match_uuid };
    }

    // Intento 3: Buscar siguiente partido sin restricciones de bracket (fallback)
    // Este es el comportamiento original para ligas y compatibilidad
    let query = supa
        .from('matches')
        .select('id, match_uuid, round_id')
        .or(`home_league_team_id.eq.${teamId},away_league_team_id.eq.${teamId}`)
        .gt('round_id', currentRoundNum)
        .eq('competition_id', competitionId)
        .order('round_id', { ascending: true })
        .limit(1);

    const { data, error } = await query.maybeSingle();
    if (error || !data) return null;
    return { id: data.id, match_uuid: data.match_uuid };
};

const saveSuspensionForMatch = async (meta, leagueTeamId, playerIds, type = 'red_card') => {
    const supa = await getSupa();
    if (!supa || !meta) return;

    // El partido que causa la sanción es el actual. `matches.id` (texto) NO es
    // único entre competiciones, así que la competición se toma del meta del
    // partido (fiable) y solo como último recurso se resuelve por el id de
    // texto. Antes se usaba getMatchCompetitionId(id) directamente, que
    // resolvía a la competición equivocada y dejaba la sanción sin crear.
    const originMatchId = meta.id;
    const originMatchUuid = meta.match_uuid != null ? meta.match_uuid : null;
    const competitionId = meta.competition_id != null
        ? meta.competition_id
        : await getMatchCompetitionId(originMatchId);

    let getQuery = supa
        .from('player_suspensions')
        .select('player_id')
        .eq('origin_match_id', originMatchId)
        .eq('league_team_id', leagueTeamId);
    if (competitionId != null) getQuery = getQuery.eq('competition_id', competitionId);
    const { data: currentSus, error: errGet } = await getQuery;

    if (errGet) {
        console.warn('Error reading current suspensions', errGet);
    }

    const currentPids = (currentSus || []).map(x => x.player_id);
    const newPidsSet = new Set(playerIds);
    const toDelete = currentPids.filter(pid => !newPidsSet.has(pid));

    if (toDelete.length > 0) {
        let deleteQuery = supa
            .from('player_suspensions')
            .delete()
            .eq('origin_match_id', originMatchId)
            .eq('league_team_id', leagueTeamId)
            .in('player_id', toDelete);

        // Filtrar por competition_id si está disponible
        if (competitionId != null) {
            deleteQuery = deleteQuery.eq('competition_id', competitionId);
        }

        await deleteQuery;
    }

    const toInsert = playerIds.filter(pid => !currentPids.includes(pid));

    if (toInsert.length > 0) {
        const season = getActiveSeasonSafe();
        const currentRound = meta.round_id || meta.jornada;

        const nextMatch = await getNextMatchForTeam(
            season,
            leagueTeamId,
            currentRound,
            competitionId,
            meta.bracket_type,
            meta.cup_leg,
            meta.round_type
        );
        if (!nextMatch) {
            console.log('No next match found for suspension/injury for team', leagueTeamId);
            return;
        }

        const rows = toInsert.map(pid => {
            const row = {
                player_id: pid,
                league_team_id: leagueTeamId,
                match_id: nextMatch.id,
                match_uuid: nextMatch.match_uuid != null ? nextMatch.match_uuid : null,
                origin_match_id: originMatchId,
                origin_match_uuid: originMatchUuid,
                reason: type
            };
            // Añadir competition_id si está disponible
            if (competitionId != null) {
                row.competition_id = competitionId;
            }
            return row;
        });

        const { error: errIns } = await supa
            .from('player_suspensions')
            .insert(rows);

        if (errIns) console.warn('Error inserting suspensions', errIns);
    }
};

// -----------------------------
// DB Saving Functions
// -----------------------------

export const saveScorersToSupabase = async (matchId) => {
    const state = scorerState[matchId];
    if (!state) return { ok: false, msg: 'No hay datos de goleadores' };

    const supa = await getSupa();
    if (!supa) return { ok: false, msg: 'Supabase no configurado' };

    const meta = state.meta;
    // Usar competition_id y match_uuid del contexto del modal (evita cruce entre competiciones)
    let competitionId = meta.competition_id != null ? meta.competition_id : await getMatchCompetitionId(matchId);
    let matchUuid = meta.match_uuid != null ? meta.match_uuid : await getMatchUuid(matchId, competitionId);

    if (!matchUuid) {
        console.error('No se pudo obtener match_uuid del match. No se pueden guardar los goles.');
        return { ok: false, msg: 'Error: el partido no tiene match_uuid asignado.' };
    }

    // Obtener season del match si no está en el meta (filtrar por competition_id para no coger otro partido)
    let season = meta.season || null;
    if (!season) {
        try {
            let seasonQuery = supa.from('matches').select('season').eq('id', matchId);
            if (competitionId != null) seasonQuery = seasonQuery.eq('competition_id', competitionId);
            const { data: matchData, error: matchError } = await seasonQuery.maybeSingle();
            if (!matchError && matchData && matchData.season) {
                season = matchData.season;
            } else {
                season = getActiveSeasonSafe();
            }
        } catch (err) {
            console.warn('Error obteniendo season del match:', err);
            season = getActiveSeasonSafe();
        }
    }

    const localTeamId = meta.local_team_id;
    const visitTeamId = meta.visitante_team_id;

    if (!localTeamId || !visitTeamId) {
        return { ok: false, msg: 'Faltan league_team_id en el partido' };
    }

    const { error: errDel } = await supa
        .from('goal_events')
        .delete()
        .eq('match_uuid', matchUuid)
        .in('event_type', ['goal', 'own_goal']);

    if (errDel) {
        console.error('Error borrando goal_events:', errDel);
        return { ok: false, msg: 'No se pudieron borrar los eventos antiguos' };
    }

    const rows = [];
    const pushSide = (detailKey, leagueTeamId) => {
        (state[detailKey] || []).forEach(g => {
            const row = {
                match_id: matchId,
                match_uuid: matchUuid,
                league_team_id: leagueTeamId,
                player_id: (g.player_id === -1) ? null : g.player_id,
                minute: (g.minute != null && Number.isFinite(Number(g.minute))) ? Number(g.minute) : null,
                event_type: (g.player_id === -1) ? 'own_goal' : 'goal'
            };
            // Añadir competition_id si está disponible
            if (competitionId !== null) {
                row.competition_id = competitionId;
            }
            // Añadir season si está disponible
            if (season !== null) {
                row.season = season;
            }
            rows.push(row);
        });
    };

    pushSide('goalsDetailLocal', localTeamId);
    pushSide('goalsDetailVisitante', visitTeamId);

    if (rows.length) {
        const { error: errIns } = await supa
            .from('goal_events')
            .insert(rows);

        if (errIns) {
            console.error('Error insertando goal_events:', errIns);
            return { ok: false, msg: 'No se pudieron guardar los goles del partido' };
        }
    }

    return { ok: true, msg: 'Goleadores guardados correctamente' };
};

export const saveRedCardsFull = async (matchId) => {
    const state = scorerState[matchId];
    if (!state) return { ok: false, msg: 'No hay datos' };

    const supa = await getSupa();
    if (!supa) return { ok: false, msg: 'Supabase no configurado' };

    const meta = state.meta;
    // Usar competition_id y match_uuid del contexto del modal (evita cruce entre competiciones)
    const competitionId = meta.competition_id != null ? meta.competition_id : await getMatchCompetitionId(matchId);
    const matchUuid = meta.match_uuid != null ? meta.match_uuid : await getMatchUuid(matchId, competitionId);

    if (!matchUuid) {
        console.error('No se pudo obtener match_uuid del match. No se pueden guardar las tarjetas rojas.');
        return { ok: false, msg: 'Error: el partido no tiene match_uuid asignado.' };
    }
    const localTeamId = meta.local_team_id;
    const visitTeamId = meta.visitante_team_id;

    if (!localTeamId || !visitTeamId) return { ok: false, msg: 'Faltan IDs de equipo' };

    const { error: errDel } = await supa
        .from('match_red_cards')
        .delete()
        .eq('match_uuid', matchUuid);

    if (errDel) {
        console.error('Error borrando rojas de match_red_cards:', errDel);
        return { ok: false, msg: 'Error al limpiar rojas antiguas' };
    }

    const rows = [];
    const season = meta.season || null;
    (state.redLocal || []).forEach(p => {
        const row = {
            match_id: matchId,
            match_uuid: matchUuid,
            league_team_id: localTeamId,
            player_id: p.player_id,
            minute: (p.minute != null ? p.minute : null)
        };
        // Añadir competition_id si está disponible
        if (competitionId !== null) {
            row.competition_id = competitionId;
        }
        // Añadir season si está disponible
        if (season !== null) {
            row.season = season;
        }
        rows.push(row);
    });
    (state.redVisitante || []).forEach(p => {
        const row = {
            match_id: matchId,
            match_uuid: matchUuid,
            league_team_id: visitTeamId,
            player_id: p.player_id,
            minute: (p.minute != null ? p.minute : null)
        };
        // Añadir competition_id si está disponible
        if (competitionId !== null) {
            row.competition_id = competitionId;
        }
        // Añadir season si está disponible
        if (season !== null) {
            row.season = season;
        }
        rows.push(row);
    });

    if (rows.length) {
        const { error: errIns } = await supa.from('match_red_cards').insert(rows);
        if (errIns) {
            console.error('Error insertando rojas en match_red_cards:', errIns);
            return { ok: false, msg: 'Error guardando detalle tarjetas' };
        }
    }

    const lCount = (state.redLocal || []).length;
    const vCount = (state.redVisitante || []).length;

    // UPSERT: Crear o actualizar registros en match_team_stats
    // La clave única es (match_id, league_team_id), así que usamos upsert
    const localStatsRow = {
        match_id: matchId,
        match_uuid: matchUuid,
        league_team_id: localTeamId,
        red_cards: lCount
    };
    
    const visitStatsRow = {
        match_id: matchId,
        match_uuid: matchUuid,
        league_team_id: visitTeamId,
        red_cards: vCount
    };

    // Añadir competition_id si está disponible (requerido para match_team_stats)
    if (competitionId !== null) {
        localStatsRow.competition_id = competitionId;
        visitStatsRow.competition_id = competitionId;
    }

    // Usar upsert para crear o actualizar los registros
    // onConflict especifica las columnas de la clave única
    const [resL, resV] = await Promise.all([
        supa.from('match_team_stats')
            .upsert(localStatsRow, { onConflict: 'match_id,league_team_id' }),
        supa.from('match_team_stats')
            .upsert(visitStatsRow, { onConflict: 'match_id,league_team_id' })
    ]);

    if (resL.error || resV.error) {
        console.warn('Error actualizando contador rojas', resL.error, resV.error);
    }

    await Promise.all([
        saveSuspensionForMatch(meta, localTeamId, state.redLocal.map(p => p.player_id), 'red_card'),
        saveSuspensionForMatch(meta, visitTeamId, state.redVisitante.map(p => p.player_id), 'red_card')
    ]);

    return { ok: true, msg: 'Tarjetas rojas y sanciones guardadas' };
};

// Helper privado: gestiona suspensiones por acumulación de amarillas para un equipo
const saveYellowSuspensionsForTeam = async (supa, matchId, competitionId, competitionType, teamId, matchPlayerPids, matchMeta) => {
    const threshold = competitionType === 'league' ? 5 : 3;

    // Total amarillas por jugador de este equipo en toda la competición
    const { data: allYellows } = await supa
        .from('match_yellow_cards')
        .select('player_id')
        .eq('competition_id', competitionId)
        .eq('league_team_id', teamId)
        .not('player_id', 'is', null);

    const countByPlayer = {};
    (allYellows || []).forEach(r => {
        countByPlayer[r.player_id] = (countByPlayer[r.player_id] || 0) + 1;
    });

    // Jugadores de ESTE partido que cruzan el umbral (múltiplo exacto)
    const suspended = matchPlayerPids.filter(pid =>
        (countByPlayer[pid] || 0) > 0 && (countByPlayer[pid] || 0) % threshold === 0
    );

    // Suspensiones amarillas existentes de este partido para este equipo
    const { data: current } = await supa
        .from('player_suspensions')
        .select('player_id')
        .eq('origin_match_id', matchId)
        .eq('league_team_id', teamId)
        .eq('reason', 'yellow_accumulated');

    const currentPids = (current || []).map(x => x.player_id);
    const newSet = new Set(suspended);
    const toDelete = currentPids.filter(pid => !newSet.has(pid));
    const toInsert = suspended.filter(pid => !currentPids.includes(pid));

    if (toDelete.length) {
        await supa.from('player_suspensions').delete()
            .eq('origin_match_id', matchId)
            .eq('league_team_id', teamId)
            .eq('reason', 'yellow_accumulated')
            .in('player_id', toDelete);
    }

    if (toInsert.length) {
        const season = getActiveSeasonSafe();
        const nextMatch = await getNextMatchForTeam(
            season, teamId,
            matchMeta.round_id,
            competitionId,
            matchMeta.bracket_type,
            matchMeta.cup_leg,
            matchMeta.round_type
        );
        if (!nextMatch) {
            console.log('No next match found for yellow suspension, team', teamId);
            return;
        }
        const rows = toInsert.map(pid => ({
            player_id: pid,
            league_team_id: teamId,
            match_id: nextMatch.id,
            match_uuid: nextMatch.match_uuid != null ? nextMatch.match_uuid : null,
            origin_match_id: matchId,
            origin_match_uuid: matchMeta.match_uuid != null ? matchMeta.match_uuid : null,
            reason: 'yellow_accumulated',
            competition_id: competitionId
        }));
        const { error } = await supa.from('player_suspensions').insert(rows);
        if (error) console.warn('Error insertando suspensiones por amarillas:', error);
    }
};

export const saveYellowCardsFull = async (matchId) => {
    const state = scorerState[matchId];
    if (!state) return { ok: false, msg: 'No hay datos' };

    const supa = await getSupa();
    if (!supa) return { ok: false, msg: 'Supabase no configurado' };

    const meta = state.meta;
    const competitionId = meta.competition_id != null ? meta.competition_id : await getMatchCompetitionId(matchId);
    const matchUuid = meta.match_uuid != null ? meta.match_uuid : await getMatchUuid(matchId, competitionId);

    if (!matchUuid) {
        console.error('No se pudo obtener match_uuid. No se pueden guardar las amarillas.');
        return { ok: false, msg: 'Error: el partido no tiene match_uuid asignado.' };
    }

    const localTeamId = meta.local_team_id;
    const visitTeamId = meta.visitante_team_id;
    if (!localTeamId || !visitTeamId) return { ok: false, msg: 'Faltan IDs de equipo' };

    // 1. Borrar amarillas existentes de este partido
    const { error: errDel } = await supa
        .from('match_yellow_cards')
        .delete()
        .eq('match_uuid', matchUuid);

    if (errDel) {
        console.error('Error borrando match_yellow_cards:', errDel);
        return { ok: false, msg: 'Error al limpiar amarillas antiguas' };
    }

    // 2. Insertar nuevas amarillas
    const rows = [];
    const season = meta.season || null;
    (state.yellowLocal || []).forEach(p => {
        const row = { match_id: matchId, match_uuid: matchUuid, league_team_id: localTeamId, player_id: p.player_id, minute: (p.minute != null ? p.minute : null) };
        if (competitionId !== null) row.competition_id = competitionId;
        if (season !== null) row.season = season;
        rows.push(row);
    });
    (state.yellowVisitante || []).forEach(p => {
        const row = { match_id: matchId, match_uuid: matchUuid, league_team_id: visitTeamId, player_id: p.player_id, minute: (p.minute != null ? p.minute : null) };
        if (competitionId !== null) row.competition_id = competitionId;
        if (season !== null) row.season = season;
        rows.push(row);
    });

    if (rows.length) {
        const { error: errIns } = await supa.from('match_yellow_cards').insert(rows);
        if (errIns) {
            console.error('Error insertando amarillas:', errIns);
            return { ok: false, msg: 'Error guardando tarjetas amarillas' };
        }
    }

    // 3. Suspensiones por acumulación (solo si hay competición conocida)
    if (competitionId) {
        const { data: comp } = await supa
            .from('competitions')
            .select('competition_type')
            .eq('id', competitionId)
            .single();
        const competitionType = comp?.competition_type;

        if (competitionType === 'league' || competitionType === 'cup') {
            await Promise.all([
                saveYellowSuspensionsForTeam(supa, matchId, competitionId, competitionType, localTeamId, (state.yellowLocal || []).map(p => p.player_id), meta),
                saveYellowSuspensionsForTeam(supa, matchId, competitionId, competitionType, visitTeamId, (state.yellowVisitante || []).map(p => p.player_id), meta),
            ]);
        }
    }

    return { ok: true, msg: 'Tarjetas amarillas y sanciones guardadas' };
};

export const saveInjuriesFull = async (matchId) => {
    const state = scorerState[matchId];
    if (!state) return { ok: false, msg: 'No hay datos' };

    const supa = await getSupa();
    if (!supa) return { ok: false, msg: 'Supabase no configurado' };

    const meta = state.meta;
    // Usar competition_id y match_uuid del contexto del modal (evita cruce entre competiciones)
    const competitionId = meta.competition_id != null ? meta.competition_id : await getMatchCompetitionId(matchId);
    const matchUuid = meta.match_uuid != null ? meta.match_uuid : await getMatchUuid(matchId, competitionId);

    if (!matchUuid) {
        console.error('No se pudo obtener match_uuid del match. No se pueden guardar las lesiones.');
        return { ok: false, msg: 'Error: el partido no tiene match_uuid asignado.' };
    }
    const localTeamId = meta.local_team_id;
    const visitTeamId = meta.visitante_team_id;

    if (!localTeamId || !visitTeamId) return { ok: false, msg: 'Faltan IDs de equipo' };

    const { error: errDel } = await supa
        .from('match_injuries')
        .delete()
        .eq('match_uuid', matchUuid);

    if (errDel) {
        console.error('Error borrando match_injuries:', errDel);
        return { ok: false, msg: 'Error al limpiar lesiones antiguas' };
    }

    const rows = [];
    const season = meta.season || null;
    (state.injuriesLocal || []).forEach(p => {
        const row = {
            match_id: matchId,
            match_uuid: matchUuid,
            league_team_id: localTeamId,
            player_id: p.player_id
        };
        // Añadir competition_id si está disponible
        if (competitionId !== null) {
            row.competition_id = competitionId;
        }
        // Añadir season si está disponible
        if (season !== null) {
            row.season = season;
        }
        rows.push(row);
    });
    (state.injuriesVisitante || []).forEach(p => {
        const row = {
            match_id: matchId,
            match_uuid: matchUuid,
            league_team_id: visitTeamId,
            player_id: p.player_id
        };
        // Añadir competition_id si está disponible
        if (competitionId !== null) {
            row.competition_id = competitionId;
        }
        // Añadir season si está disponible
        if (season !== null) {
            row.season = season;
        }
        rows.push(row);
    });

    if (rows.length) {
        const { error: errIns } = await supa.from('match_injuries').insert(rows);
        if (errIns) {
            console.error('Error insertando match_injuries:', errIns);
            return { ok: false, msg: 'Error guardando lesiones' };
        }
    }

    await Promise.all([
        saveSuspensionForMatch(meta, localTeamId, state.injuriesLocal.map(p => p.player_id), 'injury'),
        saveSuspensionForMatch(meta, visitTeamId, state.injuriesVisitante.map(p => p.player_id), 'injury')
    ]);

    return { ok: true, msg: 'Lesiones registradas correctamente' };
};

export const loadSuspensionsForMatches = async (partidos) => {
    const supa = await getSupa();
    if (!supa) return {};

    const matchIds = partidos.map(p => p.id).filter(Boolean);
    if (!matchIds.length) return {};

    // `match_id` (texto) NO es único entre competiciones, así que acotamos por
    // competición para no traer sanciones de otra liga con el mismo id de texto.
    const compId = partidos.map(p => p.competition_id).find(c => c != null);

    let query = supa
        .from('player_suspensions')
        .select(`
        match_id,
        reason,
        player:players(name),
        team:league_teams(nickname, display_name)
      `)
        .in('match_id', matchIds);
    if (compId != null) query = query.eq('competition_id', compId);

    const { data, error } = await query;

    if (error) {
        console.warn('Error fetching player_suspensions:', error);
        return {};
    }

    const map = {};
    (data || []).forEach(row => {
        const mid = row.match_id;
        const pName = row.player?.name || 'Jugador';
        const tName = row.team?.nickname || row.team?.display_name || 'Equipo';

        if (!map[mid]) map[mid] = [];
        map[mid].push({ playerName: pName, teamName: tName, reason: row.reason });
    });
    return map;
};

