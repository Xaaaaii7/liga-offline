import {
  loadAllMatches,
  getJornadas,
  getPartidoMeta,
  loadCitiesMap,
  saveMatchResult
} from '../modules/resultados-data.js';

import {
  renderJornada,
  STREAM_START
} from '../modules/resultados-ui.js';

import { createNavigationControls } from '../modules/navigation.js';
import { getCompetitionFromURL, getCurrentCompetitionSlug, buildBreadcrumb, renderBreadcrumb, buildURLWithCompetition } from '../modules/competition-context.js';
import { getCompetitionBySlug } from '../modules/competition-data.js';
import { loadCompetitionTheme } from '../modules/theme-loader.js';
// liga-offline: ranked y auth/admin están excluidos. Stubs inertes en lugar
// de los módulos originales (ranked-match-creator, competition-permissions):
// una competición offline nunca es 'ranked' ni tiene admin, así que las ramas
// que usan esto quedan muertas y no hace falta tocar el resto del fichero.
const createRankedMatch = async () => ({ success: false, error: 'ranked no disponible offline' });
const getRankedTeams = async () => [];
const isCompetitionAdmin = async () => false;
import { escapeHtml } from '../modules/utils.js';
import { loadCrestMap } from '../modules/manager-crests.js';

(async () => {
  const root = document.getElementById('resultados');
  if (!root) return;

  // --- Obtener contexto de competición ---
  let competitionId = null;
  let competitionSlug = null;
  let competitionName = null;
  let competition = null;

  try {
    competitionSlug = getCompetitionFromURL() || await getCurrentCompetitionSlug();
    if (competitionSlug) {
      competition = await getCompetitionBySlug(competitionSlug);
      console.log('[Resultados] Competition loaded:', competition);
      if (competition) {
        competitionId = competition.id;
        competitionName = competition.name;

        // Aplicar tema de la competición
        await loadCompetitionTheme(competitionId);

        // Si es ranked, mostrar botón de crear partido
        if (competition.competition_type === 'ranked') {
          console.log('[Resultados] Ranked competition detected, setting up match creation');
          const createMatchContainer = document.getElementById('create-match-container');
          console.log('[Resultados] Create match container:', createMatchContainer);
          if (createMatchContainer) {
            createMatchContainer.hidden = false;
            console.log('[Resultados] Container display set to block');
          } else {
            console.warn('[Resultados] create-match-container element not found in DOM');
          }
          // Configurar modal de creación
          setupCreateMatchModal(competitionId);
        }
      }
    }
  } catch (e) {
    console.warn('Error obteniendo contexto de competición:', e);
    // Continuar sin filtro de competición (compatibilidad hacia atrás)
  }

  // --- Renderizar breadcrumb ---
  const breadcrumbContainer = document.createElement('div');
  breadcrumbContainer.className = 'breadcrumb-container';
  breadcrumbContainer.style.marginBottom = '1rem';
  root.insertAdjacentElement('beforebegin', breadcrumbContainer);

  if (competitionName) {
    const breadcrumbItems = buildBreadcrumb(competitionSlug, competitionName, 'Resultados');
    renderBreadcrumb(breadcrumbContainer, breadcrumbItems);
  }

  // Cargar datos
  root.innerHTML = `<p class="hint">Cargando resultados...</p>`;

  // Start background loads
  loadCitiesMap(competitionId);
  await loadCrestMap();

  const { jornadas, partidoMeta } = await loadAllMatches(competitionId);

  if (!Array.isArray(jornadas) || !jornadas.length) {
    root.innerHTML = `<p class="hint">No se pudieron cargar los partidos.</p>`;
    return;
  }

  // Find last played
  const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
  let lastPlayed = 0;
  jornadas.forEach(j => {
    if ((j.partidos || []).some(p => isNum(p.goles_local) && isNum(p.goles_visitante))) {
      if (j.numero > lastPlayed) lastPlayed = j.numero;
    }
  });
  if (!lastPlayed) {
    // Sin ningún partido jugado todavía: arrancar en la primera jornada.
    lastPlayed = Math.min(...jornadas.map(j => j.numero));
  }

  const minJornada = Math.min(...jornadas.map(j => j.numero));
  const maxJornada = Math.max(...jornadas.map(j => j.numero));

  let isAdmin = false;
  try {
    isAdmin = competitionId ? await isCompetitionAdmin(competitionId) : false;
  } catch (err) {
    console.warn('Error verificando admin:', err);
  }

  const isRanked = competition?.competition_type === 'ranked';

  // Init UI
  const navWrap = document.createElement('div');
  navWrap.className = 'jornada-nav resultados-nav';
  navWrap.innerHTML = `
    <button id="res-prev" class="nav-btn">◀</button>
    <span id="res-label" class="jornada-label chip"></span>
    <button id="res-next" class="nav-btn">▶</button>
  `;

  const jornadaWrap = document.createElement('div');
  jornadaWrap.id = 'jornada-contenido';
  jornadaWrap.className = 'resultados-jornada';

  root.innerHTML = '';
  root.appendChild(navWrap);
  root.appendChild(jornadaWrap);

  const labelEl = document.getElementById('res-label');
  const prevBtn = document.getElementById('res-prev');
  const nextBtn = document.getElementById('res-next');

  let current = lastPlayed;

  // Create navigation controls
  createNavigationControls({
    prevBtn,
    nextBtn,
    labelEl,
    minValue: minJornada,
    maxValue: maxJornada,
    initialValue: lastPlayed,
    onUpdate: async (newValue) => {
      current = newValue;
      await renderJornada(jornadas, current, jornadaWrap, labelEl, () => current, isAdmin, isRanked);
    },
    formatLabel: (val) => `Jornada ${val}`
  });

  // Initial render
  await renderJornada(jornadas, current, jornadaWrap, labelEl, () => current, isAdmin, isRanked);

  // Global handler for clicks in root (upload, cards, save result)
  root.addEventListener('click', async (e) => {
    const target = e.target;

    // 1) Guardar resultado desde la card (ranked)
    const saveResultBtn = target.closest?.('.btn-save-result-card');
    if (saveResultBtn) {
      e.preventDefault();
      e.stopPropagation();
      const matchId = saveResultBtn.getAttribute('data-partido-id');
      if (!matchId) return;
      const card = saveResultBtn.closest?.('.result-card');
      if (!card) return;
      const localInput = card.querySelector('.result-edit-score input[data-side="local"]');
      const awayInput = card.querySelector('.result-edit-score input[data-side="visitante"]');
      const localVal = localInput?.value?.trim();
      const awayVal = awayInput?.value?.trim();
      const homeGoals = localVal === '' ? null : parseInt(localVal, 10);
      const awayGoals = awayVal === '' ? null : parseInt(awayVal, 10);
      if (homeGoals !== null && Number.isNaN(homeGoals)) return;
      if (awayGoals !== null && Number.isNaN(awayGoals)) return;
      const meta = getPartidoMeta(matchId);
      if (!meta) return;
      const result = await saveMatchResult(matchId, meta, homeGoals, awayGoals);
      if (result.ok) {
        const statusEl = card.querySelector('.result-edit-score-status');
        if (statusEl) statusEl.textContent = 'Resultado guardado';
        const updated = await loadAllMatches(competitionId);
        jornadas.length = 0;
        jornadas.push(...(updated.jornadas || []));
        await renderJornada(jornadas, current, jornadaWrap, labelEl, () => current, isAdmin, isRanked);
      } else {
        const statusEl = card.querySelector('.result-edit-score-status');
        if (statusEl) statusEl.textContent = result.msg || 'Error';
      }
      return;
    }

    // 2) Botón "Iniciar stream"
    const startStreamBtn = target.closest?.('.start-stream-btn');
    if (startStreamBtn) {
      e.preventDefault();
      e.stopPropagation();
      const pid = startStreamBtn.getAttribute('data-partido-id');
      if (!pid) return;
      const meta = getPartidoMeta(pid);
      if (!meta || !meta.match_uuid) {
        alert('Este partido no tiene identificador asignado. No se puede vincular al stream.');
        return;
      }
      if (!STREAM_START.enabled || !STREAM_START.liveChannelUrl || !STREAM_START.startStreamEndpoint) {
        alert('Iniciar stream no está configurado.');
        return;
      }
      openStreamStartModal(meta.match_uuid, pid);
      return;
    }

    // 3) Botón "Subir imagen"
    const uploadBtn = target.closest?.('.upload-photo-btn');
    if (uploadBtn) {
      e.preventDefault();
      handleUploadClick(uploadBtn);
      return;
    }

    // 4) Tarjeta de partido — navegar a la página de partido
    const cardBtn = target.closest?.('.partido-card');
    if (!cardBtn) return;

    const id = cardBtn.getAttribute('data-partido-id');
    if (!id) return;

    window.location.href = buildURLWithCompetition('partido.html', competitionSlug, { match: id });
  });

  // ---------------
  // Stream start modal (Iniciar stream: elegir canal en directo)
  // ---------------
  const streamStartBackdrop = document.getElementById('stream-start-backdrop');
  const streamStartList = document.getElementById('stream-start-list');
  const streamStartAccept = document.getElementById('stream-start-accept');
  const streamStartCancel = document.getElementById('stream-start-cancel');
  const streamStartClose = document.getElementById('stream-start-close');

  let streamStartMatchUuid = null;
  let streamStartSelectedChannel = null;

  const closeStreamStartModal = () => {
    if (streamStartBackdrop) streamStartBackdrop.hidden = true;
    streamStartMatchUuid = null;
    streamStartSelectedChannel = null;
    if (streamStartAccept) streamStartAccept.disabled = true;
  };

  const openStreamStartModal = async (matchUuid, _pid) => {
    streamStartMatchUuid = matchUuid;
    streamStartSelectedChannel = null;
    if (streamStartAccept) streamStartAccept.disabled = true;
    if (!streamStartList || !streamStartBackdrop) return;
    streamStartList.innerHTML = '<p class="hint">Cargando canales en directo...</p>';
    streamStartBackdrop.hidden = false;

    try {
      const res = await fetch(STREAM_START.liveChannelUrl, { cache: 'no-store' });
      const data = await res.json().catch(() => ({}));
      const channels = Array.isArray(data.channels) ? data.channels : [];
      if (channels.length === 0) {
        streamStartList.innerHTML = '<p class="hint">No hay canales en directo ahora. Enciende tu stream en Twitch y vuelve a intentarlo.</p>';
        return;
      }
      streamStartList.innerHTML = channels.map(ch => `
        <label style="display: flex; align-items: center; gap: 8px; padding: 8px 0; cursor: pointer;">
          <input type="radio" name="stream-channel" value="${ch}" data-channel="${ch}">
          <span>${ch}</span>
        </label>
      `).join('');
      streamStartList.querySelectorAll('input[name="stream-channel"]').forEach(radio => {
        radio.addEventListener('change', () => {
          streamStartSelectedChannel = radio.value;
          if (streamStartAccept) streamStartAccept.disabled = false;
        });
      });
    } catch (err) {
      console.error(err);
      streamStartList.innerHTML = '<p class="hint" style="color: #dc2626;">Error al cargar canales. Inténtalo de nuevo.</p>';
    }
  };

  if (streamStartAccept) {
    streamStartAccept.addEventListener('click', async () => {
      if (!streamStartMatchUuid || !streamStartSelectedChannel) return;
      streamStartAccept.disabled = true;
      streamStartAccept.textContent = 'Iniciando...';
      try {
        const res = await fetch(STREAM_START.startStreamEndpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ matchUuid: streamStartMatchUuid, channel: streamStartSelectedChannel })
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok !== false) {
          alert('Stream vinculado. El contenedor ha sido iniciado.');
          closeStreamStartModal();
        } else {
          alert(data.message || data.error || `Error ${res.status}. Inténtalo de nuevo.`);
        }
      } catch (err) {
        console.error(err);
        alert('Error al iniciar el stream. Inténtalo de nuevo.');
      } finally {
        streamStartAccept.textContent = 'Aceptar';
        streamStartAccept.disabled = false;
      }
    });
  }
  if (streamStartCancel) streamStartCancel.addEventListener('click', closeStreamStartModal);
  if (streamStartClose) streamStartClose.addEventListener('click', closeStreamStartModal);
  if (streamStartBackdrop) {
    streamStartBackdrop.addEventListener('click', (e) => { if (e.target === streamStartBackdrop) closeStreamStartModal(); });
  }

  // ---------------
  // Upload Logic (Local Copy)
  // ---------------
  const requestUploadUrl = async (matchId, file) => {
    // Config hardcoded here as in original or import?
    // original: const MATCH_UPLOAD = { enabled: true, presignEndpoint: ... }
    const MATCH_UPLOAD = {
      enabled: true,
      presignEndpoint: 'https://d39ra5ecf4.execute-api.eu-west-1.amazonaws.com/prod/presign-match-upload'
    };

    if (!MATCH_UPLOAD.enabled || !MATCH_UPLOAD.presignEndpoint) {
      throw new Error('Subida de imágenes no configurada');
    }

    // Obtener metadatos del partido (competition_id y season)
    const matchMeta = getPartidoMeta(matchId);
    let competitionId = matchMeta?.competition_id || null;
    let season = matchMeta?.season || null;

    // Fallback: obtener del contexto si no están en matchMeta
    if (!competitionId) {
      try {
        const { getCurrentCompetitionId } = await import('../modules/competitions.js');
        competitionId = await getCurrentCompetitionId();
      } catch (e) {
        console.warn('No se pudo obtener competition_id del contexto:', e);
      }
    }

    if (!season) {
      try {
        const { getCurrentCompetition } = await import('../modules/competitions.js');
        const comp = await getCurrentCompetition();
        if (comp && comp.season) {
          season = comp.season;
        } else {
          const { getActiveSeason } = await import('../modules/supabase-client.js');
          season = getActiveSeason();
        }
      } catch (e) {
        console.warn('No se pudo obtener season del contexto:', e);
      }
    }

    const payload = {
      matchId,
      filename: file.name,
      contentType: file.type || 'image/jpeg',
      competitionId: competitionId,
      season: season
    };

    const res = await fetch(MATCH_UPLOAD.presignEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error(`Error solicitando URL: HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !data.uploadUrl) throw new Error('Respuesta sin uploadUrl');
    return data.uploadUrl;
  };

  const uploadMatchImage = async (matchId, file, buttonEl) => {
    try {
      buttonEl.disabled = true;
      buttonEl.textContent = 'Subiendo...';
      const uploadUrl = await requestUploadUrl(matchId, file);
      const res = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'image/jpeg' },
        body: file
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      buttonEl.textContent = 'Imagen subida ✔';
      buttonEl.classList.add('upload-success');
    } catch (err) {
      console.error(err);
      alert('No se ha podido subir la imagen. Inténtalo de nuevo.');
      buttonEl.disabled = false;
      buttonEl.textContent = 'Subir imagen';
    }
  };

  const handleUploadClick = (btn) => {
    const matchId = btn.getAttribute('data-partido-id');
    if (!matchId) return;
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (!file) return;
      uploadMatchImage(matchId, file, btn);
    });
    input.click();
  };

  // ---------------
  // Ratings Upload Logic
  // ---------------
  const requestRatingsUploadUrl = async (matchId, file) => {
    const MATCH_UPLOAD = {
      enabled: true,
      presignEndpoint: 'https://d39ra5ecf4.execute-api.eu-west-1.amazonaws.com/prod/presign-match-upload'
    };

    if (!MATCH_UPLOAD.enabled || !MATCH_UPLOAD.presignEndpoint) {
      throw new Error('Subida de imágenes no configurada');
    }

    // Obtener metadatos del partido (competition_id y season)
    const matchMeta = getPartidoMeta(matchId);
    let competitionId = matchMeta?.competition_id || null;
    let season = matchMeta?.season || null;

    // Fallback: obtener del contexto si no están en matchMeta
    if (!competitionId) {
      try {
        const { getCurrentCompetitionId } = await import('../modules/competitions.js');
        competitionId = await getCurrentCompetitionId();
      } catch (e) {
        console.warn('No se pudo obtener competition_id del contexto:', e);
      }
    }

    if (!season) {
      try {
        const { getCurrentCompetition } = await import('../modules/competitions.js');
        const comp = await getCurrentCompetition();
        if (comp && comp.season) {
          season = comp.season;
        } else {
          const { getActiveSeason } = await import('../modules/supabase-client.js');
          season = getActiveSeason();
        }
      } catch (e) {
        console.warn('No se pudo obtener season del contexto:', e);
      }
    }

    const payload = {
      matchId,
      filename: file.name,
      contentType: file.type || 'image/jpeg',
      competitionId: competitionId,
      season: season,
      type: 'ratings' // Indicar que es para valoraciones
    };

    const res = await fetch(MATCH_UPLOAD.presignEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error(`Error solicitando URL: HTTP ${res.status}`);
    const data = await res.json();
    if (!data || !data.uploadUrl) throw new Error('Respuesta sin uploadUrl');
    return data.uploadUrl;
  };

  const uploadRatingsImage = async (matchId, file, buttonEl) => {
    try {
      buttonEl.disabled = true;
      buttonEl.textContent = 'Subiendo...';
      const uploadUrl = await requestRatingsUploadUrl(matchId, file);
      console.log('[Ratings Upload] URL presignada obtenida, intentando subir...');
      const res = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type || 'image/jpeg' },
        body: file
      });
      if (!res.ok) {
        const errorText = await res.text().catch(() => 'Sin detalles');
        console.error('[Ratings Upload] Error en subida:', {
          status: res.status,
          statusText: res.statusText,
          error: errorText,
          uploadUrl: uploadUrl.substring(0, 100) + '...' // Solo primeros 100 chars para no exponer toda la URL
        });
        throw new Error(`HTTP ${res.status}: ${res.statusText}`);
      }
      buttonEl.textContent = 'Imagen subida ✔';
      buttonEl.classList.add('upload-success');
      // Mostrar mensaje de éxito
      setTimeout(() => {
        buttonEl.textContent = '📷 Subir imagen de valoraciones';
        buttonEl.disabled = false;
        buttonEl.classList.remove('upload-success');
      }, 3000);
    } catch (err) {
      console.error(err);
      alert('No se ha podido subir la imagen. Inténtalo de nuevo.');
      buttonEl.disabled = false;
      buttonEl.textContent = '📷 Subir imagen de valoraciones';
    }
  };

  // Escuchar evento personalizado desde resultados-modal.js
  document.addEventListener('uploadRatingsImage', async (e) => {
    const { matchId, file, buttonEl, meta } = e.detail;
    if (matchId && file && buttonEl) {
      await uploadRatingsImage(matchId, file, buttonEl);
    }
  });

  // ---------------
  // Ranked Match Creation Modal
  // ---------------
  function setupCreateMatchModal(competitionId) {
    const modal = document.getElementById('create-match-modal');
    const openBtn = document.getElementById('create-match-btn');
    const closeBtn = document.getElementById('create-match-close');
    const cancelBtn = document.getElementById('cancel-create-match');
    const form = document.getElementById('create-match-form');
    const homeSelect = document.getElementById('home-team-select');
    const awaySelect = document.getElementById('away-team-select');

    if (!modal || !openBtn || !form) return;

    // Cargar equipos
    async function loadTeams() {
      const teams = await getRankedTeams(competitionId);
      
      // Eliminar duplicados por ID (por si acaso)
      const uniqueTeams = new Map();
      teams.forEach(t => {
        if (t.id && !uniqueTeams.has(t.id)) {
          uniqueTeams.set(t.id, t);
        }
      });
      
      const uniqueTeamsArray = Array.from(uniqueTeams.values());
      const options = uniqueTeamsArray.map(t =>
        `<option value="${escapeHtml(t.id)}">${escapeHtml(t.display_name || t.nickname)}</option>`
      ).join('');

      if (homeSelect) {
        homeSelect.innerHTML = '<option value="">Selecciona equipo...</option>' + options;
      }
      if (awaySelect) {
        awaySelect.innerHTML = '<option value="">Selecciona equipo...</option>' + options;
      }
    }

    openBtn.addEventListener('click', async () => {
      await loadTeams();
      modal.removeAttribute('hidden');
    });

    if (closeBtn) {
      closeBtn.addEventListener('click', () => {
        modal.setAttribute('hidden', '');
        form.reset();
      });
    }

    if (cancelBtn) {
      cancelBtn.addEventListener('click', () => {
        modal.setAttribute('hidden', '');
        form.reset();
      });
    }

    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const homeTeamId = parseInt(homeSelect.value);
      const awayTeamId = parseInt(awaySelect.value);

      if (!homeTeamId || !awayTeamId) {
        alert('Debes seleccionar ambos equipos');
        return;
      }

      const result = await createRankedMatch(competitionId, homeTeamId, awayTeamId);

      if (result.success) {
        alert('Partido creado exitosamente');
        modal.setAttribute('hidden', '');
        form.reset();
        // Recargar página para mostrar el nuevo partido
        window.location.reload();
      } else {
        alert('Error: ' + result.error);
      }
    });
  }

  // Initial Render
  await renderJornada(jornadas, current, jornadaWrap, labelEl, () => current);

})();
