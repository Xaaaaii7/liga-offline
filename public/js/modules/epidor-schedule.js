/**
 * Generador de calendario "Champions" para Liga Epidor (24 equipos en 4 bombos
 * de 6). Cada equipo juega 5 partidos: 3 cross-bombo (1 vs cada otro bombo) + 2
 * own-bombo (2 oponentes distintos del propio). Total 60 partidos en 5 jornadas
 * de 12.
 *
 * Algoritmo (construcción explícita, sin backtracking — O(N) y determinista):
 *
 *   Las 5 jornadas se construyen como perfect matchings sobre los 24 equipos:
 *
 *   - Jornada 1: cross B1↔B2 ∪ cross B3↔B4   (12 partidos, todos los teams)
 *   - Jornada 2: cross B1↔B3 ∪ cross B2↔B4   (12)
 *   - Jornada 3: cross B1↔B4 ∪ cross B2↔B3   (12)
 *   - Jornada 4: own-matching M1 de cada bombo (3 ed. × 4 bombos = 12)
 *   - Jornada 5: own-matching M2 de cada bombo (12)
 *
 *   Para cada par cross (Bi, Bj): shuffle de Bj con PRNG y empareja índice a índice.
 *   Para cada own (6-ciclo): shuffle de los 6 teams y descomponemos en 2 matchings:
 *      M1 = (t0,t1)(t2,t3)(t4,t5)
 *      M2 = (t1,t2)(t3,t4)(t5,t0)
 *
 * Determinismo: mismo seed → mismo output. La estructura de jornadas es fija;
 * lo que varía con el seed son las parejas concretas (orden de los bombos).
 */

import { rngFromSeed } from './competition-draw.js';

const NUM_POTS = 4;
const TEAMS_PER_POT = 6;
const TOTAL_TEAMS = NUM_POTS * TEAMS_PER_POT;          // 24
const MATCHES_PER_TEAM = 5;
const NUM_JORNADAS = 5;
const MATCHES_PER_JORNADA = TOTAL_TEAMS / 2;           // 12
const TOTAL_MATCHES = (TOTAL_TEAMS * MATCHES_PER_TEAM) / 2; // 60

/**
 * Genera el calendario de la fase liguilla.
 *
 * @param {Array<Array<number>>} pots — 4 arrays de 6 team_ids cada uno.
 * @param {number} seed — semilla para el PRNG (determinismo).
 * @returns {{ matches: Array<{home_team_id, away_team_id, jornada, kind, pot_home, pot_away}> }}
 */
export function generateEpidorLeagueSchedule(pots, seed) {
  validatePots(pots);
  const rng = rngFromSeed(seed);

  // Cross-bombo: para cada par (i,j), shuffle de pots[j] y emparejar con pots[i].
  // pairings[i][j] = array de {home, away} (6 elementos), i<j.
  const cross = {};
  for (let i = 0; i < NUM_POTS; i++) {
    for (let j = i + 1; j < NUM_POTS; j++) {
      const shuffledJ = fisherYates([...pots[j]], rng);
      const pairs = pots[i].map((teamI, k) => ({
        home_team_id: teamI,
        away_team_id: shuffledJ[k],
        pot_home: i + 1,
        pot_away: j + 1,
      }));
      cross[`${i}-${j}`] = pairs;
    }
  }

  // Own-bombo: shuffle 6 teams por bombo y descomponer 6-ciclo en M1 y M2.
  // own[i] = { m1: 3 pairs, m2: 3 pairs }
  const own = [];
  for (let i = 0; i < NUM_POTS; i++) {
    const t = fisherYates([...pots[i]], rng);
    own.push({
      m1: [
        { home_team_id: t[0], away_team_id: t[1], pot_home: i + 1, pot_away: i + 1 },
        { home_team_id: t[2], away_team_id: t[3], pot_home: i + 1, pot_away: i + 1 },
        { home_team_id: t[4], away_team_id: t[5], pot_home: i + 1, pot_away: i + 1 },
      ],
      m2: [
        { home_team_id: t[1], away_team_id: t[2], pot_home: i + 1, pot_away: i + 1 },
        { home_team_id: t[3], away_team_id: t[4], pot_home: i + 1, pot_away: i + 1 },
        { home_team_id: t[5], away_team_id: t[0], pot_home: i + 1, pot_away: i + 1 },
      ],
    });
  }

  // Construcción de jornadas (5 perfect matchings):
  const jornadaSpec = [
    { jornada: 1, kind: 'cross', items: [...cross['0-1'], ...cross['2-3']] },
    { jornada: 2, kind: 'cross', items: [...cross['0-2'], ...cross['1-3']] },
    { jornada: 3, kind: 'cross', items: [...cross['0-3'], ...cross['1-2']] },
    { jornada: 4, kind: 'own',   items: own.flatMap(o => o.m1) },
    { jornada: 5, kind: 'own',   items: own.flatMap(o => o.m2) },
  ];

  const matches = jornadaSpec.flatMap(j =>
    j.items.map(m => ({ ...m, kind: j.kind, jornada: j.jornada }))
  );

  return { matches };
}

// ============================================================
// Helpers
// ============================================================

function validatePots(pots) {
  if (!Array.isArray(pots) || pots.length !== NUM_POTS) {
    throw new Error(`Se requieren exactamente ${NUM_POTS} bombos.`);
  }
  const seen = new Set();
  for (const pot of pots) {
    if (!Array.isArray(pot) || pot.length !== TEAMS_PER_POT) {
      throw new Error(`Cada bombo debe tener ${TEAMS_PER_POT} equipos.`);
    }
    for (const id of pot) {
      if (id == null) throw new Error('Team id nulo no válido.');
      if (seen.has(id)) throw new Error(`Team id ${id} aparece en más de un bombo.`);
      seen.add(id);
    }
  }
}

function fisherYates(arr, rng) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

