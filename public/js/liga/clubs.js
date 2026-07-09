import { getCompetitionFromURL, getCurrentCompetitionSlug, buildURLWithCompetition } from '../modules/competition-context.js';
import { loadCompetitionTheme } from '../modules/theme-loader.js';
import { escapeHtml } from '../modules/utils.js';

(async () => {
  const grid = document.getElementById("clubs-grid");
  if (!grid) return;

  // Obtener contexto de competición
  let competitionSlug = getCompetitionFromURL();
  if (!competitionSlug) {
    try {
      competitionSlug = await getCurrentCompetitionSlug();
    } catch (e) {
      console.debug('No se pudo obtener competitionSlug:', e);
    }
  }

  // Aplicar tema si hay competición
  if (competitionSlug) {
    try {
      const { getCompetitionBySlug } = await import('../modules/competition-data.js');
      const competition = await getCompetitionBySlug(competitionSlug);
      if (competition && competition.id) {
        await loadCompetitionTheme(competition.id);
      }
    } catch (e) {
      console.debug('No se pudo aplicar tema:', e);
    }
  }

  // Aseguramos que CoreStats esté cargado
  if (!window.CoreStats) {
    grid.innerHTML = `<p style="color:var(--muted)">No se pudo inicializar CoreStats.</p>`;
    return;
  }

  const { norm, slug } = CoreStats;

  // Obtener competitionId
  let competitionId = null;
  if (competitionSlug) {
    try {
      const { getCompetitionBySlug } = await import('../modules/competition-data.js');
      const competition = await getCompetitionBySlug(competitionSlug);
      if (competition) {
        competitionId = competition.id;
      }
    } catch (e) {
      console.debug('No se pudo obtener competitionId:', e);
    }
  }

  if (!competitionId) {
    grid.innerHTML = `<p style="color:var(--muted)">No se pudo obtener la competición.</p>`;
    return;
  }

  const logoPath = (name) => `img/${slug(name)}.png`;

  // Intentar usar la vista league_teams_by_competition (SQL)
  let equipos = [];
  try {
    const { getSupabaseClient } = await import('../modules/supabase-client.js');
    const supabase = await getSupabaseClient();

    const { data, error } = await supabase
      .from('league_teams_by_competition')
      .select('nickname, display_name, club_crest')
      .eq('competition_id', competitionId)
      .order('nickname', { ascending: true, nullsLast: true });

    if (error) {
      console.warn('Error obteniendo equipos desde league_teams_by_competition, usando fallback:', error);
      throw error;
    }

    if (data && data.length > 0) {
      // Usar nickname (nombre de usuario) como principal, display_name como fallback
      equipos = data
        .map(team => ({
          name: team.nickname || team.display_name,
          crest: team.club_crest || ''
        }))
        .filter(t => t.name);
    }
  } catch (e) {
    // Fallback: extraer equipos desde jornadas (método anterior)
    console.log('[clubs.js] Usando método fallback para obtener equipos');
    const jornadas = await CoreStats.getResultados(competitionId).catch(() => []);
    if (Array.isArray(jornadas) && jornadas.length > 0) {
      const set = new Map();
      for (const j of jornadas) {
        for (const p of (j.partidos || [])) {
          if (p.local) set.set(norm(p.local), p.local);
          if (p.visitante) set.set(norm(p.visitante), p.visitante);
        }
      }
      equipos = Array.from(set.values())
        .sort((a,b)=> a.localeCompare(b, "es", { sensitivity:"base" }))
        .map(name => ({ name, crest: '' }));
    }
  }

  if (!equipos.length) {
    grid.innerHTML = `<p style="color:var(--muted)">No hay equipos disponibles.</p>`;
    return;
  }

  grid.innerHTML = equipos.map(({ name: eq, crest }) => {
    // Construir URL con parámetro de competición si existe
    const clubUrl = buildURLWithCompetition('club.html', competitionSlug, { team: eq });
    const eqSafe = escapeHtml(eq);
    const badgeSrc = crest || logoPath(eq);
    return `
    <a class="club-card" href="${escapeHtml(clubUrl)}" aria-label="Entrar a ${eqSafe}">
      <div class="club-badge-wrap">
        <img class="club-badge" src="${escapeHtml(badgeSrc)}" alt="Escudo ${eqSafe}"
             onerror="this.style.visibility='hidden'">
      </div>
      <div class="club-name">${eqSafe}</div>
      <div class="club-cta">Ver club →</div>
    </a>
  `;
  }).join("");
})();
