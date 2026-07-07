import { normalizeText } from './utils.js';
import { isNum } from './utils.js';
import { getResultados, getPenaltyMap } from './stats-data.js';

// Caché de clasificaciones por jornada / opciones
const _clasifCache = new Map(); // key: `${limit||'ALL'}|${useH2H?1:0}`

// Diferencia de goles
export const dg = e => e.gf - e.gc;

/**
 * Carga estadísticas de clasificación desde la vista SQL league_standings
 * @param {number} competitionId - ID de la competición
 * @param {number|null} hasta - Jornada hasta la cual calcular (null = todas)
 * @returns {Promise<Array|null>} Array de equipos con estadísticas o null si falla
 */
const loadStandingsFromView = async (competitionId, hasta = null) => {
    if (!competitionId) return null;

    try {
        const { getSupabaseClient } = await import('./supabase-client.js');
        const supabase = await getSupabaseClient();
        if (!supabase) return null;

        // Verificar que la competición sea de tipo 'league'
        const { data: competition, error: compError } = await supabase
            .from('competitions')
            .select('competition_type, season')
            .eq('id', competitionId)
            .single();

        if (compError || !competition) {
            console.debug('Error obteniendo competición para league_standings:', compError);
            return null;
        }

        if (competition.competition_type !== 'league') {
            // No es una liga, no usar la vista
            return null;
        }

        // Consultar la vista o función según si hay filtro de jornada
        let standingsData = null;
        let standingsError = null;

        if (hasta !== null && hasta > 0) {
            // Usar función SQL para filtrar por jornada (filtra partidos antes de agregar)
            const { data, error } = await supabase.rpc('get_league_standings_until_jornada', {
                p_competition_id: competitionId,
                p_jornada: hasta
            });
            standingsData = data;
            standingsError = error;
        } else {
            // Usar vista para clasificación completa
            const { data, error } = await supabase
                .from('league_standings')
                .select(`
                    league_team_id,
                    competition_id,
                    season,
                    jornada_max,
                    pj,
                    g,
                    e,
                    p,
                    gf,
                    gc,
                    goal_difference,
                    pts_raw,
                    penalty_points,
                    pts
                `)
                .eq('competition_id', competitionId)
                .eq('season', competition.season);
            standingsData = data;
            standingsError = error;
        }

        if (standingsError) {
            console.warn('Error cargando league_standings:', standingsError);
            return null;
        }

        if (!standingsData || standingsData.length === 0) {
            return null;
        }

        // Obtener información de equipos desde league_teams
        const teamIds = standingsData.map(row => row.league_team_id).filter(Boolean);
        const { data: teamsData, error: teamsError } = await supabase
            .from('league_teams')
            .select('id, nickname, display_name')
            .in('id', teamIds)
            .eq('competition_id', competitionId);

        if (teamsError) {
            console.warn('Error cargando league_teams para league_standings:', teamsError);
            return null;
        }

        // Crear mapa de league_team_id -> nombre
        const teamMap = new Map();
        (teamsData || []).forEach(team => {
            teamMap.set(team.id, team.nickname || team.display_name || `Equipo ${team.id}`);
        });

        // Mapear datos de la vista al formato esperado
        const equipos = standingsData.map(row => {
            const teamName = teamMap.get(row.league_team_id) || `Equipo ${row.league_team_id}`;

            return {
                nombre: teamName,
                league_team_id: row.league_team_id,
                pj: row.pj || 0,
                g: row.g || 0,
                e: row.e || 0,
                p: row.p || 0,
                gf: row.gf || 0,
                gc: row.gc || 0,
                pts_raw: row.pts_raw || 0,
                penalty_pts: row.penalty_points || 0,
                pts: row.pts || 0,
                goal_difference: row.goal_difference || 0
            };
        });

        return equipos;
    } catch (err) {
        console.warn('Error en loadStandingsFromView:', err);
        return null;
    }
};

/**
 * Carga el roster completo de equipos de una competición desde league_teams.
 * Se usa para que la clasificación muestre TODOS los equipos inscritos, aunque
 * aún no hayan jugado ningún partido (la vista league_standings y el fallback
 * solo agregan equipos con partidos disputados).
 * @param {number} competitionId
 * @returns {Promise<Array<{league_team_id:number, nombre:string, penalty_pts:number}>>}
 */
const loadCompetitionTeams = async (competitionId) => {
    if (!competitionId) return [];
    try {
        const { getSupabaseClient } = await import('./supabase-client.js');
        const supabase = await getSupabaseClient();
        if (!supabase) return [];

        const { data, error } = await supabase
            .from('league_teams')
            .select('id, nickname, display_name, penalty_points')
            .eq('competition_id', competitionId);

        if (error || !data) {
            console.debug('No se pudo cargar el roster de league_teams:', error);
            return [];
        }

        return data.map(t => ({
            league_team_id: t.id,
            nombre: t.nickname || t.display_name || `Equipo ${t.id}`,
            penalty_pts: t.penalty_points || 0
        }));
    } catch (err) {
        console.debug('Error en loadCompetitionTeams:', err);
        return [];
    }
};

/**
 * Inyecta en una tabla de clasificación los equipos del roster que aún no
 * aparezcan (los que no han jugado ningún partido), con stats a 0.
 * Dedup por league_team_id cuando existe; si no, por nombre normalizado.
 * Función pura: no muta `equipos`, devuelve un array nuevo.
 * @param {Array} equipos - equipos ya presentes (de la vista SQL o el fallback)
 * @param {Array<{league_team_id:number, nombre:string, penalty_pts:number}>} roster
 * @returns {Array}
 */
export const mergeRosterIntoStandings = (equipos, roster) => {
    if (!Array.isArray(roster) || !roster.length) return equipos;

    const result = [...equipos];
    const idsPresentes = new Set(result.map(e => e.league_team_id).filter(Boolean));
    const nombresPresentes = new Set(result.map(e => normalizeText(e.nombre)));

    for (const t of roster) {
        const yaEsta = (t.league_team_id && idsPresentes.has(t.league_team_id))
            || nombresPresentes.has(normalizeText(t.nombre));
        if (yaEsta) continue;
        const pen = t.penalty_pts || 0;
        result.push({
            nombre: t.nombre,
            league_team_id: t.league_team_id,
            pj: 0, g: 0, e: 0, p: 0, gf: 0, gc: 0,
            pts_raw: 0,
            penalty_pts: pen,
            pts: Math.max(0, 0 - pen),
            goal_difference: 0
        });
    }
    return result;
};

// --------------------------
// Clasificación con H2H
// --------------------------
export const computeClasificacion = async (hasta = null, opts = {}) => {
    const { useH2H = true, competitionId = null, typeConfig = null } = opts;

    // Obtener valores de puntos desde type_config o usar defaults
    const pointsWin = typeConfig?.points_win ?? 3;
    const pointsDraw = typeConfig?.points_draw ?? 1;
    const pointsLoss = typeConfig?.points_loss ?? 0;

    // Obtener criterios de desempate desde type_config o usar defaults
    const tiebreaker = typeConfig?.tiebreaker ?? ['points', 'goal_difference', 'goals_for', 'head_to_head'];

    // Cache simple en memoria para no recalcular siempre lo mismo
    // Incluir typeConfig en la clave del cache para invalidar si cambia
    const configKey = typeConfig ? JSON.stringify({ pointsWin, pointsDraw, tiebreaker }) : 'default';
    const cacheKey = `${hasta || 'ALL'}|${useH2H ? 1 : 0}|${configKey}`;
    if (_clasifCache.has(cacheKey)) {
        return _clasifCache.get(cacheKey);
    }

    // Intentar cargar desde la vista SQL para competiciones de tipo 'league'
    let equipos = await loadStandingsFromView(competitionId, hasta);
    let h2h = {};
    let usedView = false;
    
    if (equipos && equipos.length > 0) {
        // Datos cargados desde la vista SQL
        usedView = true;
    } else {
        // Fallback: método original (para competiciones no-league o si la vista falla)
        const jornadas = await getResultados(competitionId);

        const limit = (hasta == null)
            ? jornadas.length
            : Math.max(0, Math.min(hasta, jornadas.length));

        const teams = new Map();
        const teamObj = (name) => {
            const k = normalizeText(name);
            if (!teams.has(k)) {
                teams.set(k, {
                    nombre: name, pj: 0, g: 0, e: 0, p: 0,
                    gf: 0, gc: 0, pts: 0
                });
            }
            return teams.get(k);
        };

        // H2H acumulado por emparejamiento
        const h2h = {};
        const addH2H = (A, B, gfA, gfB) => {
            const a = normalizeText(A), b = normalizeText(B);
            (h2h[a] ||= {});
            (h2h[a][b] ||= { gf: 0, gc: 0 });
            h2h[a][b].gf += gfA;
            h2h[a][b].gc += gfB;
        };

        for (let i = 0; i < limit; i++) {
            const j = jornadas[i];
            for (const p of (j?.partidos || [])) {
                if (!p.local || !p.visitante) continue;
                // Skip cup matches: para mixed las eliminatorias vienen incluidas en
                // getResultados (las stats individuales las necesitan), pero no deben
                // contar como puntos de liga/grupo en las standings.
                if (p.round_type === 'cup') continue;

                const L = teamObj(p.local);
                const V = teamObj(p.visitante);

                const gl = isNum(p.goles_local) ? p.goles_local : null;
                const gv = isNum(p.goles_visitante) ? p.goles_visitante : null;
                if (gl === null || gv === null) continue;

                L.pj++; V.pj++;
                L.gf += gl; L.gc += gv;
                V.gf += gv; V.gc += gl;

                // ✅ Usar valores de type_config para puntos
                if (gl > gv) {
                    L.g++;
                    L.pts += pointsWin;
                    V.p++;
                    V.pts += pointsLoss;
                }
                else if (gl < gv) {
                    V.g++;
                    V.pts += pointsWin;
                    L.p++;
                    L.pts += pointsLoss;
                }
                else {
                    L.e++;
                    V.e++;
                    L.pts += pointsDraw;
                    V.pts += pointsDraw;
                }

                addH2H(p.local, p.visitante, gl, gv);
                addH2H(p.visitante, p.local, gv, gl);
            }
        }

        equipos = Array.from(teams.values());

        // 🔴 Aplicar sanciones si las tenemos (solo en fallback, la vista ya las incluye)
        const _penaltyByTeamNorm = getPenaltyMap();
        if (_penaltyByTeamNorm && _penaltyByTeamNorm.size) {
            for (const t of equipos) {
                const k = normalizeText(t.nombre);
                const pen = _penaltyByTeamNorm.get(k) || 0;

                t.pts_raw = t.pts;       // puntos por partidos (sin sanción)
                t.penalty_pts = pen;     // sanción
                t.pts = t.pts_raw - pen; // puntos finales

                if (t.pts < 0) t.pts = 0; // opcional: evitar negativos
            }
        }
    }

    // Inyectar equipos inscritos sin partidos: la vista SQL y el fallback solo
    // producen equipos que han jugado, así que un equipo sin partidos no aparecía.
    const roster = await loadCompetitionTeams(competitionId);
    equipos = mergeRosterIntoStandings(equipos, roster);

    // Calcular H2H desde partidos (necesario para ordenación en ambos casos)
    const jornadas = await getResultados(competitionId);
    const limit = (hasta == null)
        ? jornadas.length
        : Math.max(0, Math.min(hasta, jornadas.length));

    const addH2H = (A, B, gfA, gfB) => {
        const a = normalizeText(A), b = normalizeText(B);
        (h2h[a] ||= {});
        (h2h[a][b] ||= { gf: 0, gc: 0 });
        h2h[a][b].gf += gfA;
        h2h[a][b].gc += gfB;
    };

    for (let i = 0; i < limit; i++) {
        const j = jornadas[i];
        for (const p of (j?.partidos || [])) {
            if (!p.local || !p.visitante) continue;

            const gl = isNum(p.goles_local) ? p.goles_local : null;
            const gv = isNum(p.goles_visitante) ? p.goles_visitante : null;
            if (gl === null || gv === null) continue;

            addH2H(p.local, p.visitante, gl, gv);
            addH2H(p.visitante, p.local, gv, gl);
        }
    }

    // ✅ Aplicar criterios de desempate: SIEMPRE prioridad 1) Puntos, 2) H2H, 3) Resto
    equipos.sort((A, B) => {
        // 1️⃣ PRIMERO: Puntos (siempre tiene máxima prioridad)
        if (B.pts !== A.pts) return B.pts - A.pts;

        // 2️⃣ SEGUNDO: Head-to-Head (siempre segunda prioridad si useH2H está activo)
        if (useH2H) {
            const a = normalizeText(A.nombre), b = normalizeText(B.nombre);
            const ha = h2h[a]?.[b], hb = h2h[b]?.[a];
            if (ha && hb) {
                const difA = (ha.gf || 0) - (ha.gc || 0);
                const difB = (hb.gf || 0) - (hb.gc || 0);
                if (difA !== difB) return difB - difA;
            }
        }

        // 3️⃣ TERCERO: Aplicar los demás criterios del tiebreaker (excluyendo points y head_to_head)
        for (const criterion of tiebreaker) {
            if (criterion === 'points' || criterion === 'head_to_head') {
                // Ya aplicados arriba, saltar
                continue;
            } else if (criterion === 'goal_difference') {
                const dA = dg(A), dB = dg(B);
                if (dA !== dB) return dB - dA;
            } else if (criterion === 'goals_for') {
                if (B.gf !== A.gf) return B.gf - A.gf;
            }
        }

        // Si todos los criterios son iguales, ordenar alfabéticamente
        return A.nombre.localeCompare(B.nombre, "es", { sensitivity: "base" });
    });

    _clasifCache.set(cacheKey, equipos);

    // Limpiar cache si tiene más de 10 entradas (evitar memory leak)
    if (_clasifCache.size > 10) {
        const firstKey = _clasifCache.keys().next().value;
        _clasifCache.delete(firstKey);
    }

    return equipos;
};

// Por jornada (te devuelve un array de tablas)
export const computeClasificacionPorJornada = async (opts = {}) => {
    const { competitionId = null } = opts;

    // Obtener type_config de la competición si competitionId está disponible
    let typeConfig = opts.typeConfig || null;
    if (!typeConfig && competitionId) {
        try {
            const { getCompetitionById } = await import('./competition-data.js');
            const competition = await getCompetitionById(competitionId);
            typeConfig = competition?.type_config || null;
        } catch (e) {
            console.debug('No se pudo obtener type_config para computeClasificacionPorJornada:', e);
        }
    }

    const jornadas = await getResultados(competitionId);
    const tables = [];
    for (let j = 1; j <= jornadas.length; j++) {
        tables.push(await computeClasificacion(j, { ...opts, typeConfig }));
    }
    return tables;
};

// Totales GF/GC/PJ simples (por si lo quieres directo)
export const computeTeamTotals = async (competitionId = null) => {
    // Obtener type_config de la competición si competitionId está disponible
    let typeConfig = null;
    if (competitionId) {
        try {
            const { getCompetitionById } = await import('./competition-data.js');
            const competition = await getCompetitionById(competitionId);
            typeConfig = competition?.type_config || null;
        } catch (e) {
            console.debug('No se pudo obtener type_config para computeTeamTotals:', e);
        }
    }

    const tabla = await computeClasificacion(null, {
        useH2H: false,
        competitionId,
        typeConfig
    });
    return tabla.map(t => ({
        nombre: t.nombre, pj: t.pj, gf: t.gf, gc: t.gc
    }));
};
