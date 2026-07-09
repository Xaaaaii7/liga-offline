import { getCompetitionFromURL, getCurrentCompetitionSlug, buildBreadcrumb, renderBreadcrumb } from '../modules/competition-context.js';
import { getCompetitionBySlug } from '../modules/competition-data.js';
import { loadCompetitionTheme } from '../modules/theme-loader.js';
import { renderPodium } from '../modules/podium.js';
import { escapeHtml } from '../modules/utils.js';
import { loadCrestMap, getCrestOrLogo } from '../modules/manager-crests.js';

/**
 * Devuelve (o crea) un contenedor de podio antes de la tabla del tab.
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

(async () => {
  const root = document.getElementById('jugadores');

  // --- Obtener contexto de competición ---
  let competitionId = null;
  let competitionSlug = null;
  let competitionName = null;
  let competitionSeason = null;

  try {
    competitionSlug = getCompetitionFromURL() || await getCurrentCompetitionSlug();
    if (competitionSlug) {
      const competition = await getCompetitionBySlug(competitionSlug);
      if (competition) {
        competitionId = competition.id;
        competitionName = competition.name;
        competitionSeason = competition.season || null;

        // Aplicar tema de la competición
        await loadCompetitionTheme(competitionId);
      }
    }
  } catch (e) {
    console.warn('Error obteniendo contexto de competición:', e);
  }

  // --- Renderizar breadcrumb ---
  if (competitionName && root) {
    const breadcrumbContainer = document.createElement('div');
    breadcrumbContainer.className = 'breadcrumb-container';
    breadcrumbContainer.style.marginBottom = '1rem';
    root.insertAdjacentElement('beforebegin', breadcrumbContainer);
    
    const breadcrumbItems = buildBreadcrumb(competitionSlug, competitionName, 'Estadísticas');
    renderBreadcrumb(breadcrumbContainer, breadcrumbItems);
  }

  // -----------------------------
  // Tabs Jugadores (UI only)
  // -----------------------------
  if (root) {
    const tabsContainer = root.querySelector('.tabs-jugadores');
    const tabButtons = tabsContainer?.querySelectorAll('button') || [];
    const panels = root.querySelectorAll('.tab-panel');

    const switchTab = (id) => {
      panels.forEach(p => p.classList.toggle('active', p.id === id));
      tabButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.tab === id));
    };

    tabButtons.forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.tab;
        if (id) switchTab(id);
      });
    });
  }

  // -----------------------------
  // Core helpers
  // -----------------------------
  const norm = CoreStats.norm;
  const slug = CoreStats.slug;

  await loadCrestMap();
  const logoPath = (team) => getCrestOrLogo(team, competitionSeason);

  const teamCell = (name) => `
    <div class="team-cell">
      <img class="team-badge team-badge-sm"
           src="${logoPath(name)}"
           alt="Escudo ${escapeHtml(name)}"
           onerror="this.style.visibility='hidden'">
      <span class="team-name">${escapeHtml(name)}</span>
    </div>
  `;

  const podiumChip = (i) => {
    if (i === 0) return '<span class="chip chip-podium chip-p1">TOP 1</span>';
    if (i === 1) return '<span class="chip chip-podium chip-p2">TOP 2</span>';
    if (i === 2) return '<span class="chip chip-podium chip-p3">TOP 3</span>';
    return '';
  };

  const setHTML = (id, html) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  };

  const setRows = (id, rows) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = rows.join('');
  };

  // =========================================================
  // 1) PICHICHI / ZAMORA EQUIPOS (GLOBAL)
  //    Totales vienen del core, aquí solo ordenamos/pintamos
  // =========================================================
  const totals = await CoreStats.computeTeamTotals(competitionId).catch(() => []);

  const gfPJ = t => (t.pj > 0) ? (t.gf / t.pj).toFixed(2) : '—';
  const gcPJ = t => (t.pj > 0) ? (t.gc / t.pj).toFixed(2) : '—';
  const dg   = t => (t.gf - t.gc);

  const pichichiEq = totals.slice().sort((a,b)=>
    (b.gf - a.gf) || (dg(b)-dg(a)) || (a.gc - b.gc) ||
    a.nombre.localeCompare(b.nombre,'es',{sensitivity:'base'})
  );

  const zamoraEq = totals.slice().sort((a,b)=>
    (a.gc - b.gc) || (dg(b)-dg(a)) || (b.gf - a.gf) ||
    a.nombre.localeCompare(b.nombre,'es',{sensitivity:'base'})
  );

  const rowPichichi = (t,i)=>`
    <tr>
      <td class="jug-pos-cell">${i+1}${podiumChip(i)}</td>
      <td>${teamCell(t.nombre)}</td>
      <td>${t.pj}</td>
      <td>${t.gf}</td>
      <td>${gfPJ(t)}</td>
    </tr>`;

  const rowZamora = (t,i)=>`
    <tr>
      <td class="jug-pos-cell">${i+1}${podiumChip(i)}</td>
      <td>${teamCell(t.nombre)}</td>
      <td>${t.pj}</td>
      <td>${t.gc}</td>
      <td>${gcPJ(t)}</td>
    </tr>`;

  setHTML('tabla-pichichi', pichichiEq.map(rowPichichi).join(''));
  setHTML('tabla-zamora',   zamoraEq.map(rowZamora).join(''));

  // Podios Pichichi / Zamora (equipos)
  renderPodium(getPodiumContainer('tab-pichichi'), pichichiEq, {
    getName: t => t.nombre,
    getValue: t => t.gf,
    valueLabel: 'goles a favor',
    getSubtitle: t => `${t.pj} PJ · ${gfPJ(t)} GF/PJ`,
    getImg: t => logoPath(t.nombre)
  });
  renderPodium(getPodiumContainer('tab-zamora'), zamoraEq, {
    getName: t => t.nombre,
    getValue: t => t.gc,
    valueLabel: 'goles en contra',
    getSubtitle: t => `${t.pj} PJ · ${gcPJ(t)} GC/PJ`,
    getImg: t => logoPath(t.nombre)
  });

  // =========================================================
  // 2) RANKINGS AVANZADOS POR EQUIPO (GLOBAL)
  //    100% CoreStats.computeRankingsPorEquipo()
  // =========================================================
  const adv = await CoreStats.computeRankingsPorEquipo(competitionId).catch(() => null);

  if (adv) {
    const {
      posesionTop = [],
      fairTop = [],
      passTop = [],
      shotTop = [],
      efectTop = [],
      posMed,
      fair,
      passAcc,
      precisionTiro,
      conversionGol,
      combinedShot,
      efectRival
    } = adv;

    const fmtPct = v => Number.isFinite(v) ? (v*100).toFixed(1)+'%' : '—';

    const rPos = (t,i)=> `
      <tr>
        <td class="jug-pos-cell">${i+1}${podiumChip(i)}</td>
        <td>${teamCell(t.nombre)}</td>
        <td>${t.pj}</td>
        <td>${fmtPct(posMed(t))}</td>
      </tr>`;

    const rFair= (t,i)=> `
      <tr>
        <td class="jug-pos-cell">${i+1}${podiumChip(i)}</td>
        <td>${teamCell(t.nombre)}</td>
        <td>${t.pj}</td>
        <td>${t.entradas}</td>
        <td>${t.faltas}</td>
        <td>${t.rojas}</td>
        <td>${fair(t).toFixed(2)}</td>
      </tr>`;

    const rPass= (t,i)=> `
      <tr>
        <td class="jug-pos-cell">${i+1}${podiumChip(i)}</td>
        <td>${teamCell(t.nombre)}</td>
        <td>${t.pj}</td>
        <td>${t.pases}</td>
        <td>${t.completados}</td>
        <td>${fmtPct(passAcc(t))}</td>
      </tr>`;

    const rShot= (t,i)=> `
      <tr>
        <td class="jug-pos-cell">${i+1}${podiumChip(i)}</td>
        <td>${teamCell(t.nombre)}</td>
        <td>${t.pj}</td>
        <td>${t.tiros}</td>
        <td>${t.taPuerta}</td>
        <td>${t.goles}</td>
        <td>${fmtPct(precisionTiro(t))}</td>
        <td>${fmtPct(conversionGol(t))}</td>
        <td>${fmtPct(combinedShot(t))}</td>
      </tr>`;

    const rEfect = (t,i)=> `
      <tr>
        <td class="jug-pos-cell">${i+1}${podiumChip(i)}</td>
        <td>${teamCell(t.nombre)}</td>
        <td>${t.pj}</td>
        <td>${t.golesEncajados}</td>
        <td>${t.tirosRival}</td>
        <td>${fmtPct(efectRival(t))}</td>
      </tr>`;

    setRows('tabla-posesion-eq', posesionTop.map(rPos));
    setRows('tabla-fairplay-eq', fairTop.map(rFair));
    setRows('tabla-pass-eq',     passTop.map(rPass));
    setRows('tabla-shot-eq',     shotTop.map(rShot));
    setRows('tabla-efect-rival', efectTop.map(rEfect));

    // Podios de rankings avanzados
    renderPodium(getPodiumContainer('tab-posesion'), posesionTop, {
      getName: t => t.nombre,
      getValue: t => fmtPct(posMed(t)),
      valueLabel: 'posesión media',
      getSubtitle: t => `${t.pj} PJ con datos`,
      getImg: t => logoPath(t.nombre)
    });
    renderPodium(getPodiumContainer('tab-fairplay'), fairTop, {
      getName: t => t.nombre,
      getValue: t => fair(t).toFixed(2),
      valueLabel: 'índice fair play',
      getSubtitle: t => `${t.rojas} rojas · ${t.faltas} faltas`,
      getImg: t => logoPath(t.nombre)
    });
    renderPodium(getPodiumContainer('tab-pass'), passTop, {
      getName: t => t.nombre,
      getValue: t => fmtPct(passAcc(t)),
      valueLabel: 'precisión de pase',
      getSubtitle: t => `${t.pases} pases`,
      getImg: t => logoPath(t.nombre)
    });
    renderPodium(getPodiumContainer('tab-shot'), shotTop, {
      getName: t => t.nombre,
      getValue: t => fmtPct(combinedShot(t)),
      valueLabel: 'índice de tiro',
      getSubtitle: t => `${t.goles} goles · ${t.tiros} tiros`,
      getImg: t => logoPath(t.nombre)
    });
    renderPodium(getPodiumContainer('tab-efect'), efectTop, {
      getName: t => t.nombre,
      getValue: t => fmtPct(efectRival(t)),
      valueLabel: '% acierto rival',
      getSubtitle: t => `${t.golesEncajados} encajados`,
      getImg: t => logoPath(t.nombre)
    });
  }

  // =========================================================
  // 3) MVP TEMPORADA (EQUIPOS)
  //    100% CoreStats.computeMvpTemporada()
  // =========================================================
  const mvpSeasonArr = await CoreStats.computeMvpTemporada(competitionId).catch(() => []);

  const mvpTbody = document.getElementById('tabla-mvp-jornada');
  if (mvpTbody) {
    mvpTbody.innerHTML = mvpSeasonArr.map((s,i)=>{
      const puntos = (s.mvpAvg * 100).toFixed(1);
      return `
        <tr>
          <td class="jug-pos-cell">${i+1}${podiumChip(i)}</td>
          <td>${teamCell(s.nombre)}</td>
          <td>${s.jornadas}</td>
          <td>${s.pj}</td>
          <td>${s.gf}</td>
          <td>${s.gc}</td>
          <td>${puntos}</td>
        </tr>
      `;
    }).join('');

    renderPodium(getPodiumContainer('panel-mvp-jornada'), mvpSeasonArr, {
      getName: s => s.nombre,
      getValue: s => (s.mvpAvg * 100).toFixed(1),
      valueLabel: 'MVP medio',
      getSubtitle: s => `${s.jornadas} jornadas · ${s.pj} PJ`,
      getImg: s => logoPath(s.nombre)
    });
  }

})();
