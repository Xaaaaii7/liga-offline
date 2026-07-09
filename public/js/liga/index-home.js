import { getSupabaseClient } from '../modules/supabase-client.js';
import { escapeHtml } from '../modules/utils.js';

(async () => {
  const supabase = await getSupabaseClient();
  const gridEl = document.getElementById('competitions-grid');
  const loadingEl = document.getElementById('competitions-loading');
  const emptyEl = document.getElementById('competitions-empty');

  const { data: competitions, error } = await supabase
    .from('competitions')
    .select('id, name, slug, season, competition_type, logo_url')
    .order('id', { ascending: false });

  loadingEl.style.display = 'none';

  if (error) {
    gridEl.innerHTML = `<p>Error cargando competiciones: ${escapeHtml(error.message)}</p>`;
    return;
  }
  if (!competitions.length) {
    emptyEl.style.display = 'block';
    return;
  }

  const cards = await Promise.all(competitions.map(async (comp) => {
    const { count: teamCount } = await supabase
      .from('league_teams')
      .select('id', { count: 'exact', head: true })
      .eq('competition_id', comp.id);

    const { count: totalMatches } = await supabase
      .from('matches')
      .select('match_uuid', { count: 'exact', head: true })
      .eq('competition_id', comp.id);

    const { count: playedMatches } = await supabase
      .from('matches')
      .select('match_uuid', { count: 'exact', head: true })
      .eq('competition_id', comp.id)
      .not('home_goals', 'is', null)
      .not('away_goals', 'is', null);

    // "Acceder" entra a la competición (landing = clasificación) si ya hay
    // calendario; si no, lleva a configurar para generarlo primero.
    const hasCalendar = (totalMatches ?? 0) > 0;
    const accederHref = hasCalendar
      ? `clasificacion.html?comp=${encodeURIComponent(comp.slug)}`
      : `configurar-competicion.html?comp=${encodeURIComponent(comp.slug)}`;

    return { comp, teamCount: teamCount ?? 0, total: totalMatches ?? 0, played: playedMatches ?? 0, accederHref };
  }));

  const typeLabels = { league: 'Liga', cup: 'Copa', mixed: 'Mixta', ranked: 'Ranked' };

  gridEl.innerHTML = cards.map(({ comp, teamCount, total, played, accederHref }) => {
    const completion = total > 0 ? Math.round((played / total) * 100) : 0;
    const logoSrc = comp.logo_url || 'img/logo.png';
    const typeBadge = `<span class="comp-card__badge">${escapeHtml(typeLabels[comp.competition_type] || comp.competition_type)}</span>`;
    const seasonBadge = comp.season ? `<span class="comp-card__badge">${escapeHtml(comp.season)}</span>` : '';

    return `
      <article class="comp-card" data-competition-id="${comp.id}">
        <div class="comp-card__head">
          <img class="comp-card__logo" src="${escapeHtml(logoSrc)}" alt="" onerror="this.src='img/logo.png'">
          <div class="comp-card__title">
            <h3 class="comp-card__name">${escapeHtml(comp.name)}</h3>
            <div class="comp-card__badges">${typeBadge}${seasonBadge}</div>
          </div>
        </div>

        <div class="comp-card__kpis">
          <div class="comp-card__kpi">
            <div class="comp-card__kpi-value comp-card__kpi-value--accent">${teamCount}</div>
            <div class="comp-card__kpi-label">Equipos</div>
          </div>
          <div class="comp-card__kpi">
            <div class="comp-card__kpi-value">${played}<span style="opacity:.45">/${total}</span></div>
            <div class="comp-card__kpi-label">Partidos</div>
          </div>
          <div class="comp-card__kpi">
            <div class="comp-card__kpi-value">${completion}%</div>
            <div class="comp-card__kpi-label">Completado</div>
          </div>
        </div>

        <div class="comp-card__progress" aria-hidden="true">
          <div class="comp-card__progress-fill" style="width:${completion}%"></div>
        </div>

        <div class="comp-card__actions">
          <a class="btn btn-outline" href="configurar-competicion.html?comp=${encodeURIComponent(comp.slug)}">⚙️ Configurar</a>
          <a class="btn btn-primary" href="${accederHref}">Acceder</a>
        </div>
      </article>
    `;
  }).join('');
})();
