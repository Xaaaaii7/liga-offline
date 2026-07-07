import { classifyPosition, getPositionName } from '../modules/player-ratings-data.js';
import { getCompetitionFromURL, getCurrentCompetitionSlug, buildBreadcrumb, renderBreadcrumb } from '../modules/competition-context.js';
import { getCompetitionBySlug } from '../modules/competition-data.js';
import { loadCompetitionTheme } from '../modules/theme-loader.js';
import { getSupabaseClient } from '../modules/supabase-client.js';
import { renderPodium } from '../modules/podium.js';
import { escapeHtml } from '../modules/utils.js';
import {
  fetchGoalMinutesByCompetition,
  fetchGoalMinutesByPlayer,
  fetchTopScorersForCompetition,
  fetchMatchTimelines,
  computeFirstGoalOutcome,
  computeComebacks,
  renderTramoChart,
} from '../modules/goal-timing-stats.js';

// URL safe para usar en src/href: rechaza javascript: / data: / vbscript:.
const safeUrl = (url) => {
  if (!url) return '';
  const s = String(url).trim();
  return /^(https?:|\/|\.\/|\.\.\/|#)/i.test(s) ? s : '';
};

/**
 * Obtiene (o crea) el contenedor del podio antes de la tabla de un tab.
 */
function getPodiumContainer(tabId) {
  const tab = document.getElementById(tabId);
  if (!tab) return null;
  const table = tab.querySelector('table');
  if (!table) return null;
  let el = tab.querySelector(':scope > .podium');
  if (!el) {
    el = document.createElement('div');
    table.parentNode.insertBefore(el, table);
  }
  return el;
}

/**
 * Renderiza el podio de jugadores (top 3) sobre la tabla indicada.
 */
function renderPlayerPodium(tabId, players) {
  renderPodium(getPodiumContainer(tabId), players, {
    getName: p => p.player_name || 'Sin nombre',
    getValue: p => {
      const r = p.bayesian_rating ?? p.avg_rating;
      return r != null ? Number(r).toFixed(2) : '—';
    },
    valueLabel: 'media',
    getSubtitle: p => p.team_nickname || p.club_name || '',
    getImg: p => p.club_crest || null,
    imgRounded: 'circle'
  });
}

(async () => {
  // --- Obtener contexto de competición ---
  let competitionId = null;
  let competitionSlug = null;
  try {
    competitionSlug = getCompetitionFromURL() || await getCurrentCompetitionSlug();
    if (competitionSlug) {
      const competition = await getCompetitionBySlug(competitionSlug);
      if (competition) {
        competitionId = competition.id;
        
        // Breadcrumb
        const breadcrumb = buildBreadcrumb(competition, { 
          label: 'Estadísticas', 
          href: `estadisticas.html?comp=${competitionSlug}` 
        });
        renderBreadcrumb('breadcrumb', breadcrumb);
        
        // Tema de la competición
        await loadCompetitionTheme(competition);
      }
    }
  } catch (e) {
    console.warn('Error obteniendo contexto de competición:', e);
  }

  // Cargar datos directamente desde Supabase (cargar más de 30 para tener suficientes por posición)
  const supabase = await getSupabaseClient();
  
  // Obtener tipo de competición y start_date para aplicar filtro y calcular edad
  let competitionType = null;
  let competitionStartDate = null;
  if (competitionId) {
    try {
      const { data: comp, error: compError } = await supabase
        .from('competitions')
        .select('competition_type, start_date')
        .eq('id', competitionId)
        .single();
      
      if (!compError && comp) {
        competitionType = comp.competition_type;
        competitionStartDate = comp.start_date;
      }
    } catch (e) {
      console.warn('Error obteniendo tipo de competición:', e);
    }
  }

  let query = supabase
    .from('player_ratings_avg')
    .select('player_id, player_name, position, competition_id, season, matches_count, avg_rating, bayesian_rating, min_rating, max_rating, total_rating_sum, club_id, club_name, club_crest, league_team_id, team_nickname, competition_type')
    .order('bayesian_rating', { ascending: false })
    .limit(500); // Aumentado para asegurar que haya suficientes jugadores de cada posición

  // Solo filtrar por competición si la tenemos y es válida
  if (competitionId && !isNaN(parseInt(competitionId)) && parseInt(competitionId) > 0) {
    query = query.eq('competition_id', parseInt(competitionId));
  }

  // Mínimo de partidos: liga 3, copa 2
  // Excepción: Liga Epidor (comp 49) arrancó esta temporada y todavía no llega
  // a 3 jornadas jugadas por equipo, así que se baja a 2 para no dejar las
  // tablas vacías.
  const LEAGUE_MIN_MATCHES_OVERRIDES = { 49: 2 };
  if (competitionType === 'league') {
    query = query.gte('matches_count', LEAGUE_MIN_MATCHES_OVERRIDES[competitionId] ?? 3);
  } else if (competitionType === 'cup') {
    query = query.gte('matches_count', 2);
  }

  const { data: allRatings, error } = await query;

  if (error) {
    console.error('Error cargando valoraciones:', error);
  }

  // Si no hay datos, mostrar mensaje en todas las tablas
  if (!allRatings || allRatings.length === 0) {
    const noDataMessage = competitionId 
      ? 'No hay datos de valoraciones disponibles para esta competición'
      : 'No hay datos de valoraciones disponibles';
    
    ['tabla-porteros', 'tabla-defensas', 'tabla-centrocampistas', 'tabla-delanteros', 'tabla-golden-boy', 'tabla-total'].forEach(tableId => {
      const tbody = document.getElementById(tableId);
      if (tbody) {
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--muted);">${noDataMessage}</td></tr>`;
      }
    });
    return;
  }

  // Función de ordenamiento: primero por bayesian_rating, luego por matches_count
  const sortPlayers = (a, b) => {
    const ratingA = a.bayesian_rating ?? a.avg_rating;
    const ratingB = b.bayesian_rating ?? b.avg_rating;
    if (ratingB !== ratingA) return ratingB - ratingA;
    return b.matches_count - a.matches_count;
  };

  // Agrupar por posición
  const byPosition = {
    'GK': [],
    'DEF': [],
    'MID': [],
    'FWD': []
  };

  allRatings.forEach(player => {
    const pos = classifyPosition(player.position);
    if (byPosition[pos]) {
      byPosition[pos].push(player);
    }
  });

  // Ordenar cada posición y limitar a top 30
  Object.keys(byPosition).forEach(pos => {
    byPosition[pos].sort(sortPlayers);
    byPosition[pos] = byPosition[pos].slice(0, 30);
  });

  // Ordenar también el ranking total
  allRatings.sort(sortPlayers);

  // Renderizar tablas + podios
  renderPlayerPodium('tab-porteros', byPosition['GK']);
  renderTable('tabla-porteros', byPosition['GK']);

  renderPlayerPodium('tab-defensas', byPosition['DEF']);
  renderTable('tabla-defensas', byPosition['DEF']);

  renderPlayerPodium('tab-centrocampistas', byPosition['MID']);
  renderTable('tabla-centrocampistas', byPosition['MID']);

  renderPlayerPodium('tab-delanteros', byPosition['FWD']);
  renderTable('tabla-delanteros', byPosition['FWD']);

  const topTotal = allRatings.slice(0, 30);
  renderPlayerPodium('tab-total', topTotal);
  renderTable('tabla-total', topTotal);

  // Cargar y renderizar Golden Boy (jugadores jóvenes ≤21 años)
  await loadAndRenderGoldenBoy(allRatings, supabase, sortPlayers, competitionStartDate);

  // Cargar estadísticas de tarjetas
  await loadAndRenderCardsStats(supabase, competitionId);

  // Cargar estadísticas de ritmo de partido (tramos, primer gol, remontadas)
  await loadAndRenderRitmoPartido(supabase, competitionId, competitionSlug);

  // Sistema de pestañas
  setupTabs();
})();

/**
 * Renderiza una tabla con los jugadores
 */
function renderTable(tableId, players) {
  const tbody = document.getElementById(tableId);
  if (!tbody) return;

  if (!players || players.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;color:var(--muted);">No hay datos disponibles</td></tr>`;
    return;
  }

  tbody.innerHTML = players.map((p, i) => {
    const teamDisplay = p.team_nickname || p.club_name || '—';
    const clubCrest = p.club_crest || '';
    
    return `
      <tr>
        <td class="pos-cell">${i + 1}</td>
        <td class="player-cell">
          <strong>${escapeHtml(p.player_name || 'Sin nombre')}</strong>
        </td>
        <td class="team-cell">
          ${clubCrest ? `<img src="${escapeHtml(safeUrl(clubCrest))}" alt="${escapeHtml(p.club_name || '')}" class="team-badge">` : ''}
          <span>${escapeHtml(teamDisplay)}</span>
        </td>
        <td>${p.matches_count}</td>
        <td class="rating-cell"><strong>${(p.bayesian_rating ?? p.avg_rating) != null ? (p.bayesian_rating ?? p.avg_rating) : '—'}</strong></td>
      </tr>
    `;
  }).join('');
}

/**
 * Carga y renderiza la tabla de Golden Boy (jugadores jóvenes ≤21 años)
 * @param {Array} allRatings - Array de ratings de jugadores
 * @param {Object} supabase - Cliente de Supabase
 * @param {Function} sortPlayers - Función para ordenar jugadores
 * @param {string|null} competitionStartDate - Fecha de inicio de la competición (para calcular edad)
 */
async function loadAndRenderGoldenBoy(allRatings, supabase, sortPlayers, competitionStartDate = null) {
  try {
    if (!allRatings || allRatings.length === 0) {
      renderTable('tabla-golden-boy', [], true);
      return;
    }

    // Get player IDs from ratings
    const playerIds = allRatings.map(p => p.player_id).filter(Boolean);
    
    if (playerIds.length === 0) {
      renderTable('tabla-golden-boy', [], true);
      return;
    }

    // Get players with date_of_birth
    const { data: playersData, error: playersError } = await supabase
      .from('players')
      .select('id, date_of_birth')
      .in('id', playerIds)
      .not('date_of_birth', 'is', null);

    if (playersError) {
      console.warn('Error cargando fechas de nacimiento para Golden Boy:', playersError);
      renderTable('tabla-golden-boy', [], true);
      return;
    }

    if (!playersData || playersData.length === 0) {
      renderTable('tabla-golden-boy', [], true);
      return;
    }

    // Calculate age and filter young players (≤21 years)
    // Use competition start_date if available, otherwise use today
    const referenceDate = competitionStartDate ? new Date(competitionStartDate) : new Date();
    const youngPlayers = [];

    playersData.forEach(player => {
      if (player.date_of_birth) {
        const birthDate = new Date(player.date_of_birth);
        let age = referenceDate.getFullYear() - birthDate.getFullYear();
        const monthDiff = referenceDate.getMonth() - birthDate.getMonth();
        
        if (monthDiff < 0 || (monthDiff === 0 && referenceDate.getDate() < birthDate.getDate())) {
          age--;
        }
        
        // Include players 21 years or less
        if (age <= 21) {
          const rating = allRatings.find(r => r.player_id === player.id);
          if (rating) {
            youngPlayers.push({
              ...rating,
              age: age
            });
          }
        }
      }
    });

    // Sort by avg_rating descending, then by matches_count descending
    youngPlayers.sort(sortPlayers);

    // Limit to top 30
    const topYoungPlayers = youngPlayers.slice(0, 30);

    // Render Golden Boy podium + table
    renderPlayerPodium('tab-golden-boy', topYoungPlayers);
    renderTable('tabla-golden-boy', topYoungPlayers);
  } catch (err) {
    console.error('Error cargando Golden Boy:', err);
    renderTable('tabla-golden-boy', [], true);
  }
}

/**
 * Carga y renderiza las tablas de tarjetas rojas y amarillas
 */
async function loadAndRenderCardsStats(supabase, competitionId) {
  async function fetchCards(tableName) {
    let q = supabase.from(tableName).select('player_id, league_team_id');
    if (competitionId) q = q.eq('competition_id', competitionId);
    const { data, error } = await q;
    if (error) { console.warn(`Error cargando ${tableName}:`, error); return []; }
    return data || [];
  }

  async function aggregateAndRender(cards, tbodyId) {
    const tbody = document.getElementById(tbodyId);
    if (!tbody) return;

    if (!cards.length) {
      tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--muted);">No hay datos disponibles</td></tr>`;
      return;
    }

    // Agregar por jugador
    const byPlayer = {};
    cards.forEach(c => {
      if (!c.player_id) return;
      if (!byPlayer[c.player_id]) byPlayer[c.player_id] = { count: 0, league_team_id: c.league_team_id };
      byPlayer[c.player_id].count++;
    });

    const playerIds = Object.keys(byPlayer).map(Number);
    const teamIds = [...new Set(Object.values(byPlayer).map(v => v.league_team_id).filter(Boolean))];

    const [{ data: players }, { data: teams }] = await Promise.all([
      supabase.from('players').select('id, name').in('id', playerIds),
      supabase.from('league_teams').select('id, nickname, clubs(crest_url)').in('id', teamIds),
    ]);

    const playerMap = Object.fromEntries((players || []).map(p => [p.id, p.name]));
    const teamMap = Object.fromEntries((teams || []).map(t => [t.id, { nickname: t.nickname, crest: t.clubs?.crest_url || '' }]));

    const rows = playerIds
      .map(pid => ({
        name: playerMap[pid] || `Jugador ${pid}`,
        team: teamMap[byPlayer[pid].league_team_id]?.nickname || '—',
        crest: teamMap[byPlayer[pid].league_team_id]?.crest || '',
        count: byPlayer[pid].count,
      }))
      .sort((a, b) => b.count - a.count);

    tbody.innerHTML = rows.map((r, i) => `
      <tr>
        <td class="pos-cell">${i + 1}</td>
        <td class="player-cell"><strong>${escapeHtml(r.name)}</strong></td>
        <td class="team-cell">
          ${r.crest ? `<img src="${escapeHtml(safeUrl(r.crest))}" alt="${escapeHtml(r.team)}" class="team-badge">` : ''}
          <span>${escapeHtml(r.team)}</span>
        </td>
        <td><strong>${r.count}</strong></td>
      </tr>
    `).join('');
  }

  const [redCards, yellowCards] = await Promise.all([
    fetchCards('match_red_cards'),
    fetchCards('match_yellow_cards'),
  ]);

  await Promise.all([
    aggregateAndRender(redCards, 'tabla-tarjetas-rojas'),
    aggregateAndRender(yellowCards, 'tabla-tarjetas-amarillas'),
  ]);
}

/**
 * Carga y renderiza el tab "Ritmo de Partido": histograma de goles por tramo
 * (a nivel competición o por jugador), KPI de "primer gol → resultado" y
 * lista de remontadas.
 */
async function loadAndRenderRitmoPartido(supabase, competitionId, competitionSlug) {
  const histogramaEl = document.getElementById('ritmo-histograma');
  const nivelSelect = document.getElementById('ritmo-nivel');
  const jugadorSelect = document.getElementById('ritmo-jugador');
  const primerGolEl = document.getElementById('ritmo-primer-gol');
  const remontadasEl = document.getElementById('ritmo-remontadas');

  if (!histogramaEl || !competitionId) return;

  // Histograma de competición (vista por defecto)
  const compMinutes = await fetchGoalMinutesByCompetition(competitionId);
  renderTramoChart(histogramaEl, compMinutes);

  // Selector de jugador (poblado con los goleadores reales de la competición)
  const scorers = await fetchTopScorersForCompetition(competitionId);
  if (jugadorSelect && scorers.length) {
    jugadorSelect.innerHTML = scorers
      .map(s => `<option value="${s.player_id}">${escapeHtml(s.name)} (${s.goals})</option>`)
      .join('');
  }

  if (nivelSelect && jugadorSelect) {
    nivelSelect.addEventListener('change', async () => {
      if (nivelSelect.value === 'jugador') {
        jugadorSelect.style.display = '';
        if (jugadorSelect.value) {
          const minutes = await fetchGoalMinutesByPlayer(Number(jugadorSelect.value));
          renderTramoChart(histogramaEl, minutes, { emptyMessage: 'Este jugador no tiene goles con minuto registrado.' });
        }
      } else {
        jugadorSelect.style.display = 'none';
        renderTramoChart(histogramaEl, compMinutes);
      }
    });

    jugadorSelect.addEventListener('change', async () => {
      if (!jugadorSelect.value) return;
      const minutes = await fetchGoalMinutesByPlayer(Number(jugadorSelect.value));
      renderTramoChart(histogramaEl, minutes, { emptyMessage: 'Este jugador no tiene goles con minuto registrado.' });
    });
  }

  // KPI "primer gol → resultado" + remontadas (requieren cronología completa por partido)
  try {
    const timelines = await fetchMatchTimelines(competitionId);

    const outcome = computeFirstGoalOutcome(timelines);
    if (primerGolEl) {
      if (outcome.total > 0) {
        const pct = Math.round((outcome.gana / outcome.total) * 100);
        primerGolEl.innerHTML = `
          <div class="ritmo-kpi__main">${pct}%</div>
          <div class="ritmo-kpi__desc">de los partidos los gana el equipo que marca primero (sobre ${outcome.total} partidos con cronología de gol completa).</div>
          <div class="ritmo-kpi__breakdown">
            <span>Gana: <strong>${outcome.gana}</strong></span>
            <span>Empata: <strong>${outcome.empata}</strong></span>
            <span>Pierde: <strong>${outcome.pierde}</strong></span>
          </div>
        `;
      } else {
        primerGolEl.innerHTML = `<p class="tramo-chart-empty">Todavía no hay suficientes partidos con minuto registrado.</p>`;
      }
    }

    const comebacks = computeComebacks(timelines);
    if (remontadasEl) {
      if (!comebacks.length) {
        remontadasEl.innerHTML = `<li class="tramo-chart-empty">Todavía no hay remontadas registradas esta temporada.</li>`;
      } else {
        const ltIds = [...new Set(comebacks.flatMap(m => [m.home_league_team_id, m.away_league_team_id]))];
        const { data: teams } = await supabase
          .from('league_teams')
          .select('id, nickname, display_name')
          .in('id', ltIds);
        const teamMap = new Map((teams || []).map(t => [t.id, t.nickname || t.display_name || '?']));

        remontadasEl.innerHTML = comebacks.map(m => {
          const homeName = teamMap.get(m.home_league_team_id) || '?';
          const awayName = teamMap.get(m.away_league_team_id) || '?';
          const winner = m.side === 'home' ? homeName : awayName;
          return `
            <li>
              <a class="remontada-card" href="partido.html?match=${encodeURIComponent(m.id)}&comp=${encodeURIComponent(competitionSlug || '')}">
                <span>${escapeHtml(homeName)} <span class="remontada-card__score">${m.home_goals}-${m.away_goals}</span> ${escapeHtml(awayName)}</span>
                <span class="remontada-card__badge">Remontada de ${escapeHtml(winner)}</span>
              </a>
            </li>
          `;
        }).join('');
      }
    }
  } catch (e) {
    console.warn('Error calculando primer gol / remontadas:', e);
  }
}

/**
 * Configura el sistema de pestañas
 */
function setupTabs() {
  const tabs = document.querySelectorAll('.tabs button[data-tab]');
  const panels = document.querySelectorAll('.tab-panel');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const targetId = tab.dataset.tab;
      
      // Remover active de todos
      tabs.forEach(t => t.classList.remove('active'));
      panels.forEach(p => p.classList.remove('active'));
      
      // Añadir active al seleccionado
      tab.classList.add('active');
      const targetPanel = document.getElementById(targetId);
      if (targetPanel) {
        targetPanel.classList.add('active');
      }
    });
  });
}

