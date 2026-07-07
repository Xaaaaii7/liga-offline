/**
 * Motor de simulación de la calculadora de liga.
 * Funciones puras sin dependencia del DOM ni de Supabase,
 * para poder testear de forma aislada.
 */

import { normalizeText, isNum } from './utils.js';

/** Diferencia de goles */
const dg = e => e.gf - e.gc;

/** Número máximo de jornadas pendientes para activar la calculadora */
export const MIN_JORNADAS_REMAINING = 5;

/**
 * Genera una clave única para un partido dentro de una jornada
 * @param {number} jornada - Número de jornada
 * @param {number} idx - Índice del partido dentro de la jornada
 * @returns {string}
 */
export const matchKey = (jornada, idx) => `${jornada}-${idx}`;

/**
 * Filtra las jornadas que tienen al menos un partido pendiente
 * @param {Array} jornadas - Array de jornadas con sus partidos
 * @returns {Array} Jornadas que contienen partidos sin resultado
 */
export function getJornadasWithPending(jornadas) {
  if (!jornadas?.length) return [];
  return jornadas.filter(j =>
    j.partidos.some(p => !isNum(p.goles_local) || !isNum(p.goles_visitante))
  );
}

/**
 * Determina si la calculadora debe estar disponible
 * @param {Array} jornadas - Todas las jornadas de la competición
 * @returns {{ available: boolean, reason: string|null, pendingCount: number }}
 */
export function checkAvailability(jornadas) {
  const pending = getJornadasWithPending(jornadas);

  if (pending.length === 0) {
    return { available: false, reason: 'all_played', pendingCount: 0 };
  }
  if (pending.length > MIN_JORNADAS_REMAINING) {
    return { available: false, reason: 'too_many', pendingCount: pending.length };
  }
  return { available: true, reason: null, pendingCount: pending.length };
}

/**
 * Construye el mapa de posiciones reales (nombre normalizado -> posición 1-based)
 * @param {Array} standings - Clasificación ordenada
 * @returns {Map<string, number>}
 */
export function buildRealPosMap(standings) {
  const map = new Map();
  standings.forEach((t, i) => map.set(normalizeText(t.nombre), i + 1));
  return map;
}

/**
 * Simula la clasificación completa a partir de los partidos reales y los resultados del usuario.
 * @param {Array} jornadas - Todas las jornadas
 * @param {Object} userResults - Resultados simulados por el usuario { [matchKey]: { home, away } }
 * @param {Object} options
 * @param {number} options.pointsWin - Puntos por victoria (default 3)
 * @param {number} options.pointsDraw - Puntos por empate (default 1)
 * @param {number} options.pointsLoss - Puntos por derrota (default 0)
 * @param {string[]} options.tiebreaker - Criterios de desempate
 * @param {Map|null} options.penaltyMap - Mapa de sanciones (nombre normalizado -> puntos)
 * @returns {Array} Clasificación simulada ordenada
 */
export function simulateStandings(jornadas, userResults, options = {}) {
  const {
    pointsWin = 3,
    pointsDraw = 1,
    pointsLoss = 0,
    tiebreaker = ['points', 'goal_difference', 'goals_for', 'head_to_head'],
    penaltyMap = null
  } = options;

  const teams = new Map();

  const teamObj = (name) => {
    const k = normalizeText(name);
    if (!teams.has(k)) {
      teams.set(k, {
        nombre: name,
        key: k,
        pj: 0, g: 0, e: 0, p: 0,
        gf: 0, gc: 0, pts: 0
      });
    }
    return teams.get(k);
  };

  // H2H
  const h2h = {};
  const addH2H = (A, B, gfA, gfB) => {
    const a = normalizeText(A), b = normalizeText(B);
    (h2h[a] ||= {});
    (h2h[a][b] ||= { gf: 0, gc: 0 });
    h2h[a][b].gf += gfA;
    h2h[a][b].gc += gfB;
  };

  // Procesar todas las jornadas
  for (const j of jornadas) {
    j.partidos.forEach((p, idx) => {
      if (!p.local || !p.visitante) return;

      const L = teamObj(p.local);
      const V = teamObj(p.visitante);

      let gl, gv;

      const played = isNum(p.goles_local) && isNum(p.goles_visitante);
      if (played) {
        gl = p.goles_local;
        gv = p.goles_visitante;
      } else {
        const key = matchKey(j.numero, idx);
        const sim = userResults[key];
        if (sim?.home != null && sim?.away != null) {
          gl = sim.home;
          gv = sim.away;
        } else {
          return; // Sin resultado
        }
      }

      L.pj++; V.pj++;
      L.gf += gl; L.gc += gv;
      V.gf += gv; V.gc += gl;

      if (gl > gv) {
        L.g++; L.pts += pointsWin;
        V.p++; V.pts += pointsLoss;
      } else if (gl < gv) {
        V.g++; V.pts += pointsWin;
        L.p++; L.pts += pointsLoss;
      } else {
        L.e++; V.e++;
        L.pts += pointsDraw;
        V.pts += pointsDraw;
      }

      addH2H(p.local, p.visitante, gl, gv);
      addH2H(p.visitante, p.local, gv, gl);
    });
  }

  // Aplicar sanciones
  const equipos = Array.from(teams.values());
  for (const t of equipos) {
    const pen = penaltyMap?.get(t.key) || 0;
    t.pts_raw = t.pts;
    t.penalty_pts = pen;
    t.pts = t.pts_raw - pen;
    if (t.pts < 0) t.pts = 0;
  }

  // Ordenar
  equipos.sort((A, B) => {
    if (B.pts !== A.pts) return B.pts - A.pts;

    // H2H
    const a = A.key, b = B.key;
    const ha = h2h[a]?.[b], hb = h2h[b]?.[a];
    if (ha && hb) {
      const difA = (ha.gf || 0) - (ha.gc || 0);
      const difB = (hb.gf || 0) - (hb.gc || 0);
      if (difA !== difB) return difB - difA;
    }

    for (const criterion of tiebreaker) {
      if (criterion === 'points' || criterion === 'head_to_head') continue;
      if (criterion === 'goal_difference') {
        const dA = dg(A), dB = dg(B);
        if (dA !== dB) return dB - dA;
      } else if (criterion === 'goals_for') {
        if (B.gf !== A.gf) return B.gf - A.gf;
      }
    }

    return A.nombre.localeCompare(B.nombre, 'es', { sensitivity: 'base' });
  });

  return equipos;
}

/**
 * Calcula los cambios de posición entre la clasificación real y la simulada
 * @param {Array} simulatedStandings - Clasificación simulada
 * @param {Map<string, number>} realPosMap - Mapa de posiciones reales
 * @returns {Array<{ nombre: string, pos: number, realPos: number|null, diff: number }>}
 */
export function computePositionChanges(simulatedStandings, realPosMap) {
  return simulatedStandings.map((t, i) => {
    const pos = i + 1;
    const realPos = realPosMap.get(t.key) ?? null;
    const diff = realPos != null ? realPos - pos : 0;
    return { nombre: t.nombre, pos, realPos, diff };
  });
}
