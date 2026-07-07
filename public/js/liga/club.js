
import {
  isNum,
  normalizeText as norm,
  slugify as slug,
  playerLink,
  escapeHtml
} from '../modules/utils.js';

import {
  loadPlantillaFromDb,
} from '../modules/club-data.js';
import { getCompetitionFromURL, getCurrentCompetitionSlug, buildBreadcrumb, renderBreadcrumb, buildURLWithCompetition } from '../modules/competition-context.js';
import { renderNoticiasRelacionadas } from '../modules/noticias-relacionadas.js';
import { getCompetitionBySlug } from '../modules/competition-data.js';
import { loadCompetitionTheme } from '../modules/theme-loader.js';
import { getSupabaseClient } from '../modules/supabase-client.js';
import { loadFanbaseForClub, moodBucket } from '../modules/fanbase-data.js';
import {
  loadRolesForClub,
  loadMoraleForPlayers,
  moraleBucket,
  ROLE_LABELS,
} from '../modules/player-morale-data.js';
import { getActiveSeason, loadCrestMap, getCrestOrLogo } from '../modules/manager-crests.js';
import { fetchGoalMinutesByLeagueTeamIds, renderTramoChart } from '../modules/goal-timing-stats.js';

(async () => {
  // --- Obtener contexto de competición ---
  let competitionId = null;
  let competitionSlug = null;
  let competitionName = null;
  let competition = null; // ✅ Guardar competition completo para type_config

  try {
    competitionSlug = getCompetitionFromURL() || await getCurrentCompetitionSlug();
    if (competitionSlug) {
      competition = await getCompetitionBySlug(competitionSlug);
      if (competition) {
        competitionId = competition.id;
        competitionName = competition.name;
        
        // Aplicar tema de la competición
        await loadCompetitionTheme(competitionId);
      }
    }
  } catch (e) {
    console.warn('Error obteniendo contexto de competición:', e);
  }

  // --------------------------
  // CLUB target
  // --------------------------
  const CLUB = window.CLUB_NAME;
  if (!CLUB) {
    document.getElementById("club-root").innerHTML =
      "<p style='color:var(--muted)'>Equipo no especificado.</p>";
    return;
  }

  // --- Renderizar breadcrumb ---
  if (competitionName) {
    const root = document.getElementById("club-root");
    if (root) {
      const breadcrumbContainer = document.createElement('div');
      breadcrumbContainer.className = 'breadcrumb-container';
      breadcrumbContainer.style.marginBottom = '1rem';
      root.insertAdjacentElement('beforebegin', breadcrumbContainer);
      
      const breadcrumbItems = buildBreadcrumb(competitionSlug, competitionName, CLUB);
      renderBreadcrumb(breadcrumbContainer, breadcrumbItems);
    }
  }

  // Helpers locales derivados de módulos (para compatibilidad de uso en el código)
  const playerPhotoPath = (nombre) => `img/jugadores/${slug(nombre)}.jpg`;

  // --------------------------
  // HERO (relleno en 2 fases: logo + nombre ahora,
  // KPIs/meta una vez calculados clasificación y forma)
  // --------------------------
  document.getElementById("club-title").textContent = CLUB;
  document.getElementById("club-name").textContent = CLUB;

  // Cargar el mapping manager→escudo del club (necesario para que el hero y
  // los mini-logos muestren el escudo del club, no la foto personal del manager).
  await loadCrestMap();
  const clubSeason = competition?.season;

  const heroCrest = document.getElementById("club-hero-crest");
  heroCrest.src = getCrestOrLogo(CLUB, clubSeason);
  heroCrest.alt = `Escudo ${CLUB}`;
  heroCrest.onerror = () => heroCrest.style.visibility = "hidden";

  const heroEyebrow = document.getElementById("club-hero-eyebrow");
  if (heroEyebrow) {
    heroEyebrow.textContent = competitionName ? `Club · ${competitionName}` : "Club";
  }

  // --------------------------
  // Datos base (core cache)
  // Utilizamos window.CoreStats por ahora ya que no está modularizado
  // --------------------------
  const CoreStats = window.CoreStats || {
    getResultados: async () => [],
    getStatsIndex: async () => ({}),
    computeClasificacion: async () => [],
    getPichichiRows: async () => [],
    computePichichiPlayers: () => [],
    computeRankingsPorEquipo: async () => ({}),
    computeTeamTotals: async () => []
  };

  const resultados = await CoreStats.getResultados(competitionId);
  await CoreStats.getStatsIndex(competitionId); // Ensure index is loaded if needed internally

  resultados.sort((a, b) => (a.numero || 0) - (b.numero || 0));

  // --------------------------
  // Partidos del club, próximo/último partido y Team Form usando SQL
  // --------------------------
  let partidosClub = [];
  let nextMatch = null;
  let lastMatch = null;
  let formResults = [];
  let formRating = "NO DATA";
  let teamFormBox = '';

  // Intentar usar funciones SQL
  try {
    const supabase = await getSupabaseClient();
    
    if (competitionId) {
      // Obtener partidos del equipo
      const { data: matchesData, error: matchesError } = await supabase.rpc('get_team_matches', {
        p_competition_id: competitionId,
        p_team_nickname: CLUB
      });

      if (!matchesError && matchesData) {
        // Mapear datos de SQL al formato esperado
        partidosClub = matchesData.map(m => ({
          local: m.is_home ? (m.home_team_nickname || m.home_team_display_name) : (m.away_team_nickname || m.away_team_display_name),
          visitante: m.is_home ? (m.away_team_nickname || m.away_team_display_name) : (m.home_team_nickname || m.home_team_display_name),
          goles_local: m.is_home ? m.team_goals : m.opponent_goals,
          goles_visitante: m.is_home ? m.opponent_goals : m.team_goals,
          jornada: m.jornada,
          fecha: m.match_date,
          fecha_jornada: m.match_date,
          hora: m.match_time,
          result: m.result,
          is_played: m.is_played,
          stream_url: m.stream_url
        }));

        // Encontrar próximo y último partido
        nextMatch = matchesData.find(m => m.is_next_match) || null;
        lastMatch = matchesData.find(m => m.is_last_match) || null;

        // Mapear nextMatch y lastMatch al formato esperado
        const nextMatchRaw = matchesData.find(m => m.is_next_match);
        if (nextMatchRaw) {
          nextMatch = {
            local: nextMatchRaw.is_home ? (nextMatchRaw.home_team_nickname || nextMatchRaw.home_team_display_name) : (nextMatchRaw.away_team_nickname || nextMatchRaw.away_team_display_name),
            visitante: nextMatchRaw.is_home ? (nextMatchRaw.away_team_nickname || nextMatchRaw.away_team_display_name) : (nextMatchRaw.home_team_nickname || nextMatchRaw.home_team_display_name),
            fecha: nextMatchRaw.match_date,
            fecha_jornada: nextMatchRaw.match_date,
            hora: nextMatchRaw.match_time
          };
        }

        const lastMatchRaw = matchesData.find(m => m.is_last_match);
        if (lastMatchRaw) {
          lastMatch = {
            local: lastMatchRaw.is_home ? (lastMatchRaw.home_team_nickname || lastMatchRaw.home_team_display_name) : (lastMatchRaw.away_team_nickname || lastMatchRaw.away_team_display_name),
            visitante: lastMatchRaw.is_home ? (lastMatchRaw.away_team_nickname || lastMatchRaw.away_team_display_name) : (lastMatchRaw.home_team_nickname || lastMatchRaw.home_team_display_name),
            goles_local: lastMatchRaw.is_home ? lastMatchRaw.team_goals : lastMatchRaw.opponent_goals,
            goles_visitante: lastMatchRaw.is_home ? lastMatchRaw.opponent_goals : lastMatchRaw.team_goals
          };
        }

        // Obtener Team Form
        const { data: formData, error: formError } = await supabase.rpc('get_team_form', {
          p_competition_id: competitionId,
          p_team_nickname: CLUB,
          p_last_n_matches: 3
        });

        if (!formError && formData && formData.length > 0) {
          const form = formData[0];
          formResults = form.form_results || [];
          formRating = form.form_rating || "NO DATA";
        }
      }
    }
  } catch (e) {
    console.warn('Error usando funciones SQL para partidos/form, usando fallback:', e);
  }

  // Fallback: calcular en JavaScript si SQL falló o no hay datos
  if (partidosClub.length === 0) {
    for (const j of resultados) {
      for (const p of (j.partidos || [])) {
        if (p.local === CLUB || p.visitante === CLUB) {
          partidosClub.push({
            ...p,
            jornada: j.numero,
            fecha_jornada: j.fecha
          });
        }
      }
    }

    nextMatch = partidosClub.find(p =>
      p.goles_local == null || p.goles_visitante == null
    );

    lastMatch = [...partidosClub].reverse().find(p =>
      isNum(p.goles_local) && isNum(p.goles_visitante)
    );

    const playedMatches = partidosClub.filter(p =>
      isNum(p.goles_local) && isNum(p.goles_visitante)
    );

    const last3 = playedMatches.slice(-3);

    formResults = last3.map(p => {
      const clubIsLocal = norm(p.local) === norm(CLUB);
      const gl = p.goles_local, gv = p.goles_visitante;

      if (gl === gv) return "D";
      const clubWon = clubIsLocal ? (gl > gv) : (gv > gl);
      return clubWon ? "W" : "L";
    });

    const countW = formResults.filter(r => r === "W").length;
    const countD = formResults.filter(r => r === "D").length;
    const countL = formResults.filter(r => r === "L").length;

    formRating = (() => {
      if (formResults.length < 3) return "NO DATA";
      if (countW === 3) return "🔥 ON FIRE";
      if (countW === 2) return "🟩 STRONG";
      if (countW === 1 && countL === 0) return "🟨 SOLID";
      if (countD === 3) return "⚪ STEADY";
      if (countW === 0 && countL === 1) return "🟧 SHAKY";
      if (countL === 2) return "🟥 BAD MOMENT";
      if (countL === 3) return "❄️ COLD";
      return "🟨 SOLID";
    })();
  }

  const formHTML = (formResults.length)
    ? `
      <div class="club-form-row">
        ${formResults.map(r => `
          <span class="form-pill form-${r.toLowerCase()}">${r}</span>
        `).join("")}
      </div>
      <div class="club-form-rating">${formRating}</div>
    `
    : `<p class="muted">Aún no hay 3 partidos jugados.</p>`;

  teamFormBox = `
    <div class="club-box">
      <h3>Team Form</h3>
      ${formHTML}
    </div>
  `;

  // --------------------------
  // Clasificación desde CoreStats (con H2H)
  // --------------------------
  const fullClasif = await CoreStats.computeClasificacion(null, { 
    useH2H: true, 
    competitionId,
    typeConfig: competition?.type_config || null
  });
  const idxClub = fullClasif.findIndex(t => norm(t.nombre) === norm(CLUB));

  const clubRow = fullClasif.find(t => norm(t.nombre) === norm(CLUB));
  const clubPos = (idxClub >= 0) ? idxClub + 1 : "—";

  // --- Rellenar hero: meta-row (PJ·G·E·P) + 4 KPI tiles (Pos·Pts·DG·Forma)
  const heroMeta = document.getElementById("club-hero-meta");
  const heroKpis = document.getElementById("club-hero-kpis");

  if (clubRow) {
    if (heroMeta) {
      heroMeta.innerHTML = `
        <span>${clubRow.pj} PJ</span>
        <span>${clubRow.g}G</span>
        <span>${clubRow.e}E</span>
        <span>${clubRow.p}P</span>
        <span>${clubRow.gf} GF · ${clubRow.gc} GC</span>
      `;
    }

    const dg = (clubRow.gf || 0) - (clubRow.gc || 0);
    const dgClass = dg > 0 ? 'page-hero__kpi-value--pos' : (dg < 0 ? 'page-hero__kpi-value--neg' : '');
    const dgText = dg > 0 ? `+${dg}` : `${dg}`;

    const formPillsHTML = formResults.length
      ? formResults.map(r => `<span class="form-pill form-${r.toLowerCase()}">${r}</span>`).join("")
      : `<span class="muted" style="font-size:.75rem">—</span>`;

    if (heroKpis) {
      heroKpis.innerHTML = `
        <div class="page-hero__kpi">
          <div class="page-hero__kpi-value page-hero__kpi-value--accent">${clubPos}</div>
          <div class="page-hero__kpi-label">Pos</div>
        </div>
        <div class="page-hero__kpi">
          <div class="page-hero__kpi-value">${clubRow.pts}</div>
          <div class="page-hero__kpi-label">Pts</div>
        </div>
        <div class="page-hero__kpi">
          <div class="page-hero__kpi-value ${dgClass}">${dgText}</div>
          <div class="page-hero__kpi-label">DG</div>
        </div>
        <div class="page-hero__kpi page-hero__kpi--form">
          <div class="page-hero__kpi-pills">${formPillsHTML}</div>
          <div class="page-hero__kpi-label">Forma</div>
        </div>
      `;
    }
  } else {
    if (heroMeta) heroMeta.innerHTML = `<span class="muted">Sin datos aún.</span>`;
    if (heroKpis) heroKpis.innerHTML = '';
  }

  let mini = [];
  if (idxClub === -1) mini = fullClasif.slice(0, 9);
  else mini = fullClasif.slice(Math.max(0, idxClub - 4), idxClub + 5);

  // --------------------------
  // Máximo goleador del club desde TSV (CoreStats)
  // --------------------------
  let goleador = null;
  let pichichiAllPlayers = [];
  try {
    const rows = await CoreStats.getPichichiRows(competitionId);
    const data = CoreStats.computePichichiPlayers(rows);
    pichichiAllPlayers = data;
    const jugadoresClub = data.filter(x => norm(x.equipo) === norm(CLUB));
    goleador = jugadoresClub[0] || null;
  } catch (e) {
    console.warn("No se pudo cargar pichichi TSV para club:", e);
  }

  // --------------------------
  // Mejor jugador por valoración
  // --------------------------
  let mejorJugador = null;
  try {
    if (competitionId) {
      const supabase = await getSupabaseClient();
      const { data: topRatings } = await supabase
        .from('player_ratings_avg')
        .select('player_id, player_name, position, matches_count, avg_rating, bayesian_rating, team_nickname')
        .eq('competition_id', competitionId)
        .ilike('team_nickname', CLUB)
        .order('bayesian_rating', { ascending: false })
        .limit(1);

      const top = topRatings?.[0] || null;
      if (top) {
        const [{ data: yellows }, { data: reds }] = await Promise.all([
          supabase.from('match_yellow_cards').select('id').eq('competition_id', competitionId).eq('player_id', top.player_id),
          supabase.from('match_red_cards').select('id').eq('competition_id', competitionId).eq('player_id', top.player_id),
        ]);
        const pInfo = pichichiAllPlayers.find(x => norm(x.jugador) === norm(top.player_name));
        mejorJugador = {
          ...top,
          goles: pInfo?.goles || 0,
          amarillas: yellows?.length || 0,
          rojas: reds?.length || 0,
        };
      }
    }
  } catch (e) {
    console.warn('Error cargando mejor jugador por valoración:', e);
  }

  // --------------------------
  // TAB RESUMEN render
  // --------------------------
  const tabResumen = document.getElementById("tab-resumen");

  const nextHTML = nextMatch ? `
    <div class="club-box">
      <h3>Próximo partido</h3>
      <div class="club-match">
        <img src="${getCrestOrLogo(nextMatch.local, clubSeason)}" class="club-mini-logo" onerror="this.style.visibility='hidden'">
        <strong>${escapeHtml(nextMatch.local)}</strong>
        <span>vs</span>
        <strong>${escapeHtml(nextMatch.visitante)}</strong>
        <img src="${getCrestOrLogo(nextMatch.visitante, clubSeason)}" class="club-mini-logo" onerror="this.style.visibility='hidden'">
        <div class="club-date">${escapeHtml(nextMatch.fecha || nextMatch.fecha_jornada || "")} ${escapeHtml(nextMatch.hora || "")}</div>
      </div>
    </div>
  ` : `
    <div class="club-box"><h3>Próximo partido</h3><p>No hay partidos pendientes.</p></div>
  `;

  const lastHTML = lastMatch ? `
    <div class="club-box">
      <h3>Último partido</h3>
      <div class="club-match">
        <img src="${getCrestOrLogo(lastMatch.local, clubSeason)}" class="club-mini-logo" onerror="this.style.visibility='hidden'">
        <strong>${escapeHtml(lastMatch.local)}</strong>
        <span>${lastMatch.goles_local} - ${lastMatch.goles_visitante}</span>
        <strong>${escapeHtml(lastMatch.visitante)}</strong>
        <img src="${getCrestOrLogo(lastMatch.visitante, clubSeason)}" class="club-mini-logo" onerror="this.style.visibility='hidden'">
      </div>
    </div>
  ` : `
    <div class="club-box"><h3>Último partido</h3><p>No hay partidos jugados.</p></div>
  `;

  const miniClasifHTML = `
    <div class="club-box">
      <h3>Clasificación</h3>
      <table class="club-mini-table">
        <thead><tr><th>#</th><th>Equipo</th><th>Pts</th></tr></thead>
        <tbody>
          ${mini.map(t => {
    const pos = fullClasif.findIndex(x => norm(x.nombre) === norm(t.nombre)) + 1;
    return `
              <tr class="${norm(t.nombre) === norm(CLUB) ? "club-highlight" : ""}">
                <td>${pos}</td><td>${escapeHtml(t.nombre)}</td><td>${t.pts}</td>
              </tr>
            `;
  }).join("")}
        </tbody>
      </table>
    </div>
  `;

  const goleadorHTML = goleador ? `
    <div class="club-box">
      <h3>Máximo goleador</h3>
      <div class="club-player">
        <img class="club-player-photo"
             src="${playerPhotoPath(goleador.jugador)}"
             alt="${escapeHtml(goleador.jugador)}"
             onerror="this.style.visibility='hidden'">
        <div class="club-player-info">
          <strong>${escapeHtml(goleador.jugador)}</strong>
          <span>${goleador.goles} goles</span>
          <small class="muted">${goleador.pj} PJ</small>
        </div>
      </div>
    </div>
  ` : `
    <div class="club-box"><h3>Máximo goleador</h3><p>Sin datos en pichichi.</p></div>
  `;

  const mjRating = mejorJugador ? (mejorJugador.bayesian_rating ?? mejorJugador.avg_rating) : null;
  const mejorJugadorHTML = mejorJugador ? `
    <div class="club-box">
      <h3>Mejor jugador</h3>
      <div class="club-player">
        <img class="club-player-photo"
             src="${playerPhotoPath(mejorJugador.player_name)}"
             alt="${escapeHtml(mejorJugador.player_name)}"
             onerror="this.style.visibility='hidden'">
        <div class="club-player-info">
          <strong>${playerLink(mejorJugador.player_id, mejorJugador.player_name)}</strong>
          <span class="club-rating-value">${mjRating != null ? mjRating : '—'} ⭐</span>
          <small class="muted">${mejorJugador.matches_count} PJ</small>
          <div class="club-player-stats">
            <span class="pill">⚽ ${mejorJugador.goles}</span>
            ${mejorJugador.amarillas ? `<span class="pill pill-yellow">🟨 ${mejorJugador.amarillas}</span>` : ''}
            ${mejorJugador.rojas ? `<span class="pill pill-red">🟥 ${mejorJugador.rojas}</span>` : ''}
          </div>
        </div>
      </div>
    </div>
  ` : '';

  tabResumen.innerHTML = `
    <div class="club-resumen">
      <div class="club-resumen-feature">
        ${nextHTML}
        ${lastHTML}
        ${teamFormBox}
      </div>
      <div class="club-resumen-body">
        <div class="club-resumen-main">
          ${miniClasifHTML}
        </div>
        <aside class="club-resumen-aside">
          ${goleadorHTML}
          ${mejorJugadorHTML}
        </aside>
      </div>
    </div>
  `;

  // --------------------------
  // TAB PLANTILLA (Supabase)
  // --------------------------
  const plantillaEl = document.getElementById("tab-plantilla");

  const calcAge = (dob) => {
    if (!dob) return null;
    const d = new Date(dob);
    if (isNaN(d)) return null;
    const now = new Date();
    let age = now.getFullYear() - d.getFullYear();
    const m = now.getMonth() - d.getMonth();
    if (m < 0 || (m === 0 && now.getDate() < d.getDate())) age--;
    return age;
  };

  const posGroup = (pos) => {
    const p = (pos || "").toLowerCase();
    if (p.includes("goalkeeper") || p.includes("portero")) return "Porteros";
    if (p.includes("defence") || p.includes("back") || p.includes("centre-back") || p.includes("defensa")) return "Defensas";
    if (p.includes("midfield") || p.includes("medio") || p.includes("mid")) return "Centrocampistas";
    if (p.includes("offence") || p.includes("forward") || p.includes("wing") || p.includes("striker") || p.includes("delantero")) return "Delanteros";
    return "Otros";
  };

  /**
   * Carga estadísticas de valoraciones para los jugadores
   * @param {Array} squad - Array de jugadores
   * @param {number} competitionId - ID de la competición
   * @returns {Promise<Object>} Mapa de player_id/name -> {matches, avg}
   */
  async function loadPlayerRatingsStats(squad, competitionId) {
    if (!squad || !squad.length || !competitionId) return {};

    try {
      const supabase = await getSupabaseClient();
      
      // Obtener los IDs y nombres de los jugadores
      const playerIds = squad.filter(p => p.id).map(p => p.id);
      const playerNames = squad.map(p => p.name).filter(Boolean);

      if (!playerIds.length && !playerNames.length) return {};

      // Consultar la vista player_ratings_avg (bayesian_rating para valoración mostrada)
      let query = supabase
        .from('player_ratings_avg')
        .select('player_id, player_name, matches_count, avg_rating, bayesian_rating')
        .eq('competition_id', competitionId);

      // Filtrar por IDs o nombres
      if (playerIds.length > 0) {
        query = query.in('player_id', playerIds);
      }

      const { data, error } = await query;

      if (error) {
        console.warn('Error cargando estadísticas de valoraciones:', error);
        return {};
      }

      // Crear mapa por ID y por nombre (mostrar bayesian_rating si existe)
      const statsMap = {};
      if (data) {
        data.forEach(stat => {
          const rating = stat.bayesian_rating ?? stat.avg_rating;
          if (stat.player_id) {
            statsMap[stat.player_id] = {
              matches: stat.matches_count,
              avg: rating
            };
          }
          if (stat.player_name) {
            statsMap[stat.player_name] = {
              matches: stat.matches_count,
              avg: rating
            };
          }
        });
      }

      return statsMap;
    } catch (e) {
      console.warn('Error cargando estadísticas:', e);
      return {};
    }
  }

  const renderPlantilla = (teamData, playerStats = {}, moraleData = { roles: new Map(), morale: new Map() }) => {
    const coachName =
      teamData?.coach?.name ||
      [teamData?.coach?.firstName, teamData?.coach?.lastName].filter(Boolean).join(" ");

    const squad = Array.isArray(teamData?.squad) ? teamData.squad : [];
    if (!squad.length) {
      plantillaEl.innerHTML = `
        <div class="club-box" style="grid-column:span 12">
          <h3>Plantilla</h3>
          <p class="muted">No hay jugadores configurados para este club.</p>
        </div>`;
      return;
    }

    const groups = {};
    for (const pl of squad) {
      const g = posGroup(pl.position);
      (groups[g] ||= []).push(pl);
    }

    // Orden por rating desc (los que tienen rating arriba); los sin rating
    // caen al final por nombre.
    const ratingOf = (pl) => {
      const s = playerStats[pl.id] || playerStats[pl.name];
      const v = Number(s?.avg);
      return Number.isFinite(v) ? v : null;
    };
    Object.values(groups).forEach(arr =>
      arr.sort((a, b) => {
        const ra = ratingOf(a);
        const rb = ratingOf(b);
        if (ra != null && rb != null) return rb - ra;
        if (ra != null) return -1;
        if (rb != null) return 1;
        return String(a.name || "").localeCompare(String(b.name || ""), "es", { sensitivity: "base" });
      })
    );

    const groupOrder = ["Porteros", "Defensas", "Centrocampistas", "Delanteros", "Otros"];

    plantillaEl.innerHTML = `
      <div class="club-box club-plantilla-head" style="grid-column:span 12">
        <div class="club-plantilla-title">
          <h3>Plantilla</h3>
          ${coachName ? `<div class="coach-line">Entrenador: <strong>${escapeHtml(coachName)}</strong></div>` : ""}
        </div>
        <div class="squad-meta muted">${squad.length} jugadores</div>
      </div>

      ${groupOrder.filter(k => groups[k]?.length).map(k => {
      const players = groups[k];
      return `
          <div class="club-box club-plantilla-group" style="grid-column:span 12">
            <h4 class="plantilla-group-title">${k} <span class="muted">(${players.length})</span></h4>
            <div class="plantilla-grid">
              ${players.map(pl => {
        const age = calcAge(pl.dateOfBirth || pl.date_of_birth);
        const stats = playerStats[pl.id] || playerStats[pl.name];
        const ratingNum = stats ? Number(stats.avg) : null;
        const ratingTier = Number.isFinite(ratingNum)
          ? (ratingNum >= 6.5 ? 'hi' : (ratingNum >= 5.5 ? 'mid' : 'low'))
          : null;
        return `
                  <div class="plantilla-card">
                    <div class="plantilla-card-top">
                      <div class="plantilla-name">${playerLink(pl.id, pl.name || "—")}</div>
                      <div class="plantilla-pos muted">${escapeHtml(pl.position || "")}</div>
                    </div>
                    <div class="plantilla-card-meta">
                      ${pl.nationality ? `<span class="pill">${escapeHtml(pl.nationality)}</span>` : ""}
                      ${age != null ? `<span class="pill">${age} años</span>` : ""}
                      ${stats ? `<span class="pill pill-stats${ratingTier ? ` pill-stats--${ratingTier}` : ''}">${stats.matches} PJ · ${stats.avg} ⭐</span>` : ""}
                      ${(() => {
                        const moraleScore = moraleData.morale.get(pl.id);
                        if (moraleScore == null) return '';
                        const b = moraleBucket(moraleScore);
                        return `<span class="plantilla-morale-badge plantilla-morale-${b.tone}" title="Moral ${Math.round(moraleScore)}/100">${escapeHtml(b.label)}</span>`;
                      })()}
                      ${(() => {
                        const r = moraleData.roles.get(pl.id);
                        if (!r?.role) return '';
                        return `<span class="plantilla-role-pill" title="${escapeHtml(r.note || '')}">${escapeHtml(ROLE_LABELS[r.role] || r.role)}</span>`;
                      })()}
                    </div>
                  </div>
                `;
      }).join("")}
            </div>
          </div>
        `;
    }).join("")}
    `;
  };

  async function loadAndRenderPlantilla() {
    try {
      let teamData = null;

      try {
        const plantillaDb = await loadPlantillaFromDb(CLUB, competitionId);
        if (plantillaDb && Array.isArray(plantillaDb.squad) && plantillaDb.squad.length) {
          teamData = {
            coach: null,              // ahora mismo no lo tenemos en BD
            squad: plantillaDb.squad  // misma estructura que antes usa renderPlantilla
          };
        }
      } catch (e) {
        console.warn("Error cargando plantilla desde Supabase:", e);
      }

      if (!teamData) {
        plantillaEl.innerHTML = `
          <div class="club-box" style="grid-column:span 12">
            <h3>Plantilla</h3>
            <p class="muted">
              No hay datos de plantilla en base de datos.
            </p>
          </div>`;
        return;
      }

      // Cargar estadísticas de valoraciones + moral/roles en paralelo
      const clubId = teamData?.club?.id;
      await loadCrestMap();
      const season = getActiveSeason();
      const playerIds = teamData.squad.map(p => p.id).filter(Boolean);

      const [playerStats, rolesMap, moraleMap] = await Promise.all([
        loadPlayerRatingsStats(teamData.squad, competitionId),
        clubId && season ? loadRolesForClub(clubId, season) : Promise.resolve(new Map()),
        season         ? loadMoraleForPlayers(playerIds, season) : Promise.resolve(new Map()),
      ]);

      renderPlantilla(teamData, playerStats, { roles: rolesMap, morale: moraleMap });
    } catch (e) {
      console.error("Error cargando plantilla:", e);
      plantillaEl.innerHTML = `
        <div class="club-box" style="grid-column:span 12">
          <h3>Plantilla</h3>
          <p class="muted">Error cargando la plantilla.</p>
        </div>`;
    }
  }

  // Ejecutar carga de plantilla
  loadAndRenderPlantilla();


  // --------------------------
  // TAB STATS (usa CoreStats.computeRankingsPorEquipo)
  // --------------------------
  const tabStats = document.getElementById("tab-stats");

  try {
    const adv = await CoreStats.computeRankingsPorEquipo(competitionId);
    const totals = await CoreStats.computeTeamTotals(competitionId);

    const {
      raw = [],
      posMed,
      fair,
      passAcc,
      precisionTiro,
      conversionGol,
      combinedShot,
      efectRival,
      posesionTop = [],
      fairTop = [],
      passTop = [],
      shotTop = [],
      efectTop = []
    } = adv || {};

    const teamAdv = raw.find(t => norm(t.nombre) === norm(CLUB));
    const teamTot = totals.find(t => norm(t.nombre) === norm(CLUB)) || clubRow;

    if (!teamAdv || !teamTot) {
      tabStats.innerHTML = `
        <div class="club-box" style="grid-column:span 12">
          <h3>Estadísticas</h3>
          <p class="muted">No hay estadísticas agregadas para este club todavía.</p>
        </div>`;
    } else {
      const totalTeams = raw.length || fullClasif.length || 0;

      const fmtPct = v =>
        Number.isFinite(v) ? (v * 100).toFixed(1) + "%" : "—";
      const fmtNum = v =>
        Number.isFinite(v) ? v.toFixed(2) : "—";

      const rankOf = (arr) => {
        const idx = arr.findIndex(t => norm(t.nombre) === norm(CLUB));
        return idx >= 0 ? idx + 1 : null;
      };

      const posesionMedia = posMed(teamAdv);
      const pasesTotales = teamAdv.pases;
      const pasesComp = teamAdv.completados;
      const accPase = passAcc(teamAdv);
      const tirosTotales = teamAdv.tiros;
      const tirosPuerta = teamAdv.taPuerta;
      const golesTotales = teamAdv.goles;
      const precTiro = precisionTiro(teamAdv);
      const convGol = conversionGol(teamAdv);
      const combShot = combinedShot(teamAdv);
      const fairScore = fair(teamAdv);
      const efectDef = efectRival(teamAdv); // goles encajados / tiros a puerta rival

      const posRank = rankOf(posesionTop);
      const passRank = rankOf(passTop);
      const shotRank = rankOf(shotTop);
      const fairRank = rankOf(fairTop);
      const efectRank = rankOf(efectTop);

      // Helpers de render para chip de ranking + barra de posición relativa
      const rankChip = (rank, total) => {
        if (!rank || !total) {
          return `<span class="club-stats-card__rank club-stats-card__rank--muted">Sin ranking</span>`;
        }
        return `<span class="club-stats-card__rank">${rank}.º de ${total}</span>`;
      };

      const posBar = (rank, total) => {
        if (!rank || !total || total < 2) return '';
        const pct = Math.max(0, Math.min(100, ((rank - 1) / (total - 1)) * 100));
        return `
          <div class="club-stats-card__bar">
            <div class="club-stats-card__bar-track">
              <div class="club-stats-card__bar-dot" style="left:${pct}%"></div>
            </div>
            <div class="club-stats-card__bar-meta">
              <span>1.º</span>
              <span>${total}.º</span>
            </div>
          </div>
        `;
      };

      tabStats.innerHTML = `
        <div class="club-stats-wrap">
          <div class="club-stats-hero">
            <div class="club-stats-hero-tile">
              <div class="club-stats-hero-tile__label">Posesión</div>
              <div class="club-stats-hero-tile__value">${fmtPct(posesionMedia)}</div>
              ${posRank
                ? `<span class="club-stats-hero-tile__rank">${posRank}.º de ${totalTeams}</span>`
                : `<span class="club-stats-hero-tile__rank club-stats-hero-tile__rank--muted">—</span>`}
            </div>
            <div class="club-stats-hero-tile">
              <div class="club-stats-hero-tile__label">Precisión pase</div>
              <div class="club-stats-hero-tile__value">${fmtPct(accPase)}</div>
              ${passRank
                ? `<span class="club-stats-hero-tile__rank">${passRank}.º de ${totalTeams}</span>`
                : `<span class="club-stats-hero-tile__rank club-stats-hero-tile__rank--muted">—</span>`}
            </div>
            <div class="club-stats-hero-tile">
              <div class="club-stats-hero-tile__label">Conversión gol</div>
              <div class="club-stats-hero-tile__value">${fmtPct(convGol)}</div>
              ${shotRank
                ? `<span class="club-stats-hero-tile__rank">${shotRank}.º de ${totalTeams}</span>`
                : `<span class="club-stats-hero-tile__rank club-stats-hero-tile__rank--muted">—</span>`}
            </div>
            <div class="club-stats-hero-tile">
              <div class="club-stats-hero-tile__label">Solidez def.</div>
              <div class="club-stats-hero-tile__value">${fmtPct(efectDef)}</div>
              ${efectRank
                ? `<span class="club-stats-hero-tile__rank">${efectRank}.º de ${totalTeams}</span>`
                : `<span class="club-stats-hero-tile__rank club-stats-hero-tile__rank--muted">—</span>`}
            </div>
          </div>

          <div class="club-stats-cards">
            <div class="club-stats-card">
              <div class="club-stats-card__head">
                <h3 class="club-stats-card__title">Perfil general</h3>
                <span class="club-stats-card__rank club-stats-card__rank--muted">Resumen</span>
              </div>
              <div class="club-stats-card__main">${teamAdv.pj} <small style="font-size:.7em;color:var(--muted);font-weight:700">PJ analizados</small></div>
              <ul class="club-stats-card__detail">
                <li><span>Goles a favor</span><span>${teamTot.gf}</span></li>
                <li><span>Goles en contra</span><span>${teamTot.gc}</span></li>
                <li><span>Diferencia de goles</span><span>${teamTot.gf - teamTot.gc}</span></li>
              </ul>
            </div>

            <div class="club-stats-card">
              <div class="club-stats-card__head">
                <h3 class="club-stats-card__title">Posesión media</h3>
                ${rankChip(posRank, totalTeams)}
              </div>
              <div class="club-stats-card__main">${fmtPct(posesionMedia)}</div>
              ${posBar(posRank, totalTeams)}
            </div>

            <div class="club-stats-card">
              <div class="club-stats-card__head">
                <h3 class="club-stats-card__title">Juego de pase</h3>
                ${rankChip(passRank, totalTeams)}
              </div>
              <div class="club-stats-card__main">${fmtPct(accPase)}</div>
              ${posBar(passRank, totalTeams)}
              <ul class="club-stats-card__detail">
                <li><span>Pases totales</span><span>${pasesTotales}</span></li>
                <li><span>Pases completados</span><span>${pasesComp}</span></li>
              </ul>
            </div>

            <div class="club-stats-card">
              <div class="club-stats-card__head">
                <h3 class="club-stats-card__title">Peligro ofensivo</h3>
                ${rankChip(shotRank, totalTeams)}
              </div>
              <div class="club-stats-card__main">${fmtPct(convGol)}</div>
              ${posBar(shotRank, totalTeams)}
              <ul class="club-stats-card__detail">
                <li><span>Tiros totales</span><span>${tirosTotales}</span></li>
                <li><span>Tiros a puerta</span><span>${tirosPuerta}</span></li>
                <li><span>Goles</span><span>${golesTotales}</span></li>
                <li><span>Precisión de tiro</span><span>${fmtPct(precTiro)}</span></li>
                <li><span>Índice combinado</span><span>${fmtPct(combShot)}</span></li>
              </ul>
            </div>

            <div class="club-stats-card">
              <div class="club-stats-card__head">
                <h3 class="club-stats-card__title">Fair play</h3>
                ${rankChip(fairRank, totalTeams)}
              </div>
              <div class="club-stats-card__main">${fmtNum(fairScore)}</div>
              ${posBar(fairRank, totalTeams)}
              <ul class="club-stats-card__detail">
                <li><span>Entradas</span><span>${teamAdv.entradas}</span></li>
                <li><span>Faltas</span><span>${teamAdv.faltas}</span></li>
                <li><span>Rojas</span><span>${teamAdv.rojas}</span></li>
              </ul>
            </div>

            <div class="club-stats-card">
              <div class="club-stats-card__head">
                <h3 class="club-stats-card__title">Eficacia defensiva</h3>
                ${rankChip(efectRank, totalTeams)}
              </div>
              <div class="club-stats-card__main">${fmtPct(efectDef)}</div>
              ${posBar(efectRank, totalTeams)}
              <ul class="club-stats-card__detail">
                <li><span>Goles encajados</span><span>${teamAdv.golesEncajados}</span></li>
                <li><span>Tiros a puerta rival</span><span>${teamAdv.tirosRival}</span></li>
              </ul>
            </div>
          </div>
        </div>
      `;
    }
  } catch (e) {
    console.error("Error generando estadísticas de club:", e);
    tabStats.innerHTML =
      `<div class="club-box" style="grid-column:span 12">
         <h3>Estadísticas</h3>
         <p class="muted">No se pudieron calcular las estadísticas del club.</p>
       </div>`;
  }

  // Card de "goles por tramo" para este equipo en esta competición
  // (independiente del bloque anterior: se rellena cuando resolvemos leagueTeamRow más abajo)
  tabStats.insertAdjacentHTML('beforeend', `
    <div class="club-stats-card" style="grid-column:1 / -1;margin-top:12px">
      <div class="club-stats-card__head">
        <h3 class="club-stats-card__title">Goles por tramo del partido</h3>
      </div>
      <div id="club-tramo-chart"></div>
    </div>
  `);

  // --------------------------
  // Tabs click
  // --------------------------
  document.querySelectorAll(".tabs button").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".tabs button").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");

      const t = btn.dataset.tab;
      document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
      document.getElementById("tab-" + t).classList.add("active");

    });
  });

  // --------------------------
  // Resolver league_team del club en esta competición (compartido por
  // noticias-relacionadas y el pill de afición).
  // --------------------------
  let leagueTeamRow = null;
  if (competitionId) {
    try {
      const supabase = await getSupabaseClient();
      const { data: lt } = await supabase
        .from('league_teams')
        .select('id, club_id, season')
        .eq('competition_id', competitionId)
        .or(`nickname.eq.${CLUB},display_name.eq.${CLUB}`)
        .maybeSingle();
      if (lt?.id) leagueTeamRow = lt;
    } catch (e) {
      console.warn('[club] league_team lookup:', e?.message);
    }
  }

  // --------------------------
  // Goles por tramo del partido (este equipo, en esta competición)
  // --------------------------
  try {
    const tramoEl = document.getElementById('club-tramo-chart');
    if (tramoEl && leagueTeamRow?.id) {
      const minutes = await fetchGoalMinutesByLeagueTeamIds([leagueTeamRow.id]);
      renderTramoChart(tramoEl, minutes, { emptyMessage: 'Este equipo no tiene goles con minuto registrado esta temporada.' });
    }
  } catch (e) {
    console.warn('[club] tramo chart:', e?.message);
  }

  // --------------------------
  // Pill de afición en el hero (ficha completa vive en entidad.html)
  // --------------------------
  try {
    if (leagueTeamRow?.club_id && leagueTeamRow?.season) {
      const fb = await loadFanbaseForClub(leagueTeamRow.club_id, leagueTeamRow.season);
      if (fb?.state) {
        const b = moodBucket(fb.state.mood_score);
        const heroMeta = document.getElementById("club-hero-meta");
        if (heroMeta) {
          heroMeta.insertAdjacentHTML('beforeend', `
            <a class="fb-hero-pill fb-mood-${b.tone}"
               href="entidad.html?id=${leagueTeamRow.club_id}#tab-aficion"
               title="Ver afición del club">
              <span class="fb-hero-pill-icon" aria-hidden="true">📣</span>
              <span>${b.label} · ${fb.state.mood_score}</span>
            </a>
          `);
        }
      }
    }
  } catch (e) {
    console.warn('[club] fanbase pill:', e?.message);
  }

  // --------------------------
  // Noticias relacionadas con este club
  // --------------------------
  try {
    const noticiasContainer = document.getElementById("club-noticias-relacionadas");
    if (noticiasContainer && leagueTeamRow?.id) {
      await renderNoticiasRelacionadas(
        noticiasContainer,
        { league_team_id: leagueTeamRow.id },
        { limit: 5, title: 'En las noticias' },
      );
    }
  } catch (e) {
    console.warn('[club] noticias-relacionadas:', e?.message);
  }

})();
