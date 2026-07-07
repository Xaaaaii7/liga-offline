/**
 * Asignación de árbitros a partidos.
 *
 * Solo se ejecuta para competiciones de la temporada 2026-27 en adelante.
 * Para cada partido sin árbitro asignado de la competición:
 *   - Determina el pool candidato según el nombre de la competición:
 *     · "Voll Damm" → árbitros tier='voll'
 *     · "Estrella Damm" → árbitros tier='estrella' (incluye Playoff)
 *     · Resto (Copa Epidor, etc.) → pool común de los 12
 *   - Agrupa los partidos por round_id y, dentro de cada jornada, asigna un
 *     árbitro distinto a cada partido (random sin repetición dentro de la
 *     jornada). Si una jornada tiene más partidos que árbitros candidatos,
 *     el pool se recicla.
 *
 * La operación es idempotente: solo toca partidos con referee_id IS NULL.
 * El override manual desde admin sobrescribe sin que esta función lo deshaga.
 */

import { getSupabaseClient } from './supabase-client.js';

const SEASON_FROM = '2026-27';

/**
 * Asigna árbitros a los partidos sin árbitro de la competición indicada.
 * Idempotente: si todos los partidos ya tienen árbitro, no hace nada.
 *
 * @param {number} competitionId
 * @returns {Promise<{assigned: number, skipped: boolean, reason?: string}>}
 */
export async function assignRefereesForCompetition(competitionId) {
    if (!competitionId) return { assigned: 0, skipped: true, reason: 'no_competition_id' };
    const supabase = await getSupabaseClient();

    const { data: comp, error: compErr } = await supabase
        .from('competitions')
        .select('id, name, season')
        .eq('id', competitionId)
        .single();

    if (compErr || !comp) {
        return { assigned: 0, skipped: true, reason: 'competition_not_found' };
    }
    if (comp.season < SEASON_FROM) {
        return { assigned: 0, skipped: true, reason: 'season_too_early' };
    }

    const { data: matches, error: matchesErr } = await supabase
        .from('matches')
        .select('match_uuid, round_id')
        .eq('competition_id', competitionId)
        .is('referee_id', null);

    if (matchesErr) {
        console.error('[referee-assigner] error fetching matches', matchesErr);
        return { assigned: 0, skipped: true, reason: 'matches_query_error' };
    }
    if (!matches || matches.length === 0) {
        return { assigned: 0, skipped: true, reason: 'no_unassigned_matches' };
    }

    const tier = inferTier(comp.name);
    let refQuery = supabase.from('referees').select('id, tier');
    if (tier) refQuery = refQuery.eq('tier', tier);
    const { data: refs, error: refsErr } = await refQuery;

    if (refsErr) {
        console.error('[referee-assigner] error fetching referees', refsErr);
        return { assigned: 0, skipped: true, reason: 'refs_query_error' };
    }
    if (!refs || refs.length === 0) {
        return { assigned: 0, skipped: true, reason: 'no_referees_in_pool' };
    }

    const byRound = new Map();
    for (const m of matches) {
        const round = m.round_id ?? 0;
        if (!byRound.has(round)) byRound.set(round, []);
        byRound.get(round).push(m);
    }

    const updates = [];
    for (const roundMatches of byRound.values()) {
        const pool = shuffle([...refs]);
        for (let i = 0; i < roundMatches.length; i++) {
            const ref = pool[i % pool.length];
            updates.push({ matchUuid: roundMatches[i].match_uuid, refereeId: ref.id });
        }
    }

    // Aplicamos en paralelo; cada update es independiente.
    // Filtramos por match_uuid (PK) — matches.id es text y se repite entre
    // competiciones, así que un .eq('id', ...) afectaría al partido equivalente
    // en otras competiciones que todavía estuvieran sin árbitro.
    const results = await Promise.all(updates.map(u =>
        supabase.from('matches')
            .update({ referee_id: u.refereeId })
            .eq('match_uuid', u.matchUuid)
    ));
    const failed = results.filter(r => r.error);
    if (failed.length) {
        console.error('[referee-assigner] some updates failed', failed.map(r => r.error));
    }

    return { assigned: updates.length - failed.length, skipped: false };
}

/**
 * Determina el tier de árbitros candidato para una competición a partir de su
 * nombre. Devuelve null si la competición acepta el pool común (Copa Epidor,
 * otros torneos puntuales).
 *
 * @param {string} competitionName
 * @returns {'voll'|'estrella'|null}
 */
function inferTier(competitionName) {
    if (!competitionName) return null;
    if (/voll\s*damm/i.test(competitionName)) return 'voll';
    if (/estrella\s*damm/i.test(competitionName)) return 'estrella';
    return null;
}

function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}
