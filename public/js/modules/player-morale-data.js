/**
 * Helpers de datos para moral del jugador y roles asignados por el manager.
 *
 * Tablas:
 *   team_player_roles      → roles editables sin login (anon insert/update)
 *   player_morale_state    → solo lectura desde UI
 *   player_morale_event    → solo lectura desde UI
 *
 * Caps via trigger BD (cooldown 24h por jugador, 20/día por club). Si se viola,
 * el upsert falla con error 'check_violation' y la UI debe mostrar el mensaje.
 */

import { getSupabaseClient } from './supabase-client.js';

export const ROLE_LABELS = {
    pilar:          'Pilar',
    rotacion:       'Rotación',
    joven_promesa:  'Joven promesa',
    descarte:       'Descarte',
    recuperacion:   'Recuperación',
};

export const ROLE_DESCRIPTIONS = {
    pilar:          'Titular indiscutible. La suplencia inesperada le duele más.',
    rotacion:       'Entra y sale. No le afecta no jugar.',
    joven_promesa:  'Positivos amplificados, negativos amortiguados.',
    descarte:       'Confirmas que no cuenta. Ausencias no penalizan.',
    recuperacion:   'Lesión / baja. Moral congelada mientras dure.',
};

/**
 * Buckets cualitativos derivados del score (0..100). Devuelve {key, label, tone}.
 * Usar también en jugador.html para el badge.
 */
export function moraleBucket(score) {
    if (score == null) return { key: 'unknown', label: 'Sin datos', tone: 'unknown' };
    const s = Number(score);
    if (!Number.isFinite(s)) return { key: 'unknown', label: 'Sin datos', tone: 'unknown' };
    if (s >= 85)             return { key: 'euforico',   label: 'Eufórico',   tone: 'great' };
    if (s >= 65)             return { key: 'motivado',   label: 'Motivado',   tone: 'good' };
    if (s >= 45)             return { key: 'estable',    label: 'Estable',    tone: 'neutral' };
    if (s >= 25)             return { key: 'apatico',    label: 'Apático',    tone: 'meh' };
    if (s >= 10)             return { key: 'desinflado', label: 'Desinflado', tone: 'bad' };
    return                          { key: 'hundido',    label: 'Hundido',    tone: 'awful' };
}

/**
 * Carga el squad de un club en una temporada con su rol asignado (si hay) y
 * su moral actual (si hay). Devuelve array de {player_id, name, position,
 * date_of_birth, nationality, role, role_note, morale_score}.
 *
 * No incluye jugadores sin membership activa en esa season.
 */
export async function loadSquadWithRolesAndMorale(clubId, season) {
    if (!clubId || !season) return [];
    const supabase = await getSupabaseClient();

    const { data: membs, error: membErr } = await supabase
        .from('player_club_memberships')
        .select(`
            player:players(id, name, position, date_of_birth, nationality)
        `)
        .eq('club_id', clubId)
        .eq('season',  season)
        .eq('is_current', true);

    if (membErr) {
        console.warn('Error cargando memberships:', membErr);
        return [];
    }

    const squad = (membs || [])
        .map(m => m.player)
        .filter(Boolean);

    if (!squad.length) return [];

    const playerIds = squad.map(p => p.id);

    const [rolesRes, moraleRes] = await Promise.all([
        supabase
            .from('team_player_roles')
            .select('player_id, role, note')
            .eq('club_id', clubId)
            .eq('season',  season),
        supabase
            .from('player_morale_state')
            .select('player_id, score')
            .eq('season', season)
            .in('player_id', playerIds),
    ]);

    const roleMap   = new Map((rolesRes.data || []).map(r => [r.player_id, r]));
    const moraleMap = new Map((moraleRes.data || []).map(m => [m.player_id, m.score]));

    return squad.map(p => ({
        ...p,
        role:          roleMap.get(p.id)?.role || null,
        role_note:     roleMap.get(p.id)?.note || null,
        morale_score:  moraleMap.has(p.id) ? moraleMap.get(p.id) : null,
    }));
}

/**
 * UPSERT del rol de un jugador. role=null borra la fila (no_role = default).
 * Lanza el error original si el trigger de caps se dispara, para que la UI
 * pueda leerlo (error.message contiene el RAISE EXCEPTION).
 */
export async function upsertPlayerRole({ clubId, playerId, season, role, note = null }) {
    if (!clubId || !playerId || !season) {
        throw new Error('clubId, playerId y season son obligatorios');
    }
    const supabase = await getSupabaseClient();

    if (role == null) {
        const { error } = await supabase
            .from('team_player_roles')
            .delete()
            .eq('club_id', clubId)
            .eq('player_id', playerId)
            .eq('season', season);
        if (error) throw error;
        return null;
    }

    const { data, error } = await supabase
        .from('team_player_roles')
        .upsert({
            club_id:   clubId,
            player_id: playerId,
            season,
            role,
            note:      note || null,
        }, { onConflict: 'club_id,player_id,season' })
        .select('player_id, role, note')
        .maybeSingle();
    if (error) throw error;
    return data;
}

/**
 * Convierte el slug de `player_morale_event.reason` + payload en una frase
 * humana. Devuelve string corto.
 */
export function humanizeMoraleReason(ev) {
    if (!ev) return '';
    const { kind, reason, payload } = ev;

    // Comunicados
    if (kind === 'statement_own_manager' || kind === 'statement_neutral_manager' || kind === 'statement_rival_manager') {
        const tone = payload?.tone || (reason || '').split('_').pop();
        const TONE = {
            agradecimiento: 'le agradeció públicamente',
            declaracion:    'habló sobre él',
            ironia:         'lanzó una ironía sobre él',
            queja:          'se quejó de él en público',
            provocacion:    'le provocó públicamente',
        }[tone] || `le mencionó (${tone || '?'})`;
        const SRC = {
            statement_own_manager:     'Su manager',
            statement_neutral_manager: 'Otro manager',
            statement_rival_manager:   'Un manager rival',
        }[kind];
        return `${SRC} ${TONE}`;
    }

    if (kind === 'role_change') {
        const roleNew = payload?.role_new;
        const roleOld = payload?.role_old;
        if (roleOld) return `El manager le cambió de ${ROLE_LABELS[roleOld] || roleOld} a ${ROLE_LABELS[roleNew] || roleNew}`;
        if (roleNew) return `El manager le declaró ${ROLE_LABELS[roleNew] || roleNew}`;
        return 'Cambio de rol del manager';
    }

    if (kind === 'manual') return 'Ajuste manual del admin';
    if (kind === 'decay')  return 'Tendencia natural al baseline';

    // Match
    if (kind === 'match') {
        const status = payload?.status;
        const result = payload?.result;
        const goals  = payload?.goals  ?? 0;
        const reds   = payload?.reds   ?? 0;
        const yellows = payload?.yellows ?? 0;
        const rating = payload?.rating;
        const gf     = payload?.gf;
        const ga     = payload?.ga;

        const STATUS = {
            starter:    'Titular',
            sub_played: 'Suplente que entró',
            not_played: 'No jugó',
        }[status] || 'En el partido';
        const RESULT = {
            W: 'en victoria',
            D: 'en empate',
            L: 'en derrota',
        }[result] || '';

        const score = (gf != null && ga != null) ? `${gf}-${ga}` : '';
        const extras = [];
        if (goals > 0)   extras.push(goals === 1 ? 'marcó' : `marcó ${goals} goles`);
        if (rating != null) extras.push(`rating ${Number(rating).toFixed(1)}`);
        if (reds > 0)    extras.push('vio roja');
        else if (yellows > 0) extras.push(yellows === 1 ? 'amarilla' : `${yellows} amarillas`);

        const tail = extras.length ? ` · ${extras.join(', ')}` : '';
        return `${STATUS} ${RESULT}${score ? ` (${score})` : ''}${tail}`.trim();
    }

    return reason || kind || '';
}

/**
 * Map player_id → role para todos los jugadores de un club en una temporada.
 * Útil para enriquecer una plantilla ya cargada por otro flujo.
 */
export async function loadRolesForClub(clubId, season) {
    if (!clubId || !season) return new Map();
    const supabase = await getSupabaseClient();
    const { data, error } = await supabase
        .from('team_player_roles')
        .select('player_id, role, note')
        .eq('club_id', clubId)
        .eq('season',  season);
    if (error) {
        console.warn('Error cargando roles:', error);
        return new Map();
    }
    return new Map((data || []).map(r => [r.player_id, r]));
}

/**
 * Map player_id → score para un conjunto de jugadores en una temporada.
 */
export async function loadMoraleForPlayers(playerIds, season) {
    if (!playerIds?.length || !season) return new Map();
    const supabase = await getSupabaseClient();
    const { data, error } = await supabase
        .from('player_morale_state')
        .select('player_id, score')
        .eq('season', season)
        .in('player_id', playerIds);
    if (error) {
        console.warn('Error cargando moral states:', error);
        return new Map();
    }
    return new Map((data || []).map(m => [m.player_id, m.score]));
}

/**
 * Últimos N eventos de moral de un jugador en una temporada (para mostrar
 * historial en jugador.html). Default 5.
 */
export async function loadRecentMoraleEvents(playerId, season, limit = 5) {
    if (!playerId || !season) return [];
    const supabase = await getSupabaseClient();
    const { data, error } = await supabase
        .from('player_morale_event')
        .select('id, kind, delta, reason, score_after, occurred_at, source_match_uuid, source_statement_id, payload')
        .eq('player_id', playerId)
        .eq('season', season)
        .order('occurred_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit);
    if (error) {
        console.warn('Error cargando eventos de moral:', error);
        return [];
    }
    return data || [];
}

/**
 * Moral actual de un jugador en una temporada. null si no hay state.
 */
export async function loadMoraleStateForPlayer(playerId, season) {
    if (!playerId || !season) return null;
    const supabase = await getSupabaseClient();
    const { data, error } = await supabase
        .from('player_morale_state')
        .select('score, last_event_at')
        .eq('player_id', playerId)
        .eq('season', season)
        .maybeSingle();
    if (error) {
        console.warn('Error cargando moral state:', error);
        return null;
    }
    return data;
}
