import { getSupabaseClient } from './supabase-client.js';

// Tramos de 15' + descuento. El minuto solo es fiable desde la temporada
// 2026-27 (ver memoria goal-minute-stats-design); los own_goal nunca traen
// minuto, así que quedan fuera del histograma por diseño.
export const TRAMOS = [
  { label: '1-15', min: 1, max: 15 },
  { label: '16-30', min: 16, max: 30 },
  { label: '31-45', min: 31, max: 45 },
  { label: '46-60', min: 46, max: 60 },
  { label: '61-75', min: 61, max: 75 },
  { label: '76-90', min: 76, max: 90 },
  { label: '90+', min: 91, max: Infinity },
];

export function bucketizeMinutes(minutes) {
  const buckets = TRAMOS.map(t => ({ label: t.label, count: 0 }));
  (minutes || []).forEach(m => {
    if (m == null) return;
    const idx = TRAMOS.findIndex(t => m >= t.min && m <= t.max);
    if (idx >= 0) buckets[idx].count++;
  });
  return buckets;
}

export async function fetchGoalMinutesByLeagueTeamIds(leagueTeamIds) {
  if (!leagueTeamIds || !leagueTeamIds.length) return [];
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from('goal_events')
    .select('minute')
    .in('league_team_id', leagueTeamIds)
    .eq('event_type', 'goal')
    .not('minute', 'is', null);
  if (error) { console.warn('[goal-timing-stats] league_team_ids:', error.message); return []; }
  return (data || []).map(r => r.minute);
}

export async function fetchGoalMinutesByCompetition(competitionId) {
  if (!competitionId) return [];
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from('goal_events')
    .select('minute')
    .eq('competition_id', competitionId)
    .eq('event_type', 'goal')
    .not('minute', 'is', null);
  if (error) { console.warn('[goal-timing-stats] competition:', error.message); return []; }
  return (data || []).map(r => r.minute);
}

export async function fetchGoalMinutesByPlayer(playerId) {
  if (!playerId) return [];
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from('goal_events')
    .select('minute')
    .eq('player_id', playerId)
    .eq('event_type', 'goal')
    .not('minute', 'is', null);
  if (error) { console.warn('[goal-timing-stats] player:', error.message); return []; }
  return (data || []).map(r => r.minute);
}

export async function fetchTopScorersForCompetition(competitionId, limit = 40) {
  if (!competitionId) return [];
  const supabase = await getSupabaseClient();
  const { data, error } = await supabase
    .from('goal_events')
    .select('player_id, players(name)')
    .eq('competition_id', competitionId)
    .eq('event_type', 'goal')
    .not('player_id', 'is', null);
  if (error) { console.warn('[goal-timing-stats] top scorers:', error.message); return []; }

  const byPlayer = new Map();
  (data || []).forEach(r => {
    if (!byPlayer.has(r.player_id)) {
      byPlayer.set(r.player_id, { player_id: r.player_id, name: r.players?.name || `Jugador ${r.player_id}`, goals: 0 });
    }
    byPlayer.get(r.player_id).goals++;
  });
  return [...byPlayer.values()].sort((a, b) => b.goals - a.goals).slice(0, limit);
}

/**
 * Reconstruye la cronología de gol de cada partido jugado de la competición.
 * Descarta partidos donde la reconstrucción a partir de eventos con minuto no
 * cuadra con el marcador real (típicamente un own_goal sin minuto), para no
 * dar un "primer gol" o una "remontada" falsos.
 */
export async function fetchMatchTimelines(competitionId) {
  if (!competitionId) return [];
  const supabase = await getSupabaseClient();

  const { data: matches, error: mErr } = await supabase
    .from('matches')
    .select('match_uuid, id, home_league_team_id, away_league_team_id, home_goals, away_goals')
    .eq('competition_id', competitionId)
    .eq('is_played', true)
    .or('resolved_administratively.is.null,resolved_administratively.eq.false')
    .not('home_goals', 'is', null)
    .not('away_goals', 'is', null);
  if (mErr) { console.warn('[goal-timing-stats] timelines matches:', mErr.message); return []; }

  const played = (matches || []).filter(m => (m.home_goals + m.away_goals) > 0);
  if (!played.length) return [];

  const matchUuids = played.map(m => m.match_uuid).filter(Boolean);
  const { data: events, error: eErr } = await supabase
    .from('goal_events')
    .select('match_uuid, minute, league_team_id, event_type')
    .in('match_uuid', matchUuids)
    .in('event_type', ['goal', 'own_goal'])
    .not('minute', 'is', null);
  if (eErr) console.warn('[goal-timing-stats] timelines events:', eErr.message);

  const byMatch = new Map();
  (events || []).forEach(e => {
    if (!byMatch.has(e.match_uuid)) byMatch.set(e.match_uuid, []);
    byMatch.get(e.match_uuid).push(e);
  });

  return played
    .map(m => {
      const evs = (byMatch.get(m.match_uuid) || []).slice().sort((a, b) => a.minute - b.minute);
      let homeReconstructed = 0, awayReconstructed = 0;
      evs.forEach(e => {
        if (e.league_team_id === m.home_league_team_id) homeReconstructed++;
        else if (e.league_team_id === m.away_league_team_id) awayReconstructed++;
      });
      const complete = homeReconstructed === m.home_goals && awayReconstructed === m.away_goals;
      return { ...m, events: evs, complete };
    })
    .filter(m => m.complete && m.events.length > 0);
}

export function computeFirstGoalOutcome(timelines) {
  let gana = 0, empata = 0, pierde = 0;
  (timelines || []).forEach(m => {
    const first = m.events[0];
    const firstIsHome = first.league_team_id === m.home_league_team_id;
    const diff = m.home_goals - m.away_goals;
    const forFirstScorer = firstIsHome ? diff : -diff;
    if (forFirstScorer > 0) gana++;
    else if (forFirstScorer === 0) empata++;
    else pierde++;
  });
  return { gana, empata, pierde, total: gana + empata + pierde };
}

export function computeComebacks(timelines) {
  const results = [];
  (timelines || []).forEach(m => {
    let diff = 0, minDiff = 0, maxDiff = 0;
    m.events.forEach(e => {
      diff += e.league_team_id === m.home_league_team_id ? 1 : -1;
      minDiff = Math.min(minDiff, diff);
      maxDiff = Math.max(maxDiff, diff);
    });
    const finalDiff = m.home_goals - m.away_goals;
    // Remontada = empezó perdiendo y acabó ganando (no cuenta si solo empata).
    const homeComeback = minDiff < 0 && finalDiff > 0;
    const awayComeback = maxDiff > 0 && finalDiff < 0;
    if (homeComeback || awayComeback) {
      results.push({ ...m, side: homeComeback ? 'home' : 'away' });
    }
  });
  return results;
}

export function renderTramoChart(container, minutes, { emptyMessage } = {}) {
  if (!container) return;
  const buckets = bucketizeMinutes(minutes);
  const total = buckets.reduce((s, b) => s + b.count, 0);
  if (!total) {
    container.innerHTML = `<p class="tramo-chart-empty">${emptyMessage || 'Todavía no hay goles con minuto registrado.'}</p>`;
    return;
  }
  const max = Math.max(...buckets.map(b => b.count));
  container.innerHTML = `
    <div class="tramo-chart" role="img" aria-label="Goles por tramo del partido">
      ${buckets.map(b => `
        <div class="tramo-chart__col">
          <div class="tramo-chart__value">${b.count}</div>
          <div class="tramo-chart__bar" style="height:${Math.max(8, Math.round((b.count / max) * 100))}%"></div>
          <div class="tramo-chart__label">${b.label}</div>
        </div>
      `).join('')}
    </div>
    <p class="tramo-chart-total">${total} gol${total === 1 ? '' : 'es'} con minuto registrado</p>
  `;
}
