import { getSupabaseClient, getSupabaseConfig, getActiveSeason } from './supabase-client.js';
import { normalizeText } from './utils.js';
import { teamNameFromObj } from './domain.js';
import { isNum } from './utils.js';
import { queryTable, TABLES_WITH_COMPETITION_ID } from './db-helpers.js';
import { getCurrentCompetitionId } from './competitions.js';

// Carga + caché de datos
let _resultadosCache = null;
let _resultadosCacheKey = null; // Guardar el competitionId usado en el caché
let _statsIndexCache = null;
let _statsIndexCacheKey = null; // Guardar el competitionId usado en el caché
let _pichichiRowsCache = null;
let _pichichiRowsCacheKey = null; // Guardar el competitionId usado en el caché

// Mapa interno de equipos por id de league_teams (para casar stats)
let _teamMapCache = null;
// Mapa de sanciones por nombre normalizado de equipo
let _penaltyByTeamNorm = null;

const mapStatsRowFromDb = (row) => ({
    goles: row?.goals ?? null,
    posesion: row?.possession ?? null,
    tiros: row?.shots ?? null,
    tiros_a_puerta: row?.shots_on_target ?? null,
    faltas: row?.fouls ?? null,
    fueras_de_juego: row?.offsides ?? null,
    corners: row?.corners ?? null,
    tiros_libres: row?.free_kicks ?? null,
    pases: row?.passes ?? null,
    pases_completados: row?.passes_completed ?? null,
    centros: row?.crosses ?? null,
    pases_interceptados: row?.interceptions ?? null,
    entradas: row?.tackles ?? null,
    paradas: row?.saves ?? null,
    rojas: row?.red_cards ?? null
});

// Carga jornadas desde Supabase.matches + league_teams
const loadResultadosFromSupabase = async (competitionId = null) => {
    const supabase = await getSupabaseClient();

    // Obtener competition_id automáticamente si no se proporciona
    let finalCompetitionId = competitionId;
    if (finalCompetitionId === null) {
        try {
            finalCompetitionId = await getCurrentCompetitionId();
        } catch (e) {
            throw new Error('No se pudo obtener competition_id para matches. Es obligatorio.');
        }
    }

    // Obtener tipo de competición para filtrar por round_type
    let competitionType = null;
    if (finalCompetitionId) {
        try {
            const { getCompetitionById } = await import('./competition-data.js');
            const competition = await getCompetitionById(finalCompetitionId);
            competitionType = competition?.competition_type || null;
        } catch (e) {
            console.warn('No se pudo obtener tipo de competición, se obtendrán todos los partidos:', e);
        }
    }

    let query = supabase
        .from('matches')
        .select(`
        id,season,round_id,match_date,match_time,home_goals,away_goals,stream_url,
        competition_id,round_type,resolved_administratively,match_uuid,
        bracket_type,cup_leg,
        home_league_team_id,away_league_team_id,
        home:league_teams!matches_home_league_team_id_fkey(
          id,nickname,display_name,penalty_points,penalty_reason,club:clubs(id,name)
        ),
        away:league_teams!matches_away_league_team_id_fkey(
          id,nickname,display_name,penalty_points,penalty_reason,club:clubs(id,name)
        )
      `)
        .order('round_id', { ascending: true })
        .order('match_date', { ascending: true });

    // competition_id es obligatorio para matches
    if (finalCompetitionId === null) {
        throw new Error('competition_id es obligatorio para matches pero no se proporcionó ni se pudo obtener del contexto.');
    }
    query = query.eq('competition_id', finalCompetitionId);

    // NOTA: NO filtramos partidos administrativos aquí porque la CLASIFICACIÓN
    // sí debe incluirlos (para puntos, victorias, etc.)
    // El filtro se aplica en lugares específicos como MVP, pichichi, etc.

    // Filtrar por round_type según el tipo de competición
    // Para ligas: solo partidos con round_type IS NULL o round_type = 'league'
    // Para copas: solo partidos con round_type = 'cup'
    // Para mixtas: incluimos también 'cup' para que goles/MVP de la fase
    // eliminatoria sumen a la ficha del jugador. computeClasificacion ignora
    // explícitamente round_type='cup' para que no contaminen las standings.
    if (competitionType === 'league') {
        // Liga: excluir partidos de copa, incluir solo liga o null
        query = query.or('round_type.is.null,round_type.eq.league');
    } else if (competitionType === 'cup') {
        // Copa: solo partidos de copa
        query = query.eq('round_type', 'cup');
    } else if (competitionType === 'mixed') {
        // Mixta: grupos + cup (las stats de jugador necesitan ambos)
        query = query.or('round_type.is.null,round_type.in.(league,group,cup)');
    }
    // Si no hay tipo de competición o es desconocido, obtener todos los partidos (compatibilidad hacia atrás)

    const { data, error } = await query;
    if (error) throw error;

    const matches = data || [];
    if (!matches.length) return [];

    // Construimos teamMap interno por id de league_teams
    const teamMap = new Map();
    matches.forEach(m => {
        if (m.home) teamMap.set(m.home.id, m.home);
        if (m.away) teamMap.set(m.away.id, m.away);
    });
    _teamMapCache = teamMap;

    // Nuevo: mapa de sanciones por nombre normalizado
    const penaltyMap = new Map();

    // Construimos jornadas como en resultados.json
    const jornadasMap = new Map();

    matches.forEach((m, idx) => {
        // El número de jornada visible al usuario viene de rounds.number (1..N).
        // Antes usábamos round_id como fallback, pero rounds.id es un PK global
        // y solo coincidía con el number en Liga Principal 25-26 por azar.
        const roundNumberFromEmbed = Number(m.round?.number);
        const roundIdNum = Number(m.round_id);
        const numero = Number.isFinite(roundNumberFromEmbed) && roundNumberFromEmbed > 0
            ? roundNumberFromEmbed
            : (Number.isFinite(roundIdNum) && roundIdNum > 0
                ? roundIdNum
                : (jornadasMap.size + 1));

        const jornada = jornadasMap.get(numero) || {
            numero,
            fecha: m.match_date,
            partidos: []
        };
        if (!jornada.fecha && m.match_date) jornada.fecha = m.match_date;

        const localName = teamNameFromObj(m.home || {}, m.home_league_team_id, _teamMapCache);
        const visitName = teamNameFromObj(m.away || {}, m.away_league_team_id, _teamMapCache);

        // 🔴 Nuevo: registrar sanciones por nombre normalizado
        const localPenalty = m.home && Number.isFinite(+m.home.penalty_points)
            ? +m.home.penalty_points
            : 0;
        const visitPenalty = m.away && Number.isFinite(+m.away.penalty_points)
            ? +m.away.penalty_points
            : 0;

        penaltyMap.set(normalizeText(localName), localPenalty);
        penaltyMap.set(normalizeText(visitName), visitPenalty);

        const partido = {
            id: m.id,
            fecha: m.match_date,
            hora: m.match_time,
            local: localName,
            visitante: visitName,
            goles_local: isNum(m.home_goals) ? m.home_goals : null,
            goles_visitante: isNum(m.away_goals) ? m.away_goals : null,
            stream: m.stream_url || '',
            local_team_id: m.home_league_team_id,
            visitante_team_id: m.away_league_team_id,
            local_club_id: (m.home && m.home.club && m.home.club.id) || null,
            visitante_club_id: (m.away && m.away.club && m.away.club.id) || null,
            round_id: m.round_id,
            competition_id: m.competition_id || null,
            season: m.season || null,
            match_uuid: m.match_uuid || null,
            bracket_type: m.bracket_type || null,
            cup_leg: m.cup_leg || null,
            round_type: m.round_type || null
        };

        jornada.partidos.push(partido);
        jornadasMap.set(numero, jornada);
    });

    // 🔴 Guardamos el mapa de sanciones en caché global
    _penaltyByTeamNorm = penaltyMap;


    const jornadas = Array
        .from(jornadasMap.values())
        .sort((a, b) => (a.numero || 0) - (b.numero || 0));

    _resultadosCache = jornadas;
    return jornadas;
};

// Carga índice de stats desde match_team_stats
const loadStatsIndexFromSupabase = async (competitionId = null) => {
    const supabase = await getSupabaseClient();

    // Nos aseguramos de tener teamMap cargado
    if (!_teamMapCache) {
        await getResultados(competitionId);
    }
    const teamMap = _teamMapCache || new Map();

    // Obtener competition_id automáticamente si no se proporciona
    let finalCompetitionId = competitionId;
    if (finalCompetitionId === null) {
        try {
            finalCompetitionId = await getCurrentCompetitionId();
        } catch (e) {
            throw new Error('No se pudo obtener competition_id para match_team_stats. Es obligatorio.');
        }
    }

    // Si quieres filtrar por competición, unimos con matches
    let query = supabase
        .from('match_team_stats')
        .select(`
        match_id,league_team_id,
        possession,shots,shots_on_target,goals,fouls,offsides,corners,free_kicks,
        passes,passes_completed,crosses,interceptions,tackles,saves,red_cards,
        match:matches(season,competition_id,resolved_administratively)
      `);

    // competition_id es obligatorio para match_team_stats
    if (finalCompetitionId === null) {
        throw new Error('competition_id es obligatorio para match_team_stats pero no se proporcionó ni se pudo obtener del contexto.');
    }
    query = query.eq('match.competition_id', finalCompetitionId);

    const { data, error } = await query;
    if (error) throw error;

    const rows = data || [];
    const index = {};

    rows.forEach(row => {
        const matchId = row.match_id;
        const leagueTeamId = row.league_team_id;
        if (!matchId || leagueTeamId == null) return;

        // 🔴 Excluir partidos resueltos administrativamente de estadísticas de equipos
        const isAdminResolved = row.match?.resolved_administratively === true;
        if (isAdminResolved) return;

        // Solo incluir si el equipo está en el teamMap de la competición actual
        // Esto evita mostrar "Equipo X" para equipos de otras competiciones
        if (!teamMap.has(leagueTeamId)) {
            // Comportamiento esperado: ignorar stats de equipos de otras competiciones
            // No loguear para evitar ruido en consola
            return;
        }

        const teamObj = teamMap.get(leagueTeamId);
        const teamName = teamNameFromObj(teamObj, leagueTeamId, teamMap);

        // Verificar que el nombre no sea un fallback genérico (Equipo X)
        // Si teamNameFromObj devuelve un fallback, significa que no encontramos el equipo
        if (!teamName || teamName.startsWith('Equipo ')) {
            // Comportamiento esperado: ignorar stats sin nombre válido
            // No loguear para evitar ruido en consola
            return;
        }

        index[matchId] ||= {};
        // Guardar por nombre (para compatibilidad)
        index[matchId][teamName] = mapStatsRowFromDb(row);
        // También guardar por league_team_id para mapeo seguro
        index[matchId][`_team_id_${leagueTeamId}`] = mapStatsRowFromDb(row);
    });

    _statsIndexCache = index;
    return index;
};

// --------------------------
// APIs públicas de carga
// --------------------------
export const getResultados = async (competitionId = null) => {
    // Si el caché existe y es para el mismo competitionId, usarlo
    const cacheKey = competitionId || 'all';
    if (_resultadosCache && _resultadosCacheKey === cacheKey) {
        return _resultadosCache;
    }

    // Si cambió el competitionId, invalidar también los caches relacionados
    if (_resultadosCacheKey !== null && _resultadosCacheKey !== cacheKey) {
        // Invalidar caches relacionados que dependen de los resultados
        _teamMapCache = null;
        _penaltyByTeamNorm = null;
        // También invalidar statsIndex y pichichi ya que dependen de los resultados
        _statsIndexCache = null;
        _statsIndexCacheKey = null;
        _pichichiRowsCache = null;
        _pichichiRowsCacheKey = null;
    }

    try {
        const jornadas = await loadResultadosFromSupabase(competitionId);
        const result = Array.isArray(jornadas) ? jornadas : [];
        // Guardar en caché con su clave
        _resultadosCache = result;
        _resultadosCacheKey = cacheKey;
        return result;
    } catch (e) {
        console.warn('Fallo cargando resultados desde Supabase:', e);
    }

    return [];
};

export const getStatsIndex = async (competitionId = null) => {
    // Si el caché existe y es para el mismo competitionId, usarlo
    const cacheKey = competitionId || 'all';
    if (_statsIndexCache && _statsIndexCacheKey === cacheKey) {
        return _statsIndexCache;
    }

    // Si cambió el competitionId, asegurarse de que tenemos los resultados actualizados
    // (porque statsIndex depende de _teamMapCache que se carga en loadResultadosFromSupabase)
    const resultadosCacheKey = competitionId || 'all';
    if (!_teamMapCache || _resultadosCacheKey !== resultadosCacheKey) {
        // Cargar resultados primero para tener el teamMap actualizado
        await getResultados(competitionId);
    }

    try {
        const idx = await loadStatsIndexFromSupabase(competitionId);
        const result = idx && typeof idx === "object" ? idx : {};
        // Guardar en caché con su clave
        _statsIndexCache = result;
        _statsIndexCacheKey = cacheKey;
        return result;
    } catch (e) {
        console.warn('Fallo cargando stats desde Supabase:', e);
    }

    return {};
};

// --------------------------
// Pichichi desde Supabase
// --------------------------
// Carga pichichi desde Supabase:
const loadPichichiFromSupabase = async (competitionId = null) => {
    try {
        // Usar db-helpers para manejar automáticamente competition_id
        const data = await queryTable('goleadores', 'season, player_id, jugador, manager, partidos, goles, competition_id', {
            competitionId,
            autoCompetitionId: true
        });

        if (!data || !data.length) return [];

        // Adaptamos al formato que espera computePichichiPlayers:
        // "Jugador", "Equipo", "Partidos", "Goles"
        // También incluimos player_id para uso en palmares
        const rows = data.map(r => ({
            "Jugador": r.jugador || '',
            "Equipo": r.manager || '',           // aquí usamos el nickname del manager
            "Partidos": String(r.partidos ?? 0),   // partidos jugados por el EQUIPO (corregido)
            "Goles": String(r.goles ?? 0),
            "player_id": r.player_id || null      // Incluir player_id para palmares
        }));

        return rows;
    } catch (error) {
        console.warn('Error cargando pichichi desde vista goleadores:', error);
        return [];
    }
};


export const getPichichiRows = async (competitionId = null) => {
    // Si el caché existe y es para el mismo competitionId, usarlo
    const cacheKey = competitionId || 'all';
    if (_pichichiRowsCache && _pichichiRowsCacheKey === cacheKey) {
        return _pichichiRowsCache;
    }

    // Cargar desde Supabase únicamente
    try {
        const rowsDb = await loadPichichiFromSupabase(competitionId);
        const result = Array.isArray(rowsDb) ? rowsDb : [];
        // Guardar en caché con su clave
        _pichichiRowsCache = result;
        _pichichiRowsCacheKey = cacheKey;
        return result;
    } catch (e) {
        console.warn('Error cargando pichichi desde Supabase:', e);
        const result = [];
        _pichichiRowsCache = result;
        _pichichiRowsCacheKey = cacheKey;
        return result;
    }
};

// Exportar sanciones para que stats-calc pueda usarlas
export function getPenaltyMap() {
    return _penaltyByTeamNorm;
}
