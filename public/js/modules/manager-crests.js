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

const STORAGE_KEY = 'managerCrestMap.v3';
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
  const supabase = await getSupabaseClient();

  const [{ data: users, error: usersErr }, { data: seasonsRows, error: seasonsErr }] = await Promise.all([
    supabase
      .from('users')
      .select(`
        nickname,
        user_season_clubs(
          season,
          club:clubs(crest_url)
        )
      `),
    supabase
      .from('seasons')
      .select('name, is_active')
      .eq('is_active', true)
      .limit(1)
  ]);

  if (usersErr || !Array.isArray(users)) {
    return { activeSeason: null, map: {} };
  }

  const activeSeason = (!seasonsErr && seasonsRows && seasonsRows[0]?.name) || null;

  const map = {};
  for (const u of users) {
    if (!u.nickname) continue;
    const rows = (u.user_season_clubs || [])
      .filter(r => r?.club?.crest_url && r.season)
      // Orden ascendente por season para que findLast funcione
      .sort((a, b) => String(a.season).localeCompare(String(b.season)));
    if (!rows.length) continue;

    const bySeason = {};
    const seasonsAsc = [];
    for (const r of rows) {
      bySeason[r.season] = r.club.crest_url;
      seasonsAsc.push({ season: r.season, crest: r.club.crest_url });
    }
    map[keyFor(u.nickname)] = { bySeason, seasonsAsc };
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
