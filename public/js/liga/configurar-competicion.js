import { getSupabaseClient } from '../modules/supabase-client.js';
import { getCompetitionFromURL, getCurrentCompetitionSlug, buildBreadcrumb, renderBreadcrumb } from '../modules/competition-context.js';
import { getCompetitionBySlug } from '../modules/competition-data.js';
import { generateScheduleForCompetition } from '../modules/competition-permissions.js';
import { escapeHtml } from '../modules/utils.js';

(async () => {
  const slug = getCompetitionFromURL() || await getCurrentCompetitionSlug();
  const competition = await getCompetitionBySlug(slug);
  if (!competition) {
    document.getElementById('configurar-root').innerHTML = '<p>No se encontró la competición.</p>';
    return;
  }

  const breadcrumbEl = document.getElementById('breadcrumb');
  if (breadcrumbEl) {
    renderBreadcrumb(breadcrumbEl, buildBreadcrumb(slug, competition.name, 'Configurar'));
  }

  const supabase = await getSupabaseClient();
  const tbody = document.getElementById('tabla-equipos');

  async function loadTeams() {
    const { data, error } = await supabase
      .from('league_teams')
      .select('id, nickname, display_name, is_human_controlled, club:clubs(name)')
      .eq('competition_id', competition.id)
      .order('nickname');
    if (error) {
      console.error('Error cargando equipos:', error);
      tbody.innerHTML = `<tr><td colspan="3">Error cargando equipos: ${escapeHtml(error.message)}</td></tr>`;
      return [];
    }
    return data || [];
  }

  function renderTeams(teams) {
    tbody.innerHTML = teams.map(t => `
      <tr>
        <td>${escapeHtml(t.display_name || t.nickname)}</td>
        <td>${escapeHtml(t.club?.name || '')}</td>
        <td><input type="checkbox" data-team-id="${t.id}" ${t.is_human_controlled ? 'checked' : ''} /></td>
      </tr>
    `).join('');

    tbody.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', async () => {
        const teamId = Number(cb.dataset.teamId);
        const { error } = await supabase
          .from('league_teams')
          .update({ is_human_controlled: cb.checked })
          .eq('id', teamId);
        if (error) {
          console.error('Error guardando is_human_controlled:', error);
          cb.checked = !cb.checked; // revertir en la UI si falló
        }
      });
    });
  }

  let teams = await loadTeams();
  renderTeams(teams);

  document.getElementById('btn-generar-calendario').addEventListener('click', async () => {
    const statusEl = document.getElementById('calendario-status');
    const startDate = document.getElementById('start-date').value || null;
    const teamIds = teams.map(t => t.id);

    if (teamIds.length < 2) {
      statusEl.textContent = 'Hacen falta al menos 2 equipos.';
      return;
    }

    statusEl.textContent = 'Generando calendario…';
    const result = await generateScheduleForCompetition(competition.id, teamIds, { startDate });
    if (result.success) {
      statusEl.textContent = `Calendario generado: ${result.matchesCreated ?? ''} partidos creados.`;
    } else {
      statusEl.textContent = `Error: ${result.error}`;
    }
  });
})();
