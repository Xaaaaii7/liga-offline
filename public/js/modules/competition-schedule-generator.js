/**
 * Módulo para generar calendarios de competiciones
 * Soporta: Liga, Copa, Mixto
 * 
 * IMPORTANTE: No modifica la lógica existente de resultados.html
 * Solo genera los partidos en la base de datos
 */

import { getSupabaseClient } from './supabase-client.js';
import { calculateGroupStandings } from './competition-standings.js';
import { assignRefereesForCompetition } from './referee-assigner.js';

/**
 * Genera el calendario completo de una competición según su tipo
 * @param {number} competitionId - ID de la competición
 * @param {Object} competitionData - Datos de la competición
 * @param {Array<number>} teamIds - Array de league_team_ids que participan
 * @param {Object} [options] - Opciones del calendario
 * @param {string} [options.startDate] - YYYY-MM-DD, inicio de la jornada 1 (solo
 *   se aplica a `league` y a la fase de grupos de `mixed`; cada jornada
 *   posterior se programa en una ventana de 10 días)
 * @returns {Promise<{success: boolean, matchesCreated?: number, error?: string}>}
 */
export async function generateCompetitionSchedule(competitionId, competitionData, teamIds, options = {}) {
    if (!competitionId || !competitionData || !teamIds || teamIds.length === 0) {
        return { success: false, error: 'Datos incompletos para generar calendario' };
    }

    const type = competitionData.competition_type;

    try {
        let result;
        switch (type) {
            case 'league':
                result = await generateLeagueSchedule(competitionId, competitionData, teamIds, options);
                break;
            case 'cup':
                result = await generateCupSchedule(competitionId, competitionData, teamIds);
                break;
            case 'mixed':
                result = await generateMixedSchedule(competitionId, competitionData, teamIds, options);
                break;
            default:
                return { success: false, error: `Tipo de competición no soportado: ${type}` };
        }

        // Asignación automática de árbitros (solo 2026-27 en adelante; idempotente).
        // No bloqueamos el resultado del calendario si falla.
        if (result?.success) {
            try {
                await assignRefereesForCompetition(competitionId);
            } catch (refErr) {
                console.error('Error asignando árbitros (no bloqueante):', refErr);
            }
        }

        return result;
    } catch (error) {
        console.error('Error generando calendario:', error);
        return { success: false, error: `Error generando calendario: ${error.message}` };
    }
}

/**
 * Genera calendario para Liga
 * @param {number} competitionId
 * @param {Object} competitionData
 * @param {Array<number>} teamIds
 * @param {Object} [options]
 * @param {string} [options.startDate] - YYYY-MM-DD para asignar fechas (jornada N
 *   se programa en startDate + (N-1)*10 días, priorizando domingo/lunes)
 * @returns {Promise<{success: boolean, matchesCreated?: number, error?: string}>}
 */
async function generateLeagueSchedule(competitionId, competitionData, teamIds, options = {}) {
    const format = competitionData.type_config?.format || 'double_round';
    const season = competitionData.season;
    const numTeams = teamIds.length;

    if (numTeams < 2) {
        return { success: false, error: 'Se necesitan al menos 2 equipos para una liga' };
    }

    // Formato "champions" (Liga Epidor & similares): 24 equipos en 4 bombos de 6.
    // Delegado en epidor-schedule.js — no usa el round-robin clásico.
    if (format === 'champions') {
        return await generateChampionsSchedule(competitionId, competitionData, teamIds, options);
    }

    // Formato "champions5" (Liga Epidor 25 & similares): 25 equipos en 5 bombos de 5.
    // Delegado en epidor25-schedule.js — paralelo a "champions" pero con 8 jornadas.
    if (format === 'champions5') {
        return await generateChampions5Schedule(competitionId, competitionData, teamIds, options);
    }

    const { pairings, legRounds } = buildRoundRobinPairings(teamIds, format);
    const matches = pairings.map(p => ({
        competition_id: competitionId,
        season: season,
        round_id: p.round_id,
        round_type: 'league',
        home_league_team_id: p.home_league_team_id,
        away_league_team_id: p.away_league_team_id,
        home_goals: null,
        away_goals: null
    }));

    // Romper el patrón del algoritmo del círculo: aleatorizar el orden de las
    // jornadas. Se hace por vuelta de forma independiente para que la ida siga
    // jugándose antes que la vuelta y, además, el espejo fijo R(i)↔R(i+N) del
    // double_round quede destruido.
    if (format === 'single_round') {
        remapRoundsRandomly(matches, 1, legRounds);
    } else {
        remapRoundsRandomly(matches, 1, legRounds);
        remapRoundsRandomly(matches, legRounds + 1, legRounds * 2);
    }

    // Asignar fechas: jornada N → ventana de 10 días desde startDate + (N-1)*10,
    // priorizando domingo/lunes; hora fija 21:00.
    assignDatesToMatches(matches, options.startDate);

    // Insertar partidos en la base de datos
    return await insertMatches(matches);
}

/**
 * Genera calendario formato "Champions": 24 equipos en 4 bombos de 6, 5 jornadas
 * de 12 partidos. Cada team juega 3 cross-bombo + 2 own-bombo (oponentes distintos).
 *
 * El orden de `teamIds` define la composición de bombos: posiciones 0-5 → B1,
 * 6-11 → B2, 12-17 → B3, 18-23 → B4.
 */
async function generateChampionsSchedule(competitionId, competitionData, teamIds, options = {}) {
    if (teamIds.length !== 24) {
        return { success: false, error: `Formato Champions requiere exactamente 24 equipos (recibidos ${teamIds.length}).` };
    }

    // Particionar en 4 bombos de 6 según orden
    const pots = [
        teamIds.slice(0, 6),
        teamIds.slice(6, 12),
        teamIds.slice(12, 18),
        teamIds.slice(18, 24),
    ];

    const seed = options.seed != null ? Number(options.seed) : Math.floor(Math.random() * 2 ** 32);

    const { generateEpidorLeagueSchedule } = await import('./epidor-schedule.js');
    let result;
    try {
        result = generateEpidorLeagueSchedule(pots, seed);
    } catch (e) {
        return { success: false, error: `Error generando calendario Champions: ${e.message}` };
    }

    const season = competitionData.season;

    // Crear (o reusar) las 5 filas de `rounds` para esta competición — matches.round_id
    // tiene FK a rounds(id), así que sin estas rows fallan los INSERT.
    const supabase = await getSupabaseClient();
    const NUM_J = 5;
    const { data: existingRounds, error: rErr } = await supabase
        .from('rounds')
        .select('id, number')
        .eq('competition_id', competitionId)
        .order('number', { ascending: true });
    if (rErr) {
        return { success: false, error: `Error consultando rounds: ${rErr.message}` };
    }
    const roundsByNumber = new Map((existingRounds || []).map(r => [r.number, r.id]));

    const toInsert = [];
    for (let n = 1; n <= NUM_J; n++) {
        if (!roundsByNumber.has(n)) {
            toInsert.push({
                competition_id: competitionId,
                season,
                number: n,
                name: `Jornada ${n}`,
            });
        }
    }
    if (toInsert.length) {
        const { data: created, error: insertErr } = await supabase
            .from('rounds')
            .insert(toInsert)
            .select('id, number');
        if (insertErr) {
            return { success: false, error: `Error creando rounds: ${insertErr.message}` };
        }
        for (const r of created || []) roundsByNumber.set(r.number, r.id);
    }

    const matches = result.matches.map(m => ({
        competition_id: competitionId,
        season,
        round_id: roundsByNumber.get(m.jornada),
        round_type: 'league',
        home_league_team_id: m.home_team_id,
        away_league_team_id: m.away_team_id,
        home_goals: null,
        away_goals: null,
    }));

    assignDatesToMatches(matches, options.startDate);
    return await insertMatches(matches);
}

/**
 * Genera calendario formato "Champions5": 25 equipos en 5 bombos de 5, 8 jornadas
 * (5 cross + 3 own), 75 partidos. Cada team juega 6 partidos: 4 cross (1 vs cada
 * otro bombo) + 2 own (5-ciclo dentro del propio bombo).
 *
 * El orden de `teamIds` define la composición de bombos: posiciones 0-4 → B1,
 * 5-9 → B2, 10-14 → B3, 15-19 → B4, 20-24 → B5.
 */
async function generateChampions5Schedule(competitionId, competitionData, teamIds, options = {}) {
    if (teamIds.length !== 25) {
        return { success: false, error: `Formato Champions5 requiere exactamente 25 equipos (recibidos ${teamIds.length}).` };
    }

    // Particionar en 5 bombos de 5 según orden
    const pots = [
        teamIds.slice(0, 5),
        teamIds.slice(5, 10),
        teamIds.slice(10, 15),
        teamIds.slice(15, 20),
        teamIds.slice(20, 25),
    ];

    const seed = options.seed != null ? Number(options.seed) : Math.floor(Math.random() * 2 ** 32);

    const { generateEpidor25LeagueSchedule } = await import('./epidor25-schedule.js');
    let result;
    try {
        result = generateEpidor25LeagueSchedule(pots, seed);
    } catch (e) {
        return { success: false, error: `Error generando calendario Champions5: ${e.message}` };
    }

    const season = competitionData.season;

    // Crear (o reusar) las 8 filas de `rounds` para esta competición — matches.round_id
    // tiene FK a rounds(id), así que sin estas rows fallan los INSERT.
    const supabase = await getSupabaseClient();
    const NUM_J = 8;
    const { data: existingRounds, error: rErr } = await supabase
        .from('rounds')
        .select('id, number')
        .eq('competition_id', competitionId)
        .order('number', { ascending: true });
    if (rErr) {
        return { success: false, error: `Error consultando rounds: ${rErr.message}` };
    }
    const roundsByNumber = new Map((existingRounds || []).map(r => [r.number, r.id]));

    const toInsert = [];
    for (let n = 1; n <= NUM_J; n++) {
        if (!roundsByNumber.has(n)) {
            toInsert.push({
                competition_id: competitionId,
                season,
                number: n,
                name: `Jornada ${n}`,
            });
        }
    }
    if (toInsert.length) {
        const { data: created, error: insertErr } = await supabase
            .from('rounds')
            .insert(toInsert)
            .select('id, number');
        if (insertErr) {
            return { success: false, error: `Error creando rounds: ${insertErr.message}` };
        }
        for (const r of created || []) roundsByNumber.set(r.number, r.id);
    }

    const matches = result.matches.map(m => ({
        competition_id: competitionId,
        season,
        round_id: roundsByNumber.get(m.jornada),
        round_type: 'league',
        home_league_team_id: m.home_team_id,
        away_league_team_id: m.away_team_id,
        home_goals: null,
        away_goals: null,
    }));

    assignDatesToMatches(matches, options.startDate);
    return await insertMatches(matches);
}

/**
 * Calcula la estructura completa del bracket de una copa
 * @param {number} numTeams - Número de equipos
 * @param {boolean} isDoubleElim - Si es doble eliminación
 * @returns {Object} Estructura del bracket con rondas y partidos
 */
export function calculateBracketStructure(numTeams, isDoubleElim) {
    const nextPowerOf2 = Math.pow(2, Math.ceil(Math.log2(numTeams)));
    const teamsWithBye = nextPowerOf2 - numTeams;
    
    const winnerRounds = [];
    const loserRounds = [];
    let currentRound = 1;
    let teamsInRound = nextPowerOf2;
    
    // Calcular rondas del winner bracket
    while (teamsInRound > 1) {
        // En la primera ronda, solo generar partidos para los equipos que juegan
        // (sin contar los byes)
        const matchesInRound = currentRound === 1 
            ? (numTeams - teamsWithBye) / 2  // Primera ronda: solo equipos que juegan
            : teamsInRound / 2;  // Rondas siguientes: normal
        
        const matches = [];
        
        for (let i = 0; i < matchesInRound; i++) {
            const matchId = `J${currentRound}-P${i + 1}-winner`;
            matches.push({
                id: matchId,
                homeIndex: i * 2,
                awayIndex: i * 2 + 1,
                bracketType: 'winner',
                leg: null, // Se asignará según formato
                winnerTarget: null, // Se asignará después
                loserTarget: null // Se asignará si es doble eliminación
            });
        }
        
        winnerRounds.push({
            cupRound: currentRound,
            isFirstRound: currentRound === 1,
            matches: matches,
            teamsInRound: teamsInRound,
            teamsWithBye: currentRound === 1 ? teamsWithBye : 0
        });
        
        // Para la siguiente ronda: ganadores de esta ronda + byes
        teamsInRound = currentRound === 1
            ? matchesInRound + teamsWithBye  // R1: ganadores + byes
            : matchesInRound;  // Rondas siguientes: solo ganadores
        currentRound++;
    }
    
    // Si es doble eliminación, calcular loser bracket
    // Secuencia (ej. 16): LB R1 entrada WB, R2 entrada WB, R3 interna, R4 entrada WB, R5 final (sin entrada).
    // WB R1 → LB R1, WB R2 → LB R2, WB R3 → LB R4. Con 8 equipos (W=3) solo R1 y R2 reciben del WB.
    if (isDoubleElim) {
        const W = winnerRounds.length;
        const lbEntryFromWbRound = W >= 4 ? [0, 1, 3] : [0, 1];
        const numLbRounds = W >= 4 ? 5 : 4;

        for (let lbIdx = 0; lbIdx < numLbRounds; lbIdx++) {
            const lbRoundNum = lbIdx + 1;
            let numMatches;
            const wbRoundForEntry = lbEntryFromWbRound.indexOf(lbIdx);

            if (wbRoundForEntry >= 0 && wbRoundForEntry < W) {
                const wbLosers = winnerRounds[wbRoundForEntry].matches.length;
                if (wbRoundForEntry === 0) {
                    numMatches = wbLosers / 2;
                } else {
                    numMatches = wbLosers;
                }
            } else {
                if (lbIdx === 0) continue;
                if (lbIdx === 2 && loserRounds.length >= 2) {
                    numMatches = (loserRounds[0].matches.length + loserRounds[1].matches.length) / 2;
                } else {
                    const prevMatches = loserRounds[lbIdx - 1].matches.length;
                    numMatches = Math.max(1, Math.floor(prevMatches / 2));
                }
            }

            const matches = [];
            for (let j = 0; j < numMatches; j++) {
                matches.push({
                    id: `L${lbRoundNum}-P${j + 1}`,
                    homeIndex: null,
                    awayIndex: null,
                    bracketType: 'loser',
                    leg: null,
                    winnerTarget: null,
                    loserTarget: null
                });
            }
            loserRounds.push({
                cupRound: lbRoundNum,
                isFirstRound: lbIdx === 0,
                matches,
                teamsInRound: numMatches * 2,
                teamsWithBye: 0
            });
        }
    }
    
    // Combinar rondas: primero winner, luego loser (si aplica)
    const allRounds = [...winnerRounds];
    if (isDoubleElim) {
        allRounds.push(...loserRounds);
    }
    
    // Asignar targets (ganadores avanzan a siguiente ronda)
    for (let i = 0; i < winnerRounds.length - 1; i++) {
        const currentRoundMatches = winnerRounds[i].matches;
        const nextRoundMatches = winnerRounds[i + 1].matches;
        
        for (let j = 0; j < currentRoundMatches.length; j++) {
            const match = currentRoundMatches[j];
            const targetMatchIndex = Math.floor(j / 2);
            
            if (targetMatchIndex < nextRoundMatches.length) {
                const targetMatch = nextRoundMatches[targetMatchIndex];
                match.winnerTarget = {
                    matchId: targetMatch.id,
                    position: j % 2 === 0 ? 'home' : 'away',
                    bracketType: 'winner'
                };
            }
            
            // Si es doble eliminación: WB R1→LB R1, WB R2→LB R2, WB R3→LB R4 (R5 final sin entrada)
            if (isDoubleElim && loserRounds && loserRounds.length > 0) {
                const targetLoserRoundIndex = i === 2 ? 3 : i;
                if (targetLoserRoundIndex >= 0 && targetLoserRoundIndex < loserRounds.length) {
                    const loserRound = loserRounds[targetLoserRoundIndex];
                    if (loserRound?.matches?.length) {
                        const isLbR2 = targetLoserRoundIndex === 1;
                        const loserMatchIndex = isLbR2 ? j : Math.floor(j / 2);
                        const loserPosition = isLbR2 ? 'away' : (j % 2 === 0 ? 'home' : 'away');
                        if (loserMatchIndex < loserRound.matches.length && loserRound.matches[loserMatchIndex]?.id) {
                            match.loserTarget = {
                                matchId: loserRound.matches[loserMatchIndex].id,
                                position: loserPosition,
                                bracketType: 'loser'
                            };
                        }
                    }
                }
            }
        }
    }
    
    // Cuando hay byes en R1, el winnerTarget por defecto (Math.floor(j/2)) no
    // respeta el bracket estándar: agrupa partidos de R1 consecutivos en el
    // mismo R2, y deja los slots bye-vs-bye sin entrada. Reasignar siguiendo
    // getR2SlotMap, que sí respeta getStandardBracketPairs.
    if (teamsWithBye > 0 && winnerRounds.length >= 2) {
        const slotMap = getR2SlotMap(nextPowerOf2, numTeams);
        const r1Round = winnerRounds[0];
        const r2Round = winnerRounds[1];

        for (let k = 0; k < r1Round.matches.length; k++) {
            for (let m = 0; m < slotMap.length; m++) {
                const slot = slotMap[m];
                if (slot.home && slot.home.type === 'r1Winner' && slot.home.r1Idx === k) {
                    r1Round.matches[k].winnerTarget = {
                        matchId: r2Round.matches[m].id,
                        position: 'home',
                        bracketType: 'winner'
                    };
                    break;
                }
                if (slot.away && slot.away.type === 'r1Winner' && slot.away.r1Idx === k) {
                    r1Round.matches[k].winnerTarget = {
                        matchId: r2Round.matches[m].id,
                        position: 'away',
                        bracketType: 'winner'
                    };
                    break;
                }
            }
        }
    }

    // Asignar targets en el loser bracket (ganadores avanzan a la siguiente ronda)
    if (isDoubleElim) {
        for (let i = 0; i < loserRounds.length - 1; i++) {
            const currentRoundMatches = loserRounds[i].matches;
            const nextRoundMatches = loserRounds[i + 1].matches;

            for (let j = 0; j < currentRoundMatches.length; j++) {
                const match = currentRoundMatches[j];
                const isR1ToR2 = i === 0;
                const isR3ToR4 = i === 2;
                const targetMatchIndex = (isR1ToR2 || isR3ToR4) ? j : Math.floor(j / 2);
                const position = (isR1ToR2 || isR3ToR4) ? 'home' : (j % 2 === 0 ? 'home' : 'away');

                if (targetMatchIndex < nextRoundMatches.length) {
                    const targetMatch = nextRoundMatches[targetMatchIndex];
                    match.winnerTarget = {
                        matchId: targetMatch.id,
                        position,
                        bracketType: 'loser'
                    };
                }
            }
        }
    }
    
    return { rounds: allRounds, winnerRounds, loserRounds, teamsWithBye, nextPowerOf2 };
}

/**
 * Emparejamientos de primera ronda con seeding balanceado estándar (1 vs N, etc.)
 * Semillas en 1-based. Para 16: (1,16), (8,9), (5,12), (4,13), (3,14), (6,11), (7,10), (2,15).
 * @param {number} n - Potencia de 2 (4, 8, 16 o 32)
 * @returns {Array<[number, number]>} Array de [seedA, seedB] por partido
 */
export function getStandardBracketPairs(n) {
    const pairs = {
        4: [[1, 4], [2, 3]],
        8: [[1, 8], [4, 5], [2, 7], [3, 6]],
        16: [[1, 16], [8, 9], [5, 12], [4, 13], [3, 14], [6, 11], [7, 10], [2, 15]],
        32: [[1, 32], [16, 17], [8, 25], [9, 24], [4, 29], [13, 20], [3, 30], [14, 19], [6, 27], [11, 22], [7, 26], [10, 23], [2, 31], [15, 18], [5, 28], [12, 21]]
    };
    return pairs[n] || [];
}

/**
 * Primera ronda balanceada para copa: byes (seeds 1..teamsWithBye) y pares de partidos.
 * Orden de inscripción = seed (teamIds[0]=Seed 1). Aplica cuando N no es potencia de 2.
 * @param {number} nextPowerOf2 - Tamaño de bracket (potencia de 2)
 * @param {number} numParticipants - Número real de equipos
 * @returns {{ byeIndices: number[], pairIndices: Array<[number, number]> }} Índices 0-based en teamIds
 */
export function getBalancedFirstRoundForCup(nextPowerOf2, numParticipants) {
    const teamsWithBye = nextPowerOf2 - numParticipants;
    const allPairs = getStandardBracketPairs(nextPowerOf2);
    const byeIndices = [];
    for (let s = 0; s < teamsWithBye; s++) {
        byeIndices.push(s);
    }
    const playingMin = teamsWithBye + 1;
    const playingMax = nextPowerOf2;
    const pairIndices = allPairs
        .filter(([a, b]) => a >= playingMin && a <= playingMax && b >= playingMin && b <= playingMax)
        .map(([a, b]) => [a - 1, b - 1]);
    return { byeIndices, pairIndices };
}

/**
 * Mapea cada slot de los partidos de R2 a su origen: o un seed con bye
 * (placement directo) o el ganador de un partido de R1 (vía `match_relations`).
 * El orden de `pairIndices` de `getBalancedFirstRoundForCup` define el índice
 * de R1 (`r1Idx`) que aparece aquí.
 *
 * @param {number} nextPowerOf2 - Tamaño de bracket (potencia de 2)
 * @param {number} numParticipants - Número real de equipos
 * @returns {Array<{home: ?{type:'bye'|'r1Winner', seedIdx?:number, r1Idx?:number},
 *                  away: ?{type:'bye'|'r1Winner', seedIdx?:number, r1Idx?:number}}>}
 *          Array de longitud nextPowerOf2/2 (un entry por partido de R2).
 */
export function getR2SlotMap(nextPowerOf2, numParticipants) {
    const allPairs = getStandardBracketPairs(nextPowerOf2);
    // Cada par de allPairs (= un partido de R1 del bracket completo) ocupa un
    // slot de R2. Hay 2 slots por partido de R2, así que R2 tiene
    // nextPowerOf2 / 4 partidos.
    const numR2Matches = nextPowerOf2 / 4;
    const slots = Array.from({ length: numR2Matches }, () => ({ home: null, away: null }));

    let r1Idx = 0;
    for (let pairIdx = 0; pairIdx < allPairs.length; pairIdx++) {
        const [a, b] = allPairs[pairIdx];
        const r2MatchIdx = Math.floor(pairIdx / 2);
        const position = pairIdx % 2 === 0 ? 'home' : 'away';

        const aExists = a <= numParticipants;
        const bExists = b <= numParticipants;

        if (aExists && bExists) {
            slots[r2MatchIdx][position] = { type: 'r1Winner', r1Idx };
            r1Idx++;
        } else if (aExists) {
            slots[r2MatchIdx][position] = { type: 'bye', seedIdx: a - 1 };
        } else if (bExists) {
            slots[r2MatchIdx][position] = { type: 'bye', seedIdx: b - 1 };
        }
    }

    return slots;
}

/**
 * Distribuye equipos entre los que juegan la primera ronda y los que tienen bye.
 * Para copas (useSeededOrder=true): no mezcla; orden de teamIds = seeds 1..N.
 * @param {Array<number>} teamIds - IDs de todos los equipos (orden = orden de inscripción = seed)
 * @param {Object} bracketStructure - Estructura del bracket
 * @param {boolean} useSeededOrder - Si true (copas), no mezclar y respetar seed por orden
 * @returns {Object} Objeto con playingTeams, byeTeams y opcionalmente balancedData para R1
 */
export function distributeTeams(teamIds, bracketStructure, useSeededOrder = false) {
    const { teamsWithBye, nextPowerOf2 } = bracketStructure;
    const numParticipants = teamIds.length;

    if (useSeededOrder && nextPowerOf2) {
        const balanced = getBalancedFirstRoundForCup(nextPowerOf2, numParticipants);
        const byeTeams = balanced.byeIndices.map((i) => teamIds[i]);
        const playingTeams = teamIds.filter((_, idx) => !balanced.byeIndices.includes(idx));
        return { playingTeams, byeTeams, balancedFirstRound: balanced };
    }

    const shuffledTeams = [...teamIds];
    shuffleArray(shuffledTeams);
    const byeTeams = shuffledTeams.slice(0, teamsWithBye);
    const playingTeams = shuffledTeams.slice(teamsWithBye);
    return { playingTeams, byeTeams, balancedFirstRound: null };
}

/**
 * Calcula el round_id correcto según el tipo de competición.
 * Para mixed se pasa `roundIdOffset` con el último round_id de la fase de
 * grupos, así las jornadas de cup no chocan con las de grupos.
 * @param {number} cupRound - Número de ronda de copa (1=octavos, 2=cuartos, etc.)
 * @param {string|null} cupLeg - Pierna del partido ('first', 'second', 'final', null)
 * @param {string|null} bracketType - Tipo de bracket ('winner', 'loser', null)
 * @param {string} format - Formato de la copa ('single_match', 'double_match_except_final')
 * @param {boolean} isDoubleElim - Si es doble eliminación
 * @param {number} [roundIdOffset=0] - Offset a sumar al round_id resultante
 * @returns {number} round_id calculado
 */
export function calculateRoundId(cupRound, cupLeg, bracketType, format, isDoubleElim, roundIdOffset = 0) {
    let baseId;
    if (isDoubleElim) {
        // Doble eliminación: separar por bracket
        const bracketOffset = bracketType === 'winner' ? 1 : 2;
        if (format === 'double_match_except_final') {
            // Doble partido: ida y vuelta
            // 4 jornadas por ronda: ida winner, vuelta winner, ida loser, vuelta loser
            const baseRound = (cupRound - 1) * 4;
            if (cupLeg === 'first') {
                baseId = baseRound + bracketOffset;
            } else if (cupLeg === 'second') {
                baseId = baseRound + bracketOffset + 2;
            } else {
                // Final: solo una jornada por bracket
                baseId = baseRound + bracketOffset;
            }
        } else {
            // Partido único: 2 jornadas por ronda (winner y loser)
            baseId = (cupRound - 1) * 2 + bracketOffset;
        }
    } else {
        // Eliminación simple
        if (format === 'double_match_except_final') {
            // Doble partido: ida y vuelta
            if (cupLeg === 'first') {
                baseId = cupRound * 2 - 1;
            } else if (cupLeg === 'second') {
                baseId = cupRound * 2;
            } else {
                // Final: solo una jornada
                baseId = cupRound * 2 - 1;
            }
        } else {
            // Partido único: una jornada por ronda
            baseId = cupRound;
        }
    }
    return baseId + roundIdOffset;
}

/**
 * Genera calendario para Copa (eliminatoria)
 * Genera TODOS los partidos al inicio con relaciones explícitas
 * @param {number} competitionId
 * @param {Object} competitionData
 * @param {Array<number>} teamIds
 * @returns {Promise<{success: boolean, matchesCreated?: number, error?: string}>}
 */
async function generateCupSchedule(competitionId, competitionData, teamIds, roundIdOffset = 0) {
    const format = competitionData.type_config?.format || 'single_match';
    const season = competitionData.season;
    const numTeams = teamIds.length;
    const isDoubleElim = competitionData.type_config?.is_double_elimination || false;

    if (numTeams < 2) {
        return { success: false, error: 'Se necesitan al menos 2 equipos para una copa' };
    }

    // 1. Calcular estructura completa del bracket
    const bracketStructure = calculateBracketStructure(numTeams, isDoubleElim);
    const nextPowerOf2 = bracketStructure.nextPowerOf2;
    const teamsWithBye = bracketStructure.teamsWithBye;

    // 2. Distribuir equipos: copas usan seeding por orden de inscripción (sin mezclar)
    const { playingTeams, byeTeams, balancedFirstRound } = distributeTeams(
        teamIds,
        { ...bracketStructure, nextPowerOf2, rounds: bracketStructure.winnerRounds || bracketStructure.rounds },
        true
    );

    // Map de slots de R2: indica para cada partido de R2 qué seed (bye) ocupa
    // home/away, o si es un slot que se llena con el ganador de un R1.
    const r2SlotMap = teamsWithBye > 0 ? getR2SlotMap(nextPowerOf2, numTeams) : null;

    // 3. Generar todos los partidos
    const allMatches = [];
    const relations = [];
    
    // Primero generar partidos del winner bracket
    const winnerRounds = bracketStructure.winnerRounds || bracketStructure.rounds;
    for (const round of winnerRounds) {
        const isFinal = round.cupRound === winnerRounds.length;
        const isSecondRound = round.cupRound === 2;

        for (let matchIdx = 0; matchIdx < round.matches.length; matchIdx++) {
            const match = round.matches[matchIdx];
            let homeTeamId = null;
            let awayTeamId = null;

            if (round.isFirstRound && balancedFirstRound && balancedFirstRound.pairIndices[matchIdx]) {
                const [homeSeedIdx, awaySeedIdx] = balancedFirstRound.pairIndices[matchIdx];
                homeTeamId = teamIds[homeSeedIdx] ?? null;
                awayTeamId = teamIds[awaySeedIdx] ?? null;
            } else if (round.isFirstRound) {
                homeTeamId = playingTeams[match.homeIndex] ?? null;
                awayTeamId = playingTeams[match.awayIndex] ?? null;
            } else if (isSecondRound && r2SlotMap) {
                // Segunda ronda con byes: r2SlotMap indica qué seeds van en home/away.
                // Cuando hay más byes que partidos de R1, algunos slots de R2 son
                // bye-vs-bye (predeterminados); los slots r1Winner se llenan vía relaciones.
                const slot = r2SlotMap[matchIdx];
                if (slot?.home?.type === 'bye') {
                    homeTeamId = teamIds[slot.home.seedIdx] ?? null;
                }
                if (slot?.away?.type === 'bye') {
                    awayTeamId = teamIds[slot.away.seedIdx] ?? null;
                }
            }
            // Rondas 3+: todos null, se llenan via relaciones
            
            // Determinar cup_leg según formato
            let cupLeg = null;
            if (format === 'double_match_except_final' && !isFinal) {
                // Para doble partido, necesitamos crear dos partidos (ida y vuelta)
                // Por ahora, creamos el de ida aquí y el de vuelta después
                cupLeg = 'first';
            } else if (isFinal) {
                cupLeg = 'final';
            }
            
            // Calcular round_id
            const roundId = calculateRoundId(
                round.cupRound,
                cupLeg,
                match.bracketType,
                format,
                isDoubleElim,
                roundIdOffset
            );

            // Crear partido de ida (si es doble partido) o único
            if (format === 'double_match_except_final' && !isFinal) {
                // Partido de ida
                const matchIdIda = `${match.id}-ida`;
                allMatches.push({
                    id: matchIdIda,
                    competition_id: competitionId,
                    season: season,
                    round_id: roundId,
                    round_type: 'cup',
                    cup_round: round.cupRound,
                    cup_leg: 'first',
                    bracket_type: match.bracketType,
                    is_cup_final: false,
                    is_third_place_match: false,
                    home_league_team_id: homeTeamId,
                    away_league_team_id: awayTeamId,
                    home_goals: null,
                    away_goals: null
                });

                // Partido de vuelta
                const matchIdVuelta = `${match.id}-vuelta`;
                allMatches.push({
                    id: matchIdVuelta,
                    competition_id: competitionId,
                    season: season,
                    round_id: roundId + 1, // Vuelta tiene round_id siguiente
                    round_type: 'cup',
                    cup_round: round.cupRound,
                    cup_leg: 'second',
                    bracket_type: match.bracketType,
                    is_cup_final: false,
                    is_third_place_match: false,
                    home_league_team_id: awayTeamId, // Invertir equipos en vuelta
                    away_league_team_id: homeTeamId,
                    home_goals: null,
                    away_goals: null
                });
                
                // Crear relación a nivel de ronda (doble partido)
                // Para doble partido, la relación es a nivel de ronda, no de partido individual
                if (match.winnerTarget) {
                    // Buscar el round destino en winnerRounds o loserRounds
                    const targetRounds = match.winnerTarget.bracketType === 'loser' 
                        ? bracketStructure.loserRounds 
                        : bracketStructure.winnerRounds || bracketStructure.rounds;
                    const targetRound = targetRounds?.find(r => 
                        r.matches.some(m => m.id === match.winnerTarget.matchId)
                    );
                    const totalRounds = targetRounds?.length || bracketStructure.rounds.length;
                    const targetIsDouble = targetRound && 
                        targetRound.cupRound < totalRounds && 
                        format === 'double_match_except_final';
                    
                    // El target_match_id debe ser el partido de ida del destino (si es doble partido)
                    const targetMatchId = targetIsDouble 
                        ? `${match.winnerTarget.matchId}-ida`
                        : match.winnerTarget.matchId;
                    
                    relations.push({
                        source_match_id: null,
                        source_cup_round: round.cupRound,
                        source_bracket_type: match.bracketType,
                        target_match_id: targetMatchId,
                        position: match.winnerTarget.position,
                        condition: 'winner',
                        bracket_type: match.winnerTarget.bracketType,
                        is_round_relation: true
                    });
                }
                
                if (match.loserTarget && isDoubleElim) {
                    const targetRounds = match.loserTarget.bracketType === 'loser' 
                        ? bracketStructure.loserRounds 
                        : bracketStructure.winnerRounds || bracketStructure.rounds;
                    const targetRound = targetRounds?.find(r => 
                        r.matches.some(m => m.id === match.loserTarget.matchId)
                    );
                    const totalRounds = targetRounds?.length || bracketStructure.rounds.length;
                    const targetIsDouble = targetRound && 
                        targetRound.cupRound < totalRounds && 
                        format === 'double_match_except_final';
                    
                    const targetMatchId = targetIsDouble 
                        ? `${match.loserTarget.matchId}-ida`
                        : match.loserTarget.matchId;
                    
                    relations.push({
                        source_match_id: null,
                        source_cup_round: round.cupRound,
                        source_bracket_type: match.bracketType,
                        target_match_id: targetMatchId,
                        position: match.loserTarget.position,
                        condition: 'loser',
                        bracket_type: match.loserTarget.bracketType,
                        is_round_relation: true
                    });
                }
            } else {
                // Partido único
                allMatches.push({
                    id: match.id,
                    competition_id: competitionId,
                    season: season,
                    round_id: roundId,
                    round_type: 'cup',
                    cup_round: round.cupRound,
                    cup_leg: cupLeg,
                    bracket_type: match.bracketType,
                    is_cup_final: isFinal,
                    is_third_place_match: false,
                    home_league_team_id: homeTeamId,
                    away_league_team_id: awayTeamId,
                    home_goals: null,
                    away_goals: null
                });

                // Crear relación a nivel de partido (partido único)
                if (match.winnerTarget) {
                    // Buscar el round destino en winnerRounds o loserRounds
                    const targetRounds = match.winnerTarget.bracketType === 'loser' 
                        ? bracketStructure.loserRounds 
                        : bracketStructure.winnerRounds || bracketStructure.rounds;
                    const targetRound = targetRounds?.find(r => 
                        r.matches.some(m => m.id === match.winnerTarget.matchId)
                    );
                    const totalRounds = targetRounds?.length || bracketStructure.rounds.length;
                    const targetIsDouble = targetRound && 
                        targetRound.cupRound < totalRounds && 
                        format === 'double_match_except_final';
                    
                    const targetMatchId = targetIsDouble 
                        ? `${match.winnerTarget.matchId}-ida`
                        : match.winnerTarget.matchId;
                    
                    relations.push({
                        source_match_id: match.id,
                        source_cup_round: null,
                        source_bracket_type: null,
                        target_match_id: targetMatchId,
                        position: match.winnerTarget.position,
                        condition: 'winner',
                        bracket_type: match.winnerTarget.bracketType,
                        is_round_relation: false
                    });
                }
                
                if (match.loserTarget && isDoubleElim) {
                    const targetRounds = match.loserTarget.bracketType === 'loser' 
                        ? bracketStructure.loserRounds 
                        : bracketStructure.winnerRounds || bracketStructure.rounds;
                    const targetRound = targetRounds?.find(r => 
                        r.matches.some(m => m.id === match.loserTarget.matchId)
                    );
                    const totalRounds = targetRounds?.length || bracketStructure.rounds.length;
                    const targetIsDouble = targetRound && 
                        targetRound.cupRound < totalRounds && 
                        format === 'double_match_except_final';
                    
                    const targetMatchId = targetIsDouble 
                        ? `${match.loserTarget.matchId}-ida`
                        : match.loserTarget.matchId;
                    
                    relations.push({
                        source_match_id: match.id,
                        source_cup_round: null,
                        source_bracket_type: null,
                        target_match_id: targetMatchId,
                        position: match.loserTarget.position,
                        condition: 'loser',
                        bracket_type: match.loserTarget.bracketType,
                        is_round_relation: false
                    });
                }
            }
        }
    }
    
    // Generar partidos del loser bracket (si es doble eliminación)
    if (isDoubleElim && bracketStructure.loserRounds && bracketStructure.loserRounds.length > 0) {
        for (const round of bracketStructure.loserRounds) {
            const isFinal = round.cupRound === bracketStructure.loserRounds.length;
            
            for (const match of round.matches) {
                // Los partidos del loser bracket siempre tienen equipos en NULL inicialmente
                // Se llenarán automáticamente con las relaciones
                let homeTeamId = null;
                let awayTeamId = null;
                
                // Determinar cup_leg según formato
                let cupLeg = null;
                if (format === 'double_match_except_final' && !isFinal) {
                    cupLeg = 'first';
                }
                
                // Calcular round_id
                const roundId = calculateRoundId(
                    round.cupRound,
                    cupLeg,
                    'loser',
                    format,
                    isDoubleElim,
                    roundIdOffset
                );
                
                if (format === 'double_match_except_final' && !isFinal) {
                    // Partido de ida
                    const matchIdIda = `${match.id}-ida`;
                    allMatches.push({
                        id: matchIdIda,
                        competition_id: competitionId,
                        season: season,
                        round_id: roundId,
                        round_type: 'cup',
                        cup_round: round.cupRound,
                        cup_leg: 'first',
                        bracket_type: 'loser',
                        is_cup_final: false,
                        is_third_place_match: false,
                        home_league_team_id: homeTeamId,
                        away_league_team_id: awayTeamId,
                        home_goals: null,
                        away_goals: null
                    });

                    // Partido de vuelta
                    const matchIdVuelta = `${match.id}-vuelta`;
                    allMatches.push({
                        id: matchIdVuelta,
                        competition_id: competitionId,
                        season: season,
                        round_id: roundId + 1,
                        round_type: 'cup',
                        cup_round: round.cupRound,
                        cup_leg: 'second',
                        bracket_type: 'loser',
                        is_cup_final: false,
                        is_third_place_match: false,
                        home_league_team_id: awayTeamId,
                        away_league_team_id: homeTeamId,
                        home_goals: null,
                        away_goals: null
                    });
                    
                    // Crear relación a nivel de ronda
                    if (match.winnerTarget) {
                        const targetRounds = bracketStructure.loserRounds;
                        const targetRound = targetRounds?.find(r => 
                            r.matches.some(m => m.id === match.winnerTarget.matchId)
                        );
                        const totalRounds = targetRounds?.length || 0;
                        const targetIsDouble = targetRound && 
                            targetRound.cupRound < totalRounds && 
                            format === 'double_match_except_final';
                        
                        const targetMatchId = targetIsDouble 
                            ? `${match.winnerTarget.matchId}-ida`
                            : match.winnerTarget.matchId;
                        
                        relations.push({
                            source_match_id: null,
                            source_cup_round: round.cupRound,
                            source_bracket_type: 'loser',
                            target_match_id: targetMatchId,
                            position: match.winnerTarget.position,
                            condition: 'winner',
                            bracket_type: 'loser',
                            is_round_relation: true
                        });
                    }
                } else {
                    // Partido único (final del LB = partido por 3º y 4º puesto)
                    const isLoserBracketFinal = round.cupRound === bracketStructure.loserRounds.length;
                    allMatches.push({
                        id: match.id,
                        competition_id: competitionId,
                        season: season,
                        round_id: roundId,
                        round_type: 'cup',
                        cup_round: round.cupRound,
                        cup_leg: cupLeg,
                        bracket_type: 'loser',
                        is_cup_final: false,
                        is_third_place_match: isLoserBracketFinal,
                        home_league_team_id: homeTeamId,
                        away_league_team_id: awayTeamId,
                        home_goals: null,
                        away_goals: null
                    });

                    // Crear relación a nivel de partido
                    if (match.winnerTarget) {
                        relations.push({
                            source_match_id: match.id,
                            source_cup_round: null,
                            source_bracket_type: null,
                            target_match_id: match.winnerTarget.matchId,
                            position: match.winnerTarget.position,
                            condition: 'winner',
                            bracket_type: 'loser',
                            is_round_relation: false
                        });
                    }
                }
            }
        }
    }

    // 4. Insertar todos los partidos
    const result = await insertMatches(allMatches);
    
    if (!result.success) {
        return result;
    }
    
    // 5. Obtener match_uuid de los partidos insertados para las relaciones
    // Usar los partidos que ya devolvió insertMatches, o buscar si no están disponibles
    const supabase = await getSupabaseClient();
    let matchUuidMap = new Map();
    
    if (result.insertedMatches && result.insertedMatches.length > 0) {
        // Usar los partidos que ya devolvió insertMatches
        result.insertedMatches.forEach(m => {
            matchUuidMap.set(m.id, m.match_uuid);
        });
    } else {
        // Si no están disponibles, buscarlos
        const matchIds = allMatches.map(m => m.id);
        const { data: insertedMatches, error: fetchError } = await supabase
            .from('matches')
            .select('id, match_uuid')
            .eq('competition_id', competitionId)
            .in('id', matchIds);
        
        if (fetchError) {
            console.warn('Error obteniendo match_uuid:', fetchError);
            return { success: false, error: `Error obteniendo match_uuid: ${fetchError.message}` };
        }
        
        if (insertedMatches) {
            insertedMatches.forEach(m => {
                matchUuidMap.set(m.id, m.match_uuid);
            });
        }
    }
    
    // 6. Actualizar relaciones con match_uuid
    const relationsWithUuid = relations.map(rel => {
        const relation = { ...rel };
        
        // Para source_match_uuid
        if (relation.source_match_id) {
            relation.source_match_uuid = matchUuidMap.get(relation.source_match_id) || null;
        }
        
        // Para target_match_uuid
        if (relation.target_match_id) {
            relation.target_match_uuid = matchUuidMap.get(relation.target_match_id);
            if (!relation.target_match_uuid) {
                console.warn(`No se encontró match_uuid para target_match_id: ${relation.target_match_id}`);
            }
        }
        
        return relation;
    });
    
    // 7. Insertar relaciones (winner/loser)
    if (relationsWithUuid.length > 0) {
        const relationsResult = await insertMatchRelations(relationsWithUuid);
        if (!relationsResult.success) {
            console.warn('Error insertando relaciones:', relationsResult.error);
        }
    }
    
    if (byeTeams.length > 0) {
        result.message = `${result.message}. ${byeTeams.length} equipo${byeTeams.length > 1 ? 's' : ''} ${byeTeams.length > 1 ? 'tienen' : 'tiene'} bye y ${byeTeams.length > 1 ? 'pasan' : 'pasa'} automáticamente a la siguiente ronda.`;
    }
    
    return result;
}


/**
 * Genera calendario para Mixto (grupos + eliminatoria)
 * @param {number} competitionId
 * @param {Object} competitionData
 * @param {Array<number>} teamIds
 * @returns {Promise<{success: boolean, matchesCreated?: number, error?: string}>}
 */
async function generateMixedSchedule(competitionId, competitionData, teamIds, options = {}) {
    const numGroups = competitionData.type_config?.num_groups || 2;
    const teamsPerGroup = competitionData.type_config?.teams_per_group || 4;
    const season = competitionData.season;
    const leagueFormat = competitionData.type_config?.group_phase_format || 'single_round';
    const cupFormat = competitionData.type_config?.knockout_format || 'single_match';
    const numTeams = teamIds.length;

    if (numTeams < numGroups * 2) {
        return { success: false, error: `Se necesitan al menos ${numGroups * 2} equipos para ${numGroups} grupos` };
    }

    if (numTeams > numGroups * teamsPerGroup) {
        return { success: false, error: `Hay ${numTeams} equipos pero la capacidad configurada es ${numGroups} grupos × ${teamsPerGroup} = ${numGroups * teamsPerGroup}` };
    }

    // Distribución round-robin por bombos: el orden recibido (del modal de seeding)
    // codifica los bombos. El equipo en posición i va al grupo i % numGroups, así
    // un bombo (cada bloque de numGroups posiciones consecutivas) reparte un equipo
    // por grupo. Para tamaños desiguales (numTeams < numGroups × teamsPerGroup) el
    // último bombo queda incompleto y los grupos finales tendrán un equipo menos.
    const groups = Array.from({ length: numGroups }, () => []);
    for (let i = 0; i < numTeams; i++) {
        const groupIdx = i % numGroups;
        groups[groupIdx].push(teamIds[i]);
    }

    const allMatches = [];

    // FASE DE GRUPOS: Generar partidos para cada grupo usando round-robin.
    // Para tamaño impar añadimos un "equipo fantasma" (null): el algoritmo estándar
    // de rotación se ejecuta sobre tamaño par y los partidos contra el fantasma se
    // descartan — el equipo emparejado con el fantasma esa jornada descansa.
    for (let g = 0; g < groups.length; g++) {
        const groupTeams = groups[g];
        const groupName = `Grupo ${String.fromCharCode(65 + g)}`; // A, B, C, D...
        const realSize = groupTeams.length;
        const isOdd = realSize % 2 === 1;
        const teams = isOdd ? [...groupTeams, null] : [...groupTeams];
        const workingSize = teams.length;
        const numRounds = workingSize - 1;
        const matchesPerRound = workingSize / 2;

        const generateLeg = (legOffset) => {
            for (let round = 1; round <= numRounds; round++) {
                for (let i = 0; i < matchesPerRound; i++) {
                    const home = teams[i];
                    const away = teams[workingSize - 1 - i];

                    // Si alguno es el fantasma, ese par representa el descanso del otro.
                    if (home === null || away === null) continue;

                    allMatches.push({
                        competition_id: competitionId,
                        season: season,
                        round_id: round + legOffset,
                        round_type: 'group',
                        group_name: groupName,
                        home_league_team_id: home,
                        away_league_team_id: away,
                        home_goals: null,
                        away_goals: null
                    });
                }

                // Rotar equipos (excepto el primero)
                const last = teams.pop();
                teams.splice(1, 0, last);
            }
        };

        if (leagueFormat === 'single_round') {
            generateLeg(0);
        } else {
            // Double round: primera vuelta con la rotación estándar...
            generateLeg(0);

            // ...y segunda vuelta invirtiendo local/visitante de los partidos generados.
            const firstRoundMatches = allMatches.filter(m => m.group_name === groupName);
            firstRoundMatches.forEach(match => {
                allMatches.push({
                    competition_id: competitionId,
                    season: season,
                    round_id: match.round_id + numRounds,
                    round_type: 'group',
                    group_name: groupName,
                    home_league_team_id: match.away_league_team_id,
                    away_league_team_id: match.home_league_team_id,
                    home_goals: null,
                    away_goals: null
                });
            });
        }
    }

    // FASE ELIMINATORIA: Se generará cuando se conozcan los clasificados
    // Por ahora, creamos la estructura básica
    // Nota: Los partidos de eliminatoria se crearán dinámicamente cuando se completen los grupos

    // Romper el patrón del round-robin aleatorizando el orden de jornadas. La
    // misma permutación se aplica a todos los grupos (un mismo round_id =
    // misma jornada del calendario), independiente por vuelta ida/vuelta.
    const maxRound = allMatches.reduce((m, x) => Math.max(m, x.round_id || 0), 0);
    if (leagueFormat === 'single_round') {
        remapRoundsRandomly(allMatches, 1, maxRound);
    } else {
        const legRounds = Math.floor(maxRound / 2);
        if (legRounds >= 1) {
            remapRoundsRandomly(allMatches, 1, legRounds);
            remapRoundsRandomly(allMatches, legRounds + 1, maxRound);
        }
    }

    // Asignar fechas a la fase de grupos (la eliminatoria se generará después
    // y heredará las fechas en su propia fase, partido a partido).
    assignDatesToMatches(allMatches, options.startDate);

    // Insertar partidos de grupos
    const result = await insertMatches(allMatches);

    // Guardar información de grupos en config para uso futuro
    if (result.success) {
        await saveGroupsConfig(competitionId, groups, competitionData.config || {});
    }

    return result;
}

/**
 * Estado de los grupos de una competición mixta para decidir si se puede
 * sembrar el bracket de eliminatoria.
 *
 * @param {number} competitionId
 * @returns {Promise<{
 *   ready: boolean,
 *   reason: string|null,
 *   pendingGroupMatches: number,
 *   hasCupMatches: boolean,
 *   competition: Object|null
 * }>}
 */
export async function getMixedBracketStatus(competitionId) {
    const supabase = await getSupabaseClient();

    const { data: competition, error: compError } = await supabase
        .from('competitions')
        .select('id, competition_type, season, config, type_config')
        .eq('id', competitionId)
        .single();

    if (compError || !competition) {
        return { ready: false, reason: 'No se pudo cargar la competición', pendingGroupMatches: 0, hasCupMatches: false, competition: null };
    }

    if (competition.competition_type !== 'mixed') {
        return { ready: false, reason: 'No es una competición mixta', pendingGroupMatches: 0, hasCupMatches: false, competition };
    }

    const { count: pendingCount, error: pendingError } = await supabase
        .from('matches')
        .select('id', { count: 'exact', head: true })
        .eq('competition_id', competitionId)
        .eq('round_type', 'group')
        .or('home_goals.is.null,away_goals.is.null');

    if (pendingError) {
        return { ready: false, reason: 'Error consultando partidos de grupos', pendingGroupMatches: 0, hasCupMatches: false, competition };
    }

    const { count: groupTotal } = await supabase
        .from('matches')
        .select('id', { count: 'exact', head: true })
        .eq('competition_id', competitionId)
        .eq('round_type', 'group');

    const { count: cupCount } = await supabase
        .from('matches')
        .select('id', { count: 'exact', head: true })
        .eq('competition_id', competitionId)
        .eq('round_type', 'cup');

    const hasCupMatches = (cupCount || 0) > 0;
    const pendingGroupMatches = pendingCount || 0;

    if (groupTotal === 0) {
        return { ready: false, reason: 'No hay partidos de grupos generados', pendingGroupMatches: 0, hasCupMatches, competition };
    }

    if (hasCupMatches) {
        return { ready: false, reason: 'El bracket ya está sembrado', pendingGroupMatches, hasCupMatches, competition };
    }

    if (pendingGroupMatches > 0) {
        return { ready: false, reason: `Faltan ${pendingGroupMatches} partidos de grupos por jugar`, pendingGroupMatches, hasCupMatches, competition };
    }

    return { ready: true, reason: null, pendingGroupMatches: 0, hasCupMatches: false, competition };
}

/**
 * Calcula la lista de equipos clasificados a la eliminatoria de una mixta,
 * en orden de seeding válido para `generateCupSchedule`. El orden devuelto
 * agrupa primero por posición en el grupo y dentro de cada posición ordena
 * por letra de grupo:
 *
 *   [1ºA, 1ºB, 1ºC, 1ºD, 2ºA, 2ºB, 2ºC, 2ºD, ...]
 *
 * Combinado con el seeding clásico de copa (seed 1 vs seed N, etc.) eso
 * produce los cruces estándar 1ºA-2ºD, 1ºD-2ºA, 1ºB-2ºC, 1ºC-2ºB.
 *
 * @param {number} competitionId
 * @returns {Promise<{
 *   success: boolean,
 *   error?: string,
 *   qualifierIds?: number[],
 *   maxGroupRoundId?: number,
 *   competition?: Object,
 *   mergedConfig?: Object
 * }>}
 */
export async function getMixedQualifiers(competitionId) {
    const supabase = await getSupabaseClient();

    const { data: competition, error: compError } = await supabase
        .from('competitions')
        .select('id, competition_type, season, config, type_config')
        .eq('id', competitionId)
        .single();

    if (compError || !competition) {
        return { success: false, error: 'No se pudo cargar la competición' };
    }

    if (competition.competition_type !== 'mixed') {
        return { success: false, error: 'La competición no es mixta' };
    }

    const mergedConfig = { ...(competition.config || {}), ...(competition.type_config || {}) };
    const numGroups = mergedConfig.num_groups;
    const qualifiersPerGroup = mergedConfig.qualifiers_per_group;
    const groupsCfg = mergedConfig.groups;

    if (!numGroups || !qualifiersPerGroup || !Array.isArray(groupsCfg) || groupsCfg.length === 0) {
        return { success: false, error: 'La configuración de grupos no está completa (num_groups, qualifiers_per_group o groups vacíos)' };
    }

    if (groupsCfg.length !== numGroups) {
        return { success: false, error: `Inconsistencia: type_config.num_groups=${numGroups} pero hay ${groupsCfg.length} grupos guardados` };
    }

    const total = numGroups * qualifiersPerGroup;
    if (total < 2 || (total & (total - 1)) !== 0) {
        return { success: false, error: `El total de clasificados (${total}) no es potencia de 2` };
    }

    // Cargar partidos de grupos
    const { data: groupMatches, error: matchesError } = await supabase
        .from('matches')
        .select('group_name, round_id, home_league_team_id, away_league_team_id, home_goals, away_goals')
        .eq('competition_id', competitionId)
        .eq('round_type', 'group');

    if (matchesError) {
        return { success: false, error: `Error cargando partidos de grupos: ${matchesError.message}` };
    }

    if (!groupMatches || groupMatches.length === 0) {
        return { success: false, error: 'No hay partidos de grupos generados' };
    }

    const pending = groupMatches.filter(m => m.home_goals === null || m.away_goals === null);
    if (pending.length > 0) {
        return { success: false, error: `Faltan ${pending.length} partidos de grupos por jugar` };
    }

    // Calcular clasificación por grupo (reusa la lógica de standings)
    const standings = calculateGroupStandings(groupMatches, groupsCfg, mergedConfig, null);

    // Recoger top-N de cada grupo en orden alfabético del grupo
    const groupNames = groupsCfg.map(g => g.name);
    const qualifierIds = [];
    for (let pos = 0; pos < qualifiersPerGroup; pos++) {
        for (const groupName of groupNames) {
            const groupStandings = standings[groupName];
            if (!groupStandings || groupStandings.length <= pos) {
                return { success: false, error: `El grupo ${groupName} no tiene suficientes equipos para el clasificado ${pos + 1}` };
            }
            qualifierIds.push(groupStandings[pos].team_id);
        }
    }

    if (qualifierIds.length !== total) {
        return { success: false, error: `Se esperaban ${total} clasificados pero se obtuvieron ${qualifierIds.length}` };
    }

    // Calcular el máximo round_id de los grupos para usarlo como offset del bracket
    const maxGroupRoundId = groupMatches.reduce((m, x) => Math.max(m, x.round_id || 0), 0);

    return {
        success: true,
        qualifierIds,
        maxGroupRoundId,
        competition,
        mergedConfig
    };
}

/**
 * Siembra el bracket de eliminatoria de una competición mixta una vez los
 * grupos están completos. Reusa generateCupSchedule pasando los clasificados
 * como teamIds y un fake competitionData con el formato de la fase final
 * (knockout_format/is_double_elimination/has_third_place_match), más un
 * offset de round_id para que las jornadas no choquen con las de grupos.
 *
 * @param {number} competitionId
 * @returns {Promise<{success: boolean, matchesCreated?: number, error?: string}>}
 */
export async function seedMixedBracket(competitionId) {
    const status = await getMixedBracketStatus(competitionId);
    if (!status.ready) {
        return { success: false, error: status.reason || 'No se puede sembrar el bracket' };
    }

    const qualifiersResult = await getMixedQualifiers(competitionId);
    if (!qualifiersResult.success) {
        return { success: false, error: qualifiersResult.error };
    }

    const { qualifierIds, maxGroupRoundId, competition, mergedConfig } = qualifiersResult;

    // Construir un competitionData "tipo cup" para reutilizar generateCupSchedule.
    // Mantenemos el competition_type real ('mixed') pero el generator solo lee
    // type_config.format / is_double_elimination / has_third_place_match.
    const fakeCupData = {
        ...competition,
        competition_type: 'cup',
        type_config: {
            format: mergedConfig.knockout_format || 'single_match',
            is_double_elimination: mergedConfig.is_double_elimination || false,
            has_third_place_match: mergedConfig.has_third_place_match || false,
            away_goals_rule: mergedConfig.away_goals_rule,
            extra_time: mergedConfig.extra_time,
            penalties: mergedConfig.penalties
        }
    };

    return await generateCupSchedule(competitionId, fakeCupData, qualifierIds, maxGroupRoundId);
}

/**
 * Inserta relaciones entre partidos en la base de datos
 * @param {Array<Object>} relations
 * @returns {Promise<{success: boolean, relationsCreated?: number, error?: string}>}
 */
async function insertMatchRelations(relations) {
    if (relations.length === 0) {
        return { success: true, relationsCreated: 0 };
    }

    const supabase = await getSupabaseClient();

    // Insertar en lotes
    const batchSize = 100;
    let inserted = 0;

    for (let i = 0; i < relations.length; i += batchSize) {
        const batch = relations.slice(i, i + batchSize);
        const { error } = await supabase
            .from('match_relations')
            .insert(batch);

        if (error) {
            console.error('Error insertando relaciones:', error);
            return { success: false, error: `Error insertando relaciones: ${error.message}` };
        }

        inserted += batch.length;
    }

    return { 
        success: true, 
        relationsCreated: inserted,
        message: `Se crearon ${inserted} relaciones entre partidos`
    };
}

/**
 * Inserta partidos en la base de datos
 * @param {Array<Object>} matches
 * @returns {Promise<{success: boolean, matchesCreated?: number, error?: string}>}
 */
async function insertMatches(matches) {
    if (matches.length === 0) {
        return { success: false, error: 'No hay partidos para insertar' };
    }

    const supabase = await getSupabaseClient();

    // Generar IDs con formato "J{round_id}-P{partido}" para cada partido
    // Agrupar por round_id para numerar los partidos correctamente dentro de cada ronda
    const matchesByRound = new Map();
    matches.forEach(match => {
        // Asegurar que todos los partidos tengan round_id
        let roundId = match.round_id;
        
        // Si no tiene round_id, intentar obtenerlo de cup_round
        if (!roundId && match.cup_round) {
            roundId = match.cup_round;
        }
        
        // Si aún no tiene round_id, usar 1 como fallback
        if (!roundId) {
            roundId = 1;
            // Añadir round_id al objeto si no lo tenía
            match.round_id = roundId;
        }
        
        if (!matchesByRound.has(roundId)) {
            matchesByRound.set(roundId, []);
        }
        matchesByRound.get(roundId).push(match);
    });

    // Generar IDs para cada partido
    const matchesWithIds = [];
    matchesByRound.forEach((roundMatches, roundId) => {
        roundMatches.forEach((match, idx) => {
            // Añadir sufijo de bracket si existe
            const bracketSuffix = match.bracket_type ? `-${match.bracket_type}` : '';
            const matchId = `J${roundId}-P${idx + 1}${bracketSuffix}`;
            matchesWithIds.push({
                id: matchId,
                ...match
            });
        });
    });

    // Verificar qué partidos ya existen (una sola query para todos)
    const competitionId = matchesWithIds[0]?.competition_id;
    if (!competitionId) {
        return { success: false, error: 'No se pudo determinar competition_id' };
    }
    
    const matchIds = matchesWithIds.map(m => m.id);
    const { data: existingMatches, error: checkError } = await supabase
        .from('matches')
        .select('id')
        .eq('competition_id', competitionId)
        .in('id', matchIds);
    
    if (checkError) {
        console.error('Error verificando partidos existentes:', checkError);
        // Continuar de todas formas, intentar insertar
    }
    
    const existingIds = new Set((existingMatches || []).map(m => m.id));
    
    // Filtrar partidos que no existen
    const newMatches = matchesWithIds.filter(match => !existingIds.has(match.id));
    const skipped = matchesWithIds.length - newMatches.length;
    
    if (newMatches.length === 0) {
        return { 
            success: true, 
            matchesCreated: 0,
            matchesSkipped: skipped,
            message: `Todos los partidos ya existían (${skipped} partidos)`
        };
    }

    // Insertar en lotes para evitar problemas de tamaño
    const batchSize = 100;
    let inserted = 0;

    const insertedMatches = [];
    for (let i = 0; i < newMatches.length; i += batchSize) {
        const batch = newMatches.slice(i, i + batchSize).map((m) => ({
            ...m,
            is_third_place_match: m.is_third_place_match ?? false
        }));
        const { data: batchResult, error } = await supabase
            .from('matches')
            .insert(batch)
            .select('id, match_uuid');

        if (error) {
            console.error('Error insertando partidos:', error);
            return { success: false, error: `Error insertando partidos: ${error.message}` };
        }

        if (batchResult) {
            insertedMatches.push(...batchResult);
        }
        inserted += batch.length;
    }

    return { 
        success: true, 
        matchesCreated: inserted,
        matchesSkipped: skipped,
        insertedMatches: insertedMatches, // Incluir partidos insertados con match_uuid
        message: inserted > 0 
            ? `Se crearon ${inserted} partidos${skipped > 0 ? `, ${skipped} ya existían` : ''}`
            : `Todos los partidos ya existían (${skipped} partidos)`
    };
}

/**
 * Guarda la configuración de grupos en competition.config
 * @param {number} competitionId
 * @param {Array<Array<number>>} groups
 * @param {Object} existingConfig
 */
async function saveGroupsConfig(competitionId, groups, existingConfig) {
    const supabase = await getSupabaseClient();

    const groupsConfig = groups.map((groupTeams, index) => ({
        name: `Grupo ${String.fromCharCode(65 + index)}`,
        teams: groupTeams,
        qualifies: 1 // Por defecto, el primero de cada grupo. Se puede configurar después
    }));

    const updatedConfig = {
        ...existingConfig,
        groups: groupsConfig
    };

    await supabase
        .from('competitions')
        .update({ config: updatedConfig })
        .eq('id', competitionId);
}

/**
 * Guarda los equipos con bye (exentos) para una ronda específica
 * @param {number} competitionId
 * @param {number} round
 * @param {Array<number>} byeTeams
 * @param {Object} existingConfig
 */
async function saveByeTeams(competitionId, round, byeTeams, existingConfig) {
    const supabase = await getSupabaseClient();

    const byeConfig = existingConfig.byes || {};
    byeConfig[round] = byeTeams;

    const updatedConfig = {
        ...existingConfig,
        byes: byeConfig
    };

    await supabase
        .from('competitions')
        .update({ config: updatedConfig })
        .eq('id', competitionId);
}

/**
 * Obtiene los equipos con bye (exentos) para una ronda específica
 * @param {number} competitionId
 * @param {number} round
 * @returns {Promise<Array<number>>}
 */
async function getByeTeams(competitionId, round) {
    const supabase = await getSupabaseClient();

    const { data, error } = await supabase
        .from('competitions')
        .select('config')
        .eq('id', competitionId)
        .single();

    if (error || !data || !data.config || !data.config.byes) {
        return [];
    }

    return data.config.byes[round] || [];
}

/**
 * Genera los emparejamientos de una liga round-robin.
 *
 * Para N par: algoritmo del círculo, N-1 jornadas, N/2 partidos por jornada.
 * Para N impar: se añade un "equipo fantasma" para trabajar sobre tamaño par
 * (N+1), y los partidos en los que un equipo es emparejado con el fantasma se
 * descartan — ese equipo descansa esa jornada. Resultado: N jornadas, (N-1)/2
 * partidos por jornada, cada equipo descansa exactamente una vez.
 *
 * @param {Array<number>} teamIds - league_team_ids participantes.
 * @param {'single_round'|'double_round'} format
 * @returns {{
 *   pairings: Array<{round_id: number, home_league_team_id: number, away_league_team_id: number}>,
 *   legRounds: number
 * }} legRounds = nº de jornadas por vuelta (single_round: total; double_round: la mitad)
 */
export function buildRoundRobinPairings(teamIds, format = 'double_round') {
    const numTeams = teamIds.length;
    if (numTeams < 2) return { pairings: [], legRounds: 0 };

    const isOdd = numTeams % 2 === 1;
    const teams = isOdd ? [...teamIds, null] : [...teamIds];
    const workingSize = teams.length;
    const legRounds = workingSize - 1;
    const matchesPerRound = workingSize / 2;
    const pairings = [];

    const generateLeg = (legOffset) => {
        for (let round = 1; round <= legRounds; round++) {
            for (let i = 0; i < matchesPerRound; i++) {
                const home = teams[i];
                const away = teams[workingSize - 1 - i];

                // Par contra el fantasma → descanso del otro equipo.
                if (home === null || away === null) continue;

                pairings.push({
                    round_id: round + legOffset,
                    home_league_team_id: home,
                    away_league_team_id: away
                });
            }
            const last = teams.pop();
            teams.splice(1, 0, last);
        }
    };

    generateLeg(0);

    if (format !== 'single_round') {
        const firstLegCount = pairings.length;
        for (let i = 0; i < firstLegCount; i++) {
            const p = pairings[i];
            pairings.push({
                round_id: p.round_id + legRounds,
                home_league_team_id: p.away_league_team_id,
                away_league_team_id: p.home_league_team_id
            });
        }
    }

    return { pairings, legRounds };
}

/**
 * Verifica si un número es potencia de 2
 * @param {number} n
 * @returns {boolean}
 */
export function isPowerOfTwo(n) {
    return n > 0 && (n & (n - 1)) === 0;
}

/**
 * Mezcla un array aleatoriamente (Fisher-Yates)
 * @param {Array} array
 */
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

/**
 * Aplica una permutación aleatoria sobre los round_id de un subconjunto de
 * partidos. Los partidos cuyo round_id esté fuera del rango se ignoran.
 *
 * Sirve para romper el patrón predecible del algoritmo del círculo: el
 * conjunto de emparejamientos por jornada es óptimo, pero su orden temporal
 * queda aleatorizado, lo que destruye las secuencias consecutivas de rivales
 * que comparten equipos en posiciones cercanas.
 *
 * @param {Array<Object>} matches
 * @param {number} fromRound - round_id mínimo (inclusivo)
 * @param {number} toRound - round_id máximo (inclusivo)
 */
function remapRoundsRandomly(matches, fromRound, toRound) {
    if (toRound < fromRound) return;
    const targets = [];
    for (let i = fromRound; i <= toRound; i++) targets.push(i);
    shuffleArray(targets);
    const map = new Map();
    for (let i = fromRound; i <= toRound; i++) {
        map.set(i, targets[i - fromRound]);
    }
    for (const m of matches) {
        if (map.has(m.round_id)) m.round_id = map.get(m.round_id);
    }
}

/**
 * Parsea una fecha YYYY-MM-DD en local time (sin desfase UTC).
 * @param {string} dateStr
 * @returns {Date}
 */
function parseLocalDate(dateStr) {
    const [y, m, d] = dateStr.split('-').map(Number);
    return new Date(y, m - 1, d);
}

/**
 * Formatea un Date como YYYY-MM-DD en local time.
 * @param {Date} dt
 * @returns {string}
 */
function formatLocalDate(dt) {
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const d = String(dt.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

/**
 * Suma n días a una fecha YYYY-MM-DD.
 * @param {string} dateStr
 * @param {number} n
 * @returns {string}
 */
function addDaysLocal(dateStr, n) {
    const dt = parseLocalDate(dateStr);
    dt.setDate(dt.getDate() + n);
    return formatLocalDate(dt);
}

/**
 * Reparte numMatches fechas dentro de una ventana de 10 días que empieza en
 * windowStart, priorizando domingos y lunes. El resto de partidos cae en los
 * siguientes días del rango por orden cronológico.
 *
 * @param {string} windowStart - YYYY-MM-DD (primer día de la ventana de 10)
 * @param {number} numMatches
 * @returns {Array<string>} fechas YYYY-MM-DD ordenadas cronológicamente
 */
function pickRoundDates(windowStart, numMatches) {
    if (numMatches <= 0) return [];
    const days = [];
    for (let i = 0; i < 10; i++) {
        const dt = parseLocalDate(windowStart);
        dt.setDate(dt.getDate() + i);
        days.push({ date: dt, dow: dt.getDay() });
    }
    // Prioridad: domingo (0) y lunes (1) primero, luego cronológico.
    const priority = (dow) => (dow === 0 ? 0 : dow === 1 ? 1 : 2);
    const sorted = [...days].sort((a, b) => {
        const pa = priority(a.dow);
        const pb = priority(b.dow);
        if (pa !== pb) return pa - pb;
        return a.date - b.date;
    });
    const picked = sorted.slice(0, Math.min(numMatches, 10));
    picked.sort((a, b) => a.date - b.date);
    return picked.map((p) => formatLocalDate(p.date));
}

/**
 * Asigna match_date y match_time = '21:00:00' a una lista de partidos.
 * Agrupa por round_id y, para cada jornada N (1-indexada en su orden natural),
 * usa una ventana de 10 días que empieza en startDate + (N-1)*10.
 *
 * Si startDate es null/vacío no hace nada (compat con el flujo previo).
 *
 * @param {Array<Object>} matches - partidos con round_id ya asignado
 * @param {string|null|undefined} startDate - YYYY-MM-DD (inicio de jornada 1)
 */
function assignDatesToMatches(matches, startDate) {
    if (!startDate || !matches.length) return;
    const byRound = new Map();
    for (const m of matches) {
        const r = m.round_id;
        if (r == null) continue;
        if (!byRound.has(r)) byRound.set(r, []);
        byRound.get(r).push(m);
    }
    const sortedRounds = [...byRound.keys()].sort((a, b) => a - b);
    sortedRounds.forEach((roundId, idx) => {
        const windowStart = addDaysLocal(startDate, idx * 10);
        const roundMatches = byRound.get(roundId);
        const dates = pickRoundDates(windowStart, roundMatches.length);
        roundMatches.forEach((m, i) => {
            m.match_date = dates[i] || dates[dates.length - 1] || windowStart;
            m.match_time = '21:00:00';
        });
    });
}

/**
 * Genera partidos de eliminatoria para competición mixta
 * Se llama después de que se completen los grupos
 * @param {number} competitionId
 * @param {Object} competitionData
 * @param {Array<number>} qualifiedTeamIds - IDs de equipos clasificados
 * @returns {Promise<{success: boolean, matchesCreated?: number, error?: string}>}
 */
export async function generateKnockoutPhase(competitionId, competitionData, qualifiedTeamIds) {
    const cupFormat = competitionData.type_config?.knockout_format || 'single_match';
    const season = competitionData.season;

    if (qualifiedTeamIds.length < 2) {
        return { success: false, error: 'Se necesitan al menos 2 equipos clasificados para la fase eliminatoria' };
    }

    const nextPowerOf2 = Math.pow(2, Math.ceil(Math.log2(qualifiedTeamIds.length)));
    const numParticipants = qualifiedTeamIds.length;

    // Mismo sistema de seed que en copa: orden = seed 1..N, primera ronda balanceada
    const { byeIndices, pairIndices } = getBalancedFirstRoundForCup(nextPowerOf2, numParticipants);
    const byeTeams = byeIndices.map((i) => qualifiedTeamIds[i]);

    const matches = [];
    const currentRound = 1;
    const isFinal = pairIndices.length === 1 && byeTeams.length === 0;

    // Crear emparejamientos primera ronda con seeding balanceado
    for (let i = 0; i < pairIndices.length; i++) {
        const [homeIdx, awayIdx] = pairIndices[i];
        const homeTeam = qualifiedTeamIds[homeIdx];
        const awayTeam = qualifiedTeamIds[awayIdx];

        if (cupFormat === 'double_match_except_final' && !isFinal) {
            matches.push({
                competition_id: competitionId,
                season: season,
                round_id: currentRound,
                round_type: 'cup',
                cup_round: currentRound,
                cup_leg: 'first',
                is_cup_final: false,
                is_third_place_match: false,
                home_league_team_id: homeTeam,
                away_league_team_id: awayTeam,
                home_goals: null,
                away_goals: null
            });

            matches.push({
                competition_id: competitionId,
                season: season,
                round_id: currentRound,
                round_type: 'cup',
                cup_round: currentRound,
                cup_leg: 'second',
                is_cup_final: false,
                is_third_place_match: false,
                home_league_team_id: awayTeam,
                away_league_team_id: homeTeam,
                home_goals: null,
                away_goals: null
            });
        } else {
            matches.push({
                competition_id: competitionId,
                season: season,
                round_id: currentRound,
                round_type: 'cup',
                cup_round: currentRound,
                cup_leg: isFinal ? 'final' : null,
                is_cup_final: isFinal,
                is_third_place_match: false,
                home_league_team_id: homeTeam,
                away_league_team_id: awayTeam,
                home_goals: null,
                away_goals: null
            });
        }
    }

    // Guardar los equipos con bye en la configuración de la competición
    if (byeTeams.length > 0) {
        await saveByeTeams(competitionId, currentRound, byeTeams, competitionData.config || {});
    }

    // Insertar partidos de la primera ronda
    const result = await insertMatches(matches);
    
    if (result.success && byeTeams.length > 0) {
        result.message = `${result.message}. ${byeTeams.length} equipo${byeTeams.length > 1 ? 's' : ''} ${byeTeams.length > 1 ? 'tienen' : 'tiene'} bye y ${byeTeams.length > 1 ? 'pasan' : 'pasa'} automáticamente a la siguiente ronda.`;
    }
    
    return result;
}

