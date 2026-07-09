import { getSupabaseClient } from '../modules/supabase-client.js';
import { listSeasons } from '../modules/seasons-data.js';
import { escapeHtml } from '../modules/utils.js';

// Copiado tal cual de create-competition.js (lliga original).
function generateSlug(text) {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // Eliminar acentos
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

(async () => {
  const supabase = await getSupabaseClient();
  const messagesEl = document.getElementById('messages');
  const nameEl = document.getElementById('name');
  const slugEl = document.getElementById('slug');
  const seasonEl = document.getElementById('season');
  const clubsPickerEl = document.getElementById('clubs-picker');
  const clubsCountEl = document.getElementById('clubs-count');

  // Autogenerar slug a partir del nombre mientras el usuario no lo toque a mano.
  let slugTouched = false;
  slugEl.addEventListener('input', () => { slugTouched = true; });
  nameEl.addEventListener('input', () => {
    if (!slugTouched) slugEl.value = generateSlug(nameEl.value);
  });

  const seasons = await listSeasons();
  seasonEl.innerHTML = seasons.map(s =>
    `<option value="${escapeHtml(s.name)}" ${s.is_active ? 'selected' : ''}>${escapeHtml(s.name)}</option>`
  ).join('');

  const { data: clubs, error: clubsErr } = await supabase
    .from('clubs')
    .select('id, name, short_name, league:leagues(name)')
    .order('name');
  if (clubsErr) {
    clubsPickerEl.innerHTML = `Error cargando clubes: ${escapeHtml(clubsErr.message)}`;
  } else {
    const groups = new Map();
    for (const c of clubs) {
      const leagueName = c.league?.name || 'Sin liga';
      if (!groups.has(leagueName)) groups.set(leagueName, []);
      groups.get(leagueName).push(c);
    }
    const sortedLeagues = [...groups.keys()].sort();
    clubsPickerEl.innerHTML = sortedLeagues.map(leagueName => `
      <div class="cc-league-group">
        <h4>${escapeHtml(leagueName)}</h4>
        <div class="cc-clubs">
          ${groups.get(leagueName).map(c => `
            <label class="cc-club-option">
              <input type="checkbox" name="club" value="${c.id}" />
              ${escapeHtml(c.name)}
            </label>
          `).join('')}
        </div>
      </div>
    `).join('');
  }

  function updateCount() {
    clubsCountEl.textContent = document.querySelectorAll('input[name="club"]:checked').length;
  }
  clubsPickerEl.addEventListener('change', updateCount);
  updateCount();

  function showError(msg) {
    messagesEl.innerHTML = `<p style="color:var(--danger,#c0392b)">${escapeHtml(msg)}</p>`;
  }

  document.getElementById('crear-competicion-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    messagesEl.innerHTML = '';

    const name = nameEl.value.trim();
    const slug = (slugEl.value.trim() || generateSlug(name));
    const season = seasonEl.value;
    const selectedClubs = [...document.querySelectorAll('input[name="club"]:checked')].map(cb => ({
      id: Number(cb.value),
      name: cb.parentElement.textContent.trim(),
    }));

    if (!name || !slug || !season) {
      showError('Faltan campos obligatorios.');
      return;
    }
    if (selectedClubs.length < 2) {
      showError('Selecciona al menos 2 equipos.');
      return;
    }

    const { data: existing } = await supabase.from('competitions').select('id').eq('slug', slug).maybeSingle();
    if (existing) {
      showError(`El slug "${slug}" ya existe. Elige otro nombre.`);
      return;
    }

    const pointsWin = parseInt(document.getElementById('points_win').value, 10) || 0;
    const pointsDraw = parseInt(document.getElementById('points_draw').value, 10) || 0;
    const pointsLoss = parseInt(document.getElementById('points_loss').value, 10) || 0;
    const tiebreaker = [...document.querySelectorAll('input[name="tiebreaker"]:checked')].map(cb => cb.value);

    const typeConfig = {
      format: document.getElementById('league_format').value,
      points_win: pointsWin,
      points_draw: pointsDraw,
      points_loss: pointsLoss,
      tiebreaker: tiebreaker.length ? tiebreaker : ['points', 'goal_difference', 'goals_for', 'head_to_head'],
    };

    const { data: competition, error: compErr } = await supabase
      .from('competitions')
      .insert({
        name, slug, season,
        competition_type: 'league',
        max_teams: Math.max(selectedClubs.length, 2),
        type_config: typeConfig,
      })
      .select('id, slug')
      .single();

    if (compErr) {
      showError(`Error creando la competición: ${compErr.message}`);
      return;
    }

    const leagueTeamsRows = selectedClubs.map(c => ({
      season, club_id: c.id, nickname: c.name.slice(0, 20), competition_id: competition.id,
    }));
    const { error: teamsErr } = await supabase.from('league_teams').insert(leagueTeamsRows);
    if (teamsErr) {
      showError(`Competición creada pero falló al crear los equipos: ${teamsErr.message}`);
      return;
    }

    window.location.href = `configurar-competicion.html?comp=${encodeURIComponent(competition.slug)}`;
  });
})();
