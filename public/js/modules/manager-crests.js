// Resuelve el escudo del club asignado a cada manager para una temporada
// concreta. Si no se indica season, usa la temporada activa (seasons.is_active).
//
// Cuando una página pinta "el logo del equipo" (que en este torneo es la cara
// del manager humano), preferimos el crest del club real de la temporada que
// se esté visualizando. Si no hay registro para esa temporada, caemos a la
// última temporada conocida que sea ≤ la pedida (nunca a una temporada
// futura), para que pre-poblar la próxima temporada no contamine las vistas
// de temporadas actuales/pasadas.
//
// Fallback final: si no hay ninguna temporada ≤ la pedida, devolvemos
// `img/{slug(nickname)}.png` para preservar el comportamiento histórico
// (la foto personal del manager).

import { getSupabaseClient } from './supabase-client.js';
import { slugify, normalizeText } from './utils.js';

const STORAGE_KEY = 'managerCrestMap.offline.v1';
const STORAGE_TTL_MS = 10 * 60 * 1000; // 10 min

let inMemoryState = null;
let inFlight = null;

const keyFor = (name) => normalizeText(name);
const buildLocalLogo = (name) => name ? `img/${slugify(name)}.png` : '';

function readFromSession() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    if (Date.now() - (parsed.ts || 0) > STORAGE_TTL_MS) return null;
    return parsed.state || null;
  } catch {
    return null;
  }
}

function writeToSession(state) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ ts: Date.now(), state }));
  } catch {
    // Quota o sessionStorage deshabilitado: ignorar.
  }
}

async function fetchState() {
  // liga-offline: no hay `users`/`user_season_clubs` (sistema de managers
  // excluido). El "escudo del equipo" es el crest del club del `league_team`
  // (clubs.crest_url, ya apuntando a un fichero local tras import-crests.mjs).
  // Mapa keyed por nickname del league_team → crest por temporada.
  const supabase = await getSupabaseClient();

  const [{ data: teams, error: teamsErr }, { data: seasonsRows, error: seasonsErr }] = await Promise.all([
    supabase
      .from('league_teams')
      .select('nickname, display_name, season, club:clubs(crest_url)'),
    supabase
      .from('seasons')
      .select('name, is_active')
      .eq('is_active', true)
      .limit(1)
  ]);

  if (teamsErr || !Array.isArray(teams)) {
    return { activeSeason: null, map: {} };
  }

  const activeSeason = (!seasonsErr && seasonsRows && seasonsRows[0]?.name) || null;

  const map = {};
  const addName = (name, season, crest) => {
    if (!name || !season || !crest) return;
    const key = keyFor(name);
    if (!map[key]) map[key] = { bySeason: {}, seasonsAsc: [] };
    map[key].bySeason[season] = crest;
  };
  for (const t of teams) {
    const crest = t?.club?.crest_url;
    if (!crest || !t.season) continue;
    // Indexar por nickname y por display_name (las páginas usan uno u otro).
    addName(t.nickname, t.season, crest);
    addName(t.display_name, t.season, crest);
  }
  for (const key of Object.keys(map)) {
    map[key].seasonsAsc = Object.entries(map[key].bySeason)
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      .map(([season, crest]) => ({ season, crest }));
  }
  return { activeSeason, map };
}

export async function loadCrestMap() {
  if (inMemoryState) return inMemoryState;
  if (inFlight) return inFlight;

  const cached = readFromSession();
  if (cached) {
    inMemoryState = cached;
    return inMemoryState;
  }

  inFlight = (async () => {
    try {
      const state = await fetchState();
      inMemoryState = state;
      writeToSession(state);
      return state;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

// Devuelve el nombre de la temporada activa (seasons.is_active). Útil para
// callers que necesitan saberlo (manager.html, managers.html...).
export function getActiveSeason() {
  return inMemoryState?.activeSeason || null;
}

// Síncrono. SOLO devuelve algo si `loadCrestMap()` ya se ha resuelto.
// - Si pasas `season`, busca el crest para esa temporada.
// - Si no la pasas, usa la temporada activa (seasons.is_active).
// - Si no hay registro exacto, cae a la última temporada conocida ≤ la
//   efectiva (nunca a una temporada futura).
export function getCrest(teamOrNickname, season) {
  if (!inMemoryState || !teamOrNickname) return '';
  const entry = inMemoryState.map[keyFor(teamOrNickname)];
  if (!entry) return '';

  const effective = season || inMemoryState.activeSeason;
  if (!effective) {
    // Sin season de referencia: devuelve la más reciente que tengamos.
    const last = entry.seasonsAsc[entry.seasonsAsc.length - 1];
    return last?.crest || '';
  }

  if (entry.bySeason[effective]) return entry.bySeason[effective];

  // Buscar la última temporada conocida ≤ effective.
  let result = '';
  for (const row of entry.seasonsAsc) {
    if (String(row.season).localeCompare(String(effective)) <= 0) {
      result = row.crest;
    } else {
      break;
    }
  }
  return result;
}

// Devuelve el crest del club si está disponible para la season (o cualquier
// season ≤ la pedida/activa); si no, el png personal (img/{slug(nick)}.png).
// Asume que `loadCrestMap()` ya ha sido llamado.
export function getCrestOrLogo(teamOrNickname, season) {
  return getCrest(teamOrNickname, season) || buildLocalLogo(teamOrNickname);
}
