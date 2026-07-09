import { getSupabaseClient } from '../modules/supabase-client.js';
import { getCompetitionFromURL, getCurrentCompetitionSlug, buildBreadcrumb, renderBreadcrumb } from '../modules/competition-context.js';
import { getCompetitionBySlug } from '../modules/competition-data.js';
import { escapeHtml } from '../modules/utils.js';

(async () => {
  const slug = getCompetitionFromURL() || await getCurrentCompetitionSlug();
  const competition = await getCompetitionBySlug(slug);
  if (!competition) {
    document.getElementById('jornada-root').innerHTML = '<p>No se encontró la competición.</p>';
    return;
  }

  const breadcrumbEl = document.getElementById('breadcrumb');

  const params = new URLSearchParams(window.location.search);
  let jornada = Number(params.get('jornada')) || 1;

  const supabase = await getSupabaseClient();

  async function loadMatches(jornadaNum) {
    const { data, error } = await supabase
      .from('matches')
      .select(`
        id, match_uuid, home_goals, away_goals,
        home:league_teams!matches_home_league_team_id_fkey(id, nickname, display_name, is_human_controlled),
        away:league_teams!matches_away_league_team_id_fkey(id, nickname, display_name, is_human_controlled)
      `)
      .eq('competition_id', competition.id)
      .eq('round_id', jornadaNum)
      .order('match_uuid');
    if (error) {
      console.error('Error cargando partidos de la jornada:', error);
      return [];
    }
    return data || [];
  }

  function teamLabel(t) {
    return escapeHtml(t?.display_name || t?.nickname || '?');
  }

  function renderMatches(matches) {
    const tbody = document.getElementById('tabla-partidos');
    if (!matches.length) {
      tbody.innerHTML = '<tr><td colspan="4">No hay partidos en esta jornada.</td></tr>';
      return;
    }
    tbody.innerHTML = matches.map(m => {
      const played = m.home_goals != null && m.away_goals != null;
      const score = played ? `${m.home_goals} - ${m.away_goals}` : 'vs';
      const esHumano = m.home?.is_human_controlled || m.away?.is_human_controlled;
      let accion;
      if (played) {
        accion = '✅ Jugado';
      } else if (esHumano) {
        accion = `<a href="entrar-resultado.html?match=${m.match_uuid}&comp=${encodeURIComponent(slug)}">Entrar resultado</a>`;
      } else {
        // Modo "match" (no "teams"): el fixture ya existe (lo creó el
        // generador de calendario) — "teams" crearía un partido nuevo
        // aparte en vez de rellenar este.
        accion = `<code>node scripts/simulate-match.js match ${escapeHtml(m.id)}</code> + <code>node scripts/apply-sql.mjs &lt;salida&gt;</code>`;
      }
      return `
        <tr>
          <td>${teamLabel(m.home)}${m.home?.is_human_controlled ? ' 👤' : ''}</td>
          <td>${score}</td>
          <td>${teamLabel(m.away)}${m.away?.is_human_controlled ? ' 👤' : ''}</td>
          <td>${accion}</td>
        </tr>
      `;
    }).join('');
  }

  async function render() {
    document.getElementById('jornada-numero').textContent = `Jornada ${jornada}`;
    document.getElementById('jornada-title').textContent = `${competition.name} — Jornada ${jornada}`;
    if (breadcrumbEl) {
      renderBreadcrumb(breadcrumbEl, buildBreadcrumb(slug, competition.name, `Jornada ${jornada}`));
    }
    const matches = await loadMatches(jornada);
    renderMatches(matches);
    const url = new URL(window.location.href);
    url.searchParams.set('jornada', jornada);
    window.history.replaceState({}, '', url);
  }

  document.getElementById('btn-jornada-prev').addEventListener('click', () => {
    if (jornada > 1) { jornada -= 1; render(); }
  });
  document.getElementById('btn-jornada-next').addEventListener('click', () => {
    jornada += 1; render();
  });

  await render();
})();
