/**
 * Generador de calendario "Champions5" para Liga Epidor 25 (25 equipos en 5
 * bombos de 5). Cada equipo juega 6 partidos: 4 cross-bombo (1 vs cada otro
 * bombo) + 2 own-bombo (en un 5-ciclo aleatorio). Total 75 partidos en 8
 * jornadas (5 cross + 3 own).
 *
 * Algoritmo (construcción explícita, sin backtracking — O(N) y determinista):
 *
 *   CROSS (J1-J5, 5 rounds lógicos, cada uno deja descansar 1 bombo entero):
 *     Las 10 cross-pairs C(5,2) se reparten en 5 rounds, agrupando 2 pares
 *     disjuntos (cubren 4 de los 5 bombos):
 *       round-skip-B0: (B1,B2) + (B3,B4)
 *       round-skip-B1: (B0,B2) + (B3,B4)
 *       round-skip-B2: (B0,B1) + (B3,B4)
 *       round-skip-B3: (B0,B1) + (B2,B4)
 *       round-skip-B4: (B0,B1) + (B2,B3)
 *     Cada cross-pair (Bi,Bj): shuffle de pot[j] con PRNG y empareja índice a
 *     índice con pot[i].
 *     El orden real J1..J5 es una permutación aleatoria (PRNG) de los 5 rounds.
 *
 *   OWN (J6-J8, 3 rounds lógicos, edge-coloring de un 5-ciclo):
 *     Para cada bombo se baraja la lista de 5 equipos y se forma el ciclo
 *     [t0-t1, t1-t2, t2-t3, t3-t4, t4-t0]. Las 5 aristas se reparten en 3
 *     rounds: A={e0,e2} (t4 descansa), B={e1,e3} (t0 descansa), C={e4} (t1, t2,
 *     t3 descansan). Cada equipo aparece en grado 2 → 2 partidos own.
 *     El orden real J6..J8 es una permutación aleatoria (PRNG) de los 3 rounds.
 *
 * Determinismo: mismo seed → mismo output. Estructura de rounds fija; lo que
 * varía con el seed son las parejas concretas, el orden de jornadas y los
 * ciclos own.
 */

import { rngFromSeed } from './competition-draw.js';

const NUM_POTS = 5;
const TEAMS_PER_POT = 5;
const TOTAL_TEAMS = NUM_POTS * TEAMS_PER_POT;          // 25
const MATCHES_PER_TEAM = 6;
const NUM_JORNADAS = 8;
const NUM_CROSS_JORNADAS = 5;
const NUM_OWN_JORNADAS = 3;
const TOTAL_MATCHES = (TOTAL_TEAMS * MATCHES_PER_TEAM) / 2; // 75

// Partición fija de las 10 cross-pairs en 5 rounds (1-factorization de K5).
// Indexado por el bombo que descansa (0..4). Cada round = 2 pares disjuntos
// sobre los 4 bombos restantes. Cada cross-pair aparece exactamente 1 vez.
const CROSS_ROUND_PAIRS = [
  /* skip B0 */ [[1, 3], [2, 4]],
  /* skip B1 */ [[0, 2], [3, 4]],
  /* skip B2 */ [[0, 3], [1, 4]],
  /* skip B3 */ [[0, 4], [1, 2]],
  /* skip B4 */ [[0, 1], [2, 3]],
];

/**
 * Genera el calendario de la fase liguilla para 25 equipos.
 *
 * @param {Array<Array<number>>} pots — 5 arrays de 5 team_ids cada uno.
 * @param {number} seed — semilla para el PRNG (determinismo).
 * @returns {{ matches: Array<{home_team_id, away_team_id, jornada, kind, pot_home, pot_away}> }}
 */
export function generateEpidor25LeagueSchedule(pots, seed) {
  validatePots(pots);
  const rng = rngFromSeed(seed);

  // ----- CROSS -----
  // Construir los 5 cross-rounds según la partición fija.
  // Para cada par (i,j) emparejamos: shuffle de pot[j] y zip con pot[i].
  const crossRounds = CROSS_ROUND_PAIRS.map((pairList, skipBombo) => {
    const items = [];
    for (const [i, j] of pairList) {
      const shuffledJ = fisherYates([...pots[j]], rng);
      for (let k = 0; k < TEAMS_PER_POT; k++) {
        items.push({
          home_team_id: pots[i][k],
          away_team_id: shuffledJ[k],
          pot_home: i + 1,
          pot_away: j + 1,
        });
      }
    }
    return { skip: skipBombo, items };
  });

  // Barajar el orden de los 5 cross-rounds y asignarlos a J1..J5.
  const crossOrder = fisherYates([0, 1, 2, 3, 4], rng);
  const crossJornadas = crossOrder.map((roundIdx, j) => ({
    jornada: j + 1,
    kind: 'cross',
    items: crossRounds[roundIdx].items,
  }));

  // ----- OWN -----
  // Para cada bombo: shuffle de 5 equipos → 5-ciclo → 3 rounds {A,B,C}.
  // ownRoundsPerBombo[b] = [roundA_pairs, roundB_pairs, roundC_pairs]
  const ownRoundsPerBombo = pots.map((pot, b) => {
    const t = fisherYates([...pot], rng);
    return [
      // Round A: e0 + e2  (descansa t4)
      [
        { home_team_id: t[0], away_team_id: t[1], pot_home: b + 1, pot_away: b + 1 },
        { home_team_id: t[2], away_team_id: t[3], pot_home: b + 1, pot_away: b + 1 },
      ],
      // Round B: e1 + e3  (descansa t0)
      [
        { home_team_id: t[1], away_team_id: t[2], pot_home: b + 1, pot_away: b + 1 },
        { home_team_id: t[3], away_team_id: t[4], pot_home: b + 1, pot_away: b + 1 },
      ],
      // Round C: e4  (descansan t1, t2, t3)
      [
        { home_team_id: t[4], away_team_id: t[0], pot_home: b + 1, pot_away: b + 1 },
      ],
    ];
  });

  // Barajar el orden de los 3 own-rounds (mismo orden para todos los bombos
  // así una jornada own concreta corresponde al mismo "color" del 5-ciclo en
  // los 5 bombos: dos jornadas con 10 partidos y una con 5).
  const ownOrder = fisherYates([0, 1, 2], rng);
  const ownJornadas = ownOrder.map((roundIdx, j) => ({
    jornada: NUM_CROSS_JORNADAS + j + 1, // J6, J7, J8
    kind: 'own',
    items: ownRoundsPerBombo.flatMap(rounds => rounds[roundIdx]),
  }));

  // ----- ENSAMBLAJE -----
  const all = [...crossJornadas, ...ownJornadas];
  const matches = all.flatMap(j =>
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

export const _internals = {
  NUM_POTS,
  TEAMS_PER_POT,
  TOTAL_TEAMS,
  MATCHES_PER_TEAM,
  NUM_JORNADAS,
  NUM_CROSS_JORNADAS,
  NUM_OWN_JORNADAS,
  TOTAL_MATCHES,
};
