// -----------------------------
// METEO Helpers
// -----------------------------
//
// Cache por día en localStorage (TTL 24h). Solo se cachean los hits exitosos
// para no envenenar el cache con errores transitorios. El consumidor debe
// llamar solo para partidos de HOY (`matchIsToday()` en resultados-ui).
//
// Formato:
//   localStorage["meteo-cache-v1"] = {
//     "barcelona|2026-04-29": { cat: { label, emoji }, ts: <ms> },
//     ...
//   }

const CACHE_KEY = 'meteo-cache-v1';
const TTL_MS = 24 * 60 * 60 * 1000;

const memCache = new Map(); // key (city|date) -> {label,emoji} | null

function todayKey() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function readPersistentCache() {
    try {
        const raw = localStorage.getItem(CACHE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return parsed && typeof parsed === 'object' ? parsed : {};
    } catch { return {}; }
}

function writePersistentCache(obj) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(obj)); } catch { /* quota or disabled */ }
}

function prune(obj) {
    const now = Date.now();
    const next = {};
    for (const [k, v] of Object.entries(obj)) {
        if (v && typeof v.ts === 'number' && (now - v.ts) < TTL_MS) {
            next[k] = v;
        }
    }
    return next;
}

export const weatherCodeToCategory = (code) => {
    if (code == null) return null;
    const c = Number(code);

    if (c === 0) return { label: "Despejado", emoji: "☀️" };
    if ([1, 2, 3].includes(c)) return { label: "Nublado", emoji: "⛅" };
    if ([45, 48].includes(c)) return { label: "Niebla", emoji: "🌫️" };

    if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82, 95, 96, 99].includes(c))
        return { label: "Lluvia", emoji: "🌧️" };

    if ([71, 73, 75, 77, 85, 86].includes(c))
        return { label: "Nieve", emoji: "❄️" };

    return { label: "Variable", emoji: "🌥️" };
};

/**
 * Devuelve la categoría meteo de hoy para una ciudad.
 * - Cache en memoria (instant) y localStorage (persistente, TTL 24h).
 * - Devuelve `null` si la ciudad no se geocodifica, no hay datos, o falla la red.
 *   El consumidor debe esconder el placeholder cuando reciba `null`.
 */
export const fetchWeatherForCity = async (cityName) => {
    if (!cityName) return null;

    const cityKey = String(cityName).toLowerCase().trim();
    const date = todayKey();
    const fullKey = `${cityKey}|${date}`;

    // 1) Cache en memoria
    if (memCache.has(fullKey)) return memCache.get(fullKey);

    // 2) Cache persistente
    const persistent = prune(readPersistentCache());
    if (persistent[fullKey]) {
        memCache.set(fullKey, persistent[fullKey].cat);
        return persistent[fullKey].cat;
    }

    // 3) Fetch
    try {
        const geoUrl =
            `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityName)}&count=1&language=es&format=json`;
        const geoRes = await fetch(geoUrl);
        if (!geoRes.ok) throw new Error(`Geo HTTP ${geoRes.status}`);
        const geo = await geoRes.json();
        const loc = geo?.results?.[0];
        if (!loc) {
            memCache.set(fullKey, null); // negativo en mem (no persistente)
            return null;
        }

        const lat = loc.latitude;
        const lon = loc.longitude;

        const meteoUrl = `https://api.open-meteo.com/v1/forecast?latitude=${encodeURIComponent(lat)}&longitude=${encodeURIComponent(lon)}&current_weather=true`;
        const meteoRes = await fetch(meteoUrl);
        if (!meteoRes.ok) throw new Error(`Meteo HTTP ${meteoRes.status}`);
        const meteoData = await meteoRes.json();

        const cat = weatherCodeToCategory(meteoData?.current_weather?.weathercode);
        if (cat) {
            memCache.set(fullKey, cat);
            persistent[fullKey] = { cat, ts: Date.now() };
            writePersistentCache(persistent);
            return cat;
        }
    } catch (e) {
        // Errores de red / API: log silencioso, devolvemos null para que el caller esconda el placeholder.
        console.debug('Meteo fetch falló para', cityName, e?.message || e);
    }

    memCache.set(fullKey, null);
    return null;
};

/**
 * Devuelve true si la fecha (Date|string YYYY-MM-DD|ISO) coincide con hoy en local timezone.
 */
export function isToday(dateLike) {
    if (!dateLike) return false;
    let d;
    if (dateLike instanceof Date) d = dateLike;
    else d = new Date(dateLike);
    if (isNaN(d.getTime())) return false;
    const now = new Date();
    return d.getFullYear() === now.getFullYear()
        && d.getMonth() === now.getMonth()
        && d.getDate() === now.getDate();
}
