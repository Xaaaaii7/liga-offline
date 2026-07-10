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
import { recognizeStats, recognizeRatings } from '../modules/ocr-efootball.js';

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

  function setupAddList(side, kind, initial = []) {
    const list = [...initial];
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

    render(); // pinta los items iniciales (edición de un partido ya jugado)
    return list;
  }

  const homeSquad = await loadSquad(match.home?.club_id);
  const awaySquad = await loadSquad(match.away?.club_id);
  const homeTeamId = match.home?.id;
  const awayTeamId = match.away?.id;

  // Carga los datos YA guardados del partido para poder EDITARLOS (no solo
  // rellenar en blanco). El nombre del goleador/tarjeta se resuelve desde la
  // plantilla por player_id.
  const nameById = new Map([...homeSquad, ...awaySquad].map(p => [p.id, p.name]));
  async function loadExisting() {
    const [geR, rcR, ycR, tsR, prR] = await Promise.all([
      supabase.from('goal_events').select('player_id, league_team_id, minute').eq('match_uuid', matchUuid).order('minute'),
      supabase.from('match_red_cards').select('player_id, league_team_id, minute').eq('match_uuid', matchUuid).order('minute'),
      supabase.from('match_yellow_cards').select('player_id, league_team_id, minute').eq('match_uuid', matchUuid).order('minute'),
      supabase.from('match_team_stats').select('*').eq('match_uuid', matchUuid),
      supabase.from('match_player_ratings').select('player_id, rating, league_team_id').eq('match_uuid', matchUuid),
    ]);
    const forSide = (rows, teamId) => (rows || []).filter(r => r.league_team_id === teamId);
    const toItems = (rows) => rows.map(r => ({ player_id: r.player_id, player_name: nameById.get(r.player_id) || '?', minute: r.minute ?? null }));
    const build = (teamId) => ({
      scorers: toItems(forSide(geR.data, teamId)),
      reds: toItems(forSide(rcR.data, teamId)),
      yellows: toItems(forSide(ycR.data, teamId)),
      stats: (tsR.data || []).find(s => s.league_team_id === teamId) || null,
      ratings: forSide(prR.data, teamId),
    });
    return { home: build(homeTeamId), away: build(awayTeamId) };
  }
  const existing = await loadExisting();

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

  // Pre-rellena stats y ratings existentes en los inputs.
  const prefill = (side, data) => {
    if (data.stats) {
      for (const [key] of STAT_FIELDS) {
        const el = document.getElementById(`${side}-stat-${key}`);
        if (el && data.stats[key] != null) el.value = data.stats[key];
      }
    }
    data.ratings.forEach(r => {
      const el = document.getElementById(`${side}-rating-${r.player_id}`);
      if (el && r.rating != null) el.value = r.rating;
    });
  };
  prefill('home', existing.home);
  prefill('away', existing.away);

  const homeScorers = setupAddList('home', 'scorer', existing.home.scorers);
  const awayScorers = setupAddList('away', 'scorer', existing.away.scorers);
  const homeReds = setupAddList('home', 'red', existing.home.reds);
  const awayReds = setupAddList('away', 'red', existing.away.reds);
  const homeYellows = setupAddList('home', 'yellow', existing.home.yellows);
  const awayYellows = setupAddList('away', 'yellow', existing.away.yellows);

  // ── OCR de fotos → pre-rellena el editor (todo revisable/editable) ──────
  const normalize = (s) => (s || '').toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  const lev = (a, b) => {
    const m = a.length, n = b.length;
    if (!m) return n; if (!n) return m;
    const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
    for (let j = 0; j <= n; j++) dp[0][j] = j;
    for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return dp[m][n];
  };
  const sim = (a, b) => { a = normalize(a); b = normalize(b); if (!a || !b) return 0; return 1 - lev(a, b) / Math.max(a.length, b.length); };
  const bestMatch = (name, players) => {
    let best = null, score = 0;
    for (const p of players) { const s = sim(name, p.name); if (s > score) { score = s; best = p; } }
    return score >= 0.55 ? { player: best, score } : null;
  };

  const setStatus = (id, msg) => { const el = document.getElementById(id); if (el) el.textContent = msg; };

  document.getElementById('ocr-stats-input').addEventListener('change', async (ev) => {
    const file = ev.target.files?.[0]; if (!file) return;
    setStatus('ocr-stats-status', 'Leyendo la captura… (puede tardar unos segundos)');
    try {
      const res = await recognizeStats(file);
      // Orientar foto (izq/der) → local/visitante por nombre de equipo.
      const homeName = match.home?.display_name || match.home?.nickname || '';
      const awayName = match.away?.display_name || match.away?.nickname || '';
      const leftIsHome = sim(res.leftName, homeName) >= sim(res.leftName, awayName);
      const hScore = leftIsHome ? res.score.left : res.score.right;
      const aScore = leftIsHome ? res.score.right : res.score.left;
      const hStats = leftIsHome ? res.stats.left : res.stats.right;
      const aStats = leftIsHome ? res.stats.right : res.stats.left;
      if (hScore != null) document.getElementById('home-goals').value = hScore;
      if (aScore != null) document.getElementById('away-goals').value = aScore;
      let n = 0;
      for (const [key] of STAT_FIELDS) {
        if (hStats[key] != null) { const el = document.getElementById(`home-stat-${key}`); if (el) { el.value = hStats[key]; n++; } }
        if (aStats[key] != null) { const el = document.getElementById(`away-stat-${key}`); if (el) { el.value = aStats[key]; n++; } }
      }
      setStatus('ocr-stats-status', `Leído: marcador ${hScore ?? '?'}-${aScore ?? '?'} y ${n} valores de stats. Revisa y corrige.`);
    } catch (e) {
      console.error('[OCR stats]', e);
      setStatus('ocr-stats-status', 'No se pudo leer la imagen: ' + e.message);
    } finally {
      ev.target.value = '';
    }
  });

  document.getElementById('ocr-ratings-input').addEventListener('change', async (ev) => {
    const file = ev.target.files?.[0]; if (!file) return;
    setStatus('ocr-ratings-status', 'Leyendo valoraciones… (puede tardar unos segundos)');
    try {
      const res = await recognizeRatings(file);
      let n = 0, miss = 0;
      for (const row of res.rows) {
        const h = bestMatch(row.name, homeSquad);
        const a = bestMatch(row.name, awaySquad);
        let side = null, player = null;
        if (h && (!a || h.score >= a.score)) { side = 'home'; player = h.player; }
        else if (a) { side = 'away'; player = a.player; }
        if (player) { const el = document.getElementById(`${side}-rating-${player.id}`); if (el) { el.value = row.rating; n++; } }
        else miss++;
      }
      setStatus('ocr-ratings-status', `Leídas ${n} valoraciones${miss ? ` (${miss} nombres sin casar)` : ''}. Revisa y corrige.`);
    } catch (e) {
      console.error('[OCR ratings]', e);
      setStatus('ocr-ratings-status', 'No se pudo leer la imagen: ' + e.message);
    } finally {
      ev.target.value = '';
    }
  });

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
    // Editar = reemplazar: los eventos (goles/tarjetas) hacen INSERT, así que se
    // borran los previos del partido antes de re-insertar la lista actual (stats
    // y ratings ya hacen upsert). Va tras las stats para no dejar el partido sin
    // filas de stats al recalcular resolved_administratively.
    await supabase.from('goal_events').delete().eq('match_uuid', matchUuid);
    await supabase.from('match_red_cards').delete().eq('match_uuid', matchUuid);
    await supabase.from('match_yellow_cards').delete().eq('match_uuid', matchUuid);
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
