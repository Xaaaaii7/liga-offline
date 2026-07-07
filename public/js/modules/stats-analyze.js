import { isNum, toNum, normalizeText } from './utils.js';
import { getStatsIndex, getResultados, getPichichiRows } from './stats-data.js';
import { computeClasificacion } from './stats-calc.js';

// Normaliza % a 0..1
const parsePct01 = v => {
    if (v == null) return null;
    if (typeof v === "string") {
        const n = parseFloat(v.replace(",", ".").replace("%", "").trim());
        if (!Number.isFinite(n)) return null;
        return n > 1 ? n / 100 : n;
    }
    const n = +v;
    if (!Number.isFinite(n)) return null;
    return n > 1 ? n / 100 : n;
};

const addNum = (o, k, v) => { o[k] += (Number.isFinite(+v) ? +v : 0); };

// --------------------------
// Rankings avanzados por equipo
// --------------------------
export const fair = (t) => {
    const ROJA_PESO = 5;
    return ((t.entradas || 0) + 1) /
        ((t.faltas || 0) + ROJA_PESO * (t.rojas || 0) + 1);
};

export const passAcc = (t) => t.pases > 0 ? (t.completados / t.pases) : NaN;

export const precisionTiro = (t) => t.tiros > 0 ? (t.taPuerta || 0) / t.tiros : NaN;

export const conversionGol = (t) => t.tiros > 0 ? (t.goles || 0) / t.tiros : NaN;

export const combinedShot = (t) => {
    const p = precisionTiro(t), c = conversionGol(t);
    return (!isNaN(p) && !isNaN(c)) ? (p + c) / 2 : NaN;
};

export const efectRival = (t) => t.tirosRival > 0 ? t.golesEncajados / t.tirosRival : NaN;

export const computeRankingsPorEquipo = async (competitionId = null) => {
    const { getSupabaseClient } = await import('./supabase-client.js');
    const { getCurrentCompetitionId } = await import('./competitions.js');
    const supabase = await getSupabaseClient();

    // Obtener competition_id automáticamente si no se proporciona
    let finalCompetitionId = competitionId;
    if (finalCompetitionId === null) {
        try {
            finalCompetitionId = await getCurrentCompetitionId();
        } catch (e) {
            throw new Error('No se pudo obtener competition_id para team_stats_rankings. Es obligatorio.');
        }
    }

    if (finalCompetitionId === null) {
        throw new Error('competition_id es obligatorio para team_stats_rankings pero no se proporcionó ni se pudo obtener del contexto.');
    }

    // Consultar la vista team_stats_rankings directamente
    // Necesitamos hacer un join manual con league_teams porque la vista no tiene la relación
    const { data: statsData, error } = await supabase
        .from('team_stats_rankings')
        .select(`
            league_team_id,
            pj,
            pos_sum,
            pos_count,
            faltas,
            entradas,
            pases,
            completados,
            tiros,
            ta_puerta,
            goles,
            rojas,
            goles_encajados,
            tiros_rival,
            posesion_media,
            fair_play_ratio,
            precision_pase,
            precision_tiro,
            conversion_gol,
            indice_tiro_combinado,
            efectividad_defensiva
        `)
        .eq('competition_id', finalCompetitionId);

    if (error) {
        console.error('Error loading team_stats_rankings:', error);
        // Fallback al método anterior si la vista no existe
        return await computeRankingsPorEquipoLegacy(competitionId);
    }

    if (!statsData || statsData.length === 0) {
        return {
            raw: [],
            posMed: () => NaN,
            fair: () => NaN,
            passAcc: () => NaN,
            precisionTiro: () => NaN,
            conversionGol: () => NaN,
            combinedShot: () => NaN,
            efectRival: () => NaN,
            posesionTop: [],
            fairTop: [],
            passTop: [],
            shotTop: [],
            efectTop: []
        };
    }

    // Obtener nombres de equipos desde league_teams
    const teamIds = statsData.map(row => row.league_team_id).filter(id => id !== null);
    const { data: teamsData, error: teamsError } = await supabase
        .from('league_teams')
        .select('id, nickname, display_name')
        .eq('competition_id', finalCompetitionId)
        .in('id', teamIds);

    if (teamsError) {
        console.error('Error loading league_teams:', teamsError);
        // Fallback al método anterior
        return await computeRankingsPorEquipoLegacy(competitionId);
    }

    // Crear mapa de league_team_id -> nombre
    // Priorizar nickname (usuario) sobre display_name (club) para jugadores.html
    const teamMap = new Map();
    (teamsData || []).forEach(team => {
        teamMap.set(team.id, team.nickname || team.display_name || `Equipo ${team.id}`);
    });

    // Mapear datos de la vista al formato esperado
    const arr = statsData.map(row => {
        const teamName = teamMap.get(row.league_team_id) || `Equipo ${row.league_team_id}`;
        return {
            nombre: teamName,
            league_team_id: row.league_team_id,
            pj: row.pj || 0,
            // pos_sum viene en formato 0-1 desde la vista (ya normalizado)
            posSum: row.pos_sum || 0,
            posCount: row.pos_count || 0,
            faltas: row.faltas || 0,
            entradas: row.entradas || 0,
            pases: row.pases || 0,
            completados: row.completados || 0,
            tiros: row.tiros || 0,
            taPuerta: row.ta_puerta || 0,
            goles: row.goles || 0,
            rojas: row.rojas || 0,
            golesEncajados: row.goles_encajados || 0,
            tirosRival: row.tiros_rival || 0,
            // Métricas calculadas ya vienen de la vista
            _posesion_media: row.posesion_media,
            _fair_play_ratio: row.fair_play_ratio,
            _precision_pase: row.precision_pase,
            _precision_tiro: row.precision_tiro,
            _conversion_gol: row.conversion_gol,
            _indice_tiro_combinado: row.indice_tiro_combinado,
            _efectividad_defensiva: row.efectividad_defensiva
        };
    });

    // Funciones de cálculo que usan los valores de la vista si están disponibles
    const posMed = t => {
        if (t._posesion_media !== null && t._posesion_media !== undefined) {
            // La vista devuelve posesión en formato 0-1 (ya normalizado)
            return t._posesion_media;
        }
        // Si viene de la vista, posSum ya está normalizado a 0-1
        // Si viene del método legacy, posSum también está normalizado a 0-1
        if (t.posCount > 0) {
            return t.posSum / t.posCount;
        }
        return NaN;
    };

    const fairCalc = t => {
        if (t._fair_play_ratio !== null && t._fair_play_ratio !== undefined) {
            return t._fair_play_ratio;
        }
        return fair(t);
    };

    const passAccCalc = t => {
        if (t._precision_pase !== null && t._precision_pase !== undefined) {
            return t._precision_pase;
        }
        return passAcc(t);
    };

    const precisionTiroCalc = t => {
        if (t._precision_tiro !== null && t._precision_tiro !== undefined) {
            return t._precision_tiro;
        }
        return precisionTiro(t);
    };

    const conversionGolCalc = t => {
        if (t._conversion_gol !== null && t._conversion_gol !== undefined) {
            return t._conversion_gol;
        }
        return conversionGol(t);
    };

    const combinedShotCalc = t => {
        if (t._indice_tiro_combinado !== null && t._indice_tiro_combinado !== undefined) {
            return t._indice_tiro_combinado;
        }
        return combinedShot(t);
    };

    const efectRivalCalc = t => {
        if (t._efectividad_defensiva !== null && t._efectividad_defensiva !== undefined) {
            return t._efectividad_defensiva;
        }
        return efectRival(t);
    };

    const posesionTop = arr.filter(t => !isNaN(posMed(t))).sort((a, b) => posMed(b) - posMed(a));
    const fairTop = arr.slice().sort((a, b) => fairCalc(b) - fairCalc(a));
    const passTop = arr.filter(t => !isNaN(passAccCalc(t))).sort((a, b) => passAccCalc(b) - passAccCalc(a));
    const shotTop = arr.filter(t => !isNaN(combinedShotCalc(t))).sort((a, b) => combinedShotCalc(b) - combinedShotCalc(a));
    const efectTop = arr.filter(t => !isNaN(efectRivalCalc(t))).sort((a, b) => efectRivalCalc(a) - efectRivalCalc(b));

    return {
        raw: arr,
        posMed,
        fair: fairCalc,
        passAcc: passAccCalc,
        precisionTiro: precisionTiroCalc,
        conversionGol: conversionGolCalc,
        combinedShot: combinedShotCalc,
        efectRival: efectRivalCalc,
        posesionTop,
        fairTop,
        passTop,
        shotTop,
        efectTop
    };
};

// Método legacy como fallback si la vista no existe
const computeRankingsPorEquipoLegacy = async (competitionId = null) => {
    const statsIndex = await getStatsIndex(competitionId);

    const agg = new Map();
    const teamAgg = (name) => {
        if (!agg.has(name)) agg.set(name, {
            nombre: name,
            pj: 0,
            posSum: 0, posCount: 0,
            faltas: 0, entradas: 0, pases: 0, completados: 0,
            tiros: 0, taPuerta: 0, goles: 0,
            rojas: 0,
            golesEncajados: 0,
            tirosRival: 0
        });
        return agg.get(name);
    };

    for (const matchId of Object.keys(statsIndex)) {
        const porEquipo = statsIndex[matchId] || {};
        // Filtrar claves que empiezan con _team_id_ para evitar duplicados
        const equiposPartido = Object.keys(porEquipo).filter(key => !key.startsWith('_team_id_'));

        for (const eqName of equiposPartido) {
            const te = porEquipo[eqName] || {};
            const a = teamAgg(eqName);

            const hasAny = [
                "posesion", "faltas", "entradas", "pases", "pases_completados",
                "tiros", "tiros_a_puerta", "goles", "expulsiones", "rojas", "tarjetas_rojas"
            ].some(k => te[k] !== undefined);

            if (hasAny) a.pj++;

            const pos = parsePct01(te.posesion);
            if (pos !== null) { a.posSum += pos; a.posCount++; }

            addNum(a, "faltas", te.faltas);
            addNum(a, "entradas", te.entradas);
            addNum(a, "pases", te.pases);
            addNum(a, "completados", te.pases_completados);
            addNum(a, "tiros", te.tiros);
            addNum(a, "taPuerta", te.tiros_a_puerta);
            addNum(a, "goles", te.goles);
            addNum(a, "rojas", te.expulsiones ?? te.rojas ?? te.tarjetas_rojas);

            const rivalName = equiposPartido.find(n => n !== eqName);
            if (rivalName) {
                const rivalStats = porEquipo[rivalName] || {};
                addNum(a, "golesEncajados", rivalStats.goles);
                addNum(a, "tirosRival", rivalStats.tiros_a_puerta);
            }
        }
    }

    const arr = Array.from(agg.values());

    const posMed = t => t.posCount > 0 ? (t.posSum / t.posCount) : NaN;

    const posesionTop = arr.filter(t => !isNaN(posMed(t))).sort((a, b) => posMed(b) - posMed(a));
    const fairTop = arr.slice().sort((a, b) => fair(b) - fair(a));
    const passTop = arr.filter(t => !isNaN(passAcc(t))).sort((a, b) => passAcc(b) - passAcc(a));
    const shotTop = arr.filter(t => !isNaN(combinedShot(t))).sort((a, b) => combinedShot(b) - combinedShot(a));
    const efectTop = arr.filter(t => !isNaN(efectRival(t))).sort((a, b) => efectRival(a) - efectRival(b));

    return {
        raw: arr,
        posMed,
        fair,
        passAcc,
        precisionTiro,
        conversionGol,
        combinedShot,
        efectRival,
        posesionTop,
        fairTop,
        passTop,
        shotTop,
        efectTop
    };
};

// Versión asíncrona que usa SQL cuando es posible
export const computePichichiPlayersAsync = async (competitionId = null) => {
    try {
        const { getSupabaseClient } = await import('./supabase-client.js');
        const { getCurrentCompetitionId } = await import('./competitions.js');
        const supabase = await getSupabaseClient();

        // Obtener competition_id automáticamente si no se proporciona
        let finalCompetitionId = competitionId;
        if (finalCompetitionId === null) {
            try {
                finalCompetitionId = await getCurrentCompetitionId();
            } catch (e) {
                // Fallback: usar getPichichiRows y procesar en JS
                const rows = await getPichichiRows(competitionId);
                return computePichichiPlayers(rows);
            }
        }

        if (finalCompetitionId === null) {
            const rows = await getPichichiRows(competitionId);
            return computePichichiPlayers(rows);
        }

        // Llamar a la función SQL
        const params = {
            p_competition_id: finalCompetitionId,
            p_limit: 1000 // Obtener hasta 1000 (suficiente para todos los casos)
        };
        console.log('[computePichichiPlayersAsync] Llamando get_pichichi_ordered con parámetros:', params);
        
        const { data, error } = await supabase.rpc('get_pichichi_ordered', params);

        if (error) {
            console.error('[computePichichiPlayersAsync] Error obteniendo pichichi ordenado desde SQL:', {
                error,
                code: error?.code,
                message: error?.message,
                details: error?.details,
                hint: error?.hint,
                params
            });
            const rows = await getPichichiRows(competitionId);
            return computePichichiPlayers(rows);
        }
        
        console.log('[computePichichiPlayersAsync] Datos recibidos desde SQL:', data?.length || 0, 'registros');

        if (!data || data.length === 0) {
            return [];
        }

        // Mapear datos al formato esperado
        return data.map(row => ({
            jugador: row.jugador || '',
            equipo: row.manager || '',
            pj: parseInt(row.partidos || 0),
            goles: parseInt(row.goles || 0)
        }));

    } catch (err) {
        console.warn('Error usando SQL para computePichichiPlayers, usando fallback:', err);
        const rows = await getPichichiRows(competitionId);
        return computePichichiPlayers(rows);
    }
};

// Versión síncrona original (mantener para compatibilidad)
export const computePichichiPlayers = (rows) => {
    const fullData = (rows || []).map(r => ({
        jugador: r["Jugador"] || "",
        equipo: r["Equipo"] || "",
        pj: toNum(r["Partidos"]),
        goles: toNum(r["Goles"])
    }))
        .filter(r => r.jugador && r.equipo && r.pj > 0);

    fullData.sort((a, b) => {
        // 1. Primero por goles totales (pichichi clásico)
        if (b.goles !== a.goles) return b.goles - a.goles;

        // 2. Desempate por goles por partido (promedio)
        const ag = a.pj > 0 ? a.goles / a.pj : 0;
        const bg = b.pj > 0 ? b.goles / b.pj : 0;
        if (bg !== ag) return bg - ag;

        // 3. Finalmente alfabético
        return a.jugador.localeCompare(b.jugador, "es", { sensitivity: "base" });
    });

    return fullData;
};

// --------------------------
// MVP por jornada + temporada
// --------------------------

// ranking normalizado 0..1 por métrica
const rankMetric = (teams, valueFn, { highIsBetter }) => {
    const list = teams
        .map(t => ({ t, v: valueFn(t) }))
        .filter(x => Number.isFinite(x.v));
    const map = Object.create(null);
    if (list.length === 0) return map;

    list.sort((a, b) => highIsBetter ? (b.v - a.v) : (a.v - b.v));

    if (list.length === 1) {
        map[list[0].t.nombre] = 1;
        return map;
    }

    const n = list.length;
    list.forEach((x, idx) => {
        const score = (n - 1 - idx) / (n - 1); // 1º ->1, último->0
        map[x.t.nombre] = score;
    });
    return map;
};

const getScore = (map, t) => {
    const v = map[t.nombre];
    return (v === undefined) ? 0.5 : v; // neutro si no hay dato
};

export const computeMvpPorJornada = async (jornadaNumero, competitionId = null) => {
    try {
        // Intentar usar la función SQL para calcular MVP
        const { getSupabaseClient } = await import('./supabase-client.js');
        const { getCurrentCompetitionId } = await import('./competitions.js');
        const { getCacheKey, getCachedData, setCachedData } = await import('./cache-manager.js');
        const supabase = await getSupabaseClient();

        // Obtener competition_id automáticamente si no se proporciona
        let finalCompetitionId = competitionId;
        if (finalCompetitionId === null) {
            try {
                finalCompetitionId = await getCurrentCompetitionId();
            } catch (e) {
                // Fallback al método JavaScript
                return await computeMvpPorJornadaLegacy(jornadaNumero, competitionId);
            }
        }

        if (finalCompetitionId === null) {
            return await computeMvpPorJornadaLegacy(jornadaNumero, competitionId);
        }

        // Verificar caché
        const cacheKey = getCacheKey('mvp_jornada', finalCompetitionId, jornadaNumero);
        const cachedData = await getCachedData(cacheKey, 15 * 60 * 1000, finalCompetitionId); // 15 min
        
        if (cachedData !== null) {
            console.log('[computeMvpPorJornada] Datos obtenidos del caché');
            return cachedData;
        }

        // Llamar a la función SQL para calcular MVP
        const { error: calcError } = await supabase.rpc('calculate_mvp_jornada', {
            p_competition_id: finalCompetitionId,
            p_jornada: jornadaNumero
        });

        if (calcError) {
            console.warn('Error calculando MVP con función SQL, usando método legacy:', calcError);
            return await computeMvpPorJornadaLegacy(jornadaNumero, competitionId);
        }

        // Obtener los resultados calculados desde la tabla
        const { data: mvpData, error: mvpError } = await supabase
            .from('mvp_jornada')
            .select('league_team_id, mvp_score')
            .eq('competition_id', finalCompetitionId)
            .eq('jornada', jornadaNumero)
            .order('mvp_score', { ascending: false });

        if (mvpError || !mvpData || mvpData.length === 0) {
            return await computeMvpPorJornadaLegacy(jornadaNumero, competitionId);
        }

        // Obtener información de equipos
        const teamIds = mvpData.map(m => m.league_team_id);
        const { data: leagueTeams, error: teamsError } = await supabase
            .from('league_teams')
            .select('id, nickname, display_name')
            .eq('competition_id', finalCompetitionId)
            .in('id', teamIds);

        if (teamsError || !leagueTeams) {
            return await computeMvpPorJornadaLegacy(jornadaNumero, competitionId);
        }

        // Crear mapa de league_team_id -> nombre
        const teamMap = new Map();
        leagueTeams.forEach(lt => {
            teamMap.set(lt.id, lt.nickname || lt.display_name || `Equipo ${lt.id}`);
        });

        // Mapear datos al formato esperado
        const teamsJ = mvpData.map(m => ({
            nombre: teamMap.get(m.league_team_id) || `Equipo ${m.league_team_id}`,
            mvpScore: parseFloat(m.mvp_score || 0),
            pj: 0, // No disponible desde la vista, se puede calcular si es necesario
            gf: 0,
            gc: 0
        }));

        // Ordenar por mvpScore (ya viene ordenado, pero por si acaso)
        teamsJ.sort((a, b) => b.mvpScore - a.mvpScore);
        const winner = teamsJ[0] || null;

        const result = {
            jornada: jornadaNumero,
            teams: teamsJ,
            winner
        };

        // Guardar en caché
        await setCachedData(cacheKey, result, finalCompetitionId);

        return result;

    } catch (err) {
        console.warn('Error usando función SQL para MVP jornada, usando método legacy:', err);
        return await computeMvpPorJornadaLegacy(jornadaNumero, competitionId);
    }
};

// Método legacy (cálculo JavaScript) como fallback
const computeMvpPorJornadaLegacy = async (jornadaNumero, competitionId = null) => {
    const jornadas = await getResultados(competitionId);
    const statsIndex = await getStatsIndex(competitionId);
    const j = jornadas.find(x => x.numero === jornadaNumero || x.jornada === jornadaNumero) || jornadas[jornadaNumero - 1];
    if (!j) return { jornada: jornadaNumero, teams: [], winner: null };

    const partidos = j.partidos || [];
    const teamMap = new Map();

    const getT = (name) => {
        if (!teamMap.has(name)) {
            teamMap.set(name, {
                nombre: name,
                pj: 0,
                gf: 0,
                gc: 0,
                winScore: 0,

                posSum: 0, posCount: 0,
                faltas: 0, entradas: 0, pases: 0, completados: 0,
                tiros: 0, taPuerta: 0, goles: 0,
                rojas: 0,
                golesEncajados: 0,
                tirosRival: 0,
                
                // NUEVO: flag para saber si tiene stats avanzadas
                hasAdvancedStats: false
            });
        }
        return teamMap.get(name);
    };

    // Recorremos partidos de la jornada
    for (const p of partidos) {
        if (!p.local || !p.visitante) continue;

        const L = getT(p.local);
        const V = getT(p.visitante);

        const gl = isNum(p.goles_local) ? p.goles_local : null;
        const gv = isNum(p.goles_visitante) ? p.goles_visitante : null;

        if (gl !== null && gv !== null) {
            L.pj++; V.pj++;
            L.gf += gl; L.gc += gv;
            V.gf += gv; V.gc += gl;

            // victoria/empate/derrota
            if (gl > gv) L.winScore += 1;
            else if (gl < gv) V.winScore += 1;
            else { L.winScore += 0.5; V.winScore += 0.5; }
        }

        // Stats avanzadas
        const matchStats = p.id ? statsIndex[p.id] : null;
        if (matchStats) {
            const equiposPartido = Object.keys(matchStats).filter(key => !key.startsWith('_team_id_'));
            for (const eqName of equiposPartido) {
                const te = matchStats[eqName] || {};
                const a = getT(eqName);

                // NUEVO: Marcar que este equipo SÍ tiene stats avanzadas
                a.hasAdvancedStats = true;

                const pos = parsePct01(te.posesion);
                if (pos !== null) { a.posSum += pos; a.posCount++; }

                addNum(a, "faltas", te.faltas);
                addNum(a, "entradas", te.entradas);
                addNum(a, "pases", te.pases);
                addNum(a, "completados", te.pases_completados);
                addNum(a, "tiros", te.tiros);
                addNum(a, "taPuerta", te.tiros_a_puerta);
                addNum(a, "goles", te.goles);
                addNum(a, "rojas", te.expulsiones ?? te.rojas ?? te.tarjetas_rojas);

                const rivalName = equiposPartido.find(n => n !== eqName);
                if (rivalName) {
                    const rivalStats = matchStats[rivalName] || {};
                    addNum(a, "golesEncajados", rivalStats.goles);
                    addNum(a, "tirosRival", rivalStats.tiros_a_puerta);
                }
            }
        }
    }

    // NUEVO: Filtrar solo equipos con estadísticas avanzadas
    const teamsJ = Array.from(teamMap.values())
        .filter(t => t.pj > 0 && t.hasAdvancedStats);
    
    if (!teamsJ.length) return { jornada: jornadaNumero, teams: [], winner: null };

    // Rankings por métrica (esta jornada)
    const scorePichichi = rankMetric(teamsJ, t => t.gf, { highIsBetter: true });
    const scoreZamora = rankMetric(teamsJ, t => t.gc, { highIsBetter: false });
    const scoreWin = rankMetric(teamsJ, t => t.winScore, { highIsBetter: true });
    const scorePos = rankMetric(teamsJ, t => t.posCount > 0 ? (t.posSum / t.posCount) : NaN, { highIsBetter: true });
    const scorePass = rankMetric(teamsJ, t => t.pases > 0 ? (t.completados / t.pases) : NaN, { highIsBetter: true });
    const scoreFair = rankMetric(teamsJ, t => fair(t), { highIsBetter: true });
    const scoreShot = rankMetric(teamsJ, t => combinedShot(t), { highIsBetter: true });
    const scoreDef = rankMetric(teamsJ, t => efectRival(t), { highIsBetter: false });

    // Ponderación final (MVP)
    for (const t of teamsJ) {
        const sPich = getScore(scorePichichi, t);
        const sZam = getScore(scoreZamora, t);
        const sWin = getScore(scoreWin, t);
        const sPos = getScore(scorePos, t);
        const sPass = getScore(scorePass, t);
        const sFair = getScore(scoreFair, t);
        const sShot = getScore(scoreShot, t);
        const sDef = getScore(scoreDef, t);

        t.mvpScore = (
            0.20 * sPich +
            0.20 * sZam +
            0.20 * sWin +
            0.05 * sPos +
            0.05 * sPass +
            0.10 * sFair +
            0.10 * sShot +
            0.10 * sDef
        );
    }

    // Ordenar por mvpScore
    teamsJ.sort((a, b) => b.mvpScore - a.mvpScore);
    const winner = teamsJ[0];

    return {
        jornada: jornadaNumero,
        teams: teamsJ,
        winner
    };
};

export const computeMvpTemporada = async (competitionId = null) => {
    try {
        const { getSupabaseClient } = await import('./supabase-client.js');
        const { getCurrentCompetitionId } = await import('./competitions.js');
        const { getCacheKey, getCachedData, setCachedData } = await import('./cache-manager.js');
        const supabase = await getSupabaseClient();

        // Obtener competition_id automáticamente si no se proporciona
        let finalCompetitionId = competitionId;
        if (finalCompetitionId === null) {
            try {
                finalCompetitionId = await getCurrentCompetitionId();
            } catch (e) {
                // Fallback al método anterior si no se puede obtener competition_id
                return await computeMvpTemporadaLegacy(competitionId);
            }
        }

        if (finalCompetitionId === null) {
            return await computeMvpTemporadaLegacy(competitionId);
        }

        // Verificar caché
        const cacheKey = getCacheKey('mvp_temporada', finalCompetitionId);
        const cachedData = await getCachedData(cacheKey, 15 * 60 * 1000, finalCompetitionId); // 15 min
        
        if (cachedData !== null) {
            console.log('[computeMvpTemporada] Datos obtenidos del caché');
            return cachedData;
        }

        // Obtener season de la competición
        const { data: competition, error: compError } = await supabase
            .from('competitions')
            .select('season')
            .eq('id', finalCompetitionId)
            .single();

        if (compError || !competition?.season) {
            return await computeMvpTemporadaLegacy(competitionId);
        }

        // Consultar la vista mvp_temporada
        const { data: mvpData, error: mvpError } = await supabase
            .from('mvp_temporada')
            .select('league_team_id, jornadas, mvp_avg, mvp_sum')
            .eq('competition_id', finalCompetitionId)
            .eq('season', competition.season)
            .order('mvp_avg', { ascending: false });

        if (mvpError || !mvpData || mvpData.length === 0) {
            // Fallback al método anterior si no hay datos en la vista
            return await computeMvpTemporadaLegacy(competitionId);
        }

        // Obtener información de equipos y estadísticas adicionales
        const teamIds = mvpData.map(m => m.league_team_id);
        const { data: leagueTeams, error: teamsError } = await supabase
            .from('league_teams')
            .select('id, nickname, display_name')
            .eq('competition_id', finalCompetitionId)
            .in('id', teamIds);

        if (teamsError || !leagueTeams) {
            return await computeMvpTemporadaLegacy(competitionId);
        }

        // Crear mapa de league_team_id -> nombre
        const teamMap = new Map();
        leagueTeams.forEach(lt => {
            teamMap.set(lt.id, lt.nickname || lt.display_name || `Equipo ${lt.id}`);
        });

        // Obtener estadísticas adicionales (pj, gf, gc) desde clasificación
        const clasificacion = await computeClasificacion(null, { competitionId: finalCompetitionId });
        const statsMap = new Map();
        clasificacion.forEach(team => {
            const normalized = normalizeText(team.nombre);
            statsMap.set(normalized, {
                pj: team.pj || 0,
                gf: team.gf || 0,
                gc: team.gc || 0
            });
        });

        // Mapear datos de la vista al formato esperado
        const seasonArr = mvpData.map(m => {
            const teamName = teamMap.get(m.league_team_id) || `Equipo ${m.league_team_id}`;
            const normalized = normalizeText(teamName);
            const stats = statsMap.get(normalized) || { pj: 0, gf: 0, gc: 0 };

            return {
                nombre: teamName,
                jornadas: m.jornadas || 0,
                mvpSum: parseFloat(m.mvp_sum || 0),
                mvpAvg: parseFloat(m.mvp_avg || 0),
                pj: stats.pj,
                gf: stats.gf,
                gc: stats.gc
            };
        });

        // Ya está ordenado por mvp_avg DESC desde la consulta SQL
        
        // Guardar en caché (reutilizar cacheKey declarado al inicio)
        await setCachedData(cacheKey, seasonArr, finalCompetitionId);

        return seasonArr;

    } catch (err) {
        console.warn('Error usando vista SQL para MVP temporada, usando método legacy:', err);
        return await computeMvpTemporadaLegacy(competitionId);
    }
};

// Método legacy (cálculo JavaScript) como fallback
const computeMvpTemporadaLegacy = async (competitionId = null) => {
    const jornadas = await getResultados(competitionId);
    const seasonMap = new Map();

    for (const j of jornadas) {
        const jNum = j.numero ?? j.jornada;
        if (!jNum) continue;

        const { teams } = await computeMvpPorJornada(jNum, competitionId);
        if (!teams.length) continue;

        for (const t of teams) {
            let season = seasonMap.get(t.nombre);
            if (!season) {
                season = {
                    nombre: t.nombre,
                    jornadas: 0,
                    mvpSum: 0,
                    pj: 0,
                    gf: 0,
                    gc: 0
                };
                seasonMap.set(t.nombre, season);
            }
            season.jornadas += 1;
            season.mvpSum += t.mvpScore;

            season.pj += t.pj;
            season.gf += t.gf;
            season.gc += t.gc;
        }
    }

    const seasonArr = Array.from(seasonMap.values());
    seasonArr.forEach(s => {
        s.mvpAvg = s.jornadas > 0 ? s.mvpSum / s.jornadas : 0;
    });

    seasonArr.sort((a, b) =>
        (b.mvpAvg - a.mvpAvg) ||
        a.nombre.localeCompare(b.nombre, "es", { sensitivity: "base" })
    );

    return seasonArr;
};

// ==========================
// TEAM OF THE MOMENT (3 equipos)
// ==========================
export const computeTeamsFormTop = async (limit = 3, competitionId = null) => {
    try {
        // Intentar usar la función SQL
        const { getSupabaseClient } = await import('./supabase-client.js');
        const { getCurrentCompetitionId } = await import('./competitions.js');
        const supabase = await getSupabaseClient();

        // Obtener competition_id automáticamente si no se proporciona
        let finalCompetitionId = competitionId;
        if (finalCompetitionId === null) {
            try {
                finalCompetitionId = await getCurrentCompetitionId();
            } catch (e) {
                // Fallback al método legacy
                return await computeTeamsFormTopLegacy(limit);
            }
        }

        if (finalCompetitionId === null) {
            return await computeTeamsFormTopLegacy(limit);
        }

        // Llamar a la función SQL
        const params = {
            p_competition_id: finalCompetitionId,
            p_limit: limit
        };
        console.log('[computeTeamsFormTop] Llamando get_teams_form_top con parámetros:', params);
        
        const { data, error } = await supabase.rpc('get_teams_form_top', params);

        if (error) {
            console.error('[computeTeamsFormTop] Error obteniendo teams form desde SQL:', {
                error,
                code: error?.code,
                message: error?.message,
                details: error?.details,
                hint: error?.hint,
                params
            });
            return await computeTeamsFormTopLegacy(limit);
        }
        
        console.log('[computeTeamsFormTop] Datos recibidos desde SQL:', data?.length || 0, 'registros');

        if (!data || data.length === 0) {
            return [];
        }

        // Mapear datos al formato esperado
        return data.map(row => ({
            nombre: row.team_name || `Equipo ${row.league_team_id}`,
            avgScore: parseFloat(row.avg_score || 0),
            pjTotal: parseInt(row.pj_total || 0),
            lastJornada: parseInt(row.last_jornada || 0)
        }));

    } catch (err) {
        console.warn('Error usando SQL para computeTeamsFormTop, usando fallback:', err);
        return await computeTeamsFormTopLegacy(limit);
    }
};

// Método legacy (cálculo JavaScript) como fallback
const computeTeamsFormTopLegacy = async (limit = 3) => {
    const jornadas = await getResultados();
    if (!Array.isArray(jornadas) || !jornadas.length) return [];

    const porEquipo = new Map(); // nombre -> [{jornada, mvpScore, pj}]

    for (const j of jornadas) {
        const jNum = j.numero ?? j.jornada;
        if (!jNum) continue;

        const { teams } = await computeMvpPorJornada(jNum);
        for (const t of (teams || [])) {
            const arr = porEquipo.get(t.nombre) || [];
            arr.push({
                jornada: jNum,
                mvpScore: t.mvpScore || 0,
                pj: t.pj || 0
            });
            porEquipo.set(t.nombre, arr);
        }
    }

    const ranking = [];
    porEquipo.forEach((arr, name) => {
        if (!arr.length) return;
        arr.sort((a, b) => a.jornada - b.jornada);
        const last3 = arr.slice(-3);
        const n = last3.length;
        if (!n) return;

        const sumScore = last3.reduce((acc, x) => acc + (x.mvpScore || 0), 0);
        const pjTotal = last3.reduce((acc, x) => acc + (x.pj || 0), 0);
        const avgScore = sumScore / n;
        const lastJornada = last3[last3.length - 1].jornada;

        ranking.push({
            nombre: name,
            avgScore,
            pjTotal,
            lastJornada
        });
    });

    ranking.sort((a, b) =>
        (b.avgScore - a.avgScore) ||
        (b.pjTotal - a.pjTotal) ||
        (b.lastJornada - a.lastJornada) ||
        a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' })
    );

    return ranking.slice(0, limit);
};

// ==========================
// GOLEADOR DEL MOMENTO
// ==========================
import { getSupabaseClient } from './supabase-client.js';
import { slugify } from './utils.js';

export const computeGoleadorMomento = async (competitionId = null) => {
    // Requerir competitionId para funcionar
    if (competitionId === null) {
        return { error: 'Se requiere una competición seleccionada para calcular el goleador del momento.' };
    }

    try {
        // Intentar usar la función SQL
        const supabase = await getSupabaseClient();
        const { getCacheKey, getCachedData, setCachedData } = await import('./cache-manager.js');
        
        // Verificar caché
        const cacheKey = getCacheKey('goleador_momento', competitionId, 3);
        const cachedData = await getCachedData(cacheKey, 15 * 60 * 1000, competitionId); // 15 min
        
        if (cachedData !== null) {
            console.log('[computeGoleadorMomento] Datos obtenidos del caché');
            return cachedData;
        }
        
        // Llamar a la función SQL
        const params = {
            p_competition_id: competitionId,
            p_jornadas: 3
        };
        console.log('[computeGoleadorMomento] Llamando get_goleador_momento con parámetros:', params);
        
        const { data, error } = await supabase.rpc('get_goleador_momento', params);

        if (error) {
            console.error('[computeGoleadorMomento] Error obteniendo goleador del momento desde SQL:', {
                error,
                code: error?.code,
                message: error?.message,
                details: error?.details,
                hint: error?.hint,
                params
            });
            return await computeGoleadorMomentoLegacy(competitionId);
        }
        
        console.log('[computeGoleadorMomento] Datos recibidos desde SQL:', data?.length || 0, 'registros');

        if (!data || data.length === 0) {
            return { error: 'No hay goles registrados en las últimas jornadas.' };
        }

        // Obtener jornadas para el badge label
        const jornadas = data[0]?.jornadas || [];
        const jNums = Array.isArray(jornadas) ? jornadas.sort((a, b) => a - b) : [];

        const badgeLabel = (() => {
            if (!jNums.length) return 'Jornadas recientes';
            if (jNums.length === 1) return `J${jNums[0]}`;
            return `J${jNums[0]}–J${jNums[jNums.length - 1]}`;
        })();

        // Mapear datos al formato esperado
        const top5 = data.map(row => ({
            playerId: row.player_id,
            nombre: row.player_name || 'Jugador',
            equipo: row.team_name || 'Equipo',
            goles: parseInt(row.goles || 0),
            partidosTramo: parseInt(row.partidos_tramo || 1)
        }));

        const ganador = top5[0] || null;

        const result = {
            badgeLabel,
            ganador,
            top5,
            jNums
        };

        // Guardar en caché
        await setCachedData(cacheKey, result, competitionId);

        return result;

    } catch (err) {
        console.warn('Error usando SQL para computeGoleadorMomento, usando fallback:', err);
        return await computeGoleadorMomentoLegacy(competitionId);
    }
};

// Método legacy (cálculo JavaScript) como fallback
const computeGoleadorMomentoLegacy = async (competitionId) => {
    const jornadas = await getResultados(competitionId);
    if (!Array.isArray(jornadas) || !jornadas.length) {
        return { error: 'No hay jornadas todavía.' };
    }

    // 1) Buscar la última jornada con al menos un partido jugado
    let lastIndex = -1;
    for (let i = jornadas.length - 1; i >= 0; i--) {
        const j = jornadas[i];
        const partidos = j.partidos || [];
        const hasPlayed = partidos.some(p =>
            isNum(p.goles_local) && isNum(p.goles_visitante)
        );
        if (hasPlayed) {
            lastIndex = i;
            break;
        }
    }

    if (lastIndex === -1) {
        return { error: 'Todavía no hay jornadas con partidos jugados.' };
    }

    // 2) Cogemos esa jornada y las dos anteriores (si existen)
    const startIndex = Math.max(0, lastIndex - 2);
    const selectedJornadas = jornadas.slice(startIndex, lastIndex + 1);

    // Para el label (Jx–Jy)
    const jNums = selectedJornadas
        .map(j => j.numero ?? j.jornada)
        .filter(n => n != null)
        .sort((a, b) => a - b);

    const badgeLabel = (() => {
        if (!jNums.length) return 'Jornadas recientes';
        if (jNums.length === 1) return `J${jNums[0]}`;
        return `J${jNums[0]}–J${jNums[jNums.length - 1]}`;
    })();

    // 3) Sacar todos los match_id de partidos jugados en esas jornadas
    const matchIds = [];
    for (const j of selectedJornadas) {
        for (const p of (j.partidos || [])) {
            if (!isNum(p.goles_local) || !isNum(p.goles_visitante)) continue;
            if (!p.id) continue; // p.id viene de matches.id
            matchIds.push(p.id);
        }
    }

    if (!matchIds.length) {
        return { error: 'No hay partidos disputados en las últimas jornadas.' };
    }

    // 4) Leer goal_events de esos partidos, filtrando por competición y excluyendo administrativos
    const supabase = await getSupabaseClient();
    const q = supabase
        .from('goal_events')
        .select(`
      match_id,
      event_type,
      player:players (
        id,
        name
      ),
      team:league_teams (
        id,
        nickname,
        display_name
      ),
      match:matches!inner (
        competition_id,
        resolved_administratively
      )
    `)
        .in('match_id', matchIds)
        .eq('event_type', 'goal')
        .eq('match.competition_id', competitionId);

    const { data, error } = await q;
    if (error) {
        console.error('Error goal_events:', error);
        return { error: 'Error al leer los eventos de gol.' };
    }

    // 🔴 Filtrar partidos administrativos DESPUÉS del query
    const eventos = (data || []).filter(ev => {
        const isAdminResolved = ev.match?.resolved_administratively === true;
        return !isAdminResolved;
    });
    
    if (!eventos.length) {
        return { error: 'No hay goles registrados en las jornadas seleccionadas.' };
    }

    // 5) Agregar goles por jugador + nº de partidos (match_id distintos) en los que marca
    const byPlayer = new Map();
    for (const ev of eventos) {
        const player = ev.player;
        if (!player || !player.id) continue;

        const pid = player.id;
        let rec = byPlayer.get(pid);
        if (!rec) {
            const team = ev.team || {};
            const teamName =
                team.nickname ||
                team.display_name ||
                'Equipo';

            rec = {
                playerId: pid,
                nombre: player.name || 'Jugador',
                equipo: teamName,
                goles: 0,
                matchSet: new Set()   // partidos en los que ha marcado
            };
            byPlayer.set(pid, rec);
        }
        rec.goles += 1;
        if (ev.match_id) {
            rec.matchSet.add(ev.match_id);
        }
    }

    let lista = Array.from(byPlayer.values());
    if (!lista.length) {
        return { error: 'No hay jugadores con goles registrados en las jornadas seleccionadas.' };
    }

    // Calculamos partidos del tramo (partidos con gol) para desempatar
    lista = lista.map(p => ({
        ...p,
        partidosTramo: p.matchSet.size || 1 // mínimo 1 para evitar 0
    }));

    // 6) Ordenar:
    //   1) más goles
    //   2) a igualdad de goles, MENOS partidos en el tramo
    //   3) nombre alfabético
    lista.sort((a, b) =>
        (b.goles - a.goles) ||
        (a.partidosTramo - b.partidosTramo) ||
        a.nombre.localeCompare(b.nombre, 'es', { sensitivity: 'base' })
    );

    const ganador = lista[0];
    const top5 = lista.slice(0, 5);

    return {
        badgeLabel,
        ganador,
        top5,
        jNums
    };
};

/**
 * Compute matches history for a team up to a specific jornada
 * @param {Object[]} jornadas - Array of all matches
 * @param {number} hasta - limit jornada
 * @param {string} teamName 
 * @returns {Array} List of matches with result context
 */
export function computePartidosEquipo(jornadas, hasta, teamName) {
    const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
    const matches = [];
    for (let i = 0; i < hasta; i++) {
        const j = jornadas[i];
        if (!j) continue;
        for (const p of (j.partidos || [])) {
            if (!p.local || !p.visitante) continue;
            const gl = isNum(p.goles_local) ? p.goles_local : null;
            const gv = isNum(p.goles_visitante) ? p.goles_visitante : null;
            if (gl === null || gv === null) continue;

            if (p.local === teamName || p.visitante === teamName) {
                const isLocal = p.local === teamName;
                const gf = isLocal ? gl : gv;
                const gc = isLocal ? gv : gl;
                let result = 'E';
                if (gf > gc) result = 'V';
                else if (gf < gc) result = 'D';

                matches.push({
                    jornada: i + 1,
                    local: p.local,
                    visitante: p.visitante,
                    gl,
                    gv,
                    gf,
                    gc,
                    isLocal,
                    result
                });
            }
        }
    }
    return matches;
}

/**
 * Compute position history for a team
 * @param {number} hasta - limit jornada
 * @param {string} teamName 
 * @param {number|null} competitionId - ID de competición (opcional)
 * @returns {Promise<Array>} List of {jornada, pos, pts}
 */
export async function computePosicionesEquipo(hasta, teamName, competitionId = null) {
    // Verificar si es competición de tipo 'league' y usar SQL
    if (competitionId) {
        try {
            const { getSupabaseClient } = await import('./supabase-client.js');
            const { getCompetitionById } = await import('./competition-data.js');
            const { getResultados } = await import('./stats-data.js');
            const supabase = await getSupabaseClient();
            
            const competition = await getCompetitionById(competitionId);
            if (competition?.competition_type === 'league' && supabase) {
                // Usar función SQL para cada jornada
                const history = [];
                
                // Obtener league_team_id del equipo
                const { data: teamData } = await supabase
                    .from('league_teams')
                    .select('id, nickname, display_name')
                    .eq('competition_id', competitionId)
                    .or(`nickname.eq.${teamName},display_name.eq.${teamName}`)
                    .maybeSingle();
                
                if (teamData) {
                    // Obtener jornadas para calcular H2H
                    const jornadas = await getResultados(competitionId);
                    
                    // Para cada jornada, obtener clasificación desde SQL
                    for (let jNum = 1; jNum <= hasta; jNum++) {
                        const { data: standings, error } = await supabase.rpc(
                            'get_league_standings_until_jornada',
                            { 
                                p_competition_id: competitionId, 
                                p_jornada: jNum 
                            }
                        );
                        
                        if (error) {
                            console.error(`Error obteniendo clasificación para jornada ${jNum}:`, error);
                            console.error('Parámetros enviados:', { 
                                p_competition_id: competitionId, 
                                p_jornada: jNum 
                            });
                            // Si falla, usar fallback para esta jornada
                            continue;
                        }
                        
                        if (standings && standings.length > 0) {
                            // Calcular H2H para esta jornada (necesario para ordenación correcta)
                            const h2h = {};
                            const addH2H = (A, B, gfA, gfB) => {
                                const a = normalizeText(A), b = normalizeText(B);
                                (h2h[a] ||= {});
                                (h2h[a][b] ||= { gf: 0, gc: 0 });
                                h2h[a][b].gf += gfA;
                                h2h[a][b].gc += gfB;
                            };
                            
                            // Calcular H2H desde partidos hasta esta jornada
                            const limit = Math.max(0, Math.min(jNum, jornadas.length));
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
                            
                            // Obtener nombres de equipos desde league_teams
                            const teamIds = standings.map(s => s.league_team_id).filter(Boolean);
                            const { data: teamsData } = await supabase
                                .from('league_teams')
                                .select('id, nickname, display_name')
                                .in('id', teamIds)
                                .eq('competition_id', competitionId);
                            
                            const teamMap = new Map();
                            (teamsData || []).forEach(team => {
                                teamMap.set(team.id, team.nickname || team.display_name || `Equipo ${team.id}`);
                            });
                            
                            // Mapear standings a formato con nombres
                            const equipos = standings.map(row => {
                                const teamNameFromId = teamMap.get(row.league_team_id) || `Equipo ${row.league_team_id}`;
                                return {
                                    nombre: teamNameFromId,
                                    league_team_id: row.league_team_id,
                                    pj: row.pj || 0,
                                    g: row.g || 0,
                                    e: row.e || 0,
                                    p: row.p || 0,
                                    gf: row.gf || 0,
                                    gc: row.gc || 0,
                                    pts: row.pts || 0,
                                    goal_difference: row.goal_difference || 0
                                };
                            });
                            
                            // Ordenar con H2H (misma lógica que computeClasificacion)
                            equipos.sort((A, B) => {
                                // 1. Puntos
                                if (B.pts !== A.pts) return B.pts - A.pts;
                                
                                // 2. H2H
                                const a = normalizeText(A.nombre), b = normalizeText(B.nombre);
                                const ha = h2h[a]?.[b], hb = h2h[b]?.[a];
                                if (ha && hb) {
                                    const difA = (ha.gf || 0) - (ha.gc || 0);
                                    const difB = (hb.gf || 0) - (hb.gc || 0);
                                    if (difA !== difB) return difB - difA;
                                }
                                
                                // 3. Diferencia de goles
                                if (B.goal_difference !== A.goal_difference) 
                                    return B.goal_difference - A.goal_difference;
                                
                                // 4. Goles a favor
                                if (B.gf !== A.gf) return B.gf - A.gf;
                                
                                // 5. Alfabético
                                return A.nombre.localeCompare(B.nombre, "es", { sensitivity: "base" });
                            });
                            
                            // Buscar el equipo en la clasificación ordenada
                            const idx = equipos.findIndex(e => e.league_team_id === teamData.id);
                            if (idx !== -1) {
                                history.push({
                                    jornada: jNum,
                                    pos: idx + 1,
                                    pts: equipos[idx].pts
                                });
                            }
                        }
                    }
                    
                    return history;
                }
            }
        } catch (err) {
            console.warn('Error usando SQL para computePosicionesEquipo, usando fallback:', err);
        }
    }
    
    // Fallback: método original
    // Obtener type_config de la competición si competitionId está disponible
    let typeConfig = null;
    if (competitionId) {
        try {
            const { getCompetitionById } = await import('./competition-data.js');
            const competition = await getCompetitionById(competitionId);
            typeConfig = competition?.type_config || null;
        } catch (e) {
            console.debug('No se pudo obtener type_config para computePosicionesEquipo:', e);
        }
    }

    const history = [];
    for (let jNum = 1; jNum <= hasta; jNum++) {
        const tabla = await computeClasificacion(jNum, { 
            competitionId,
            typeConfig
        });
        const idx = tabla.findIndex(e => e.nombre === teamName);
        if (idx === -1) continue;
        history.push({
            jornada: jNum,
            pos: idx + 1,
            pts: tabla[idx].pts
        });
    }
    return history;
}

