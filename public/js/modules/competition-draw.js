/**
 * Sorteo de competiciones de copa.
 *
 * Genera pairings determinísticos a partir de una `pots_config` y una semilla,
 * y wrappea las RPCs `create_draft_draw`, `publish_draw`, `delete_draft_draw`.
 *
 * pots_config formato:
 *   {
 *     format: 'flat' | 'pots',
 *     pots: [{ name: string, team_ids: number[] }, ...],
 *     constraints: { cross_pot?: boolean }
 *   }
 *
 * Flujo de uso (admin):
 *   const seed = randomSeed();
 *   const pairings = generatePairings(potsConfig, seed);
 *   const drawId = await createDraftDraw({ competitionId, cupRound, seed, potsConfig, pairings });
 *   // (admin previsualiza animación con loadDraftDraw)
 *   await publishDraw(drawId);
 */

// `getSupabaseClient` se importa dinámicamente dentro de los wrappers RPC para que
// las funciones puras (rngFromSeed, generatePairings) se puedan testear en Node sin
// `window` definido.

// ============================================================
// PRNG determinista (mulberry32)
// ============================================================

/**
 * Devuelve un generador uniforme [0,1) a partir de una semilla entera.
 * Misma semilla ⇒ misma secuencia.
 */
export function rngFromSeed(seed) {
  let a = (Number(seed) | 0) >>> 0;
  return function next() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Semilla aleatoria razonable (32 bits). */
export function randomSeed() {
  return Math.floor(Math.random() * 2 ** 32);
}

// ============================================================
// Generación de pairings
// ============================================================

function fisherYates(arr, rng) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Empareja teams consecutivos. Si la lista tiene longitud impar, el último
 * queda como bye (away = null).
 * @param {number[]} teamIds
 * @param {string|null} potLabel
 * @returns {Array<{home_team_id:number, away_team_id:number|null, home_pot:string|null, away_pot:string|null}>}
 */
function pairConsecutive(teamIds, potLabel = null) {
  const result = [];
  for (let i = 0; i < teamIds.length; i += 2) {
    result.push({
      home_team_id: teamIds[i],
      away_team_id: teamIds[i + 1] ?? null,
      home_pot: potLabel,
      away_pot: teamIds[i + 1] != null ? potLabel : null,
    });
  }
  return result;
}

/**
 * Empareja dos bombos cruzados. Si los bombos no son del mismo tamaño,
 * los sobrantes del más grande caen como bye o se empareja contra el siguiente
 * sobrante del mismo bombo.
 *
 * Regla: tomamos min(lenA, lenB) parejas cross-pot. El sobrante del bombo
 * mayor se empareja entre sí (siguiendo el orden ya barajado). Si queda un
 * impar suelto al final → bye.
 */
function pairCrossPots(potA, potB, labelA, labelB) {
  const result = [];
  const n = Math.min(potA.length, potB.length);
  for (let i = 0; i < n; i++) {
    result.push({
      home_team_id: potA[i],
      away_team_id: potB[i],
      home_pot: labelA,
      away_pot: labelB,
    });
  }
  // Sobrantes
  const surplus = potA.length > potB.length ? potA.slice(n) : potB.slice(n);
  const surplusLabel = potA.length > potB.length ? labelA : labelB;
  if (surplus.length) {
    result.push(...pairConsecutive(surplus, surplusLabel));
  }
  return result;
}

/**
 * Genera los pairings de un sorteo.
 *
 * @param {Object} potsConfig
 * @param {number} seed
 * @returns {Array<{order:number, home_team_id:number, away_team_id:number|null, home_pot:string|null, away_pot:string|null}>}
 */
export function generatePairings(potsConfig, seed) {
  const rng = rngFromSeed(seed);
  const cfg = potsConfig || { format: 'flat', pots: [], constraints: {} };
  const format = cfg.format || 'flat';

  let raw;

  if (format === 'pots' && Array.isArray(cfg.pots) && cfg.pots.length >= 2 && cfg.constraints?.cross_pot) {
    // Sólo soportamos cross-pot entre los DOS primeros bombos en v1.
    // Si hay más, los extras se concatenan al final como bombo "resto".
    const potA = fisherYates(cfg.pots[0].team_ids || [], rng);
    const potB = fisherYates(cfg.pots[1].team_ids || [], rng);
    raw = pairCrossPots(potA, potB, cfg.pots[0].name || 'A', cfg.pots[1].name || 'B');

    if (cfg.pots.length > 2) {
      const extras = cfg.pots.slice(2).flatMap(p => p.team_ids || []);
      const shuffled = fisherYates(extras, rng);
      raw.push(...pairConsecutive(shuffled, 'resto'));
    }
  } else {
    // Flat: une todos los team_ids (de pots si los hubiera) y empareja al azar.
    let teamIds;
    if (Array.isArray(cfg.pots) && cfg.pots.length) {
      teamIds = cfg.pots.flatMap(p => p.team_ids || []);
    } else {
      teamIds = Array.isArray(cfg.team_ids) ? cfg.team_ids : [];
    }
    const shuffled = fisherYates(teamIds, rng);
    raw = pairConsecutive(shuffled, null);
  }

  return raw.map((p, i) => ({ order: i + 1, ...p }));
}

// ============================================================
// RPC wrappers
// ============================================================

/**
 * Crea un sorteo en estado 'draft'. Si ya había un draft para esta
 * (competition, cupRound), lo reemplaza.
 *
 * @returns {Promise<number>} draw_id creado
 */
export async function createDraftDraw({
  competitionId,
  cupRound,
  seed,
  potsConfig,
  pairings,
  notes = null,
}) {
  const { getSupabaseClient } = await import('./supabase-client.js');
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase.rpc('create_draft_draw', {
    p_competition_id: competitionId,
    p_cup_round: cupRound,
    p_seed: seed,
    p_pots_config: potsConfig,
    p_pairings: pairings,
    p_notes: notes,
  });
  if (error) {
    throw new Error(`create_draft_draw failed: ${error.message}`);
  }
  return data;
}

/**
 * Publica el sorteo: crea matches (cup_round=N) y enlaza match_uuid en pairings.
 */
export async function publishDraw(drawId) {
  const { getSupabaseClient } = await import('./supabase-client.js');
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase.rpc('publish_draw', { p_draw_id: drawId });
  if (error) {
    throw new Error(`publish_draw failed: ${error.message}`);
  }
  return data;
}

/** Borra un draft. No permite borrar publicados. */
export async function deleteDraftDraw(drawId) {
  const { getSupabaseClient } = await import('./supabase-client.js');
  const supabase = await getSupabaseClient();
  const { error } = await supabase.rpc('delete_draft_draw', { p_draw_id: drawId });
  if (error) {
    throw new Error(`delete_draft_draw failed: ${error.message}`);
  }
}

// ============================================================
// Loaders
// ============================================================

/**
 * Carga el sorteo publicado de una (competition, ronda) junto con sus pairings.
 * Devuelve `null` si no existe.
 */
export async function loadPublishedDraw({ competitionId, cupRound }) {
  const { getSupabaseClient } = await import('./supabase-client.js');
  const supabase = await getSupabaseClient();
  const { data: draw, error } = await supabase
    .from('competition_draws')
    .select('id, competition_id, cup_round, status, seed, pots_config, performed_at, published_at')
    .eq('competition_id', competitionId)
    .eq('cup_round', cupRound)
    .eq('status', 'published')
    .maybeSingle();
  if (error) {
    console.warn('[competition-draw] loadPublishedDraw error:', error.message);
    return null;
  }
  if (!draw) return null;

  const { data: pairings, error: perr } = await supabase
    .from('competition_draw_pairings')
    .select('id, draw_order, home_team_id, away_team_id, home_pot, away_pot, match_uuid')
    .eq('draw_id', draw.id)
    .order('draw_order', { ascending: true });

  if (perr) {
    console.warn('[competition-draw] loadPublishedDraw pairings error:', perr.message);
    return { ...draw, pairings: [] };
  }
  return { ...draw, pairings: pairings || [] };
}

/** Variante para previsualizar drafts (admin). */
export async function loadDraftDraw({ competitionId, cupRound }) {
  const { getSupabaseClient } = await import('./supabase-client.js');
  const supabase = await getSupabaseClient();
  const { data: draw, error } = await supabase
    .from('competition_draws')
    .select('id, competition_id, cup_round, status, seed, pots_config, performed_at')
    .eq('competition_id', competitionId)
    .eq('cup_round', cupRound)
    .eq('status', 'draft')
    .maybeSingle();
  if (error || !draw) return null;

  const { data: pairings } = await supabase
    .from('competition_draw_pairings')
    .select('id, draw_order, home_team_id, away_team_id, home_pot, away_pot')
    .eq('draw_id', draw.id)
    .order('draw_order', { ascending: true });

  return { ...draw, pairings: pairings || [] };
}
