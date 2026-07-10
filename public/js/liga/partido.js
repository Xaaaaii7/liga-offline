/**
 * partido.js — Página de detalle de partido
 * URL: partido.html?comp={slug}&match={matchId}
 */

import { getSupabaseClient } from '../modules/supabase-client.js';
import {
  getCompetitionFromURL,
  buildURLWithCompetition,
  buildBreadcrumb,
  renderBreadcrumb,
  navigateWithCompetition
} from '../modules/competition-context.js';
import { getCompetitionBySlug } from '../modules/competition-data.js';
import { loadCompetitionTheme } from '../modules/theme-loader.js';
import { isCompetitionAdmin } from '../modules/competition-permissions.js';
import { FORMATION_TEMPLATES, groupFromPosition } from '../modules/formation.js';
import {
  loadScorerStateForMatch,
  getScorerState,
  addGoalToState,
  changeGoalCount,
  removeScorer,
  setGoalMinute,
  addRedCardToState,
  removeRedCardFromState,
  setRedCardMinute,
  addYellowCardToState,
  removeYellowCardFromState,
  setYellowCardMinute,
  addInjuryToState,
  removeInjuryFromState,
  saveScorersToSupabase,
  saveRedCardsFull,
  saveYellowCardsFull,
  saveInjuriesFull,
  saveMatchResult,
  getSupa
} from '../modules/resultados-data.js';
import { logoPath, fmtDate, playerLink, escapeHtml } from '../modules/utils.js';
import { renderMarkdown, looksLikeMarkdown } from '../modules/markdown.js';
import { getSection } from '../modules/news-meta.js';
// liga-offline: sin clips de vídeo (clip-modal/clip-url excluidos). Stubs.
const clipCdnUrl = () => '';
const openClipModal = () => {};

// URL safe para usar en href: rechaza javascript: / data: / vbscript:.
const safeUrl = (url) => {
  if (!url) return '#';
  const s = String(url).trim();
  return /^(https?:|\/|\.\/|\.\.\/|#|mailto:)/i.test(s) ? s : '#';
};

// ────────────────────────────────────────────────────────
// INIT
// ────────────────────────────────────────────────────────

(async () => {
  const root = document.getElementById('partido-root');
  if (!root) return;

  // Leer parámetros de la URL
  const params = new URLSearchParams(window.location.search);
  const competitionSlug = getCompetitionFromURL();
  const matchId = params.get('match');

  if (!competitionSlug || !matchId) {
    root.innerHTML = `<p class="partido-error">Partido no encontrado. Parámetros incorrectos en la URL.</p>`;
    return;
  }

  // Cargar competición
  let competition, competitionId, isRanked, isAdmin;
  try {
    competition = await getCompetitionBySlug(competitionSlug);
    if (!competition) throw new Error('Competición no encontrada');
    competitionId = competition.id;
    isRanked = competition.competition_type === 'ranked';
    await loadCompetitionTheme(competitionId);
    isAdmin = await isCompetitionAdmin(competitionId);
  } catch (e) {
    root.innerHTML = `<p class="partido-error">Error al cargar la competición: ${escapeHtml(e.message)}</p>`;
    return;
  }

  // Cargar datos del partido
  const supa = await getSupabaseClient();

  const { data: matchArr, error: matchErr } = await supa
    .from('matches')
    // Sin embed round:rounds!matches_round_id_fkey (offline no tiene esa FK,
    // daría 400). round_id ya es el número de jornada directamente.
    .select('*')
    .eq('id', matchId)
    .eq('competition_id', competitionId)
    .limit(1);

  if (matchErr || !matchArr?.length) {
    root.innerHTML = `<p class="partido-error">Partido no encontrado.</p>`;
    return;
  }
  const match = matchArr[0];
  const matchUuid = match.match_uuid;
  const homeTeamId = match.home_league_team_id;
  const awayTeamId = match.away_league_team_id;
  const homeGoals = match.home_goals;
  const awayGoals = match.away_goals;
  const isPlayed = homeGoals !== null && awayGoals !== null;

  // Cargar equipos, goleadores, ratings, stats, rojas, amarillas, otros partidos de la jornada — en paralelo
  const otherJornadaPromise = match.round_id != null
    ? supa.from('matches')
        .select(`
          id, home_league_team_id, away_league_team_id, home_goals, away_goals, match_date, match_time,
          home:league_teams!matches_home_league_team_id_fkey(id, nickname, display_name, clubs(name, crest_url)),
          away:league_teams!matches_away_league_team_id_fkey(id, nickname, display_name, clubs(name, crest_url))
        `)
        .eq('competition_id', competitionId)
        .eq('round_id', match.round_id)
        .neq('id', matchId)
        .order('match_date', { ascending: true })
    : Promise.resolve({ data: [] });

  const refereePromise = match.referee_id
    ? supa.from('referees').select('id, first_name, last_name, nickname').eq('id', match.referee_id).maybeSingle()
    : Promise.resolve({ data: null });

  const [
    teamsResult,
    goalEventsResult,
    ratingsResult,
    teamStatsResult,
    redCardsResult,
    yellowCardsResult,
    otherJornadaResult,
    refereeResult,
    subsResult
  ] = await Promise.all([
    supa.from('league_teams').select('id, club_id, display_name, nickname, clubs(name, crest_url)').in('id', [homeTeamId, awayTeamId]),
    supa.from('goal_events').select('*, players(name)').eq('match_uuid', matchUuid).order('id'),
    supa.from('match_player_ratings')
      .select('id, player_name, rating, league_team_id, player_id, players(position)')
      .eq('match_uuid', matchUuid)
      .order('id', { ascending: true }),
    supa.from('match_team_stats').select('*').eq('match_uuid', matchUuid),
    supa.from('match_red_cards').select('player_id, league_team_id, minute').eq('match_uuid', matchUuid),
    supa.from('match_yellow_cards').select('player_id, league_team_id, minute').eq('match_uuid', matchUuid),
    otherJornadaPromise,
    refereePromise,
    supa.from('match_substitutions').select('player_off_id, player_on_id, league_team_id, minute').eq('match_uuid', matchUuid).order('minute')
  ]);

  const teams = teamsResult.data || [];
  const goalEvents = goalEventsResult.data || [];
  const ratingsRaw = ratingsResult.data || [];
  const teamStats = teamStatsResult.data || [];
  const redCardsData = redCardsResult.data || [];
  const yellowCardsData = yellowCardsResult.data || [];
  const substitutionsData = subsResult.data || [];
  const otherJornadaMatches = otherJornadaResult.data || [];
  const cronicas = []; // offline: sin sistema de noticias/crónicas
  match.refereeInfo = refereeResult?.data || null;

  const normalizeTeam = (raw, fallbackName) => raw
    ? { id: raw.id, club_id: raw.club_id ?? null, name: raw.nickname || raw.display_name || raw.clubs?.name || fallbackName, logo_url: raw.clubs?.crest_url || null }
    : { id: null, club_id: null, name: fallbackName, logo_url: null };
  const homeTeam = normalizeTeam(teams.find(t => t.id === homeTeamId), 'Local');
  const awayTeam = normalizeTeam(teams.find(t => t.id === awayTeamId), 'Visitante');

  // Breadcrumb
  const breadcrumbContainer = document.createElement('div');
  breadcrumbContainer.className = 'breadcrumb-container';
  breadcrumbContainer.style.marginBottom = '12px';
  root.insertAdjacentElement('beforebegin', breadcrumbContainer);
  const breadcrumbItems = buildBreadcrumb(competitionSlug, competition.name, 'Partido');
  renderBreadcrumb(breadcrumbContainer, breadcrumbItems);

  // Título de página
  const headerTitle = document.getElementById('partido-header-title');
  if (headerTitle) headerTitle.textContent = `${homeTeam.name} vs ${awayTeam.name}`;

  // ── Construir la página ──
  root.innerHTML = buildPageHTML(
    match, matchId, matchUuid,
    homeTeam, awayTeam,
    homeGoals, awayGoals, isPlayed,
    goalEvents, ratingsRaw,
    competitionSlug, competition.name,
    isRanked, isAdmin,
    cronicas.length > 0
  );

  // Tabs
  initTabs(root);

  // Renderizar resumen (tab default)
  renderResumen(root, {
    teamStats, ratingsRaw, goalEvents,
    homeTeam, awayTeam, homeTeamId, awayTeamId,
    otherJornadaMatches, competitionSlug,
    isPlayed, jornadaNumber: match.round?.number ?? match.round_id
  });

  // Renderizar crónica (solo si existe; el tab solo se pinta en ese caso)
  if (cronicas.length) {
    renderCronica(root, cronicas).catch(e => console.warn('[partido] cronica:', e?.message));
  }

  // Renderizar alineación
  renderLineup(root, ratingsRaw, redCardsData, yellowCardsData, homeTeam, awayTeam, homeTeamId, awayTeamId);

  // Renderizar stats
  renderStats(root, teamStats, homeTeam, awayTeam, homeTeamId, awayTeamId);

  // Renderizar eventos (timeline)
  renderEventos(root, {
    goalEvents, redCardsData, yellowCardsData, substitutionsData, ratingsRaw,
    homeTeamId, awayTeamId, isPlayed, season: competition?.season
  });

  // Renderizar valoraciones
  renderRatings(root, ratingsRaw, homeTeam, awayTeam, homeTeamId, awayTeamId, isAdmin, matchId, matchUuid, competitionId, competition.season);

  // Renderizar historial (H2H)
  await renderHistorial(root, homeTeamId, awayTeamId, homeTeam, awayTeam, matchUuid);

  // Renderizar directo/video
  renderStream(root, match);

  // Renderizar highlights (la pestaña solo existe si hay highlights_url)
  renderHighlights(root, match);

  // Renderizar apuestas (predicciones de managers)
  renderApuestasTab(root, {
    matchUuid, isPlayed, homeTeam, awayTeam,
    season: competition?.season,
  }).catch(e => console.warn('[partido] apuestas:', e?.message));

  // Mini-strip sticky (desktop) cuando el hero sale del viewport
  initMiniStrip(root, { homeTeam, awayTeam, homeGoals, awayGoals, isPlayed });

  // Renderizar editor (admin)
  if (isAdmin) {
    await initEditTab(root, matchId, matchUuid, match, homeTeam, awayTeam,
      homeTeamId, awayTeamId, competitionId, isRanked, homeGoals, awayGoals);
  }

  // liga-offline: sin comunicados de managers (sistema excluido).

})();

async function renderPartidoComunicados(matchUuid) {
  const { loadStatementsForMatch, TONE_LABELS } = await import('../modules/manager-statements-data.js');
  const rows = await loadStatementsForMatch(matchUuid);
  if (!rows.length) return;
  const root = document.getElementById('partido-comunicados');
  if (!root) return;
  root.innerHTML = `
    <section class="partido-comunicados-section">
      <h3 class="partido-section-title">Comunicados sobre este partido</h3>
      <div class="com-feed">
        ${rows.map(s => {
          const author = s.manager?.nickname || `User #${s.manager_user_id}`;
          const date = s.created_at ? new Date(s.created_at).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' }) : '';
          const toneLabel = s.tone ? TONE_LABELS[s.tone] || s.tone : null;
          return `
            <article class="com-card">
              <header class="com-card-head">
                <span class="com-card-manager">${escapeHtml(author)}</span>
                ${toneLabel ? `<span class="com-tone-pill">${escapeHtml(toneLabel)}</span>` : ''}
                <span class="com-card-date muted">${escapeHtml(date)}</span>
              </header>
              <p class="com-card-body">${escapeHtml(s.body)}</p>
            </article>
          `;
        }).join('')}
      </div>
    </section>
  `;
}

// ────────────────────────────────────────────────────────
// Predicciones del partido (Fase 3 manager_voice)
// ────────────────────────────────────────────────────────

async function renderApuestasTab(root, { matchUuid, isPlayed, homeTeam, awayTeam, season }) {
  const panel = root.querySelector('#panel-apuestas');
  if (!panel || matchUuid == null) return;

  const mod = await import('../modules/manager-predictions-data.js');
  const {
    KIND_LABELS, RESOLUTION_LABELS,
    loadPredictionsForMatch, loadManagersForSeason, loadPlayersForMatch,
    upsertPrediction,
  } = mod;

  const [preds, managers, players] = await Promise.all([
    loadPredictionsForMatch(matchUuid),
    isPlayed ? Promise.resolve([]) : loadManagersForSeason(season),
    isPlayed ? Promise.resolve([]) : loadPlayersForMatch(homeTeam?.club_id, awayTeam?.club_id, season),
  ]);

  const nameMap = await resolveScorerNames(preds);

  const formHTML = isPlayed ? '' : buildPredictionForm({ managers });
  const trendsHTML = await buildPredictionTrends(preds, homeTeam, awayTeam);
  const listHTML = buildPredictionsList(preds, { isPlayed, KIND_LABELS, RESOLUTION_LABELS, homeTeam, awayTeam, nameMap });

  panel.innerHTML = `
    <div class="apuestas-wrap">
      ${formHTML}
      ${trendsHTML}
      ${listHTML}
    </div>
  `;

  if (!isPlayed) {
    bindPredictionForm({
      matchUuid, players, homeTeam, awayTeam, upsertPrediction,
      refresh: async () => {
        const refreshed = await loadPredictionsForMatch(matchUuid);
        const refreshedNames = await resolveScorerNames(refreshed);
        const listEl = panel.querySelector('.pred-list');
        if (listEl) listEl.outerHTML = buildPredictionsList(refreshed, { isPlayed, KIND_LABELS, RESOLUTION_LABELS, homeTeam, awayTeam, nameMap: refreshedNames });
      },
    });
  }
}

function buildPredictionForm({ managers }) {
  const managerOpts = '<option value="">— elige —</option>' +
    managers.map(m => `<option value="${m.id}">${escapeHtml(m.nickname || `User #${m.id}`)}</option>`).join('');
  return `
    <div class="pred-form-wrap">
      <form id="pred-form" class="pred-form">
        <div class="pred-row">
          <label for="pred-manager">Manager</label>
          <select id="pred-manager" required>${managerOpts}</select>
        </div>
        <div class="pred-row">
          <label for="pred-kind">Tipo de predicción</label>
          <select id="pred-kind" required>
            <option value="winner_1x2">Ganador 1X2</option>
            <option value="exact_score">Resultado exacto</option>
            <option value="scorer">Marca un jugador</option>
          </select>
        </div>
        <div class="pred-row" id="pred-kind-fields"></div>
        <div class="pred-row pred-actions">
          <button type="submit" class="pred-submit-btn">Guardar predicción</button>
          <span id="pred-form-msg" class="pred-form-msg muted"></span>
        </div>
      </form>
    </div>
  `;
}

function renderKindFields(kind, players, homeTeam, awayTeam) {
  if (kind === 'winner_1x2') {
    return `
      <label>Resultado</label>
      <select id="pred-winner">
        <option value="home">Gana ${escapeHtml(homeTeam?.name || 'local')}</option>
        <option value="draw">Empate</option>
        <option value="away">Gana ${escapeHtml(awayTeam?.name || 'visitante')}</option>
      </select>
    `;
  }
  if (kind === 'exact_score') {
    return `
      <label>Marcador exacto (a 90')</label>
      <div class="pred-score-inputs">
        <input type="number" id="pred-score-home" min="0" max="20" placeholder="${escapeHtml(homeTeam?.name || 'L')}" required />
        <span class="pred-score-sep">–</span>
        <input type="number" id="pred-score-away" min="0" max="20" placeholder="${escapeHtml(awayTeam?.name || 'V')}" required />
      </div>
    `;
  }
  if (kind === 'scorer') {
    const playersFor = (clubId) => players.filter(p => p.club_id === clubId);
    const groups = [
      { label: homeTeam?.name || 'Local', list: playersFor(homeTeam?.club_id) },
      { label: awayTeam?.name || 'Visitante', list: playersFor(awayTeam?.club_id) },
    ];
    const opts = '<option value="">— elige jugador —</option>' +
      groups.map(g => g.list.length
        ? `<optgroup label="${escapeHtml(g.label)}">${g.list.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('')}</optgroup>`
        : ''
      ).join('');
    return `
      <label>Jugador que marcará</label>
      <select id="pred-scorer" required>${opts}</select>
    `;
  }
  return '';
}

function bindPredictionForm({ matchUuid, players, homeTeam, awayTeam, refresh, upsertPrediction }) {
  const form = document.getElementById('pred-form');
  if (!form) return;
  const kindSel = document.getElementById('pred-kind');
  const fieldsWrap = document.getElementById('pred-kind-fields');
  const msg = document.getElementById('pred-form-msg');

  // Render inicial (winner_1x2 por defecto)
  fieldsWrap.innerHTML = renderKindFields(kindSel.value, players, homeTeam, awayTeam);

  kindSel?.addEventListener('change', () => {
    fieldsWrap.innerHTML = renderKindFields(kindSel.value, players, homeTeam, awayTeam);
  });

  form.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    msg.textContent = '';
    msg.classList.remove('pred-form-error', 'pred-form-ok');
    const manager_user_id = Number(document.getElementById('pred-manager').value);
    if (!manager_user_id) { setMsg(msg, 'Elige el manager.', true); return; }
    const kind = kindSel.value;
    let payload = null;
    if (kind === 'winner_1x2') {
      const outcome = document.getElementById('pred-winner')?.value;
      if (!['home','draw','away'].includes(outcome)) { setMsg(msg, 'Elige un resultado.', true); return; }
      payload = { outcome };
    } else if (kind === 'exact_score') {
      const h = parseInt(document.getElementById('pred-score-home')?.value, 10);
      const a = parseInt(document.getElementById('pred-score-away')?.value, 10);
      if (!Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0) { setMsg(msg, 'Marcador inválido.', true); return; }
      payload = { home: h, away: a };
    } else if (kind === 'scorer') {
      const player_id = Number(document.getElementById('pred-scorer')?.value);
      if (!player_id) { setMsg(msg, 'Elige un jugador.', true); return; }
      payload = { player_id };
    } else {
      setMsg(msg, 'Tipo de predicción inválido.', true); return;
    }

    const res = await upsertPrediction({
      manager_user_id, match_uuid: matchUuid,
      prediction_kind: kind, prediction_payload: payload,
    });
    if (!res.ok) {
      setMsg(msg, res.error || 'Error al guardar', true);
      return;
    }
    setMsg(msg, res.action === 'updated' ? 'Predicción actualizada.' : 'Predicción guardada.', false);
    await refresh();
  });
}

function setMsg(el, text, isError) {
  el.textContent = text;
  el.classList.toggle('pred-form-error', !!isError);
  el.classList.toggle('pred-form-ok', !isError);
}

function describePrediction(p, ctx = {}) {
  const { homeTeam, awayTeam, nameMap } = ctx;
  const homeName = homeTeam?.name || 'local';
  const awayName = awayTeam?.name || 'visitante';
  const k = p.prediction_kind;
  const pl = p.prediction_payload || {};
  if (k === 'winner_1x2') {
    return pl.outcome === 'home' ? `Gana ${homeName}` : pl.outcome === 'away' ? `Gana ${awayName}` : 'Empate';
  }
  if (k === 'exact_score') return `${homeName} ${pl.home ?? '?'}–${pl.away ?? '?'} ${awayName} (a 90')`;
  if (k === 'scorer') {
    const nm = nameMap?.get(pl.player_id) || (pl.player_id != null ? `Jugador #${pl.player_id}` : '?');
    return `Marca ${nm}`;
  }
  return '?';
}

/**
 * Resuelve los nombres de los goleadores nominados en una tanda de
 * predicciones con una sola query batch. Devuelve Map<player_id, name>.
 */
async function resolveScorerNames(preds) {
  const ids = [...new Set((preds || [])
    .filter(p => p.prediction_kind === 'scorer')
    .map(p => p.prediction_payload?.player_id)
    .filter(id => id != null))];
  if (!ids.length) return new Map();
  const out = new Map();
  try {
    const { getSupabaseClient } = await import('../modules/supabase-client.js');
    const sb = await getSupabaseClient();
    const { data } = await sb.from('players').select('id, name').in('id', ids);
    for (const row of (data || [])) out.set(row.id, row.name);
  } catch (e) {
    console.warn('[apuestas] resolveScorerNames:', e?.message);
  }
  return out;
}

/**
 * Panel "Tendencias" — agregados por tipo. Se renderiza siempre que haya
 * al menos 1 predicción.
 *   winner_1x2  → % L / X / 2
 *   exact_score → resultados más votados (top 3)
 *   scorer      → jugadores más nominados (top 3, resuelve nombres)
 */
async function buildPredictionTrends(preds, homeTeam, awayTeam) {
  if (!preds?.length) return '';

  const byKind = { winner_1x2: [], exact_score: [], scorer: [] };
  for (const p of preds) {
    if (byKind[p.prediction_kind]) byKind[p.prediction_kind].push(p);
  }

  const sections = [];

  // ─── winner_1x2: porcentajes 1/X/2 ───
  if (byKind.winner_1x2.length) {
    const total = byKind.winner_1x2.length;
    const counts = { home: 0, draw: 0, away: 0 };
    for (const p of byKind.winner_1x2) {
      const o = p.prediction_payload?.outcome;
      if (counts[o] !== undefined) counts[o] += 1;
    }
    const pct = (n) => Math.round((n / total) * 100);
    const homeName = escapeHtml(homeTeam?.name || 'Local');
    const awayName = escapeHtml(awayTeam?.name || 'Visitante');
    sections.push(`
      <div class="trends-block">
        <h4 class="trends-block-title">Quiniela (1X2) · ${total} pronóstico${total === 1 ? '' : 's'}</h4>
        <div class="trends-bars">
          <div class="trends-bar"><span class="trends-bar-label">${homeName}</span><div class="trends-bar-track"><div class="trends-bar-fill" style="width:${pct(counts.home)}%"></div></div><span class="trends-bar-pct">${pct(counts.home)}% (${counts.home})</span></div>
          <div class="trends-bar"><span class="trends-bar-label">Empate</span><div class="trends-bar-track"><div class="trends-bar-fill" style="width:${pct(counts.draw)}%"></div></div><span class="trends-bar-pct">${pct(counts.draw)}% (${counts.draw})</span></div>
          <div class="trends-bar"><span class="trends-bar-label">${awayName}</span><div class="trends-bar-track"><div class="trends-bar-fill" style="width:${pct(counts.away)}%"></div></div><span class="trends-bar-pct">${pct(counts.away)}% (${counts.away})</span></div>
        </div>
      </div>
    `);
  }

  // ─── exact_score: top resultados más votados ───
  if (byKind.exact_score.length) {
    const counts = new Map();
    for (const p of byKind.exact_score) {
      const h = p.prediction_payload?.home;
      const a = p.prediction_payload?.away;
      if (h == null || a == null) continue;
      const key = `${h}–${a}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    const top = [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3);
    if (top.length) {
      sections.push(`
        <div class="trends-block">
          <h4 class="trends-block-title">Marcador exacto · ${byKind.exact_score.length} pronóstico${byKind.exact_score.length === 1 ? '' : 's'}</h4>
          <div class="trends-chips">
            ${top.map(([score, n], i) =>
              `<span class="trends-chip${i === 0 ? ' trends-chip-top' : ''}"><strong>${escapeHtml(score)}</strong> · ${n} voto${n === 1 ? '' : 's'}</span>`
            ).join('')}
          </div>
        </div>
      `);
    }
  }

  // ─── scorer: jugadores más nominados (resuelve nombre con 1 query batch) ───
  if (byKind.scorer.length) {
    const counts = new Map();
    for (const p of byKind.scorer) {
      const pid = p.prediction_payload?.player_id;
      if (pid == null) continue;
      counts.set(pid, (counts.get(pid) || 0) + 1);
    }
    if (counts.size) {
      // Resolver nombres
      const playerIds = [...counts.keys()];
      let nameMap = new Map();
      try {
        const { getSupabaseClient } = await import('../modules/supabase-client.js');
        const sb = await getSupabaseClient();
        const { data } = await sb.from('players').select('id, name').in('id', playerIds);
        for (const row of (data || [])) nameMap.set(row.id, row.name);
      } catch (e) {
        console.warn('[apuestas] scorer names:', e?.message);
      }
      const top = [...counts.entries()].sort((x, y) => y[1] - x[1]).slice(0, 3);
      sections.push(`
        <div class="trends-block">
          <h4 class="trends-block-title">¿Quién marcará? · ${byKind.scorer.length} pronóstico${byKind.scorer.length === 1 ? '' : 's'}</h4>
          <div class="trends-chips">
            ${top.map(([pid, n], i) => {
              const nm = nameMap.get(pid) || `Jugador #${pid}`;
              return `<span class="trends-chip${i === 0 ? ' trends-chip-top' : ''}"><strong>${escapeHtml(nm)}</strong> · ${n} voto${n === 1 ? '' : 's'}</span>`;
            }).join('')}
          </div>
        </div>
      `);
    }
  }

  if (!sections.length) return '';
  return `<div class="trends-wrap"><h3 class="trends-title">Tendencias del grupo</h3>${sections.join('')}</div>`;
}

function buildPredictionsList(preds, { isPlayed, KIND_LABELS, RESOLUTION_LABELS, homeTeam, awayTeam, nameMap }) {
  if (!preds.length) {
    return `<div class="pred-list pred-list-empty muted">${isPlayed ? 'Nadie predijo este partido.' : 'Aún no hay predicciones.'}</div>`;
  }
  return `
    <div class="pred-list">
      ${preds.map(p => {
        const author = p.manager?.nickname || `User #${p.manager_user_id}`;
        const kindLabel = KIND_LABELS[p.prediction_kind] || p.prediction_kind;
        const desc = describePrediction(p, { homeTeam, awayTeam, nameMap });
        let resBadge = '';
        let cardMod = '';
        if (p.resolved_at && p.resolution) {
          const label = RESOLUTION_LABELS[p.resolution] || p.resolution;
          resBadge = `<span class="pred-badge pred-badge-${p.resolution}">${escapeHtml(label)}</span>`;
          cardMod = ` pred-card-${p.resolution}`;
        }
        return `
          <article class="pred-card${cardMod}">
            <header class="pred-card-head">
              <span class="pred-author">${escapeHtml(author)}</span>
              <span class="pred-kind-pill">${escapeHtml(kindLabel)}</span>
              ${resBadge}
            </header>
            <div class="pred-body">${escapeHtml(desc)}</div>
          </article>
        `;
      }).join('')}
    </div>
  `;
}

// ────────────────────────────────────────────────────────
// HTML principal
// ────────────────────────────────────────────────────────

function buildPageHTML(match, matchId, matchUuid, homeTeam, awayTeam, homeGoals, awayGoals, isPlayed, goalEvents, ratingsRaw, compSlug, compName, isRanked, isAdmin, hasCronica) {
  const marcador = isPlayed ? `${homeGoals} – ${awayGoals}` : null;

  const fechaText = match.match_date ? fmtDate(match.match_date) : '';
  const horaText = match.match_time ? match.match_time.slice(0, 5) : '';
  const jornadaText = match.round_id ? `Jornada ${match.round?.number ?? match.round_id}` : '';
  const refInfo = match.refereeInfo;
  const refDisplayName = refInfo
    ? ([refInfo.first_name, refInfo.last_name].filter(Boolean).join(' ').trim() || refInfo.nickname || '')
    : '';
  const arbitroHTML = refInfo
    ? `<a class="partido-meta-referee" href="arbitro.html?id=${refInfo.id}">⚖️ ${escapeHtml(refDisplayName)}</a>`
    : '';
  const metaLine = [fechaText, horaText, jornadaText].filter(Boolean).join(' · ');

  // Construir mapa de player_id -> player_name desde ratings (que sí tienen nombres)
  const playerNameMap = {};
  ratingsRaw.forEach(r => {
    if (r.player_id && r.player_name) playerNameMap[r.player_id] = r.player_name;
  });

  // Goleadores desde goal_events (agrupados por player_id)
  const buildGoalersList = (events, teamId) => {
    const filtered = events.filter(g =>
      g.league_team_id === teamId &&
      (!g.event_type || g.event_type === 'goal' || g.event_type === 'penalty')
    );
    if (!filtered.length) return `<span class="partido-no-scorers">—</span>`;
    // Agrupar por player_id; resolver nombre desde players join, luego ratings map
    const byPlayer = {};
    filtered.forEach(g => {
      const key = g.player_id != null ? String(g.player_id) : `ev_${g.id}`;
      if (!byPlayer[key]) {
        byPlayer[key] = {
          id: g.player_id ?? null,
          name: g.players?.name || playerNameMap[g.player_id] || '?',
          count: 0
        };
      }
      byPlayer[key].count++;
    });
    return Object.values(byPlayer).map(({ id, name, count }) =>
      `<div class="partido-scorer-item"><span class="scorer-icon">⚽</span>${playerLink(id, name)}${count > 1 ? ` (${count})` : ''}</div>`
    ).join('');
  };

  const homeGoalersHtml = buildGoalersList(goalEvents, homeTeam.id);
  const awayGoalersHtml = buildGoalersList(goalEvents, awayTeam.id);

  const homeLogo = homeTeam.logo_url || logoPath(homeTeam.name);
  const awayLogo = awayTeam.logo_url || logoPath(awayTeam.name);

  // liga-offline: fuera Crónica (noticias), Vídeo/Highlights (clips),
  // Apuestas (quiniela) y Editar (OCR/admin — se usa entrar-resultado.html).
  const tabs = [
    { id: 'resumen', label: 'Resumen' },
    { id: 'alineacion', label: 'Alineación' },
    { id: 'stats', label: 'Stats' },
    { id: 'eventos', label: 'Eventos' },
    { id: 'valoraciones', label: 'Valoraciones' },
    { id: 'historial', label: 'H2H' }
  ];

  const tabsNav = tabs.map((t, i) =>
    `<button class="partido-tab-btn${i === 0 ? ' active' : ''}" data-tab="${t.id}">${t.label}</button>`
  ).join('');

  const tabPanels = tabs.map((t, i) =>
    `<div class="partido-tab-panel${i === 0 ? ' active' : ''}" id="panel-${t.id}"></div>`
  ).join('');

  const homeNameSafe = escapeHtml(homeTeam.name);
  const awayNameSafe = escapeHtml(awayTeam.name);

  return `
    <section class="partido-hero">
      <div class="partido-meta-comp">${escapeHtml(compName)}</div>

      <div class="partido-hero-main">
        <div class="partido-hero-team home">
          <img class="partido-hero-badge" src="${escapeHtml(safeUrl(homeLogo))}" alt="${homeNameSafe}" onerror="this.style.visibility='hidden'">
          <span class="partido-hero-team-name">${homeNameSafe}</span>
        </div>
        <div class="partido-hero-score">
          <div class="partido-hero-score-row">
            <span class="partido-hero-score-value">${isPlayed ? homeGoals : '–'}</span>
            <span class="partido-hero-score-sep">:</span>
            <span class="partido-hero-score-value">${isPlayed ? awayGoals : '–'}</span>
          </div>
          ${!isPlayed ? `<div class="partido-hero-pending">Pendiente</div>` : ''}
        </div>
        <div class="partido-hero-team away">
          <img class="partido-hero-badge" src="${escapeHtml(safeUrl(awayLogo))}" alt="${awayNameSafe}" onerror="this.style.visibility='hidden'">
          <span class="partido-hero-team-name">${awayNameSafe}</span>
        </div>
      </div>

      ${(metaLine || arbitroHTML)
        ? `<div class="partido-meta-line">${metaLine ? escapeHtml(metaLine) : ''}${arbitroHTML ? ` · ${arbitroHTML}` : ''}</div>`
        : ''}

      ${isPlayed ? `
        <div class="partido-hero-scorers">
          <div class="partido-scorers-col">
            <div class="partido-scorers-col-title">${homeNameSafe}</div>
            ${homeGoalersHtml}
          </div>
          <div class="partido-scorers-col" style="text-align:right">
            <div class="partido-scorers-col-title">${awayNameSafe}</div>
            ${awayGoalersHtml}
          </div>
        </div>
      ` : ''}
    </section>

    <div class="partido-tabs-area">
      <nav class="partido-tabs-nav">${tabsNav}</nav>
      ${tabPanels}
    </div>
  `;
}

// ────────────────────────────────────────────────────────
// TABS
// ────────────────────────────────────────────────────────

function initTabs(root) {
  const buttons = root.querySelectorAll('.partido-tab-btn');
  const panels = root.querySelectorAll('.partido-tab-panel');

  function activate(tabId) {
    buttons.forEach(b => b.classList.toggle('active', b.getAttribute('data-tab') === tabId));
    panels.forEach(p => p.classList.toggle('active', p.id === `panel-${tabId}`));
  }

  buttons.forEach(btn => {
    btn.addEventListener('click', () => {
      const tab = btn.getAttribute('data-tab');
      activate(tab);
    });
  });

  // Deep-link via ?tab=...
  const urlTab = new URLSearchParams(window.location.search).get('tab');
  if (urlTab && root.querySelector(`#panel-${urlTab}`)) {
    activate(urlTab);
  }
}

// ────────────────────────────────────────────────────────
// TAB: CRÓNICA
// ────────────────────────────────────────────────────────

async function renderCronica(root, cronicas) {
  const panel = root.querySelector('#panel-cronica');
  if (!panel || !cronicas?.length) return;

  // Hidratar periodistas (firma + sección por voz)
  const journalistIds = [...new Set(cronicas.map(c => c.journalist_id).filter(Boolean))];
  let journalistMap = new Map();
  if (journalistIds.length) {
    try {
      const supa = await getSupabaseClient();
      const { data: jrs } = await supa
        .from('journalists')
        .select('id, name, voice, avatar_url')
        .in('id', journalistIds);
      journalistMap = new Map((jrs ?? []).map(j => [j.id, j]));
    } catch (e) {
      console.warn('[partido] cronica journalists:', e?.message);
    }
  }

  panel.innerHTML = cronicas.map(c => {
    const j = journalistMap.get(c.journalist_id);
    const section = j ? getSection(j.voice) : null;
    const fecha = c.fecha ? fmtDate(c.fecha) : '';
    const bylineParts = [];
    if (j?.name) bylineParts.push(`Por <strong>${escapeHtml(j.name)}</strong>`);
    if (section) bylineParts.push(`<em>${escapeHtml(section)}</em>`);
    if (fecha) bylineParts.push(escapeHtml(fecha));
    const byline = bylineParts.length
      ? `<div class="cronica-byline">${bylineParts.join(' · ')}</div>` : '';
    const imgHtml = c.img
      ? `<img class="cronica-img" src="${escapeHtml(safeUrl(c.img))}" alt="${escapeHtml(c.titulo || '')}" onerror="this.style.display='none'">`
      : '';
    const resumenHtml = c.resumen
      ? `<p class="cronica-resumen"><em>${escapeHtml(c.resumen)}</em></p>` : '';
    const cuerpoHtml = looksLikeMarkdown(c)
      ? renderMarkdown(c.cuerpo || '')
      : (c.cuerpo || '');
    return `
      <article class="cronica-article">
        ${c.titulo ? `<h2 class="cronica-titulo">${escapeHtml(c.titulo)}</h2>` : ''}
        ${byline}
        ${imgHtml}
        ${resumenHtml}
        <div class="cronica-cuerpo news-article">${cuerpoHtml}</div>
      </article>
    `;
  }).join('');
}

// ────────────────────────────────────────────────────────
// TAB 1: ALINEACIÓN
// ────────────────────────────────────────────────────────

function renderLineup(root, ratingsRaw, redCardsData, yellowCardsData, homeTeam, awayTeam, homeTeamId, awayTeamId) {
  const panel = root.querySelector('#panel-alineacion');
  if (!panel) return;

  const homeRatings = ratingsRaw.filter(r => r.league_team_id === homeTeamId);
  const awayRatings = ratingsRaw.filter(r => r.league_team_id === awayTeamId);

  if (!homeRatings.length && !awayRatings.length) {
    panel.innerHTML = `<p class="partido-no-lineup">No hay datos de alineación para este partido.</p>`;
    return;
  }

  // Sets de player_ids con tarjeta
  const redCardPlayerIds = new Set(redCardsData.map(r => r.player_id).filter(Boolean));
  const yellowCardPlayerIds = new Set((yellowCardsData || []).map(y => y.player_id).filter(Boolean));

  const homeStarters = homeRatings.slice(0, 11);
  const homeSubs = homeRatings.slice(11);
  const awayStarters = awayRatings.slice(0, 11);
  const awaySubs = awayRatings.slice(11);

  // Agrupa el XI por línea (posición desconocida → medio, neutro).
  const groupStartersByLine = (starters) => {
    const byLine = { POR: [], DEF: [], MC: [], DEL: [] };
    starters.forEach(p => {
      const line = groupFromPosition(p.players?.position) || 'MC';
      byLine[line].push(p);
    });
    return byLine;
  };

  // Plantilla de slots con EXACTAMENTE los jugadores por línea que tiene el XI.
  // Si la composición coincide con una formación conocida, se usa su plantilla
  // (coordenadas cuidadas); si no, se generan posiciones repartidas. Así cada
  // jugador cae SIEMPRE en un slot de su propia línea y nunca hay overflow que
  // coloque, p.ej., un defensa en un hueco de delantero.
  const templateForCounts = (nDef, nMc, nDel) => {
    const key = `${nDef}-${nMc}-${nDel}`;
    if (FORMATION_TEMPLATES[key]) return FORMATION_TEMPLATES[key];
    const slots = [{ index: 0, line: 'POR', x: 50, y: 90 }];
    const band = (n, y, line) => {
      for (let i = 0; i < n; i++) {
        const x = n === 1 ? 50 : Math.round(14 + (72 * i) / (n - 1));
        slots.push({ index: slots.length, line, x, y });
      }
    };
    band(nDef, 74, 'DEF');
    band(nMc, 50, 'MC');
    band(nDel, 28, 'DEL');
    return slots;
  };

  // Asigna cada jugador a un slot de SU línea (garantizado por construcción).
  const assignSlots = (starters) => {
    const byLine = groupStartersByLine(starters);
    const template = templateForCounts(byLine.DEF.length, byLine.MC.length, byLine.DEL.length);
    const pools = {
      POR: [...byLine.POR], DEF: [...byLine.DEF], MC: [...byLine.MC], DEL: [...byLine.DEL],
    };
    const result = template.map(slot => ({ slot, player: pools[slot.line]?.shift() || null }));
    // Sobrantes por descuadres raros (p.ej. 2 porteros): rellenan huecos vacíos.
    const overflow = [...pools.POR, ...pools.DEF, ...pools.MC, ...pools.DEL];
    if (overflow.length) {
      result.forEach(entry => { if (!entry.player && overflow.length) entry.player = overflow.shift(); });
    }
    return result;
  };

  const homeSlots = assignSlots([...homeStarters]);
  const awaySlots = assignSlots([...awayStarters]);

  // Etiqueta de formación para la leyenda (nº de jugadores por línea del XI).
  const formationLabel = (starters) => {
    const by = groupStartersByLine(starters);
    return `${by.DEF.length}-${by.MC.length}-${by.DEL.length}`;
  };
  const homeFormation = formationLabel(homeStarters);
  const awayFormation = formationLabel(awayStarters);

  // Renderizar chips de jugadores en el campo
  const renderSlots = (slots, side) => slots.map(({ slot, player }) => {
    if (!player) return '';
    const hasRed = player.player_id && redCardPlayerIds.has(player.player_id);
    const hasYellow = player.player_id && yellowCardPlayerIds.has(player.player_id);
    const name = shortName(player.player_name);
    const badges = (hasYellow ? ' 🟨' : '') + (hasRed ? ' 🟥' : '');
    // Local: mitad inferior (50–100%). Visitante: mitad superior (0–50%), espejado
    const yPos = side === 'away' ? (100 - slot.y) / 2 : 50 + slot.y / 2;
    return `
      <div class="partido-player-slot" style="left:${slot.x}%;top:${yPos}%">
        <div class="partido-player-dot ${side === 'home' ? 'home' : 'away'}">${slot.line}</div>
        <div class="partido-player-label">${playerLink(player.player_id, name)}${badges}</div>
      </div>
    `;
  }).join('');

  // Suplentes
  const renderSubs = (subs, side) => {
    if (!subs.length) return `<div class="partido-sub-player" style="color:var(--muted);font-style:italic">—</div>`;
    return subs.map(p => {
      const hasRed = p.player_id && redCardPlayerIds.has(p.player_id);
      const hasYellow = p.player_id && yellowCardPlayerIds.has(p.player_id);
      const badges = (hasYellow ? ' 🟨' : '') + (hasRed ? ' 🟥' : '');
      return `<div class="partido-sub-player">↕ ${playerLink(p.player_id, p.player_name)}${badges}</div>`;
    }).join('');
  };

  const homeNameSafe = escapeHtml(homeTeam.name);
  const awayNameSafe = escapeHtml(awayTeam.name);

  panel.innerHTML = `
    <div class="partido-lineup-wrap">
      <div class="partido-field-container">
        <div class="partido-field-legend">
          <span class="partido-field-legend-home">${homeNameSafe} (${escapeHtml(homeFormation)})</span>
          <span class="partido-field-legend-away">${awayNameSafe} (${escapeHtml(awayFormation)})</span>
        </div>
        <div class="partido-field">
          <img class="partido-field-bg" src="img/campo-vertical.png" alt="Campo" onerror="this.src='';this.style.background='#1a4a1f'">
          <div class="partido-field-midline"></div>
          ${renderSlots(homeSlots, 'home')}
          ${renderSlots(awaySlots, 'away')}
        </div>
      </div>

      <div class="partido-subs-section">
        <div class="partido-subs-title">Suplentes</div>
        <div class="partido-subs-columns">
          <div>
            <div class="partido-subs-col-title">${homeNameSafe}</div>
            ${renderSubs(homeSubs, 'home')}
          </div>
          <div>
            <div class="partido-subs-col-title">${awayNameSafe}</div>
            ${renderSubs(awaySubs, 'away')}
          </div>
        </div>
      </div>
    </div>
  `;
}

function shortName(name) {
  if (!name) return '?';
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  // Apellido + inicial nombre
  return parts[parts.length - 1];
}

// ────────────────────────────────────────────────────────
// TAB 2: STATS
// ────────────────────────────────────────────────────────

function renderStats(root, teamStats, homeTeam, awayTeam, homeTeamId, awayTeamId) {
  const panel = root.querySelector('#panel-stats');
  if (!panel) return;

  const homeStats = teamStats.find(s => s.league_team_id === homeTeamId) || {};
  const awayStats = teamStats.find(s => s.league_team_id === awayTeamId) || {};

  const hasData = Object.keys(homeStats).length > 1 || Object.keys(awayStats).length > 1;
  if (!hasData) {
    panel.innerHTML = `<p class="partido-stats-no-data">No hay estadísticas de equipo para este partido.</p>`;
    return;
  }

  const STAT_LABELS = {
    possession: 'Posesión',
    shots: 'Tiros totales',
    shots_on_target: 'Tiros a puerta',
    corners: 'Corners',
    saves: 'Paradas',
    crosses: 'Centros',
    free_kicks: 'Tiros libres',
    passes: 'Pases totales',
    passes_completed: 'Pases completados',
    tackles: 'Entradas',
    interceptions: 'Intercepciones',
    fouls: 'Faltas',
    offsides: 'Fueras de juego',
    red_cards: 'Tarjetas rojas'
  };

  const SECTIONS = [
    { label: 'Ataque',     stats: ['possession', 'shots', 'shots_on_target', 'corners', 'crosses', 'free_kicks'] },
    { label: 'Posesión',   stats: ['passes', 'passes_completed'] },
    { label: 'Defensa',    stats: ['saves', 'tackles', 'interceptions'] },
    { label: 'Disciplina', stats: ['fouls', 'offsides', 'red_cards'] }
  ];

  // Para estadísticas donde MENOS es mejor (el ganador tiene menos)
  const LESS_IS_BETTER = new Set(['fouls', 'offsides', 'red_cards']);

  const renderRow = (key) => {
    const label = STAT_LABELS[key];
    if (!label) return '';

    if (key === 'possession') {
      const hp = homeStats[key] ?? null;
      const ap = awayStats[key] ?? null;
      if (hp === null && ap === null) return '';
      const hpv = hp ?? 50;
      const apv = ap ?? 50;
      return `
        <div class="ps-possession-row">
          <span class="ps-val home">${hpv}%</span>
          <div class="ps-possession-center">
            <span class="ps-label">Posesión</span>
            <div class="ps-possession-bar">
              <div class="ps-possession-bar-home" style="width:${hpv}%"></div>
              <div class="ps-possession-bar-away"></div>
            </div>
          </div>
          <span class="ps-val away">${apv}%</span>
        </div>`;
    }

    const hv = homeStats[key] ?? null;
    const av = awayStats[key] ?? null;
    if (hv === null && av === null) return '';

    const lessIsBetter = LESS_IS_BETTER.has(key);
    let winner = 'draw';
    if (hv !== null && av !== null) {
      if (lessIsBetter) winner = hv < av ? 'home' : av < hv ? 'away' : 'draw';
      else               winner = hv > av ? 'home' : av > hv ? 'away' : 'draw';
    }

    return `
      <div class="ps-stat-row ps-winner-${winner}">
        <span class="ps-val home${winner === 'home' ? ' ps-best' : ''}">${hv ?? '—'}</span>
        <span class="ps-label">${label}</span>
        <span class="ps-val away${winner === 'away' ? ' ps-best' : ''}">${av ?? '—'}</span>
      </div>`;
  };

  let sectionsHtml = '';
  SECTIONS.forEach(({ label, stats }) => {
    const rows = stats.map(renderRow).filter(Boolean).join('');
    if (!rows) return;
    const header = label ? `<div class="ps-section-header">${label}</div>` : '';
    sectionsHtml += `<div class="ps-section">${header}<div class="ps-section-rows">${rows}</div></div>`;
  });

  panel.innerHTML = `
    <div class="ps-stats-root">
      <div class="ps-header-teams">
        <span class="ps-team-label home">${escapeHtml(homeTeam.name)}</span>
        <span class="ps-team-label away">${escapeHtml(awayTeam.name)}</span>
      </div>
      ${sectionsHtml || '<p class="partido-stats-no-data">Sin datos disponibles.</p>'}
    </div>`;
}

// ────────────────────────────────────────────────────────
// TAB 3: VALORACIONES
// ────────────────────────────────────────────────────────

function renderRatings(root, ratingsRaw, homeTeam, awayTeam, homeTeamId, awayTeamId, isAdmin, matchId, matchUuid, competitionId, season) {
  const panel = root.querySelector('#panel-valoraciones');
  if (!panel) return;

  // Ordenar por rating DESC para valoraciones
  const sorted = [...ratingsRaw].sort((a, b) => {
    if (b.rating === null && a.rating === null) return 0;
    if (b.rating === null) return -1;
    if (a.rating === null) return 1;
    return b.rating - a.rating;
  });

  const homeRatings = sorted.filter(r => r.league_team_id === homeTeamId);
  const awayRatings = sorted.filter(r => r.league_team_id === awayTeamId);

  if (!homeRatings.length && !awayRatings.length) {
    let uploadHtml = '';
    if (isAdmin && matchUuid) {
      uploadHtml = `
        <div class="partido-ratings-upload">
          <p class="hint" style="margin-bottom:12px">No hay valoraciones. Sube una captura con las valoraciones de los jugadores.</p>
          <button type="button" class="btn-upload-ratings" data-match-id="${matchId}" data-match-uuid="${matchUuid}">📷 Subir imagen de valoraciones</button>
          <input type="file" accept="image/*" class="ratings-file-input" data-match-id="${matchId}" style="display:none">
        </div>
      `;
    }
    panel.innerHTML = `<p class="partido-ratings-no-data">No hay valoraciones para este partido.</p>${uploadHtml}`;
    initRatingsUpload(panel, competitionId, season);
    return;
  }

  // Determinar MVP (mayor rating, desempate por equipo ganador, luego alfabético)
  const allRatings = [...homeRatings, ...awayRatings].filter(r => r.rating !== null);
  const mvp = allRatings.sort((a, b) => b.rating - a.rating)[0] || null;

  const buildTable = (ratings, teamName) => {
    if (!ratings.length) return '';
    const rows = ratings.map(r => {
      const isMvp = mvp && r.player_name === mvp.player_name && r.league_team_id === mvp.league_team_id;
      return `
        <tr${isMvp ? ' class="best-player"' : ''}>
          <td>${playerLink(r.player_id, r.player_name)}${isMvp ? '<span class="partido-mvp-badge">⭐</span>' : ''}</td>
          <td class="partido-rating-value">${r.rating !== null ? r.rating : '—'}</td>
        </tr>
      `;
    }).join('');

    return `
      <div>
        <div class="partido-ratings-col-title">${escapeHtml(teamName)}</div>
        <table class="partido-ratings-table">
          <thead><tr><th>Jugador</th><th style="text-align:center">Nota</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  };

  // El botón de subir imagen está siempre disponible para admins, incluso si
  // ya hay valoraciones, por si la captura original no se subió o hay que
  // corregirla. Reprocesar la imagen sobrescribe las valoraciones del partido.
  let uploadHtml = '';
  if (isAdmin && matchUuid) {
    uploadHtml = `
      <div class="partido-ratings-upload">
        <p class="hint" style="margin:12px 0 8px">¿Falta la captura o hay que corregirla? Sube la imagen y se reprocesarán las valoraciones del partido.</p>
        <button type="button" class="btn-upload-ratings" data-match-id="${matchId}" data-match-uuid="${matchUuid}">📷 Subir imagen de valoraciones</button>
        <input type="file" accept="image/*" class="ratings-file-input" data-match-id="${matchId}" style="display:none">
      </div>
    `;
  }

  panel.innerHTML = `
    <div class="partido-ratings-wrap">
      <div class="partido-ratings-columns">
        ${buildTable(homeRatings, homeTeam.name)}
        ${buildTable(awayRatings, awayTeam.name)}
      </div>
      ${uploadHtml}
    </div>
  `;

  initRatingsUpload(panel);
}

function initRatingsUpload(container) {
  const uploadBtn = container.querySelector('.btn-upload-ratings');
  const fileInput = container.querySelector('.ratings-file-input');
  if (!uploadBtn || !fileInput) return;

  const PRESIGN_ENDPOINT = 'https://d39ra5ecf4.execute-api.eu-west-1.amazonaws.com/prod/presign-match-upload';

  uploadBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Usamos match_uuid (numérico) como matchId, igual que el contenedor de
    // stream-capture (ratings/{match_uuid}/raw/final.jpg). Sin competitionId
    // ni season el processor entra por la rama de 4 segmentos y resuelve el
    // match desde match_uuid; con id alfanumérico (slug de copa tipo
    // "J2-P4-winner") la lambda de presign generaría un path inválido.
    const matchUuid = uploadBtn.getAttribute('data-match-uuid');
    if (!matchUuid) {
      alert('Este partido aún no tiene match_uuid asignado.');
      return;
    }

    try {
      uploadBtn.disabled = true;
      uploadBtn.textContent = 'Subiendo...';

      // 1. Get presigned URL
      const presignRes = await fetch(PRESIGN_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          matchId: matchUuid,
          filename: file.name,
          contentType: file.type || 'image/jpeg',
          type: 'ratings'
        })
      });
      if (!presignRes.ok) throw new Error(`Presign HTTP ${presignRes.status}`);
      const { uploadUrl } = await presignRes.json();
      if (!uploadUrl) throw new Error('Respuesta sin uploadUrl');

      // 2. Upload to S3
      const uploadRes = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'image/jpeg' },
        body: file
      });
      if (!uploadRes.ok) throw new Error(`Upload HTTP ${uploadRes.status}`);

      uploadBtn.textContent = 'Imagen subida ✔';
      uploadBtn.classList.add('upload-success');
      setTimeout(() => {
        uploadBtn.textContent = '📷 Subir imagen de valoraciones';
        uploadBtn.disabled = false;
        uploadBtn.classList.remove('upload-success');
      }, 3000);
    } catch (err) {
      console.error('[Ratings Upload]', err);
      alert('No se ha podido subir la imagen. Inténtalo de nuevo.');
      uploadBtn.disabled = false;
      uploadBtn.textContent = '📷 Subir imagen de valoraciones';
    }
  });
}

// ────────────────────────────────────────────────────────
// TAB 4: HISTORIAL
// ────────────────────────────────────────────────────────

async function renderHistorial(root, homeTeamId, awayTeamId, homeTeam, awayTeam, currentMatchUuid) {
  const panel = root.querySelector('#panel-historial');
  if (!panel) return;

  panel.innerHTML = `<p class="hint">Cargando historial...</p>`;

  try {
    const supa = await getSupabaseClient();

    // Obtener user_id de cada equipo para buscar todos sus equipos en otras competiciones
    const { data: teamUserData } = await supa
      .from('league_teams')
      .select('id, user_id')
      .in('id', [homeTeamId, awayTeamId]);

    const homeUserId = teamUserData?.find(t => t.id === homeTeamId)?.user_id;
    const awayUserId = teamUserData?.find(t => t.id === awayTeamId)?.user_id;

    // Obtener todos los league_team_id para cada usuario
    const usersToFetch = [homeUserId, awayUserId].filter(Boolean);
    const { data: allUserTeams } = usersToFetch.length
      ? await supa.from('league_teams').select('id, user_id').in('user_id', usersToFetch)
      : { data: [] };

    const homeTeamIds = allUserTeams?.filter(t => t.user_id === homeUserId).map(t => t.id) || [homeTeamId];
    const awayTeamIds = allUserTeams?.filter(t => t.user_id === awayUserId).map(t => t.id) || [awayTeamId];
    const allIds = [...new Set([...homeTeamIds, ...awayTeamIds])];

    // Buscar partidos con cualquiera de los IDs, filtrar en JS el cruce correcto
    const { data: candidateMatches } = await supa
      .from('matches')
      .select('id, match_uuid, home_goals, away_goals, match_date, home_league_team_id, away_league_team_id, competition_id, competitions(slug, name, competition_type)')
      .or(`home_league_team_id.in.(${allIds.join(',')}),away_league_team_id.in.(${allIds.join(',')})`)
      .not('home_goals', 'is', null)
      .not('away_goals', 'is', null)
      .order('match_date', { ascending: false });

    // Filtrar: deben enfrentarse los dos usuarios entre sí, excluir ranked
    const isH2H = (m) => {
      const hIsHomeUser = homeTeamIds.includes(m.home_league_team_id) && awayTeamIds.includes(m.away_league_team_id);
      const hIsAwayUser = awayTeamIds.includes(m.home_league_team_id) && homeTeamIds.includes(m.away_league_team_id);
      return hIsHomeUser || hIsAwayUser;
    };
    const allH2H = (candidateMatches || []).filter(m =>
      m.competitions?.competition_type !== 'ranked' && isH2H(m)
    );

    // Lista mostrada en el panel: excluir el partido actual
    const filtered = allH2H.filter(m => m.match_uuid !== currentMatchUuid);

    if (!allH2H.length) {
      panel.innerHTML = `<p class="partido-historial-no-data">No hay enfrentamientos previos entre estos equipos.</p>`;
      return;
    }

    // Balance incluye el partido actual (allH2H)
    let wins = 0, draws = 0, losses = 0;
    allH2H.forEach(m => {
      const isHome = homeTeamIds.includes(m.home_league_team_id);
      const myGoals = isHome ? m.home_goals : m.away_goals;
      const theirGoals = isHome ? m.away_goals : m.home_goals;
      if (myGoals > theirGoals) wins++;
      else if (myGoals === theirGoals) draws++;
      else losses++;
    });

    // Cargar equipos para mostrar nombres en los partidos históricos
    const allTeamIds = new Set();
    allH2H.forEach(m => { allTeamIds.add(m.home_league_team_id); allTeamIds.add(m.away_league_team_id); });
    const { data: historicalTeams } = await supa
      .from('league_teams')
      .select('id, display_name, nickname, clubs(name)')
      .in('id', [...allTeamIds]);
    const teamMap = {};
    (historicalTeams || []).forEach(t => {
      teamMap[t.id] = t.nickname || t.display_name || t.clubs?.name || 'Equipo';
    });

    const balanceHtml = `
      <div class="partido-h2h-balance">
        <div class="partido-h2h-team">
          <div class="partido-h2h-team-name">${escapeHtml(homeTeam.name)}</div>
          <div class="partido-h2h-wins">${wins}</div>
        </div>
        <div class="partido-h2h-center">
          <div class="partido-h2h-draws-label">Empates</div>
          <div class="partido-h2h-draws">${draws}</div>
        </div>
        <div class="partido-h2h-team">
          <div class="partido-h2h-team-name">${escapeHtml(awayTeam.name)}</div>
          <div class="partido-h2h-wins">${losses}</div>
        </div>
      </div>
    `;

    const listHtml = filtered.map(m => {
      const hName = teamMap[m.home_league_team_id] || 'Local';
      const aName = teamMap[m.away_league_team_id] || 'Visitante';
      const dateText = m.match_date ? fmtDate(m.match_date) : '';
      const compName = m.competitions?.name || '';
      const compSlug = m.competitions?.slug || '';
      const metaText = [dateText, compName].filter(Boolean).join(' · ');

      return `
        <button class="partido-historial-card" data-match-id="${escapeHtml(m.id)}" data-comp-slug="${escapeHtml(compSlug)}">
          <div class="partido-historial-teams">
            <span class="partido-historial-team home">${escapeHtml(hName)}</span>
            <span class="partido-historial-score">${m.home_goals} – ${m.away_goals}</span>
            <span class="partido-historial-team away">${escapeHtml(aName)}</span>
          </div>
          <div class="partido-historial-meta">${escapeHtml(metaText)}</div>
        </button>
      `;
    }).join('');

    panel.innerHTML = `
      <div class="partido-historial-wrap">
        ${balanceHtml}
        <div class="partido-historial-list">${listHtml}</div>
      </div>
    `;

    // Click en partido histórico
    panel.querySelectorAll('.partido-historial-card').forEach(card => {
      card.addEventListener('click', () => {
        const histMatchId = card.getAttribute('data-match-id');
        const histCompSlug = card.getAttribute('data-comp-slug');
        if (histMatchId && histCompSlug) {
          window.location.href = buildURLWithCompetition('partido.html', histCompSlug, { match: histMatchId });
        }
      });
    });

  } catch (e) {
    console.error('Error cargando historial:', e);
    panel.innerHTML = `<p class="partido-historial-no-data">Error al cargar el historial.</p>`;
  }
}

// ────────────────────────────────────────────────────────
// TAB: RESUMEN (default)
// ────────────────────────────────────────────────────────

function renderResumen(root, ctx) {
  const panel = root.querySelector('#panel-resumen');
  if (!panel) return;

  const {
    teamStats, ratingsRaw, goalEvents,
    homeTeam, awayTeam, homeTeamId, awayTeamId,
    otherJornadaMatches, competitionSlug,
    isPlayed, jornadaNumber
  } = ctx;

  const restoHtml = (otherJornadaMatches && otherJornadaMatches.length)
    ? buildRestoJornadaHTML(otherJornadaMatches, competitionSlug, jornadaNumber)
    : '';

  if (!isPlayed) {
    panel.innerHTML = `<p class="partido-resumen-pending">Partido pendiente. Vuelve cuando se haya jugado.</p>${restoHtml}`;
    wireRestoJornadaClicks(panel);
    return;
  }

  // MVP
  const allRatings = ratingsRaw.filter(r => r.rating !== null);
  const sortedRatings = [...allRatings].sort((a, b) => b.rating - a.rating);
  const mvp = sortedRatings[0] || null;
  let mvpHtml = '';
  if (mvp) {
    const mvpTeam = mvp.league_team_id === homeTeamId ? homeTeam : awayTeam;
    mvpHtml = `
      <section class="partido-resumen-mvp">
        <div class="partido-resumen-mvp-label">⭐ Mejor jugador</div>
        <div class="partido-resumen-mvp-name">${playerLink(mvp.player_id, mvp.player_name)}</div>
        <div class="partido-resumen-mvp-meta">${escapeHtml(mvpTeam.name)} · Nota ${mvp.rating}</div>
      </section>
    `;
  }

  // Comparativa rápida (4 stats clave en barras)
  const homeStats = teamStats.find(s => s.league_team_id === homeTeamId) || {};
  const awayStats = teamStats.find(s => s.league_team_id === awayTeamId) || {};
  const KEY_STATS = [
    { key: 'possession', label: 'Posesión', suffix: '%' },
    { key: 'shots', label: 'Tiros', suffix: '' },
    { key: 'shots_on_target', label: 'Tiros a puerta', suffix: '' },
    { key: 'corners', label: 'Corners', suffix: '' }
  ];
  const statRows = KEY_STATS.map(({ key, label, suffix }) => {
    const h = homeStats[key];
    const a = awayStats[key];
    if (h == null && a == null) return '';
    const hv = h ?? 0;
    const av = a ?? 0;
    const total = hv + av;
    const hPct = total > 0 ? (hv / total) * 100 : 50;
    return `
      <div class="partido-resumen-stat">
        <div class="partido-resumen-stat-row">
          <span class="partido-resumen-stat-val home">${h ?? '—'}${suffix}</span>
          <span class="partido-resumen-stat-label">${label}</span>
          <span class="partido-resumen-stat-val away">${a ?? '—'}${suffix}</span>
        </div>
        <div class="partido-resumen-stat-bar">
          <div class="partido-resumen-stat-bar-home" style="width:${hPct.toFixed(1)}%"></div>
        </div>
      </div>
    `;
  }).filter(Boolean).join('');
  const statsHtml = statRows
    ? `<section class="partido-resumen-stats"><h3 class="partido-resumen-section-title">Comparativa</h3>${statRows}</section>`
    : '';

  // Goleadores cronológicos
  const goals = goalEvents.filter(g =>
    !g.event_type || ['goal', 'penalty', 'own_goal'].includes(g.event_type)
  );
  let goalsHtml = '';
  if (goals.length) {
    const playerNameMap = {};
    ratingsRaw.forEach(r => {
      if (r.player_id && r.player_name) playerNameMap[r.player_id] = r.player_name;
    });
    const sorted = [...goals].sort((a, b) => {
      const am = a.minute ?? 999;
      const bm = b.minute ?? 999;
      if (am !== bm) return am - bm;
      return (a.id || 0) - (b.id || 0);
    });
    const items = sorted.map(g => {
      const isHome = g.league_team_id === homeTeamId;
      const name = g.players?.name || playerNameMap[g.player_id] || '?';
      const minuteText = g.minute != null ? `${g.minute}'` : '—';
      const icon = g.event_type === 'own_goal' ? '🥅' : '⚽';
      const tag = g.event_type === 'penalty' ? ' (P)' : g.event_type === 'own_goal' ? ' (e/p)' : '';
      const sideClass = isHome ? 'home' : 'away';
      return `
        <div class="partido-resumen-goal ${sideClass}">
          <span class="partido-resumen-goal-min">${minuteText}</span>
          <span class="partido-resumen-goal-icon">${icon}</span>
          <span class="partido-resumen-goal-name">${playerLink(g.player_id, name)}${tag}</span>
        </div>
      `;
    }).join('');
    goalsHtml = `
      <section class="partido-resumen-goals">
        <h3 class="partido-resumen-section-title">Goles</h3>
        <div class="partido-resumen-goals-list">${items}</div>
      </section>
    `;
  }

  panel.innerHTML = (mvpHtml + statsHtml + goalsHtml + restoHtml)
    || `<p class="partido-resumen-empty">Sin datos para resumen.</p>`;

  wireRestoJornadaClicks(panel);
}

function buildRestoJornadaHTML(matches, compSlug, jornadaNumber) {
  const cards = matches.map(m => {
    const home = m.home;
    const away = m.away;
    const hName = home?.nickname || home?.display_name || home?.clubs?.name || 'Local';
    const aName = away?.nickname || away?.display_name || away?.clubs?.name || 'Visitante';
    const hLogo = home?.clubs?.crest_url || logoPath(hName);
    const aLogo = away?.clubs?.crest_url || logoPath(aName);
    const isPlayed = m.home_goals !== null && m.away_goals !== null;
    const score = isPlayed ? `${m.home_goals} – ${m.away_goals}` : 'vs';
    return `
      <button class="partido-resumen-resto-card" data-match-id="${escapeHtml(m.id)}" data-comp-slug="${escapeHtml(compSlug)}">
        <div class="partido-resumen-resto-team">
          <img class="partido-resumen-resto-logo" src="${escapeHtml(safeUrl(hLogo))}" alt="${escapeHtml(hName)}" onerror="this.style.visibility='hidden'">
          <span class="partido-resumen-resto-name">${escapeHtml(hName)}</span>
        </div>
        <div class="partido-resumen-resto-score${isPlayed ? '' : ' pending'}">${score}</div>
        <div class="partido-resumen-resto-team away">
          <span class="partido-resumen-resto-name">${escapeHtml(aName)}</span>
          <img class="partido-resumen-resto-logo" src="${escapeHtml(safeUrl(aLogo))}" alt="${escapeHtml(aName)}" onerror="this.style.visibility='hidden'">
        </div>
      </button>
    `;
  }).join('');
  const title = jornadaNumber ? `Resto de jornada ${jornadaNumber}` : 'Resto de jornada';
  return `
    <section class="partido-resumen-resto">
      <h3 class="partido-resumen-section-title">${escapeHtml(title)}</h3>
      <div class="partido-resumen-resto-scroll">${cards}</div>
    </section>
  `;
}

function wireRestoJornadaClicks(panel) {
  panel.querySelectorAll('.partido-resumen-resto-card').forEach(card => {
    card.addEventListener('click', () => {
      const matchId = card.getAttribute('data-match-id');
      const slug = card.getAttribute('data-comp-slug');
      if (matchId && slug) {
        window.location.href = buildURLWithCompetition('partido.html', slug, { match: matchId });
      }
    });
  });
}

// ────────────────────────────────────────────────────────
// TAB: EVENTOS (timeline minute-based, scaffolded para captura automática)
// ────────────────────────────────────────────────────────

function renderEventos(root, ctx) {
  const panel = root.querySelector('#panel-eventos');
  if (!panel) return;

  const { goalEvents, redCardsData, yellowCardsData, substitutionsData, ratingsRaw, homeTeamId, awayTeamId, isPlayed } = ctx;

  if (!isPlayed) {
    panel.innerHTML = `<p class="partido-eventos-pending">Partido pendiente.</p>`;
    return;
  }

  const playerNameMap = {};
  ratingsRaw.forEach(r => {
    if (r.player_id && r.player_name) playerNameMap[r.player_id] = r.player_name;
  });
  const resolveName = (player_id, fallback) => fallback || playerNameMap[player_id] || '?';

  const sideOf = (teamId) =>
    teamId === homeTeamId ? 'home' : teamId === awayTeamId ? 'away' : null;

  const events = [];

  // Goles
  goalEvents.forEach(g => {
    if (g.event_type && !['goal', 'penalty', 'own_goal'].includes(g.event_type)) return;
    const side = sideOf(g.league_team_id);
    if (!side) return;
    let icon = '⚽';
    let label = 'Gol';
    if (g.event_type === 'own_goal') { icon = '🥅'; label = 'Gol en propia'; }
    else if (g.event_type === 'penalty') { label = 'Gol (penalti)'; }
    events.push({
      minute: g.minute ?? null,
      side, icon, label,
      player_id: g.player_id ?? null,
      name: resolveName(g.player_id, g.players?.name),
      clipUrl: g.clip_url ? clipCdnUrl(g.clip_url) : null,
      goalEventId: g.id,
      sortKey: `g_${g.id}`
    });
  });

  // Amarillas
  (yellowCardsData || []).forEach((y, i) => {
    const side = sideOf(y.league_team_id);
    if (!side) return;
    events.push({
      minute: y.minute ?? null,
      side, icon: '🟨', label: 'Amarilla',
      player_id: y.player_id ?? null,
      name: resolveName(y.player_id),
      sortKey: `y_${i}`
    });
  });

  // Rojas
  (redCardsData || []).forEach((r, i) => {
    const side = sideOf(r.league_team_id);
    if (!side) return;
    events.push({
      minute: r.minute ?? null,
      side, icon: '🟥', label: 'Roja',
      player_id: r.player_id ?? null,
      name: resolveName(r.player_id),
      sortKey: `r_${i}`
    });
  });

  // Cambios
  (substitutionsData || []).forEach((sub, i) => {
    const side = sideOf(sub.league_team_id);
    if (!side) return;
    events.push({
      minute: sub.minute ?? null,
      side, icon: '🔄', label: `sale ${resolveName(sub.player_off_id)}`,
      player_id: sub.player_on_id ?? null,
      name: resolveName(sub.player_on_id),
      sortKey: `s_${i}`
    });
  });

  if (!events.length) {
    panel.innerHTML = `<p class="partido-eventos-empty">No hay eventos registrados para este partido.</p>`;
    return;
  }

  const timed = events.filter(e => e.minute != null).sort((a, b) => {
    if (a.minute !== b.minute) return a.minute - b.minute;
    return a.sortKey.localeCompare(b.sortKey);
  });
  const untimed = events.filter(e => e.minute == null);

  const renderEvent = (e) => `
    <div class="partido-evento ${e.side}">
      <span class="partido-evento-min">${e.minute != null ? `${e.minute}'` : '—'}</span>
      <span class="partido-evento-icon">${e.icon}</span>
      <span class="partido-evento-name">${playerLink(e.player_id, e.name)}</span>
      <span class="partido-evento-label">${e.label}</span>
      ${e.clipUrl ? `<button type="button" class="partido-evento-clip" data-clip="${escapeHtml(e.clipUrl)}" data-goal-id="${e.goalEventId ?? ''}" data-clip-title="${escapeHtml(`${e.name} ${e.minute != null ? `(${e.minute}')` : ''}`.trim())}">▶ ver gol</button>` : ''}
    </div>
  `;

  let html = '';
  if (timed.length) {
    html += `<div class="partido-eventos-timed">${timed.map(renderEvent).join('')}</div>`;
  }
  if (untimed.length) {
    html += `
      <div class="partido-eventos-untimed">
        <div class="partido-eventos-untimed-title">Sin tiempo registrado</div>
        ${untimed.map(renderEvent).join('')}
      </div>
    `;
  }

  panel.innerHTML = html;

  panel.querySelectorAll('.partido-evento-clip').forEach(btn => {
    btn.addEventListener('click', () => {
      const goalId = btn.getAttribute('data-goal-id');
      openClipModal({
        clipUrl: btn.getAttribute('data-clip'),
        title: btn.getAttribute('data-clip-title'),
        goalEventId: goalId ? Number(goalId) : null,
        season: ctx.season ?? null,
      });
    });
  });
}

// ────────────────────────────────────────────────────────
// MINI-STRIP STICKY (desktop only, cuando el hero sale del viewport)
// ────────────────────────────────────────────────────────

function initMiniStrip(root, ctx) {
  if (window.innerWidth < 900) return;
  const hero = root.querySelector('.partido-hero');
  if (!hero) return;

  const { homeTeam, awayTeam, homeGoals, awayGoals, isPlayed } = ctx;
  const homeLogo = homeTeam.logo_url || logoPath(homeTeam.name);
  const awayLogo = awayTeam.logo_url || logoPath(awayTeam.name);
  const score = isPlayed ? `${homeGoals} – ${awayGoals}` : 'vs';

  const strip = document.createElement('div');
  strip.className = 'partido-ministrip';
  strip.setAttribute('aria-hidden', 'true');
  strip.innerHTML = `
    <div class="partido-ministrip-inner">
      <div class="partido-ministrip-team">
        <img src="${escapeHtml(safeUrl(homeLogo))}" alt="${escapeHtml(homeTeam.name)}" onerror="this.style.visibility='hidden'">
        <span>${escapeHtml(homeTeam.name)}</span>
      </div>
      <div class="partido-ministrip-score">${score}</div>
      <div class="partido-ministrip-team away">
        <span>${escapeHtml(awayTeam.name)}</span>
        <img src="${escapeHtml(safeUrl(awayLogo))}" alt="${escapeHtml(awayTeam.name)}" onerror="this.style.visibility='hidden'">
      </div>
    </div>
  `;
  document.body.appendChild(strip);

  const observer = new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting) strip.classList.remove('visible');
    else strip.classList.add('visible');
  }, { threshold: 0 });
  observer.observe(hero);
}

// ────────────────────────────────────────────────────────
// TAB 5: VIDEO / HIGHLIGHTS
// ────────────────────────────────────────────────────────

// Construye el iframe de embed para una URL de YouTube o Twitch.
// Devuelve { embedHtml, linkLabel } (embedHtml vacío si no se puede embeber).
function buildVideoEmbed(url) {
  let embedHtml = '';
  let linkLabel = '▶ Abrir vídeo';

  // ID extraído debe ser alfanumérico estricto para evitar romper el atributo src del iframe.
  const ID_RE = /^[A-Za-z0-9_-]+$/;

  // YouTube: watch?v=ID o youtu.be/ID
  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    try {
      let videoId = null;
      const u = new URL(url);
      if (u.hostname.includes('youtu.be')) {
        videoId = u.pathname.replace(/^\//, '').split('/')[0];
      } else {
        videoId = u.searchParams.get('v');
      }
      if (videoId && ID_RE.test(videoId)) {
        linkLabel = '▶ Ver en YouTube';
        embedHtml = `
          <iframe
            src="https://www.youtube.com/embed/${videoId}"
            width="100%"
            height="400"
            frameborder="0"
            allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
            allowfullscreen
            style="border-radius:10px;border:1px solid var(--border-subtle);display:block">
          </iframe>
        `;
      }
    } catch {/* no embed */}
  }

  // Twitch: canal en directo
  if (!embedHtml && url.includes('twitch.tv')) {
    try {
      const u = new URL(url);
      const channel = u.pathname.replace(/^\//, '').split('/')[0];
      if (channel && ID_RE.test(channel)) {
        linkLabel = '▶ Ver en Twitch';
        embedHtml = `
          <iframe
            src="https://player.twitch.tv/?channel=${channel}&parent=${encodeURIComponent(window.location.hostname)}"
            width="100%"
            height="400"
            frameborder="0"
            allowfullscreen
            style="border-radius:10px;border:1px solid var(--border-subtle);display:block">
          </iframe>
        `;
      }
    } catch {/* no embed */}
  }

  return { embedHtml, linkLabel };
}

function renderVideoPanel(panel, url, noDataMsg) {
  if (!panel) return;
  if (!url) {
    panel.innerHTML = `<p class="partido-stream-no-data">${noDataMsg}</p>`;
    return;
  }
  const { embedHtml, linkLabel } = buildVideoEmbed(url);
  panel.innerHTML = `
    <div class="partido-stream-wrap">
      <div class="partido-stream-block">
        ${embedHtml}
        <a href="${escapeHtml(safeUrl(url))}" target="_blank" rel="noopener noreferrer" class="partido-stream-link" style="margin-top:${embedHtml ? '12px' : '0'}">
          ${linkLabel}
        </a>
      </div>
    </div>
  `;
}

function renderStream(root, match) {
  renderVideoPanel(
    root.querySelector('#panel-directo'),
    match.stream_url,
    'No hay enlace de vídeo para este partido.'
  );
}

function renderHighlights(root, match) {
  // El panel solo existe si hay highlights_url (ver buildPageHTML).
  renderVideoPanel(
    root.querySelector('#panel-highlights'),
    match.highlights_url,
    'No hay highlights para este partido.'
  );
}

// ────────────────────────────────────────────────────────
// TAB 6: EDITAR (admin)
// ────────────────────────────────────────────────────────

async function initEditTab(root, matchId, matchUuid, match, homeTeam, awayTeam, homeTeamId, awayTeamId, competitionId, isRanked, homeGoals, awayGoals) {
  const panel = root.querySelector('#panel-editar');
  if (!panel) return;

  const meta = {
    id: matchId,
    match_uuid: matchUuid,
    local: homeTeam.name,
    visitante: awayTeam.name,
    local_team_id: homeTeamId,
    visitante_team_id: awayTeamId,
    goles_local: homeGoals,
    goles_visitante: awayGoals,
    competition_id: competitionId
  };

  const localVal = homeGoals !== null ? String(homeGoals) : '';
  const awayVal = awayGoals !== null ? String(awayGoals) : '';
  const homeNameSafe = escapeHtml(homeTeam.name);
  const awayNameSafe = escapeHtml(awayTeam.name);
  const matchIdSafe = escapeHtml(matchId);

  const resultEditHtml = isRanked ? `
    <div class="partido-edit-section">
      <h3>Resultado del partido</h3>
      <div class="partido-edit-result">
        <span style="font-size:0.9rem;color:var(--muted)">${homeNameSafe}</span>
        <input type="number" min="0" class="partido-result-input" id="edit-home-goals" value="${escapeHtml(localVal)}" placeholder="0">
        <span class="partido-result-sep">–</span>
        <input type="number" min="0" class="partido-result-input" id="edit-away-goals" value="${escapeHtml(awayVal)}" placeholder="0">
        <span style="font-size:0.9rem;color:var(--muted)">${awayNameSafe}</span>
        <button type="button" class="btn-save-partido-result">Guardar resultado</button>
        <span class="partido-save-status" aria-live="polite"></span>
      </div>
    </div>
  ` : '';

  panel.innerHTML = `
    <div class="partido-edit-wrap">
      ${resultEditHtml}

      <div class="partido-edit-section" id="edit-scorers-section">
        <h3>Goleadores del partido</h3>
        <section class="scorers-editor" data-match-id="${matchIdSafe}">
          <div class="scorers-summary-block">
            <div class="scorers-summary-columns">
              <div class="scorers-summary-side"><h5>${homeNameSafe}</h5><ul class="scorers-summary-list" data-side="local"></ul></div>
              <div class="scorers-summary-side"><h5>${awayNameSafe}</h5><ul class="scorers-summary-list" data-side="visitante"></ul></div>
            </div>
          </div>
          <div class="scorers-edit-toggle">
            <button type="button" class="btn-toggle-scorers-edit">Editar goleadores</button>
            <span class="scorers-status" aria-live="polite"></span>
          </div>
          <div class="scorers-edit-panel" hidden>
            <p class="hint small">Añade o elimina goleadores. Luego pulsa "Guardar".</p>
            <div class="scorers-columns">
              <div class="scorers-col" data-side="local">
                <h4>${homeNameSafe}</h4>
                <ul class="scorers-list" data-side="local"></ul>
                <div class="scorers-add">
                  <select data-side="local"><option value="">Añadir goleador…</option></select>
                  <input type="number" class="scorer-minute-input" data-side="local" placeholder="Min" min="1" max="120" style="width:60px">
                  <button type="button" class="btn-add-scorer" data-side="local">＋</button>
                </div>
              </div>
              <div class="scorers-col" data-side="visitante">
                <h4>${awayNameSafe}</h4>
                <ul class="scorers-list" data-side="visitante"></ul>
                <div class="scorers-add">
                  <select data-side="visitante"><option value="">Añadir goleador…</option></select>
                  <input type="number" class="scorer-minute-input" data-side="visitante" placeholder="Min" min="1" max="120" style="width:60px">
                  <button type="button" class="btn-add-scorer" data-side="visitante">＋</button>
                </div>
              </div>
            </div>
            <div class="scorers-actions">
              <span class="scorers-status-save" aria-live="polite"></span>
              <button type="button" class="btn-save-scorers">Guardar goleadores</button>
            </div>
          </div>
        </section>
      </div>

      <div class="partido-edit-section" id="edit-redcards-section">
        <h3>Tarjetas rojas</h3>
        <section class="redcards-editor" data-match-id="${matchIdSafe}">
          <div class="scorers-summary-block">
            <div class="scorers-summary-columns">
              <div class="scorers-summary-side"><h5>${homeNameSafe}</h5><ul class="scorers-summary-list" data-side="local"></ul></div>
              <div class="scorers-summary-side"><h5>${awayNameSafe}</h5><ul class="scorers-summary-list" data-side="visitante"></ul></div>
            </div>
          </div>
          <div class="scorers-columns">
            <div class="scorers-col" data-side="local">
              <h4>${homeNameSafe}</h4>
              <ul class="scorers-list redcards-list" data-side="local"></ul>
              <div class="scorers-add">
                <select data-side="local"><option value="">Añadir jug. con roja…</option></select>
                <input type="number" class="redcard-minute-input" data-side="local" placeholder="Min" min="0" max="120" style="width:60px">
                <button type="button" class="btn-add-red" data-side="local">＋</button>
              </div>
            </div>
            <div class="scorers-col" data-side="visitante">
              <h4>${awayNameSafe}</h4>
              <ul class="scorers-list redcards-list" data-side="visitante"></ul>
              <div class="scorers-add">
                <select data-side="visitante"><option value="">Añadir jug. con roja…</option></select>
                <input type="number" class="redcard-minute-input" data-side="visitante" placeholder="Min" min="0" max="120" style="width:60px">
                <button type="button" class="btn-add-red" data-side="visitante">＋</button>
              </div>
            </div>
          </div>
          <div class="redcards-actions">
            <span class="redcards-status" aria-live="polite"></span>
            <button type="button" class="btn-save-redcards">Guardar rojas</button>
          </div>
        </section>
      </div>

      <div class="partido-edit-section" id="edit-yellowcards-section">
        <h3>Tarjetas amarillas</h3>
        <section class="yellowcards-editor" data-match-id="${matchIdSafe}">
          <div class="scorers-summary-block">
            <div class="scorers-summary-columns">
              <div class="scorers-summary-side"><h5>${homeNameSafe}</h5><ul class="scorers-summary-list" data-side="local"></ul></div>
              <div class="scorers-summary-side"><h5>${awayNameSafe}</h5><ul class="scorers-summary-list" data-side="visitante"></ul></div>
            </div>
          </div>
          <div class="scorers-columns">
            <div class="scorers-col" data-side="local">
              <h4>${homeNameSafe}</h4>
              <ul class="scorers-list yellowcards-list" data-side="local"></ul>
              <div class="scorers-add">
                <select data-side="local"><option value="">Añadir jug. con amarilla…</option></select>
                <input type="number" class="yellowcard-minute-input" data-side="local" placeholder="Min" min="0" max="120" style="width:60px">
                <button type="button" class="btn-add-yellow" data-side="local">＋</button>
              </div>
            </div>
            <div class="scorers-col" data-side="visitante">
              <h4>${awayNameSafe}</h4>
              <ul class="scorers-list yellowcards-list" data-side="visitante"></ul>
              <div class="scorers-add">
                <select data-side="visitante"><option value="">Añadir jug. con amarilla…</option></select>
                <input type="number" class="yellowcard-minute-input" data-side="visitante" placeholder="Min" min="0" max="120" style="width:60px">
                <button type="button" class="btn-add-yellow" data-side="visitante">＋</button>
              </div>
            </div>
          </div>
          <div class="yellowcards-actions">
            <span class="yellowcards-status" aria-live="polite"></span>
            <button type="button" class="btn-save-yellowcards">Guardar amarillas</button>
          </div>
        </section>
      </div>

      <div class="partido-edit-section" id="edit-injuries-section">
        <h3>Lesiones (Bajas próximo partido)</h3>
        <section class="injuries-editor" data-match-id="${matchIdSafe}">
          <div class="scorers-summary-block">
            <div class="scorers-summary-columns">
              <div class="scorers-summary-side"><h5>${homeNameSafe}</h5><ul class="scorers-summary-list" data-side="local"></ul></div>
              <div class="scorers-summary-side"><h5>${awayNameSafe}</h5><ul class="scorers-summary-list" data-side="visitante"></ul></div>
            </div>
          </div>
          <div class="scorers-columns">
            <div class="scorers-col" data-side="local">
              <h4>${homeNameSafe}</h4>
              <ul class="scorers-list injuries-list" data-side="local"></ul>
              <div class="scorers-add">
                <select data-side="local"><option value="">Añadir lesionado…</option></select>
                <button type="button" class="btn-add-injury" data-side="local">＋</button>
              </div>
            </div>
            <div class="scorers-col" data-side="visitante">
              <h4>${awayNameSafe}</h4>
              <ul class="scorers-list injuries-list" data-side="visitante"></ul>
              <div class="scorers-add">
                <select data-side="visitante"><option value="">Añadir lesionado…</option></select>
                <button type="button" class="btn-add-injury" data-side="visitante">＋</button>
              </div>
            </div>
          </div>
          <div class="injuries-actions">
            <span class="injuries-status" aria-live="polite"></span>
            <button type="button" class="btn-save-injuries">Guardar lesiones</button>
          </div>
        </section>
      </div>
    </div>
  `;

  // Inicializar editores
  await initScorersEditorInPanel(panel, matchId, meta);
  await initRedCardsEditorInPanel(panel, matchId, meta);
  await initYellowCardsEditorInPanel(panel, matchId, meta);
  await initInjuriesEditorInPanel(panel, matchId, meta);

  // Resultado ranked
  if (isRanked) {
    const saveBtn = panel.querySelector('.btn-save-partido-result');
    const homeInput = panel.querySelector('#edit-home-goals');
    const awayInput = panel.querySelector('#edit-away-goals');
    const statusEl = panel.querySelector('.partido-save-status');
    if (saveBtn) {
      saveBtn.addEventListener('click', async () => {
        const hv = homeInput?.value?.trim();
        const av = awayInput?.value?.trim();
        const hg = hv === '' ? null : parseInt(hv, 10);
        const ag = av === '' ? null : parseInt(av, 10);
        if ((hg !== null && isNaN(hg)) || (ag !== null && isNaN(ag))) {
          if (statusEl) statusEl.textContent = 'Introduce números válidos.';
          return;
        }
        saveBtn.disabled = true;
        if (statusEl) statusEl.textContent = '';
        const result = await saveMatchResult(matchId, meta, hg, ag);
        if (result.ok) {
          if (statusEl) statusEl.textContent = 'Resultado guardado.';
        } else {
          if (statusEl) statusEl.textContent = result.msg || 'Error al guardar';
        }
        saveBtn.disabled = false;
      });
    }
  }
}

// ── Helper: plantilla completa del equipo desde membresías de club ──

async function fetchTeamRoster(supa, leagueTeamId) {
  const { data: lt } = await supa
    .from('league_teams')
    .select('club_id, season')
    .eq('id', leagueTeamId)
    .single();
  if (!lt?.club_id) return [];

  const { data: memberships } = await supa
    .from('player_club_memberships')
    .select('player_id, players(id, name)')
    .eq('club_id', lt.club_id)
    .eq('season', lt.season);

  return (memberships || [])
    .filter(m => m.player_id && m.players?.name)
    .map(m => ({ player_id: m.player_id, player_name: m.players.name }))
    .sort((a, b) => a.player_name.localeCompare(b.player_name));
}

// ── Editores (usan el estado del módulo resultados-data) ──

async function initScorersEditorInPanel(panel, matchId, meta) {
  const section = panel.querySelector('.scorers-editor');
  if (!section) return;

  const toggleBtn = section.querySelector('.btn-toggle-scorers-edit');
  const editPanel = section.querySelector('.scorers-edit-panel');
  if (toggleBtn && editPanel) {
    toggleBtn.addEventListener('click', () => { editPanel.hidden = !editPanel.hidden; });
  }

  // Cargar estado del módulo (matchId = meta.id)
  await loadScorerStateForMatch(meta);

  // Poblar selects con la plantilla completa del equipo (no solo los 13 ratings)
  const supa = await getSupabaseClient();
  const [localRoster, visitanteRoster] = await Promise.all([
    fetchTeamRoster(supa, meta.local_team_id),
    fetchTeamRoster(supa, meta.visitante_team_id)
  ]);
  ['local', 'visitante'].forEach(side => {
    const sel = section.querySelector(`.scorers-col[data-side="${side}"] select`);
    if (!sel) return;
    (side === 'local' ? localRoster : visitanteRoster).forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.player_id;
      opt.textContent = p.player_name;
      sel.appendChild(opt);
    });
  });

  const getState = () => getScorerState(matchId);

  const refreshSummary = () => {
    ['local', 'visitante'].forEach(side => {
      const st = getState();
      const summaryList = section.querySelector(`.scorers-summary-list[data-side="${side}"]`);
      const arr = st?.[side] || [];
      if (summaryList) {
        summaryList.innerHTML = arr.length
          ? arr.map(p => `<li>⚽ ${escapeHtml(p.name)}${p.goals > 1 ? ` (×${p.goals})` : ''}</li>`).join('')
          : '<li style="color:var(--muted);font-style:italic">—</li>';
      }
    });
  };

  const getDetail = (side) => {
    const st = getState();
    if (!st) return [];
    return side === 'local' ? (st.goalsDetailLocal || []) : (st.goalsDetailVisitante || []);
  };

  const playerLabel = (pid) => {
    if (pid === -1) return 'Gol en propia';
    const st = getState();
    const meta = st?.playerMeta?.[pid];
    return meta?.name || `Jugador ${pid}`;
  };

  const refreshList = (side) => {
    const listEl = section.querySelector(`.scorers-list[data-side="${side}"]`);
    if (!listEl) return;
    const det = getDetail(side);
    if (!det.length) {
      listEl.innerHTML = '<li style="color:var(--muted);font-style:italic">Sin goleadores</li>';
      return;
    }
    listEl.innerHTML = det.map((g, idx) => {
      const minVal = (g.minute != null) ? g.minute : '';
      return `
        <li class="scorer-item">
          <span>⚽ ${escapeHtml(playerLabel(g.player_id))}</span>
          <div class="scorer-controls" style="display:flex;align-items:center;gap:4px">
            <input type="number" class="scorer-minute-edit" data-side="${side}" data-detail-index="${idx}" value="${minVal}" placeholder="Min" min="0" max="120" style="width:60px">
            <button class="btn-remove-scorer-goal" data-side="${side}" data-detail-index="${idx}" data-player-id="${g.player_id}" title="Eliminar este gol">✕</button>
          </div>
        </li>`;
    }).join('');
  };

  refreshSummary();
  refreshList('local');
  refreshList('visitante');

  section.addEventListener('click', (e) => {
    const addBtn = e.target.closest('.btn-add-scorer');
    const removeGoalBtn = e.target.closest('.btn-remove-scorer-goal');

    if (addBtn) {
      const side = addBtn.getAttribute('data-side');
      const sel = section.querySelector(`.scorers-col[data-side="${side}"] select`);
      const minInput = section.querySelector(`.scorer-minute-input[data-side="${side}"]`);
      const pid = parseInt(sel?.value, 10);
      if (!pid) return;
      const rawMin = minInput?.value;
      const minute = (rawMin === '' || rawMin == null) ? null : parseInt(rawMin, 10);
      addGoalToState(matchId, side, pid, minute);
      if (minInput) minInput.value = '';
      if (sel) sel.value = '';
      refreshSummary(); refreshList(side);
    }
    if (removeGoalBtn) {
      const side = removeGoalBtn.getAttribute('data-side');
      const pid = parseInt(removeGoalBtn.getAttribute('data-player-id'), 10);
      // Borrar exactamente ese gol del detalle (preserva minutos del resto)
      const st = getState();
      const detailKey = side === 'local' ? 'goalsDetailLocal' : 'goalsDetailVisitante';
      const detIdx = parseInt(removeGoalBtn.getAttribute('data-detail-index'), 10);
      if (st && st[detailKey] && detIdx >= 0 && detIdx < st[detailKey].length) {
        st[detailKey].splice(detIdx, 1);
        // Sincronizar agregado: -1 al jugador (sin volver a tocar detalle)
        const arr = st[side] || [];
        const ai = arr.findIndex(x => x.player_id === pid);
        if (ai !== -1) {
          arr[ai].goals -= 1;
          if (arr[ai].goals <= 0) arr.splice(ai, 1);
        }
      }
      refreshSummary(); refreshList(side);
    }
  });

  section.addEventListener('change', (e) => {
    const minEdit = e.target.closest('.scorer-minute-edit');
    if (!minEdit) return;
    const side = minEdit.getAttribute('data-side');
    const idx = parseInt(minEdit.getAttribute('data-detail-index'), 10);
    const raw = minEdit.value;
    const minute = (raw === '' || raw == null) ? null : parseInt(raw, 10);
    setGoalMinute(matchId, side, idx, minute);
  });

  const saveBtn = section.querySelector('.btn-save-scorers');
  const statusEl = section.querySelector('.scorers-status-save');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      if (statusEl) statusEl.textContent = 'Guardando...';
      const result = await saveScorersToSupabase(matchId);
      if (statusEl) statusEl.textContent = result.ok ? 'Guardado.' : (result.msg || 'Error');
      saveBtn.disabled = false;
    });
  }
}

async function initRedCardsEditorInPanel(panel, matchId, meta) {
  const section = panel.querySelector('.redcards-editor');
  if (!section) return;

  // El estado ya fue cargado por initScorersEditorInPanel via loadScorerStateForMatch
  // Las funciones addRedCardToState/removeRedCardFromState usan scorerState[matchId]

  const getRedArr = (side) => {
    const st = getScorerState(matchId);
    return side === 'local' ? (st?.redLocal || []) : (st?.redVisitante || []);
  };

  // Poblar selects con la plantilla completa del equipo
  const supa = await getSupabaseClient();
  const [localRosterRed, visitanteRosterRed] = await Promise.all([
    fetchTeamRoster(supa, meta.local_team_id),
    fetchTeamRoster(supa, meta.visitante_team_id)
  ]);
  const populateSelect = (select, players) => {
    players.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.player_id;
      opt.textContent = p.player_name;
      select.appendChild(opt);
    });
  };
  populateSelect(section.querySelector('.scorers-col[data-side="local"] select'), localRosterRed);
  populateSelect(section.querySelector('.scorers-col[data-side="visitante"] select'), visitanteRosterRed);

  const refreshList = (side) => {
    const arr = getRedArr(side);
    const listEl = section.querySelector(`.redcards-list[data-side="${side}"]`);
    const summaryList = section.querySelector(`.scorers-summary-list[data-side="${side}"]`);
    const html = arr.length
      ? arr.map(p => {
          const minVal = (p.minute != null) ? p.minute : '';
          return `<li class="scorer-item"><span>🟥 ${escapeHtml(p.name)}</span><div class="scorer-controls" style="display:flex;align-items:center;gap:4px"><input type="number" class="redcard-minute-edit" data-side="${side}" data-player-id="${p.player_id}" value="${minVal}" placeholder="Min" min="0" max="120" style="width:60px"><button class="btn-remove-red" data-player-id="${p.player_id}" data-side="${side}">✕</button></div></li>`;
        }).join('')
      : '<li style="color:var(--muted);font-style:italic">—</li>';
    if (listEl) listEl.innerHTML = html;
    if (summaryList) summaryList.innerHTML = arr.length
      ? arr.map(p => `<li>🟥 ${escapeHtml(p.name)}${p.minute != null ? ` ${p.minute}'` : ''}</li>`).join('')
      : '<li style="color:var(--muted);font-style:italic">—</li>';
  };

  refreshList('local');
  refreshList('visitante');

  section.addEventListener('click', (e) => {
    const addBtn = e.target.closest('.btn-add-red');
    const removeBtn = e.target.closest('.btn-remove-red');
    if (addBtn) {
      const side = addBtn.getAttribute('data-side');
      const sel = section.querySelector(`.scorers-col[data-side="${side}"] select`);
      const minInput = section.querySelector(`.redcard-minute-input[data-side="${side}"]`);
      const pid = parseInt(sel?.value, 10);
      if (!pid) return;
      const rawMin = minInput?.value;
      const minute = (rawMin === '' || rawMin == null) ? null : parseInt(rawMin, 10);
      addRedCardToState(matchId, side, pid, minute);
      if (minInput) minInput.value = '';
      if (sel) sel.value = '';
      refreshList(side);
    }
    if (removeBtn) {
      const side = removeBtn.getAttribute('data-side');
      const pid = parseInt(removeBtn.getAttribute('data-player-id'), 10);
      removeRedCardFromState(matchId, side, pid);
      refreshList(side);
    }
  });

  section.addEventListener('change', (e) => {
    const minEdit = e.target.closest('.redcard-minute-edit');
    if (!minEdit) return;
    const side = minEdit.getAttribute('data-side');
    const pid = parseInt(minEdit.getAttribute('data-player-id'), 10);
    const raw = minEdit.value;
    const minute = (raw === '' || raw == null) ? null : parseInt(raw, 10);
    setRedCardMinute(matchId, side, pid, minute);
  });

  const saveBtn = section.querySelector('.btn-save-redcards');
  const statusEl = section.querySelector('.redcards-status');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      if (statusEl) statusEl.textContent = 'Guardando...';
      const result = await saveRedCardsFull(matchId);
      if (statusEl) statusEl.textContent = result.ok ? 'Guardado.' : (result.msg || 'Error');
      saveBtn.disabled = false;
    });
  }
}

async function initYellowCardsEditorInPanel(panel, matchId, meta) {
  const section = panel.querySelector('.yellowcards-editor');
  if (!section) return;

  const getYellowArr = (side) => {
    const st = getScorerState(matchId);
    return side === 'local' ? (st?.yellowLocal || []) : (st?.yellowVisitante || []);
  };

  const supa = await getSupabaseClient();
  const [localRosterYellow, visitanteRosterYellow] = await Promise.all([
    fetchTeamRoster(supa, meta.local_team_id),
    fetchTeamRoster(supa, meta.visitante_team_id)
  ]);

  const populateSelect = (select, players) => {
    players.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.player_id;
      opt.textContent = p.player_name;
      select.appendChild(opt);
    });
  };
  populateSelect(section.querySelector('.scorers-col[data-side="local"] select'), localRosterYellow);
  populateSelect(section.querySelector('.scorers-col[data-side="visitante"] select'), visitanteRosterYellow);

  const refreshList = (side) => {
    const arr = getYellowArr(side);
    const listEl = section.querySelector(`.yellowcards-list[data-side="${side}"]`);
    const summaryList = section.querySelector(`.scorers-summary-list[data-side="${side}"]`);
    const html = arr.length
      ? arr.map(p => {
          const minVal = (p.minute != null) ? p.minute : '';
          return `<li class="scorer-item"><span>🟨 ${escapeHtml(p.name)}</span><div class="scorer-controls" style="display:flex;align-items:center;gap:4px"><input type="number" class="yellowcard-minute-edit" data-side="${side}" data-player-id="${p.player_id}" value="${minVal}" placeholder="Min" min="0" max="120" style="width:60px"><button class="btn-remove-yellow" data-player-id="${p.player_id}" data-side="${side}">✕</button></div></li>`;
        }).join('')
      : '<li style="color:var(--muted);font-style:italic">—</li>';
    if (listEl) listEl.innerHTML = html;
    if (summaryList) summaryList.innerHTML = arr.length
      ? arr.map(p => `<li>🟨 ${escapeHtml(p.name)}${p.minute != null ? ` ${p.minute}'` : ''}</li>`).join('')
      : '<li style="color:var(--muted);font-style:italic">—</li>';
  };

  refreshList('local');
  refreshList('visitante');

  section.addEventListener('click', (e) => {
    const addBtn = e.target.closest('.btn-add-yellow');
    const removeBtn = e.target.closest('.btn-remove-yellow');
    if (addBtn) {
      const side = addBtn.getAttribute('data-side');
      const sel = section.querySelector(`.scorers-col[data-side="${side}"] select`);
      const minInput = section.querySelector(`.yellowcard-minute-input[data-side="${side}"]`);
      const pid = parseInt(sel?.value, 10);
      if (!pid) return;
      const rawMin = minInput?.value;
      const minute = (rawMin === '' || rawMin == null) ? null : parseInt(rawMin, 10);
      addYellowCardToState(matchId, side, pid, minute);
      if (minInput) minInput.value = '';
      if (sel) sel.value = '';
      refreshList(side);
    }
    if (removeBtn) {
      const side = removeBtn.getAttribute('data-side');
      const pid = parseInt(removeBtn.getAttribute('data-player-id'), 10);
      removeYellowCardFromState(matchId, side, pid);
      refreshList(side);
    }
  });

  section.addEventListener('change', (e) => {
    const minEdit = e.target.closest('.yellowcard-minute-edit');
    if (!minEdit) return;
    const side = minEdit.getAttribute('data-side');
    const pid = parseInt(minEdit.getAttribute('data-player-id'), 10);
    const raw = minEdit.value;
    const minute = (raw === '' || raw == null) ? null : parseInt(raw, 10);
    setYellowCardMinute(matchId, side, pid, minute);
  });

  const saveBtn = section.querySelector('.btn-save-yellowcards');
  const statusEl = section.querySelector('.yellowcards-status');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      if (statusEl) statusEl.textContent = 'Guardando...';
      const result = await saveYellowCardsFull(matchId);
      if (statusEl) statusEl.textContent = result.ok ? 'Guardado.' : (result.msg || 'Error');
      saveBtn.disabled = false;
    });
  }
}

async function initInjuriesEditorInPanel(panel, matchId, meta) {
  const section = panel.querySelector('.injuries-editor');
  if (!section) return;

  const getInjArr = (side) => {
    const st = getScorerState(matchId);
    return side === 'local' ? (st?.injuriesLocal || []) : (st?.injuriesVisitante || []);
  };

  // Poblar selects con la plantilla completa del equipo
  const supa = await getSupabaseClient();
  const [localRosterInj, visitanteRosterInj] = await Promise.all([
    fetchTeamRoster(supa, meta.local_team_id),
    fetchTeamRoster(supa, meta.visitante_team_id)
  ]);
  const populateSelectInj = (select, players) => {
    players.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.player_id;
      opt.textContent = p.player_name;
      select.appendChild(opt);
    });
  };
  populateSelectInj(section.querySelector('.scorers-col[data-side="local"] select'), localRosterInj);
  populateSelectInj(section.querySelector('.scorers-col[data-side="visitante"] select'), visitanteRosterInj);

  const refreshList = (side) => {
    const arr = getInjArr(side);
    const listEl = section.querySelector(`.injuries-list[data-side="${side}"]`);
    const summaryList = section.querySelector(`.scorers-summary-list[data-side="${side}"]`);
    const html = arr.length
      ? arr.map(p => `<li><span>🤕 ${escapeHtml(p.name)}</span><button class="btn-remove-injury" data-player-id="${p.player_id}" data-side="${side}">✕</button></li>`).join('')
      : '<li style="color:var(--muted);font-style:italic">—</li>';
    if (listEl) listEl.innerHTML = html;
    if (summaryList) summaryList.innerHTML = arr.length
      ? arr.map(p => `<li>🤕 ${escapeHtml(p.name)}</li>`).join('')
      : '<li style="color:var(--muted);font-style:italic">—</li>';
  };

  refreshList('local');
  refreshList('visitante');

  section.addEventListener('click', (e) => {
    const addBtn = e.target.closest('.btn-add-injury');
    const removeBtn = e.target.closest('.btn-remove-injury');
    if (addBtn) {
      const side = addBtn.getAttribute('data-side');
      const sel = section.querySelector(`.scorers-col[data-side="${side}"] select`);
      const pid = parseInt(sel?.value, 10);
      if (!pid) return;
      addInjuryToState(matchId, side, pid);
      refreshList(side);
    }
    if (removeBtn) {
      const side = removeBtn.getAttribute('data-side');
      const pid = parseInt(removeBtn.getAttribute('data-player-id'), 10);
      removeInjuryFromState(matchId, side, pid);
      refreshList(side);
    }
  });

  const saveBtn = section.querySelector('.btn-save-injuries');
  const statusEl = section.querySelector('.injuries-status');
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      saveBtn.disabled = true;
      if (statusEl) statusEl.textContent = 'Guardando...';
      const result = await saveInjuriesFull(matchId);
      if (statusEl) statusEl.textContent = result.ok ? 'Guardado.' : (result.msg || 'Error');
      saveBtn.disabled = false;
    });
  }
}
