import { getCompetitionFromURL, getCurrentCompetitionSlug, buildBreadcrumb, renderBreadcrumb } from '../modules/competition-context.js';
import { getCompetitionBySlug } from '../modules/competition-data.js';
import { loadCompetitionTheme } from '../modules/theme-loader.js';
import { escapeHtml } from '../modules/utils.js';
import { loadCrestMap, getCrestOrLogo } from '../modules/manager-crests.js';

(async () => {
  const msgEl  = document.getElementById('pichichi-msg');
  const tbody  = document.getElementById('tabla-pichichi-jug');
  const heroEl = document.getElementById('pichichi-hero');

  if (!tbody) return;

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
  if (competitionName && tbody) {
    const breadcrumbContainer = document.createElement('div');
    breadcrumbContainer.className = 'breadcrumb-container';
    breadcrumbContainer.style.marginBottom = '1rem';
    tbody.parentElement.insertAdjacentElement('beforebegin', breadcrumbContainer);
    
    const breadcrumbItems = buildBreadcrumb(competitionSlug, competitionName, 'Pichichi');
    renderBreadcrumb(breadcrumbContainer, breadcrumbItems);
  }

  const setMsg = (t) => { if (msgEl) msgEl.textContent = t || ''; };

  // Helpers desde Core
  const slug = CoreStats.slug;
  const toNum = CoreStats.toNum;

  await loadCrestMap();
  const logoPath = eq => getCrestOrLogo(eq, competitionSeason);
  const playerPhotoPath = nombre => `img/jugadores/${slug(nombre)}.jpg`;
  const gpp = (g, pj) => pj > 0 ? (g / pj) : 0;

  // Chip podio (top 3)
  const podiumChip = (i) => {
    if (i === 0) return '<span class="chip chip-podium chip-p1">TOP 1</span>';
    if (i === 1) return '<span class="chip chip-podium chip-p2">TOP 2</span>';
    if (i === 2) return '<span class="chip chip-podium chip-p3">TOP 3</span>';
    return '';
  };

  function renderHero(top) {
    if (!heroEl || !top) {
      if (heroEl) heroEl.innerHTML = '';
      return;
    }

    const golesPJ = gpp(top.goles, top.pj);
    const foto = playerPhotoPath(top.jugador);

    heroEl.innerHTML = `
      <div class="pichichi-hero-card">
        <div class="pichichi-hero-photo-wrapper">
          <img
            src="${foto}"
            alt="Foto de ${escapeHtml(top.jugador)}"
            class="pichichi-hero-photo"
            onerror="this.style.visibility='hidden'">
        </div>
        <div class="pichichi-hero-info">
          <div class="pichichi-hero-label">Líder Pichichi</div>
          <h2 class="pichichi-hero-name">${escapeHtml(top.jugador)}</h2>
          <div class="pichichi-hero-team">
            <span class="pichichi-hero-team-name">${escapeHtml(top.equipo)}</span>
          </div>
          <div class="pichichi-hero-stats">
            <div class="pichichi-hero-stat">
              <span class="stat-label">Goles</span>
              <span class="stat-value">${top.goles}</span>
            </div>
            <div class="pichichi-hero-stat">
              <span class="stat-label">PJ</span>
              <span class="stat-value">${top.pj}</span>
            </div>
            <div class="pichichi-hero-stat">
              <span class="stat-label">Goles / PJ</span>
              <span class="stat-value">${golesPJ.toFixed(2)}</span>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function render(fullData) {
    if (!fullData.length) {
      tbody.innerHTML = '';
      renderHero(null);
      setMsg('No hay datos de goleadores en la hoja.');
      return;
    }

    // Héroe = primer clasificado
    renderHero(fullData[0]);

    // Solo top 30 tabla
    const data = fullData.slice(0, 30);

    tbody.innerHTML = data.map((r,i)=>`
      <tr>
        <td class="jug-pos-cell">${i+1}${podiumChip(i)}</td>
        <td>${escapeHtml(r.jugador)}</td>
        <td class="team-cell">
          <img class="team-badge"
               src="${logoPath(r.equipo)}"
               alt="Escudo ${escapeHtml(r.equipo)}"
               onerror="this.style.visibility='hidden'">
          <span>${escapeHtml(r.equipo)}</span>
        </td>
        <td>${r.pj}</td>
        <td>${r.goles}</td>
        <td>${gpp(r.goles, r.pj).toFixed(2)}</td>
      </tr>
    `).join('');

    setMsg(`Mostrando top ${data.length} goleadores (de ${fullData.length} registrados).`);
  }

  // -----------------------------
  // Carga desde Core + render
  // -----------------------------
  try {
    // Nota: getPichichiRows aún no acepta competitionId
    // Por ahora se filtra por temporada (compatibilidad hacia atrás)
    // TODO: Modificar getPichichiRows para filtrar por competición
    const rows = await CoreStats.getPichichiRows(competitionId);
    const fullData = CoreStats.computePichichiPlayers(rows);
    render(fullData);
  } catch (e) {
    console.error(e);
    setMsg('No se pudo cargar la hoja publicada. Revisa la URL TSV.');
  }
})();
