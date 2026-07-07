/**
 * Renderiza la clasificación de una competición ranked
 */
async function renderRankedStandings(competitionId, competitionSlug, competitionName, tbody) {
  console.log('[Ranked Standings] Starting with:', { competitionId, tbody });

  const { getSupabaseClient } = await import('../modules/supabase-client.js');
  const { logoPath, escapeHtml } = await import('../modules/utils.js');
  const { buildBreadcrumb, renderBreadcrumb } = await import('../modules/competition-context.js');

  const supabase = await getSupabaseClient();

  // Buscar contenedor de forma robusta
  let container = tbody?.parentElement;

  if (!container) {
    container = document.querySelector('.table-wrap') || document.querySelector('#table-wrap');
  }

  if (!container) {
    // Crear contenedor si no existe
    const main = document.querySelector('main.container') || document.querySelector('main');
    if (main) {
      container = document.createElement('div');
      container.className = 'table-wrap';
      container.id = 'table-wrap';
      main.appendChild(container);
      console.log('[Ranked Standings] Created container');
    }
  }

  if (!container) {
    console.error('[Ranked Standings] Could not find or create container');
    return;
  }

  console.log('[Ranked Standings] Using container:', container);

  // Renderizar breadcrumb
  let breadcrumbContainer = container.previousElementSibling;
  if (!breadcrumbContainer || !breadcrumbContainer.classList.contains('breadcrumb-container')) {
    breadcrumbContainer = document.createElement('div');
    breadcrumbContainer.className = 'breadcrumb-container';
    breadcrumbContainer.style.marginBottom = '1rem';
    container.parentElement.insertBefore(breadcrumbContainer, container);
  }

  if (competitionName) {
    const breadcrumbItems = buildBreadcrumb(competitionSlug, competitionName, 'Clasificación');
    renderBreadcrumb(breadcrumbContainer, breadcrumbItems);
  }

  // Cargar standings
  container.innerHTML = '<p class="hint">Cargando clasificación...</p>';

  try {
    console.log('[Ranked Standings] Fetching data for competition:', competitionId);

    // Query simplificada - solo league_teams
    const { data: standings, error } = await supabase
      .from('ranked_ratings')
      .select(`
        rating,
        matches_played,
        wins,
        draws,
        losses,
        goals_for,
        goals_against,
        goal_difference,
        league_team_id,
        league_teams (
          id,
          nickname,
          display_name
        )
      `)
      .eq('competition_id', competitionId)
      .order('rating', { ascending: false });

    console.log('[Ranked Standings] Query result:', { standings, error });

    if (error) {
      console.error('[Ranked Standings] Error loading:', error);
      container.innerHTML = `<p class="hint">Error al cargar la clasificación: ${escapeHtml(error.message)}</p>`;
      return;
    }

    if (!standings || standings.length === 0) {
      container.innerHTML = '<p class="hint">No hay equipos en esta competición ranked aún. Los equipos aparecerán aquí cuando se creen partidos.</p>';
      return;
    }

    // Crear tabla
    const tableHtml = `
      <table class="clasificacion-table">
        <thead>
          <tr>
            <th class="pos-header">#</th>
            <th class="team-header">Equipo</th>
            <th title="Rating ELO">Rating</th>
            <th title="Partidos Jugados">PJ</th>
            <th title="Ganados">G</th>
            <th title="Empatados">E</th>
            <th title="Perdidos">P</th>
            <th title="Goles a Favor">GF</th>
            <th title="Goles en Contra">GC</th>
            <th title="Diferencia de Goles">DG</th>
          </tr>
        </thead>
        <tbody id="tabla-clasificacion">
          ${standings.map((team, index) => {
      const teamName = team.league_teams?.nickname || team.league_teams?.display_name || 'Equipo';
      const logoUrl = logoPath(teamName);
      const diffClass = team.goal_difference > 0 ? 'positive' : team.goal_difference < 0 ? 'negative' : '';

      const teamNameSafe = escapeHtml(teamName);
      return `
              <tr class="team-row" data-team-id="${escapeHtml(team.league_team_id)}">
                <td class="pos-cell">
                  <span class="pos-index">${index + 1}</span>
                </td>
                <td class="team-cell">
                  <img class="team-badge"
                       src="${escapeHtml(logoUrl)}"
                       alt="Escudo ${teamNameSafe}"
                       onerror="this.style.visibility='hidden'">
                  <span class="team-name">${teamNameSafe}</span>
                </td>
                <td class="rating-cell"><strong>${team.rating}</strong></td>
                <td>${team.matches_played}</td>
                <td>${team.wins}</td>
                <td>${team.draws}</td>
                <td>${team.losses}</td>
                <td>${team.goals_for}</td>
                <td>${team.goals_against}</td>
                <td class="${diffClass}">${team.goal_difference > 0 ? '+' : ''}${team.goal_difference}</td>
              </tr>
            `;
    }).join('')}
        </tbody>
      </table>
    `;

    container.innerHTML = tableHtml;
    console.log('[Ranked Standings] Table rendered successfully');

  } catch (e) {
    console.error('[Ranked Standings] Exception:', e);
    container.innerHTML = `<p class="hint">Error al renderizar la clasificación: ${escapeHtml(e.message)}</p>`;
  }
}

export { renderRankedStandings };
