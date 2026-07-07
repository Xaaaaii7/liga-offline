/**
 * Helpers de datos para el sistema de afición por club.
 *
 * Tablas: team_fanbase_state, team_fan_event, team_fan_manager_sentiment,
 *         team_fan_player_opinion, team_fan_referee_sentiment.
 *
 * El estado vive normalizado en BD; aquí solo carga y formato.
 */

import { getSupabaseClient } from './supabase-client.js';

/** Buckets de mood para el display (umbrales coordinados con el algoritmo). */
const MOOD_BUCKETS = [
    { min: 85, label: 'Eufórica',     tone: 'euphoric' },
    { min: 70, label: 'Contenta',     tone: 'happy' },
    { min: 55, label: 'Esperanzada',  tone: 'hopeful' },
    { min: 45, label: 'Neutral',      tone: 'neutral' },
    { min: 30, label: 'Decepcionada', tone: 'disappointed' },
    { min: 15, label: 'Enfadada',     tone: 'angry' },
    { min: 0,  label: 'Deprimida',    tone: 'depressed' },
];

export function moodBucket(score) {
    const s = Number(score) || 0;
    for (const b of MOOD_BUCKETS) {
        if (s >= b.min) return b;
    }
    return MOOD_BUCKETS[MOOD_BUCKETS.length - 1];
}

export function objectiveLabel(obj) {
    return {
        title:     'Lucha por el título',
        europe:    'Aspira a la zona alta',
        mid_table: 'Pelea por la zona media',
        survival:  'Lucha por la permanencia',
        promotion: 'Aspira al ascenso',
    }[obj] || obj;
}

export function sentimentBucket(score) {
    const s = Number(score) || 0;
    if (s >= 60)  return { label: 'Ídolo', tone: 'love' };
    if (s >= 30)  return { label: 'Querido', tone: 'fond' };
    if (s >= 10)  return { label: 'Bien valorado', tone: 'positive' };
    if (s >= -10) return { label: 'Neutral', tone: 'neutral' };
    if (s >= -30) return { label: 'Cuestionado', tone: 'negative' };
    if (s >= -60) return { label: 'Rechazado', tone: 'hostile' };
    return { label: 'Persona non grata', tone: 'pariah' };
}

/**
 * Carga el estado completo de la afición de un club para la temporada activa
 * (o la temporada especificada). Devuelve null si no hay fanbase para ese club.
 */
export async function loadFanbaseForClub(clubId, season) {
    const supabase = await getSupabaseClient();

    const { data: state, error: stateErr } = await supabase
        .from('team_fanbase_state')
        .select('*')
        .eq('club_id', clubId)
        .eq('season', season)
        .maybeSingle();

    if (stateErr) {
        console.error('[fanbase-data] state error', stateErr);
        return null;
    }
    if (!state) return null;

    // Sentiment hacia el manager actual y últimos eventos en paralelo.
    const [managerRes, eventsRes] = await Promise.all([
        state.user_id
            ? supabase.from('team_fan_manager_sentiment')
                .select('score, last_updated_at, notes')
                .eq('club_id', clubId)
                .eq('manager_user_id', state.user_id)
                .maybeSingle()
            : Promise.resolve({ data: null }),
        supabase.from('team_fan_event')
            .select('id, kind, headline_text, mood_delta, snapshot_mood_after, occurred_at, source_match_uuid, payload')
            .eq('club_id', clubId)
            .eq('season', season)
            .order('occurred_at', { ascending: false })
            .limit(12),
    ]);

    return {
        state,
        managerSentiment: managerRes.data || null,
        events: eventsRes.data || [],
    };
}

/**
 * Para la página del jugador: todas las opiniones de afición sobre él,
 * cross-club y cross-season. Ordenado por temporada descendente.
 */
export async function loadPlayerOpinionsForPlayer(playerId) {
    const supabase = await getSupabaseClient();
    const { data, error } = await supabase
        .from('team_fan_player_opinion')
        .select(`
            score, season, last_updated_at,
            club:clubs(id, name, short_name, crest_url)
        `)
        .eq('player_id', playerId)
        .order('season', { ascending: false })
        .order('score', { ascending: false });
    if (error) {
        console.error('[fanbase-data] player opinions cross-club error', error);
        return [];
    }
    return data || [];
}

/**
 * Para la página del manager: todas las aficiones que tienen una opinión sobre
 * él (clubes actuales y pasados que ha dirigido). Cada entrada incluye el club.
 */
export async function loadManagerSentimentsForUser(userId) {
    const supabase = await getSupabaseClient();
    const { data, error } = await supabase
        .from('team_fan_manager_sentiment')
        .select(`
            score, last_updated_at, notes,
            club:clubs(id, name, short_name, crest_url)
        `)
        .eq('manager_user_id', userId)
        .order('last_updated_at', { ascending: false });
    if (error) {
        console.error('[fanbase-data] manager sentiments error', error);
        return [];
    }
    return data || [];
}

/**
 * Top ídolos y top criticados de la temporada actual para un club.
 * Devuelve { idols: [...], scapegoats: [...] }.
 */
export async function loadPlayerOpinionsForClub(clubId, season, limit = 3) {
    const supabase = await getSupabaseClient();
    const { data, error } = await supabase
        .from('team_fan_player_opinion')
        .select(`
            score, last_updated_at,
            player:players(id, name)
        `)
        .eq('club_id', clubId)
        .eq('season', season)
        .order('score', { ascending: false });

    if (error || !data) {
        if (error) console.error('[fanbase-data] player opinions error', error);
        return { idols: [], scapegoats: [] };
    }
    const idols = data.slice(0, limit);
    const scapegoats = [...data].sort((a, b) => a.score - b.score).slice(0, limit);
    return { idols, scapegoats };
}

/**
 * Mood delta reciente (últimos N eventos vs estado actual). Útil para mostrar
 * "↑3 esta jornada" o similar.
 */
export function recentMoodDelta(events, n = 1) {
    if (!events?.length) return 0;
    return events.slice(0, n).reduce((acc, e) => acc + (e.mood_delta || 0), 0);
}

// ─── Sentiments externos (animadversión hacia rivales) ──────────────────────

/**
 * Bucket para sentiments bipolares hacia clubes/managers rivales (-100..100).
 * Score muy negativo = animadversión alta; positivo = respeto/admiración hacia
 * el rival (raro pero posible).
 */
export function rivalBucket(score) {
    const s = Number(score) || 0;
    if (s <= -60) return { label: 'Bestia negra', tone: 'pariah' };
    if (s <= -30) return { label: 'Enemigo',      tone: 'hostile' };
    if (s <= -10) return { label: 'Hostil',       tone: 'negative' };
    if (s <   10) return { label: 'Neutral',      tone: 'neutral' };
    if (s <   30) return { label: 'Respeto',      tone: 'positive' };
    return { label: 'Admirado', tone: 'fond' };
}

/**
 * Bucket para opinion unipolar 0..100 hacia jugadores rivales. 50 = neutral,
 * >50 = animadversión, <50 = respeto/indiferencia.
 */
export function hostilePlayerBucket(score) {
    const s = Number(score) || 50;
    if (s >= 80) return { label: 'Pesadilla',   tone: 'pariah' };
    if (s >= 65) return { label: 'Odiado',      tone: 'hostile' };
    if (s >= 55) return { label: 'Antipático',  tone: 'negative' };
    if (s >= 45) return { label: 'Indiferente', tone: 'neutral' };
    return            { label: 'Respetado',  tone: 'positive' };
}

/**
 * Para entidad.html: top-N clubes/managers/jugadores rivales más odiados por
 * la afición de un club. Devuelve { clubs, managers, players }.
 *
 * - clubs y managers: orden ascendente por score (más negativo primero).
 * - players (season-scoped): orden descendente por score (más alto primero).
 */
export async function loadRivalsForClub(clubId, season, limit = 3) {
    const supabase = await getSupabaseClient();

    const clubsQ = supabase.from('team_fan_external_club_sentiment')
        .select(`
            score, last_updated_at,
            target:clubs!team_fan_external_club_sentiment_club_id_target_fkey(id, name, short_name, crest_url)
        `)
        .eq('club_id_fan', clubId)
        .order('score', { ascending: true });
    const managersQ = supabase.from('team_fan_external_manager_sentiment')
        .select(`
            score, last_updated_at,
            manager:users(id, nickname)
        `)
        .eq('club_id_fan', clubId)
        .order('score', { ascending: true });
    const playersQ = supabase.from('team_fan_external_player_opinion')
        .select(`
            score, last_updated_at,
            player:players(id, name)
        `)
        .eq('club_id_fan', clubId)
        .eq('season', season)
        .order('score', { ascending: false });
    const refereesQ = supabase.from('team_fan_referee_sentiment')
        .select(`
            score, last_updated_at,
            referee:referees(id, first_name, last_name, nickname)
        `)
        .eq('club_id', clubId)
        .order('score', { ascending: true });

    const [clubsRes, managersRes, playersRes, refereesRes] = await Promise.all([
        limit == null ? clubsQ : clubsQ.limit(limit),
        limit == null ? managersQ : managersQ.limit(limit),
        limit == null ? playersQ : playersQ.limit(limit),
        limit == null ? refereesQ : refereesQ.limit(limit),
    ]);

    if (clubsRes.error) console.error('[fanbase-data] rivals clubs', clubsRes.error);
    if (managersRes.error) console.error('[fanbase-data] rivals managers', managersRes.error);
    if (playersRes.error) console.error('[fanbase-data] rivals players', playersRes.error);
    if (refereesRes.error) console.error('[fanbase-data] rivals referees', refereesRes.error);

    return {
        clubs: (clubsRes.data || []).filter(r => r.score < 0),
        managers: (managersRes.data || []).filter(r => r.score < 0),
        players: (playersRes.data || []).filter(r => r.score > 50),
        referees: (refereesRes.data || []).filter(r => r.score < 0),
    };
}

/**
 * Equivalente a loadRivalsForClub pero para sentimientos POSITIVOS: clubes,
 * managers y árbitros con score > 0. No incluye jugadores (la opinion externa
 * de jugadores rivales raramente cae por debajo de 50; el respeto explícito
 * no es una mecánica que tengamos para jugadores).
 */
export async function loadAlliesForClub(clubId, limit = 3) {
    const supabase = await getSupabaseClient();

    const clubsQ = supabase.from('team_fan_external_club_sentiment')
        .select(`
            score, last_updated_at,
            target:clubs!team_fan_external_club_sentiment_club_id_target_fkey(id, name, short_name, crest_url)
        `)
        .eq('club_id_fan', clubId)
        .gt('score', 0)
        .order('score', { ascending: false });
    const managersQ = supabase.from('team_fan_external_manager_sentiment')
        .select(`
            score, last_updated_at,
            manager:users(id, nickname)
        `)
        .eq('club_id_fan', clubId)
        .gt('score', 0)
        .order('score', { ascending: false });
    const refereesQ = supabase.from('team_fan_referee_sentiment')
        .select(`
            score, last_updated_at,
            referee:referees(id, first_name, last_name, nickname)
        `)
        .eq('club_id', clubId)
        .gt('score', 0)
        .order('score', { ascending: false });

    const [clubsRes, managersRes, refereesRes] = await Promise.all([
        limit == null ? clubsQ : clubsQ.limit(limit),
        limit == null ? managersQ : managersQ.limit(limit),
        limit == null ? refereesQ : refereesQ.limit(limit),
    ]);

    if (clubsRes.error) console.error('[fanbase-data] allies clubs', clubsRes.error);
    if (managersRes.error) console.error('[fanbase-data] allies managers', managersRes.error);
    if (refereesRes.error) console.error('[fanbase-data] allies referees', refereesRes.error);

    return {
        clubs: clubsRes.data || [],
        managers: managersRes.data || [],
        referees: refereesRes.data || [],
    };
}

/**
 * Para arbitro.html: aficiones de clubes que tienen sentiment hacia este
 * árbitro. Devuelve filas ordenadas por score ascendente (más hostil primero).
 */
export async function loadFanSentimentsForReferee(refereeId) {
    const supabase = await getSupabaseClient();
    const { data, error } = await supabase
        .from('team_fan_referee_sentiment')
        .select(`
            score, last_updated_at,
            club:clubs(id, name, short_name, crest_url)
        `)
        .eq('referee_id', refereeId)
        .order('score', { ascending: true });
    if (error) {
        console.error('[fanbase-data] referee sentiments', error);
        return [];
    }
    return data || [];
}

/**
 * Para manager.html: aficiones de clubes rivales (no dirigidos por el manager)
 * que tienen sentiment hacia este usuario. Devuelve filas ordenadas por score
 * ascendente (más negativo primero).
 */
export async function loadExternalManagerSentimentsForUser(userId) {
    const supabase = await getSupabaseClient();
    const { data, error } = await supabase
        .from('team_fan_external_manager_sentiment')
        .select(`
            score, last_updated_at,
            club:clubs(id, name, short_name, crest_url)
        `)
        .eq('manager_user_id', userId)
        .order('score', { ascending: true });
    if (error) {
        console.error('[fanbase-data] external manager sentiments', error);
        return [];
    }
    return data || [];
}

/**
 * Para jugador.html: aficiones rivales que tienen opinion hacia este jugador,
 * cross-season. Devuelve filas con score (0..100), season y club.
 */
export async function loadExternalOpinionsForPlayer(playerId) {
    const supabase = await getSupabaseClient();
    const { data, error } = await supabase
        .from('team_fan_external_player_opinion')
        .select(`
            score, season, last_updated_at,
            club:clubs(id, name, short_name, crest_url)
        `)
        .eq('player_id', playerId)
        .order('season', { ascending: false })
        .order('score', { ascending: false });
    if (error) {
        console.error('[fanbase-data] external player opinions', error);
        return [];
    }
    return data || [];
}

/**
 * Para admin.html: catálogo completo de club_derbies con info de ambos clubes.
 */
export async function loadDerbies() {
    const supabase = await getSupabaseClient();
    const { data, error } = await supabase
        .from('club_derbies')
        .select(`
            club_a_id, club_b_id, name, base_animadversion, created_at,
            club_a:clubs!club_derbies_club_a_id_fkey(id, name, short_name, crest_url),
            club_b:clubs!club_derbies_club_b_id_fkey(id, name, short_name, crest_url)
        `)
        .order('base_animadversion', { ascending: true });
    if (error) {
        console.error('[fanbase-data] derbies', error);
        return [];
    }
    return data || [];
}
