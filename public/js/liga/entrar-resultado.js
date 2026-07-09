import { getSupabaseClient } from '../modules/supabase-client.js';
import { getCompetitionFromURL, getCurrentCompetitionSlug, buildBreadcrumb, renderBreadcrumb } from '../modules/competition-context.js';
import { getCompetitionBySlug } from '../modules/competition-data.js';
import { saveMatchResult } from '../modules/resultados-data.js';
import {
  saveMatchTeamStats,
  saveMatchPlayerRatings,
  saveGoalEvents,
  saveRedCards,
  saveYellowCards,
} from '../modules/entrada-manual-data.js';
import { escapeHtml } from '../modules/utils.js';

const STAT_FIELDS = [
  ['possession', 'Posesión %'], ['shots', 'Tiros'], ['shots_on_target', 'Tiros a puerta'],
  ['fouls', 'Faltas'], ['offsides', 'Fueras de juego'], ['corners', 'Córners'],
  ['free_kicks', 'Faltas directas'], ['passes', 'Pases'], ['passes_completed', 'Pases completados'],
  ['crosses', 'Centros'], ['interceptions', 'Intercepciones'], ['tackles', 'Entradas'], ['saves', 'Paradas'],
];

(async () => {
  const params = new URLSearchParams(window.location.search);
  const matchUuid = Number(params.get('match'));
  if (!matchUuid) {
    document.getElementById('entrar-resultado-root').innerHTML = '<p>Falta el parámetro ?match=</p>';
    return;
  }

  const slug = getCompetitionFromURL() || await getCurrentCompetitionSlug();
  const competition = await getCompetitionBySlug(slug);
  const supabase = await getSupabaseClient();

  const { data: match, error: matchErr } = await supabase
    .from('matches')
    .select(`
      id, match_uuid, home_goals, away_goals, competition_id, season,
      home:league_teams!matches_home_league_team_id_fkey(id, nickname, display_name, club_id),
      away:league_teams!matches_away_league_team_id_fkey(id, nickname, display_name, club_id)
    `)
    .eq('match_uuid', matchUuid)
    .maybeSingle();

  if (matchErr || !match) {
    document.getElementById('entrar-resultado-root').innerHTML = '<p>No se encontró el partido.</p>';
    return;
  }

  const meta = { match_uuid: match.match_uuid, competition_id: match.competition_id, season: match.season };

  if (competition) {
    const breadcrumbEl = document.getElementById('breadcrumb');
    if (breadcrumbEl) renderBreadcrumb(breadcrumbEl, buildBreadcrumb(slug, competition.name, 'Entrar resultado'));
  }

  document.getElementById('home-name').textContent = match.home?.display_name || match.home?.nickname || 'Local';
  document.getElementById('away-name').textContent = match.away?.display_name || match.away?.nickname || 'Visitante';
  document.getElementById('home-title').textContent = match.home?.display_name || match.home?.nickname || 'Local';
  document.getElementById('away-title').textContent = match.away?.display_name || match.away?.nickname || 'Visitante';
  document.getElementById('home-goals').value = match.home_goals ?? '';
  document.getElementById('away-goals').value = match.away_goals ?? '';

  async function loadSquad(clubId) {
    if (!clubId) return [];
    const { data, error } = await supabase
      .from('player_club_memberships')
      .select('player:players(id, name, position)')
      .eq('club_id', clubId)
      .eq('season', match.season)
      .eq('is_current', true);
    if (error) { console.error('Error cargando plantilla:', error); return []; }
    return (data || []).map(r => r.player).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name, 'es'));
  }

  function renderStatsInputs(container, side) {
    container.innerHTML = STAT_FIELDS.map(([key, label]) => `
      <label for="${side}-stat-${key}">${label}</label>
      <input type="number" id="${side}-stat-${key}" data-key="${key}" />
    `).join('');
  }

  function renderPlayerSelect(select, squad) {
    select.innerHTML = '<option value="">Jugador…</option>' +
      squad.map(p => `<option value="${p.id}">${escapeHtml(p.name)}</option>`).join('');
  }

  function renderRatings(container, squad, side) {
    container.innerHTML = squad.map(p => `
      <div class="er-player-row">
        <span>${escapeHtml(p.name)}</span>
        <input type="number" step="0.1" min="0" max="10" data-player-id="${p.id}" data-player-name="${escapeHtml(p.name)}" id="${side}-rating-${p.id}" />
      </div>
    `).join('');
  }

  function setupAddList(side, kind) {
    const list = [];
    const listEl = document.getElementById(`${side}-${kind}-list`);
    const selectEl = document.getElementById(`${side}-${kind}-select`);
    const minuteEl = document.getElementById(`${side}-${kind}-minute`);
    const addBtn = document.getElementById(`${side}-${kind}-add`);

    function render() {
      listEl.innerHTML = list.map((item, i) => `
        <div class="er-list-item">
          <span>${escapeHtml(item.player_name)}${item.minute != null ? ` (${item.minute}')` : ''}</span>
          <button type="button" data-idx="${i}" class="er-remove">✕</button>
        </div>
      `).join('');
      listEl.querySelectorAll('.er-remove').forEach(btn => {
        btn.addEventListener('click', () => { list.splice(Number(btn.dataset.idx), 1); render(); });
      });
    }

    addBtn.addEventListener('click', () => {
      const playerId = Number(selectEl.value);
      if (!playerId) return;
      const playerName = selectEl.options[selectEl.selectedIndex].textContent;
      const minute = minuteEl.value ? Number(minuteEl.value) : null;
      list.push({ player_id: playerId, player_name: playerName, minute });
      selectEl.value = '';
      minuteEl.value = '';
      render();
    });

    return list;
  }

  const homeSquad = await loadSquad(match.home?.club_id);
  const awaySquad = await loadSquad(match.away?.club_id);

  renderStatsInputs(document.getElementById('home-stats'), 'home');
  renderStatsInputs(document.getElementById('away-stats'), 'away');
  renderPlayerSelect(document.getElementById('home-scorer-select'), homeSquad);
  renderPlayerSelect(document.getElementById('away-scorer-select'), awaySquad);
  renderPlayerSelect(document.getElementById('home-red-select'), homeSquad);
  renderPlayerSelect(document.getElementById('away-red-select'), awaySquad);
  renderPlayerSelect(document.getElementById('home-yellow-select'), homeSquad);
  renderPlayerSelect(document.getElementById('away-yellow-select'), awaySquad);
  renderRatings(document.getElementById('home-ratings'), homeSquad, 'home');
  renderRatings(document.getElementById('away-ratings'), awaySquad, 'away');

  const homeScorers = setupAddList('home', 'scorer');
  const awayScorers = setupAddList('away', 'scorer');
  const homeReds = setupAddList('home', 'red');
  const awayReds = setupAddList('away', 'red');
  const homeYellows = setupAddList('home', 'yellow');
  const awayYellows = setupAddList('away', 'yellow');

  function readStats(side) {
    const stats = {};
    STAT_FIELDS.forEach(([key]) => {
      const el = document.getElementById(`${side}-stat-${key}`);
      stats[key] = el.value === '' ? null : Number(el.value);
    });
    return stats;
  }

  function readRatings(squad, side) {
    return squad.map(p => {
      const el = document.getElementById(`${side}-rating-${p.id}`);
      return { player_id: p.id, player_name: p.name, rating: el.value === '' ? null : el.value };
    });
  }

  document.getElementById('btn-guardar-todo').addEventListener('click', async () => {
    const statusEl = document.getElementById('guardar-status');
    statusEl.textContent = 'Guardando…';

    const homeGoals = Number(document.getElementById('home-goals').value);
    const awayGoals = Number(document.getElementById('away-goals').value);
    if (!Number.isFinite(homeGoals) || !Number.isFinite(awayGoals)) {
      statusEl.textContent = 'Falta el marcador.';
      return;
    }

    const homeTeamId = match.home.id;
    const awayTeamId = match.away.id;

    // Orden importa: match_team_stats debe existir ANTES de guardar el
    // marcador, porque trigger_check_resolved_administratively (BEFORE
    // UPDATE OF home_goals/away_goals en `matches`) solo se dispara al
    // cambiar el marcador y decide resolved_administratively mirando si ya
    // hay filas en match_team_stats en ese momento. Si se guarda el
    // marcador antes (o en paralelo, con Promise.all), el trigger no ve
    // las stats todavía y marca el partido como no resuelto de verdad,
    // excluyéndolo de MVP/Best XI aunque las stats sí se guardaran después.
    const results = [];
    results.push(await saveMatchTeamStats(match.id, meta, homeTeamId, readStats('home')));
    results.push(await saveMatchTeamStats(match.id, meta, awayTeamId, readStats('away')));
    results.push(await saveMatchPlayerRatings(match.id, meta, homeTeamId, readRatings(homeSquad, 'home')));
    results.push(await saveMatchPlayerRatings(match.id, meta, awayTeamId, readRatings(awaySquad, 'away')));
    results.push(await saveGoalEvents(match.id, meta, homeTeamId, homeScorers));
    results.push(await saveGoalEvents(match.id, meta, awayTeamId, awayScorers));
    results.push(await saveRedCards(match.id, meta, homeTeamId, homeReds));
    results.push(await saveRedCards(match.id, meta, awayTeamId, awayReds));
    results.push(await saveYellowCards(match.id, meta, homeTeamId, homeYellows));
    results.push(await saveYellowCards(match.id, meta, awayTeamId, awayYellows));
    results.push(await saveMatchResult(match.id, meta, homeGoals, awayGoals));

    const failed = results.filter(r => !r.ok);
    statusEl.textContent = failed.length
      ? `Errores: ${failed.map(f => f.msg).join(' / ')}`
      : 'Guardado correctamente.';
  });
})();
