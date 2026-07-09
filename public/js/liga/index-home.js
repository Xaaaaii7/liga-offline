import { getSupabaseClient } from '../modules/supabase-client.js';
import { escapeHtml } from '../modules/utils.js';

(async () => {
  const supabase = await getSupabaseClient();
  const listEl = document.getElementById('lista-competiciones');

  const { data: competitions, error } = await supabase
    .from('competitions')
    .select('id, name, slug, season')
    .order('id', { ascending: false });

  if (error) {
    listEl.innerHTML = `<p>Error cargando competiciones: ${escapeHtml(error.message)}</p>`;
    return;
  }
  if (!competitions.length) {
    listEl.innerHTML = '<p class="idx-empty">Todavía no hay ninguna competición. Crea la primera abajo.</p>';
    return;
  }

  const cards = await Promise.all(competitions.map(async (comp) => {
    const { count: teamCount } = await supabase
      .from('league_teams')
      .select('id', { count: 'exact', head: true })
      .eq('competition_id', comp.id);

    let continueHref = `configurar-competicion.html?comp=${encodeURIComponent(comp.slug)}`;
    let continueLabel = 'Configurar / generar calendario';

    if (teamCount > 0) {
      const { data: pending } = await supabase
        .from('matches')
        .select('round_id')
        .eq('competition_id', comp.id)
        .or('home_goals.is.null,away_goals.is.null')
        .not('round_id', 'is', null)
        .order('round_id', { ascending: true })
        .limit(1)
        .maybeSingle();

      if (pending?.round_id != null) {
        continueHref = `jornada-offline.html?comp=${encodeURIComponent(comp.slug)}&jornada=${pending.round_id}`;
        continueLabel = `Ir a jornada ${pending.round_id}`;
      } else {
        const { count: matchCount } = await supabase
          .from('matches')
          .select('match_uuid', { count: 'exact', head: true })
          .eq('competition_id', comp.id);
        if (matchCount > 0) {
          continueHref = `jornada-offline.html?comp=${encodeURIComponent(comp.slug)}&jornada=1`;
          continueLabel = 'Temporada completa — ver jornadas';
        }
      }
    }

    return { comp, teamCount: teamCount ?? 0, continueHref, continueLabel };
  }));

  listEl.innerHTML = cards.map(({ comp, teamCount, continueHref, continueLabel }) => `
    <div class="idx-comp-card">
      <div>
        <strong>${escapeHtml(comp.name)}</strong>
        <div class="idx-comp-meta">${escapeHtml(comp.season)} · ${teamCount} equipos</div>
      </div>
      <div class="idx-comp-actions">
        <a href="estadisticas.html?comp=${encodeURIComponent(comp.slug)}"><button type="button">Stats</button></a>
        <a href="${continueHref}"><button type="button">${escapeHtml(continueLabel)}</button></a>
      </div>
    </div>
  `).join('');
})();
