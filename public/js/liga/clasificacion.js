

import { isNum, escapeHtml } from '../modules/utils.js';
import { loadCrestMap, getCrestOrLogo } from '../modules/manager-crests.js';
import { getResultados } from '../modules/stats-data.js';
import { computeClasificacion, dg } from '../modules/stats-calc.js';
import { computePartidosEquipo, computePosicionesEquipo } from '../modules/stats-analyze.js';
import * as Render from '../modules/render.js';
import { Modal } from '../modules/modal.js';
import { createNavigationControls } from '../modules/navigation.js';
import { getCompetitionFromURL, getCurrentCompetitionSlug, buildBreadcrumb, renderBreadcrumb } from '../modules/competition-context.js';
import { getCompetitionBySlug } from '../modules/competition-data.js';
import { getCompetitionStandings } from '../modules/competition-standings.js';
import { renderBracket } from '../modules/bracket-renderer.js';
import { loadCompetitionTheme } from '../modules/theme-loader.js';
import { renderRankedStandings } from '../modules/ranked-standings.js';
import { resolveZones } from '../modules/tier-zones.js';

(async () => {
  const tbody = document.getElementById('tabla-clasificacion');
  if (!tbody) return;

  // --- Obtener contexto de competición ---
  let competitionId = null;
  let competitionSlug = null;
  let competitionName = null;
  let competitionType = null;

  let competition = null;
  try {
    // Primero intentar obtener de URL
    const urlSlug = getCompetitionFromURL();
    console.log('[Clasificación] Competition slug from URL:', urlSlug);

    if (urlSlug) {
      // Hay slug en URL, buscar por slug
      competition = await getCompetitionBySlug(urlSlug);
      console.log('[Clasificación] Competition found by slug:', competition);
    } else {
      // No hay slug en URL, obtener competición activa
      console.log('[Clasificación] No slug in URL, getting current competition');
      const { getCurrentCompetition, getPublicCompetitions } = await import('../modules/competitions.js');
      competition = await getCurrentCompetition();
      console.log('[Clasificación] Current competition:', competition);

      // Si no hay competición del usuario, intentar obtener una pública
      if (!competition) {
        console.log('[Clasificación] No user competition, trying public competitions');
        const publicCompetitions = await getPublicCompetitions({ is_active: true });
        if (publicCompetitions && publicCompetitions.length > 0) {
          competition = publicCompetitions[0];
          console.log('[Clasificación] Using first public competition:', competition.name);
        }
      }
    }

    if (competition) {
      competitionId = competition.id;
      competitionSlug = competition.slug;
      competitionName = competition.name;
      competitionType = competition.competition_type;
      console.log('[Clasificación] Using competition ID:', competitionId, 'Name:', competitionName, 'Type:', competitionType);

      // Aplicar tema de la competición
      await loadCompetitionTheme(competitionId);
    } else {
      console.warn('[Clasificación] No competition found');
      Render.renderError(tbody.parentElement, 'No se encontró ninguna competición activa. Por favor, selecciona una competición.');
      return;
    }
  } catch (e) {
    console.error('Error obteniendo contexto de competición:', e);
    Render.renderError(tbody.parentElement, 'Error al cargar la competición.');
    return;
  }

  // Si es una copa, mostrar bracket en lugar de tabla
  if (competitionType === 'cup' && competitionId) {
    const bracketContainer = document.getElementById('bracket-container');
    const tableWrap = document.getElementById('table-wrap');

    if (bracketContainer && tableWrap) {
      tableWrap.style.display = 'none';
      bracketContainer.style.display = 'block';

      try {
        const standings = await getCompetitionStandings(competitionId);
        if (standings.type === 'cup' && standings.data.bracket) {
          // ✨ DOBLE ELIMINACIÓN: Pasar datos adicionales para renderizado
          const renderData = standings.data.isDoubleElimination
            ? { winnerBracket: standings.data.winnerBracket, loserBracket: standings.data.loserBracket }
            : standings.data.bracket;

          renderBracket(bracketContainer, renderData, {
            showScores: true,
            totalTeams: standings.data.totalTeams || null,
            competitionId: competitionId,
            isDoubleElimination: standings.data.isDoubleElimination || false
          });
        } else {
          bracketContainer.innerHTML = '<p class="hint">No hay datos del bracket disponibles.</p>';
        }
      } catch (e) {
        console.error('Error cargando bracket:', e);
        bracketContainer.innerHTML = '<p class="hint">Error al cargar el bracket.</p>';
      }
      return; // Salir temprano para copas
    }
  }

  // Si es ranked, mostrar tabla de ratings
  if (competitionType === 'ranked' && competitionId) {
    await renderRankedStandings(competitionId, competitionSlug, competitionName, tbody);
    return; // Salir temprano para ranked
  }

  // --- Renderizar breadcrumb ---
  const breadcrumbContainer = document.createElement('div');
  breadcrumbContainer.className = 'breadcrumb-container';
  breadcrumbContainer.style.marginBottom = '1rem';
  tbody.parentElement.insertAdjacentElement('beforebegin', breadcrumbContainer);

  if (competitionName) {
    const breadcrumbItems = buildBreadcrumb(competitionSlug, competitionName, 'Clasificación');
    renderBreadcrumb(breadcrumbContainer, breadcrumbItems);
  }

  // --- Data Loading ---
  // Cargar mapping nickname → club crest para que getCrestOrLogo resuelva
  // contra clubs.crest_url en BD (mismo patrón que liga.html).
  await loadCrestMap();

  let jornadas = [];
  try {
    jornadas = await getResultados(competitionId);
  } catch (e) {
    console.error("Error loading matches:", e);
    Render.renderError(tbody.parentElement, 'No se pudieron cargar los resultados.');
    return;
  }

  if (!Array.isArray(jornadas) || !jornadas.length) {
    Render.renderError(tbody.parentElement, 'No hay jornadas disponibles.');
    return;
  }

  // Detect last played match
  let lastPlayed = 0;
  jornadas.forEach((j, idx) => {
    if ((j.partidos || []).some(p => isNum(p.goles_local) && isNum(p.goles_visitante))) {
      lastPlayed = idx + 1;
    }
  });

  // Si no hay partidos jugados, igualmos el comportamiento de liga.html:
  // mostrar la tabla con todos los equipos a 0 y omitir la navegación de jornadas.
  const hasPlayedMatches = lastPlayed > 0;

  // --- Create Navigation (solo si hay jornadas jugadas) ---
  let label = null;
  let prevBtn = null;
  let nextBtn = null;
  if (hasPlayedMatches) {
    const navWrap = document.createElement('div');
    navWrap.className = 'jornada-nav';
    navWrap.innerHTML = `
        <button id="prevJornada" class="nav-btn">◀</button>
        <span id="jornadaLabel" class="jornada-label chip"></span>
        <button id="nextJornada" class="nav-btn">▶</button>
    `;
    tbody.parentElement.insertAdjacentElement('beforebegin', navWrap);

    label = document.getElementById('jornadaLabel');
    prevBtn = document.getElementById('prevJornada');
    nextBtn = document.getElementById('nextJornada');
  }

  // --- Modal Refs ---
  const teamTitleEl = document.getElementById('team-modal-title');
  const teamSummaryEl = document.getElementById('team-modal-summary');
  const teamMetaEl = document.getElementById('team-modal-meta');
  const teamMatchesEl = document.getElementById('team-modal-matches');
  const teamBadgeImg = document.getElementById('team-modal-badge');
  const teamPosHistoryEl = document.getElementById('team-modal-poshistory');

  // Create team modal using Modal module
  const teamModal = new Modal('team-backdrop', 'team-modal-close');

  // Set cleanup hook
  teamModal.onClose = () => {
    if (teamTitleEl) teamTitleEl.textContent = '';
    if (teamSummaryEl) teamSummaryEl.textContent = '';
    if (teamMetaEl) teamMetaEl.textContent = '';
    if (teamMatchesEl) teamMatchesEl.innerHTML = '';
    if (teamPosHistoryEl) teamPosHistoryEl.innerHTML = '';
    if (teamBadgeImg) {
      teamBadgeImg.removeAttribute('src');
      teamBadgeImg.alt = '';
      teamBadgeImg.style.visibility = '';
    }
  };

  // --- Logic: Open Team History ---
  const abrirHistorialEquipo = async (equipos, hasta, teamName) => {
    const eq = equipos.find(e => e.nombre === teamName);
    const partidos = computePartidosEquipo(jornadas, hasta, teamName);
    const posHistory = await computePosicionesEquipo(hasta, teamName, competitionId);

    if (!eq && partidos.length === 0 && posHistory.length === 0) return;

    if (teamBadgeImg) {
      teamBadgeImg.style.visibility = '';
      teamBadgeImg.src = getCrestOrLogo(teamName, competition?.season);
      teamBadgeImg.alt = `Escudo ${teamName}`;
      teamBadgeImg.onerror = () => teamBadgeImg.style.visibility = 'hidden';
    }

    if (teamTitleEl) teamTitleEl.textContent = teamName;

    if (eq && teamSummaryEl) {
      const diff = dg(eq);
      const diffStr = diff > 0 ? `+${diff}` : `${diff}`;
      teamSummaryEl.textContent =
        `${eq.pj} PJ · ${eq.g} G ${eq.e} E ${eq.p} P · ${eq.gf} GF · ${eq.gc} GC · DG ${diffStr} · ${eq.pts} pts`;
    } else if (teamSummaryEl) {
      teamSummaryEl.textContent = '';
    }

    if (teamMetaEl) teamMetaEl.textContent = `Resultados hasta la jornada ${hasta}`;

    // Render Positions
    if (teamPosHistoryEl) {
      if (!posHistory.length) {
        teamPosHistoryEl.innerHTML = '';
      } else {
        const historyHtml = posHistory.map((h, idx) => {
          const prev = idx > 0 ? posHistory[idx - 1].pos : null;
          let trend = '';
          if (prev !== null) {
            if (h.pos < prev) trend = '↑';
            else if (h.pos > prev) trend = '↓';
          }
          const trendClass = !trend ? '' : (trend === '↑' ? 'pos-up' : 'pos-down');

          return `
                <div class="team-pos-row">
                  <span class="chip chip-jornada">J${h.jornada}</span>
                  <span class="team-pos-value">
                    ${h.pos}º
                    ${trend ? `<span class="team-pos-trend ${trendClass}">${trend}</span>` : ''}
                  </span>
                  <span class="team-pos-points">${h.pts} pts</span>
                </div>
              `;
        }).join('');

        Render.renderContent(teamPosHistoryEl, `
                    <h3 class="team-pos-title">Evolución en la clasificación</h3>
                    <div class="team-pos-list">${historyHtml}</div>
                `);
      }
    }

    // Render Matches
    if (teamMatchesEl) {
      if (!partidos.length) {
        Render.renderEmpty(teamMatchesEl, `Este equipo todavía no ha disputado partidos cerrados hasta la jornada ${hasta}.`);
      } else {
        const matchesHtml = partidos.map(m => {
          const resClass = m.result === 'V' ? 'result-win' : m.result === 'D' ? 'result-loss' : 'result-draw';
          const label = m.result === 'V' ? 'Victoria' : m.result === 'D' ? 'Derrota' : 'Empate';
          return `
            <div class="team-match-row ${resClass}">
              <div class="team-match-left">
                <span class="chip chip-jornada">J${m.jornada}</span>
              </div>
              <div class="team-match-center">
                <span class="team-match-team ${m.isLocal ? 'highlight-team' : ''}">${escapeHtml(m.local)}</span>
                <span class="team-match-score">${m.gl} – ${m.gv}</span>
                <span class="team-match-team ${!m.isLocal ? 'highlight-team' : ''}">${escapeHtml(m.visitante)}</span>
              </div>
              <div class="team-match-right">
                <span class="result-pill">${label}</span>
              </div>
            </div>`;
        }).join('');
        Render.renderContent(teamMatchesEl, matchesHtml);
      }
    }

    teamModal.open();
  };

  // --- Render Table Logic ---
  let current = lastPlayed;

  // Forma: últimos 5 resultados del equipo hasta la jornada `jNum` (cronológico)
  const formaEquipo = (teamName, jNum, limit = 5) => {
    const matches = computePartidosEquipo(jornadas, jNum, teamName);
    return matches.slice(-limit).map(m => m.result); // 'V' | 'E' | 'D'
  };

  const formaHtml = (results) => {
    if (!results.length) return '<span class="forma-empty">—</span>';
    return `<div class="forma">${results.map(r => {
      const cls = r === 'V' ? 'forma-w' : r === 'D' ? 'forma-l' : 'forma-d';
      const label = r === 'V' ? 'Victoria' : r === 'D' ? 'Derrota' : 'Empate';
      const letter = r === 'V' ? 'V' : r === 'D' ? 'D' : 'E';
      return `<span class="forma-pill ${cls}" title="${label}">${letter}</span>`;
    }).join('')}</div>`;
  };

  const render = async (equipos, jNum) => {
    if (label) label.textContent = `Jornada ${jNum}`;

    // Calcular tabla previa para tendencia (si no es jornada 1)
    let prevPositions = null;
    if (jNum > 1) {
      try {
        const prevEquipos = await computeClasificacion(jNum - 1, {
          competitionId,
          typeConfig: competition?.type_config || null
        });
        prevPositions = new Map();
        prevEquipos.forEach((e, idx) => prevPositions.set(e.nombre, idx));
      } catch (err) {
        console.debug('[Clasificación] No se pudo calcular posición anterior:', err);
      }
    }

    const trendFor = (teamName, currentPos) => {
      if (!prevPositions) return '';
      const prev = prevPositions.get(teamName);
      if (prev == null || prev === currentPos) {
        return `<span class="pos-trend pos-trend-same" aria-label="Sin cambio">−</span>`;
      }
      if (prev > currentPos) {
        const diff = prev - currentPos;
        return `<span class="pos-trend pos-trend-up" aria-label="Sube ${diff}">▲${diff > 1 ? diff : ''}</span>`;
      }
      const diff = currentPos - prev;
      return `<span class="pos-trend pos-trend-down" aria-label="Baja ${diff}">▼${diff > 1 ? diff : ''}</span>`;
    };

    const len = equipos.length;

    // Resuelve zonas: config-driven si la competición trae standings_zones,
    // legacy 8/4/4 (Voll Damm directo / previa / Free Damm previa) en caso contrario.
    const zoning = resolveZones({
      totalTeams: len,
      standingsZones: competition?.config?.standings_zones,
    });
    // Solo mostramos cabeceras si hay zonas relevantes. En legacy exigimos >=16 equipos para que tengan sentido.
    const showZoneLabels = zoning.mode === 'config'
      ? zoning.headers.length > 0
      : len >= 16;
    const headersByPos = new Map(zoning.headers.map(h => [h.startPos, h]));

    const rowsHtml = equipos.map((e, i) => {
      let preHeader = '';
      if (showZoneLabels && headersByPos.has(i)) {
        const h = headersByPos.get(i);
        const variantClass = h.variant === 'custom' ? 'zone-header-custom' : `zone-header-${h.variant}`;
        const styleAttr = h.color ? ` style="--zone-color:${h.color}"` : '';
        preHeader = `
      <tr class="zone-header ${variantClass}"${styleAttr}>
        <td colspan="11">${escapeHtml(h.label)} · ${h.count} ${h.count === 1 ? 'plaza' : 'plazas'}</td>
      </tr>
    `;
      }

      const row = zoning.getRow(i);
      const rowStyle = row.color ? ` style="--zone-color:${row.color}"` : '';

      const forma = formaEquipo(e.nombre, jNum);
      const nombreSafe = escapeHtml(e.nombre);
      const teamRow = `
      <tr class="${row.className}"${rowStyle}>
        <td class="pos-cell">
          <span class="pos-index">${i + 1}</span>
          ${trendFor(e.nombre, i)}
        </td>
        <td class="team-cell">
          <img class="team-badge"
               src="${escapeHtml(getCrestOrLogo(e.nombre, competition?.season))}"
               alt="Escudo ${nombreSafe}"
               onerror="this.style.visibility='hidden'">
          <button type="button"
                  class="team-name-btn"
                  data-team="${nombreSafe}">
            ${nombreSafe}
          </button>
        </td>
        <td>${e.pj}</td>
        <td>${e.g}</td>
        <td>${e.e}</td>
        <td>${e.p}</td>
        <td>${e.gf}</td>
        <td>${e.gc}</td>
        <td>${dg(e)}</td>
        <td class="pts-cell">${e.pts}</td>
        <td class="forma-cell">${formaHtml(forma)}</td>
      </tr>
      `;
      return preHeader + teamRow;
    }).join('');

    tbody.innerHTML = rowsHtml;

    tbody.querySelectorAll('.team-name-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const teamName = btn.dataset.team;
        if (!teamName) return;
        await abrirHistorialEquipo(equipos, jNum, teamName);
      });
    });

    // Render side rail (pichichi, mejor ataque, mejor defensa, evolución líder)
    renderSideRail(equipos, jNum).catch(err => console.error('Error side rail:', err));
  };

  // ==========================
  //   SIDE RAIL: 4 widgets
  // ==========================

  // Pichichi (full season) — cacheado tras la primera llamada porque no depende de la jornada.
  let _pichichiPromise = null;
  function loadPichichiTop() {
    if (!_pichichiPromise) {
      _pichichiPromise = (async () => {
        try {
          const { computePichichiPlayersAsync } = await import('../modules/stats-analyze.js');
          const all = await computePichichiPlayersAsync(competitionId);
          return all.slice(0, 5);
        } catch (e) {
          console.warn('Error pichichi side rail:', e);
          return [];
        }
      })();
    }
    return _pichichiPromise;
  }

  function renderPichichiCard(top5) {
    if (!top5 || !top5.length) {
      return `<div class="aside-card"><h3 class="aside-card-title">Pichichi</h3><p class="muted small">Sin datos.</p></div>`;
    }
    const photoPath = name => `img/jugadores/${name.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '')}.jpg`;
    const rows = top5.map((p, idx) => `
      <li class="aside-pichichi-row">
        <span class="aside-pichichi-rank">${idx + 1}</span>
        <img class="aside-pichichi-photo" src="${escapeHtml(photoPath(p.jugador))}" alt="" onerror="this.style.visibility='hidden'">
        <div class="aside-pichichi-info">
          <div class="aside-pichichi-name">${escapeHtml(p.jugador)}</div>
          <div class="aside-pichichi-team">${escapeHtml(p.equipo)}</div>
        </div>
        <span class="aside-pichichi-goals">${p.goles}</span>
      </li>
    `).join('');
    return `
      <div class="aside-card">
        <h3 class="aside-card-title">Pichichi</h3>
        <ol class="aside-pichichi-list">${rows}</ol>
      </div>
    `;
  }

  function renderAtaqueCard(equipos) {
    const sorted = [...equipos].filter(e => e.pj > 0).sort((a, b) => b.gf - a.gf).slice(0, 3);
    if (!sorted.length) return '';
    const top = sorted[0];
    const others = sorted.slice(1);
    return `
      <div class="aside-card">
        <h3 class="aside-card-title">Mejor ataque</h3>
        <div class="aside-stat-leader">
          <img class="aside-stat-leader-badge" src="${escapeHtml(getCrestOrLogo(top.nombre, competition?.season))}" alt="" onerror="this.style.visibility='hidden'">
          <div class="aside-stat-leader-info">
            <div class="aside-stat-leader-name">${escapeHtml(top.nombre)}</div>
            <div class="aside-stat-leader-detail">${top.gf} goles · ${(top.gf / top.pj).toFixed(2)}/PJ</div>
          </div>
          <div class="aside-stat-leader-value">${top.gf}</div>
        </div>
        ${others.length ? `<ol class="aside-stat-others">${others.map((t, i) => `
          <li><span class="aside-stat-others-rank">${i + 2}</span><span class="aside-stat-others-name">${escapeHtml(t.nombre)}</span><span class="aside-stat-others-value">${t.gf}</span></li>
        `).join('')}</ol>` : ''}
      </div>
    `;
  }

  function renderDefensaCard(equipos) {
    const sorted = [...equipos].filter(e => e.pj > 0).sort((a, b) => a.gc - b.gc).slice(0, 3);
    if (!sorted.length) return '';
    const top = sorted[0];
    const others = sorted.slice(1);
    return `
      <div class="aside-card">
        <h3 class="aside-card-title">Mejor defensa</h3>
        <div class="aside-stat-leader">
          <img class="aside-stat-leader-badge" src="${escapeHtml(getCrestOrLogo(top.nombre, competition?.season))}" alt="" onerror="this.style.visibility='hidden'">
          <div class="aside-stat-leader-info">
            <div class="aside-stat-leader-name">${escapeHtml(top.nombre)}</div>
            <div class="aside-stat-leader-detail">${top.gc} encajados · ${(top.gc / top.pj).toFixed(2)}/PJ</div>
          </div>
          <div class="aside-stat-leader-value">${top.gc}</div>
        </div>
        ${others.length ? `<ol class="aside-stat-others">${others.map((t, i) => `
          <li><span class="aside-stat-others-rank">${i + 2}</span><span class="aside-stat-others-name">${escapeHtml(t.nombre)}</span><span class="aside-stat-others-value">${t.gc}</span></li>
        `).join('')}</ol>` : ''}
      </div>
    `;
  }

  async function renderEvolucionLiderCard(equipos, jNum) {
    if (!equipos.length) return '';
    const leader = equipos[0];
    let posHistory = [];
    try {
      posHistory = await computePosicionesEquipo(jNum, leader.nombre, competitionId);
    } catch (e) {
      console.warn('Error pos history líder:', e);
    }
    const last5 = posHistory.slice(-5);
    const chips = last5.length
      ? last5.map(h => `
        <div class="aside-evolution-chip">
          <span class="aside-evolution-jornada">J${h.jornada}</span>
          <span class="aside-evolution-pos">${h.pos}º</span>
        </div>
      `).join('')
      : '<p class="muted small">Sin histórico aún.</p>';
    return `
      <div class="aside-card">
        <h3 class="aside-card-title">Líder · ${escapeHtml(leader.nombre)}</h3>
        <div class="aside-evolution">${chips}</div>
      </div>
    `;
  }

  async function renderSideRail(equipos, jNum) {
    const aside = document.getElementById('clasificacion-aside');
    if (!aside) return;
    const [pichichiTop, evoLiderHtml] = await Promise.all([
      loadPichichiTop(),
      renderEvolucionLiderCard(equipos, jNum)
    ]);
    aside.innerHTML = [
      renderPichichiCard(pichichiTop),
      renderAtaqueCard(equipos),
      renderDefensaCard(equipos),
      evoLiderHtml
    ].filter(Boolean).join('');
  }

  // --- Navigation Controls ---
  const labelEl = document.getElementById('jornadaLabel');

  if (hasPlayedMatches) {
    createNavigationControls({
      prevBtn,
      nextBtn,
      labelEl,
      minValue: 1,
      maxValue: lastPlayed,
      initialValue: lastPlayed,
      onUpdate: async (newValue) => {
        current = newValue;
        const equipos = await computeClasificacion(current, {
          competitionId,
          typeConfig: competition?.type_config || null
        });
        await render(equipos, current);
      },
      formatLabel: (val) => `Jornada ${val}`
    });
  }

  // Initial Render — si no hay jornadas jugadas, computamos sobre toda la
  // temporada (devuelve todos los equipos a 0), igual que liga.html.
  const initialHasta = hasPlayedMatches ? current : null;
  const equiposInicial = await computeClasificacion(initialHasta, {
    competitionId,
    typeConfig: competition?.type_config || null
  });
  await render(equiposInicial, hasPlayedMatches ? current : 0);

})();
