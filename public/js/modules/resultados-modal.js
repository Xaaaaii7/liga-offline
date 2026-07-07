import {
  fmtDate,
  isNum,
  escapeHtml
} from './utils.js';

import {
  ensureStatsIndex,
  getScorerState,
  loadScorerStateForMatch,
  // Modifiers
  addGoalToState,
  changeGoalCount,
  removeScorer,
  addRedCardToState,
  removeRedCardFromState,
  addInjuryToState,
  removeInjuryFromState,
  // Savers
  saveScorersToSupabase,
  saveRedCardsFull,
  saveInjuriesFull,
  saveMatchResult,
  // Helpers
  getSupa
} from './resultados-data.js';

import { Modal } from './modal.js';

let statsModal = null;
let bodyEl = null;
let titleEl = null;

export const initModalRefs = (backdropId, closeId, bEl, tEl) => {
  bodyEl = bEl;
  titleEl = tEl;

  // Create modal using Modal class
  statsModal = new Modal(backdropId, closeId);

  // Set cleanup hook
  statsModal.onClose = () => {
    if (bodyEl) bodyEl.innerHTML = '';
    if (titleEl) titleEl.textContent = 'Estadísticas del partido';
  };
};

export const openModal = () => {
  statsModal?.open();
};

export const closeModal = () => {
  statsModal?.close();
};

// -----------------------------
// Render Stats Table
// -----------------------------
export const renderStats = async (matchId, meta, competitionId = null, isAdmin = false, isRanked = false) => {
  if (!bodyEl) return;

  // Quick loader
  bodyEl.innerHTML = `<p class="hint">Cargando estadísticas...</p>`;
  if (titleEl) {
    titleEl.textContent = `Estadísticas — ${meta.local} vs ${meta.visitante}`;
  }

  let statsObj = {};
  try {
    // Pasar competitionId para filtrar correctamente las estadísticas
    const idx = await ensureStatsIndex(competitionId);
    statsObj = idx[matchId] || {};
  } catch (err) {
    console.warn('Error cargando stats para partido', matchId, err);
  }

  // Obtener datos de stats usando league_team_id (más seguro que nombres)
  const localTeamId = meta?.local_team_id;
  const visitTeamId = meta?.visitante_team_id;

  // Intentar obtener stats por team_id primero, luego por nombre como fallback
  const localStats = localTeamId && statsObj[`_team_id_${localTeamId}`]
    ? statsObj[`_team_id_${localTeamId}`]
    : (statsObj[meta?.local] || {});

  const visitStats = visitTeamId && statsObj[`_team_id_${visitTeamId}`]
    ? statsObj[`_team_id_${visitTeamId}`]
    : (statsObj[meta?.visitante] || {});

  const hasStats = (Object.keys(localStats).length > 0 || Object.keys(visitStats).length > 0);

  const localName = meta?.local || 'Local';
  const visitName = meta?.visitante || 'Visitante';

  const gl = isNum(meta?.goles_local) ? meta.goles_local : null;
  const gv = isNum(meta?.goles_visitante) ? meta.goles_visitante : null;
  const marcador = (gl !== null && gv !== null) ? `${gl} – ${gv}` : '-';

  const fechaTexto = meta?.fecha
    ? fmtDate(meta.fecha)
    : (meta?.fechaJornada ? fmtDate(meta.fechaJornada) : '');
  const horaTexto = meta?.hora || '';
  const jTexto = meta?.jornada ? `Jornada ${meta.jornada}` : '';

  const metaLine = [fechaTexto, horaTexto, jTexto].filter(Boolean).join(' · ');

  let tableHtml = '';
  let summaryHtml = '';

  if (!hasStats) {
    tableHtml = `<p class="hint">No hay estadísticas detalladas para este partido.</p>`;
  } else {
    // Usar los stats obtenidos por team_id
    const Adata = localStats;
    const Bdata = visitStats;

    const get = (data, k) =>
      (data && Object.prototype.hasOwnProperty.call(data, k)) ? data[k] : null;

    const ataqueKeys = ['goles', 'tiros', 'tiros_a_puerta'];
    const balonKeys = ['posesion', 'pases', 'pases_completados', 'centros'];

    const buildKvList = (keys) => keys
      .filter(k => get(Adata, k) !== null || get(Bdata, k) !== null)
      .map(k => `
          <li>
            <span>${k.replace(/_/g, ' ')}</span>
            <span>${escapeHtml(get(Adata, k) ?? '—')} · ${escapeHtml(get(Bdata, k) ?? '—')}</span>
          </li>
        `).join('');

    const ataqueHtml = buildKvList(ataqueKeys);
    const balonHtml = buildKvList(balonKeys);

    if (ataqueHtml || balonHtml) {
      summaryHtml = `
          <div class="stats-summary cards-2col">
            ${ataqueHtml ? `
              <div class="card">
                <h3>Ataque</h3>
                <ul class="kv">
                  ${ataqueHtml}
                </ul>
              </div>
            ` : ''}
            ${balonHtml ? `
              <div class="card">
                <h3>Juego con balón</h3>
                <ul class="kv">
                  ${balonHtml}
                </ul>
              </div>
            ` : ''}
          </div>
        `;
    }

    const orden = [
      'goles', 'posesion', 'tiros', 'tiros_a_puerta', 'faltas',
      'fueras_de_juego', 'corners', 'tiros_libres', 'pases',
      'pases_completados', 'centros', 'pases_interceptados',
      'entradas', 'paradas', 'rojas'
    ];

    const rows = orden
      .filter(k => Adata.hasOwnProperty(k) || Bdata.hasOwnProperty(k))
      .map(k => `
          <tr>
            <th>${k.replace(/_/g, ' ')}</th>
            <td>${escapeHtml(Adata[k] ?? '—')}</td>
            <td>${escapeHtml(Bdata[k] ?? '—')}</td>
          </tr>
        `).join('');

    tableHtml = `
        <table class="stats-table stats-table-modern">
          <thead>
            <tr>
              <th>Estadística</th>
              <th>${escapeHtml(localName)}</th>
              <th>${escapeHtml(visitName)}</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      `;
  }

  const supa = await getSupa();
  const hasSupabase = !!supa;

  const localNameSafe = escapeHtml(localName);
  const visitNameSafe = escapeHtml(visitName);
  const matchIdSafe = escapeHtml(matchId);

  const redCardsEditorHtml =
    (meta?.local_team_id && meta?.visitante_team_id && matchId)
      ? `
      <hr class="stats-divider" />
      <section class="redcards-editor" data-match-id="${matchIdSafe}">
        <h3>Tarjetas rojas</h3>

        <div class="scorers-summary-block">
          <div class="scorers-summary-columns">
            <div class="scorers-summary-side">
              <h5>${localNameSafe}</h5>
              <ul class="scorers-summary-list" data-side="local"></ul>
            </div>
            <div class="scorers-summary-side">
              <h5>${visitNameSafe}</h5>
              <ul class="scorers-summary-list" data-side="visitante"></ul>
            </div>
          </div>
        </div>

        <div class="scorers-columns">
          <div class="scorers-col" data-side="local">
            <h4>${localNameSafe}</h4>
            <ul class="scorers-list redcards-list" data-side="local"></ul>
            <div class="scorers-add">
              <select data-side="local">
                <option value="">Añadir jug. con roja…</option>
              </select>
              <button type="button" class="btn-add-red" data-side="local">＋</button>
            </div>
          </div>
          <div class="scorers-col" data-side="visitante">
            <h4>${visitNameSafe}</h4>
            <ul class="scorers-list redcards-list" data-side="visitante"></ul>
            <div class="scorers-add">
              <select data-side="visitante">
                <option value="">Añadir jug. con roja…</option>
              </select>
              <button type="button" class="btn-add-red" data-side="visitante">＋</button>
            </div>
          </div>
        </div>
        <div class="redcards-actions">
           <span class="redcards-status" aria-live="polite"></span>
           <button type="button" class="btn-save-redcards">Guardar rojas</button>
        </div>
      </section>
      `
      : '';

  const injuriesEditorHtml =
    (meta?.local_team_id && meta?.visitante_team_id && matchId)
      ? `
      <hr class="stats-divider" />
      <section class="injuries-editor" data-match-id="${matchIdSafe}">
        <h3>Lesiones (Bajas próximo partido)</h3>

        <div class="scorers-summary-block">
          <div class="scorers-summary-columns">
            <div class="scorers-summary-side">
              <h5>${localNameSafe}</h5>
              <ul class="scorers-summary-list" data-side="local"></ul>
            </div>
            <div class="scorers-summary-side">
              <h5>${visitNameSafe}</h5>
              <ul class="scorers-summary-list" data-side="visitante"></ul>
            </div>
          </div>
        </div>

        <div class="scorers-columns">
          <div class="scorers-col" data-side="local">
            <h4>${localNameSafe}</h4>
            <ul class="scorers-list injuries-list" data-side="local"></ul>
            <div class="scorers-add">
              <select data-side="local">
                <option value="">Añadir lesionado…</option>
              </select>
              <button type="button" class="btn-add-injury" data-side="local">＋</button>
            </div>
          </div>
          <div class="scorers-col" data-side="visitante">
            <h4>${visitNameSafe}</h4>
            <ul class="scorers-list injuries-list" data-side="visitante"></ul>
            <div class="scorers-add">
              <select data-side="visitante">
                <option value="">Añadir lesionado…</option>
              </select>
              <button type="button" class="btn-add-injury" data-side="visitante">＋</button>
            </div>
          </div>
        </div>
        <div class="injuries-actions">
           <span class="injuries-status" aria-live="polite"></span>
           <button type="button" class="btn-save-injuries">Guardar lesiones</button>
        </div>
      </section>
      `
      : '';

  const scorersEditorHtml =
    (meta?.local_team_id && meta?.visitante_team_id && matchId)
      ? `
      <hr class="stats-divider" />
      <section class="scorers-editor" data-match-id="${matchIdSafe}">
        <h3>Goleadores del partido</h3>

        <div class="scorers-summary-block">
          <div class="scorers-summary-columns">
            <div class="scorers-summary-side">
              <h5>${localNameSafe}</h5>
              <ul class="scorers-summary-list" data-side="local"></ul>
            </div>
            <div class="scorers-summary-side">
              <h5>${visitNameSafe}</h5>
              <ul class="scorers-summary-list" data-side="visitante"></ul>
            </div>
          </div>
        </div>

        <div class="scorers-edit-toggle">
          <button type="button" class="btn-toggle-scorers-edit">
            Editar goleadores
          </button>
          <span class="scorers-status" aria-live="polite"></span>
        </div>

        <div class="scorers-edit-panel" hidden>
          <p class="hint small">
            Usa los selectores para añadir o ajustar los goles de cada jugador.
          </p>
          <div class="scorers-columns">
            <div class="scorers-col" data-side="local">
              <h4>${localNameSafe}</h4>
              <ul class="scorers-list" data-role="list" data-side="local"></ul>
              <div class="scorers-add">
                <select data-role="select" data-side="local">
                  <option value="">Añadir goleador…</option>
                </select>
                <button type="button" class="btn-add-goal" data-side="local">＋</button>
              </div>
            </div>
            <div class="scorers-col" data-side="visitante">
              <h4>${visitNameSafe}</h4>
              <ul class="scorers-list" data-role="list" data-side="visitante"></ul>
              <div class="scorers-add">
                <select data-role="select" data-side="visitante">
                  <option value="">Añadir goleador…</option>
                </select>
                <button type="button" class="btn-add-goal" data-side="visitante">＋</button>
              </div>
            </div>
          </div>
          <div class="scorers-actions">
            <button type="button" class="btn-save-scorers">Guardar goleadores</button>
          </div>
        </div>
      </section>
      `
      : '';

  // Fetch player ratings if available
  let playerRatingsHtml = '';
  console.log('[Player Ratings Debug] meta:', meta);
  console.log('[Player Ratings Debug] competitionId:', competitionId);
  console.log('[Player Ratings Debug] match_uuid:', meta?.match_uuid);

  if (meta?.match_uuid && competitionId) {
    try {
      const supa = await getSupa();
      if (supa) {
        const { data: ratings, error } = await supa
          .from('match_player_ratings')
          .select(`
            player_name,
            rating,
            league_team_id
          `)
          .eq('match_uuid', meta.match_uuid)
          .order('rating', { ascending: false });

        if (!error && ratings && ratings.length > 0) {
          // Separate ratings by team
          const localRatings = ratings.filter(r => r.league_team_id === localTeamId);
          const visitRatings = ratings.filter(r => r.league_team_id === visitTeamId);

          // Determinar mejor jugador del partido
          // Combinar todos los ratings
          const allRatings = [...localRatings, ...visitRatings];
          
          // Determinar equipo ganador
          const winnerTeamId = (gl !== null && gv !== null) 
            ? (gl > gv ? localTeamId : (gv > gl ? visitTeamId : null))
            : null;
          
          // Encontrar mejor jugador
          const bestPlayer = allRatings
            .filter(r => r.rating !== null)
            .sort((a, b) => {
              // 1. Por rating (descendente)
              if (b.rating !== a.rating) return b.rating - a.rating;
              // 2. Por equipo ganador
              if (winnerTeamId) {
                const aIsWinner = a.league_team_id === winnerTeamId;
                const bIsWinner = b.league_team_id === winnerTeamId;
                if (aIsWinner !== bIsWinner) return bIsWinner - aIsWinner;
              }
              // 3. Alfabético
              return a.player_name.localeCompare(b.player_name);
            })[0];
          
          const bestPlayerName = bestPlayer?.player_name || null;

          const renderTeamRatings = (teamRatings, teamName, bestPlayerName) => {
            if (!teamRatings.length) {
              return `<p class="hint">No hay valoraciones registradas.</p>`;
            }
            return `
              <table class="ratings-table">
                <thead>
                  <tr>
                    <th>Jugador</th>
                    <th>Valoración</th>
                  </tr>
                </thead>
                <tbody>
                  ${teamRatings.map(r => `
                    <tr>
                      <td>${r.player_name === bestPlayerName ? '⭐ ' : ''}${escapeHtml(r.player_name)}</td>
                      <td class="rating-value">${r.rating !== null ? r.rating.toFixed(1) : '—'}</td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            `;
          };

          playerRatingsHtml = `
            <div class="player-ratings-content">
              <div class="ratings-columns">
                <div class="ratings-col">
                  <h4>${escapeHtml(localName)}</h4>
                  ${renderTeamRatings(localRatings, localName, bestPlayerName)}
                </div>
                <div class="ratings-col">
                  <h4>${escapeHtml(visitName)}</h4>
                  ${renderTeamRatings(visitRatings, visitName, bestPlayerName)}
                </div>
              </div>
            </div>
          `;
        }
      }
    } catch (err) {
      console.warn('Error loading player ratings:', err);
    }
  }

  // Determinar si hay valoraciones o no
  const hasRatings = playerRatingsHtml && 
                     !playerRatingsHtml.includes('No hay valoraciones') && 
                     !playerRatingsHtml.includes('No hay valoraciones de jugadores');
  
  // Botón de subida siempre disponible para admins (con matchId y match_uuid),
  // aunque ya haya valoraciones: por si la captura no se subió o hay que
  // corregirla. Reprocesar la imagen sobrescribe las valoraciones del partido.
  let ratingsUploadHtml = '';
  if (isAdmin && matchId && meta?.match_uuid) {
    const uploadHint = hasRatings
      ? '¿Falta la captura o hay que corregirla? Sube la imagen y se reprocesarán las valoraciones del partido.'
      : 'No hay estadísticas de jugadores. Sube una captura de pantalla con las valoraciones de los jugadores';
    ratingsUploadHtml = `
      <div class="ratings-upload-section" style="margin-top: 1rem; padding: 1rem; border: 1px dashed #ddd; border-radius: 4px; text-align: center;">
        <p class="hint" style="margin-bottom: 0.75rem;">${uploadHint}</p>
        <button type="button" class="btn-primary upload-ratings-btn" data-match-id="${matchIdSafe}" data-match-uuid="${escapeHtml(meta.match_uuid)}" style="padding: 0.5rem 1rem; font-size: 0.9rem;">
          📷 Subir imagen de valoraciones
        </button>
        <input type="file" accept="image/*" class="ratings-file-input" data-match-id="${matchIdSafe}" style="display: none;">
      </div>
    `;
  }

  if (!playerRatingsHtml) {
    playerRatingsHtml = `<p class="hint">No hay estadísticas de jugadores para este partido.</p>`;
  }

  let resultEditHtml = '';
  if (isRanked) {
    const localVal = gl !== null ? String(gl) : '';
    const visitVal = gv !== null ? String(gv) : '';
    resultEditHtml = `
      <div class="result-edit-modal">
        <h3 style="margin: 0 0 12px 0; font-size: 1rem; text-align: center;">Anotar Resultado</h3>
        <div>
          <label>
            <span>${localNameSafe}</span>
            <input type="number" min="0" class="result-input-local" data-side="local" value="${escapeHtml(localVal)}">
          </label>
          <span>–</span>
          <label>
            <span>${visitNameSafe}</span>
            <input type="number" min="0" class="result-input-visitante" data-side="visitante" value="${escapeHtml(visitVal)}">
          </label>
          <button type="button" class="btn-save-result-modal">Guardar resultado</button>
          <span class="result-edit-modal-status" aria-live="polite"></span>
        </div>
      </div>`;
  }

  bodyEl.innerHTML = `
      <div class="stats-header">
        <div class="stats-teams">
          <span class="stats-team-name">${localNameSafe}</span>
          <span class="stats-score">${marcador}</span>
          <span class="stats-team-name">${visitNameSafe}</span>
        </div>
        ${metaLine ? `<p class="stats-meta">${escapeHtml(metaLine)}</p>` : ''}
      </div>

      ${resultEditHtml}

      <div class="stats-tabs">
        <button class="stats-tab active" data-tab="equipos">Equipos</button>
        <button class="stats-tab" data-tab="jugadores">Jugadores</button>
      </div>

      <div class="stats-tab-content active" data-tab-content="equipos">
        ${summaryHtml}
        ${tableHtml}
      </div>

      <div class="stats-tab-content" data-tab-content="jugadores">
        ${playerRatingsHtml}
        ${ratingsUploadHtml}
      </div>

      ${redCardsEditorHtml}
      ${injuriesEditorHtml}
      ${scorersEditorHtml}
    `;

  if (matchId) {
    if (scorersEditorHtml) void initScorersEditor(matchId, meta);
    if (redCardsEditorHtml) void initRedCardsEditor(matchId, meta);
    if (injuriesEditorHtml) void initInjuriesEditor(matchId, meta);
  }

  // Initialize tab switching
  initTabSwitching();
  
  // Initialize ratings upload handler
  initRatingsUpload(matchId, meta);

  // Initialize ranked result save handler
  if (isRanked) initResultEditModal(matchId, meta);
};

// -----------------------------
// Result edit (ranked) in modal
// -----------------------------
const initResultEditModal = (matchId, meta) => {
  if (!bodyEl) return;
  const saveBtn = bodyEl.querySelector('.btn-save-result-modal');
  const localInput = bodyEl.querySelector('.result-input-local');
  const visitInput = bodyEl.querySelector('.result-input-visitante');
  const statusEl = bodyEl.querySelector('.result-edit-modal-status');
  const scoreEl = bodyEl.querySelector('.stats-score');
  if (!saveBtn || !localInput || !visitInput) return;

  saveBtn.addEventListener('click', async () => {
    const localVal = localInput.value.trim();
    const visitVal = visitInput.value.trim();
    const homeGoals = localVal === '' ? null : parseInt(localVal, 10);
    const awayGoals = visitVal === '' ? null : parseInt(visitVal, 10);
    if (homeGoals !== null && Number.isNaN(homeGoals)) {
      if (statusEl) statusEl.textContent = 'Introduce números válidos.';
      return;
    }
    if (awayGoals !== null && Number.isNaN(awayGoals)) {
      if (statusEl) statusEl.textContent = 'Introduce números válidos.';
      return;
    }
    saveBtn.disabled = true;
    if (statusEl) statusEl.textContent = '';
    const result = await saveMatchResult(matchId, meta, homeGoals, awayGoals);
    if (result.ok) {
      if (statusEl) statusEl.textContent = 'Resultado guardado.';
      if (scoreEl) scoreEl.textContent = (homeGoals !== null && awayGoals !== null) ? `${homeGoals} – ${awayGoals}` : '-';
    } else {
      if (statusEl) statusEl.textContent = result.msg || 'Error al guardar';
    }
    saveBtn.disabled = false;
  });
};

// -----------------------------
// Tab Switching
// -----------------------------

const initTabSwitching = () => {
  if (!bodyEl) return;

  const tabButtons = bodyEl.querySelectorAll('.stats-tab');
  const tabContents = bodyEl.querySelectorAll('.stats-tab-content');

  tabButtons.forEach(button => {
    button.addEventListener('click', () => {
      const targetTab = button.getAttribute('data-tab');

      // Remove active class from all tabs and contents
      tabButtons.forEach(btn => btn.classList.remove('active'));
      tabContents.forEach(content => content.classList.remove('active'));

      // Add active class to clicked tab and corresponding content
      button.classList.add('active');
      const targetContent = bodyEl.querySelector(`[data-tab-content="${targetTab}"]`);
      if (targetContent) {
        targetContent.classList.add('active');
      }
    });
  });
};

// -----------------------------
// Editors Helpers (DOM manipulation)
// -----------------------------

// --- Scorers ---

const renderSideScorersList = (sectionEl, side, state) => {
  if (!sectionEl || !state) return;
  const listEl = sectionEl.querySelector(`.scorers-list[data-side="${side}"]`);
  if (!listEl) return;

  const arr = state[side] || [];
  if (!arr.length) {
    listEl.innerHTML = `<li class="scorer-empty">Ningún goleador registrado.</li>`;
    return;
  }

  listEl.innerHTML = arr.map(p => `
      <li class="scorer-item" data-player-id="${p.player_id}">
        <span class="scorer-name">${escapeHtml(p.name)}</span>
        <div class="scorer-controls">
          <button type="button" class="btn-minus-goal" data-player-id="${p.player_id}" data-side="${side}">−</button>
          <span class="scorer-goals">${p.goals}</span>
          <button type="button" class="btn-plus-goal" data-player-id="${p.player_id}" data-side="${side}">＋</button>
          <button type="button" class="btn-remove-scorer" data-player-id="${p.player_id}" data-side="${side}">✕</button>
        </div>
      </li>
    `).join('');
};

const renderScorersSummary = (sectionEl, state) => {
  if (!sectionEl || !state) return;

  const toBalls = (goals) => {
    const g = Number(goals) || 0;
    if (g <= 0) return '';
    if (g === 1) return '⚽';
    return `⚽ x${g}`;
  };

  const renderSide = (side) => {
    const listEl = sectionEl.querySelector(`.scorers-summary-list[data-side="${side}"]`);
    if (!listEl) return;

    const arr = state[side] || [];
    if (!arr.length) {
      listEl.innerHTML = `<li class="scorer-summary-empty">Sin goles registrados.</li>`;
      return;
    }

    const managerNick = side === 'local'
      ? (state.localManagerNick || '')
      : (state.visitManagerNick || '');

    listEl.innerHTML = arr.map(p => `
        <li class="scorer-summary-item">
          <span class="scorer-summary-balls">${toBalls(p.goals)}</span>
          <span class="scorer-summary-name">${escapeHtml(p.name)}</span>
          ${managerNick ? `<span class="scorer-summary-club">(${escapeHtml(managerNick)})</span>` : ''}
        </li>
      `).join('');
  };

  renderSide('local');
  renderSide('visitante');
};

const renderRedCardsSummary = (sectionEl, state) => {
  if (!sectionEl || !state) return;

  const renderSide = (side) => {
    const listEl = sectionEl.querySelector(`.scorers-summary-list[data-side="${side}"]`);
    if (!listEl) return;

    const arr = (side === 'local' ? state.redLocal : state.redVisitante) || [];
    if (!arr.length) {
      listEl.innerHTML = `<li class="scorer-summary-empty">Sin tarjetas rojas.</li>`;
      return;
    }

    const managerNick = side === 'local'
      ? (state.localManagerNick || '')
      : (state.visitManagerNick || '');

    listEl.innerHTML = arr.map(p => `
        <li class="scorer-summary-item">
          <span class="scorer-summary-balls">🔴</span>
          <span class="scorer-summary-name">${escapeHtml(p.name)}</span>
          ${managerNick ? `<span class="scorer-summary-club">(${escapeHtml(managerNick)})</span>` : ''}
        </li>
      `).join('');
  };

  renderSide('local');
  renderSide('visitante');
};

const renderInjuriesSummary = (sectionEl, state) => {
  if (!sectionEl || !state) return;

  const renderSide = (side) => {
    const listEl = sectionEl.querySelector(`.scorers-summary-list[data-side="${side}"]`);
    if (!listEl) return;

    const arr = (side === 'local' ? state.injuriesLocal : state.injuriesVisitante) || [];
    if (!arr.length) {
      listEl.innerHTML = `<li class="scorer-summary-empty">Sin lesiones.</li>`;
      return;
    }

    const managerNick = side === 'local'
      ? (state.localManagerNick || '')
      : (state.visitManagerNick || '');

    listEl.innerHTML = arr.map(p => `
        <li class="scorer-summary-item">
          <span class="scorer-summary-balls">🩹</span>
          <span class="scorer-summary-name">${escapeHtml(p.name)}</span>
          ${managerNick ? `<span class="scorer-summary-club">(${escapeHtml(managerNick)})</span>` : ''}
        </li>
      `).join('');
  };

  renderSide('local');
  renderSide('visitante');
};

const fillScorersSelects = (sectionEl, state) => {
  if (!sectionEl || !state) return;

  const fill = (side, players) => {
    const sel = sectionEl.querySelector(`select[data-side="${side}"]`);
    if (!sel) return;
    sel.innerHTML = `
        <option value="">Añadir goleador…</option>
        <option value="-1">Gol en propia</option>
        ${players.map(p => `
          <option value="${escapeHtml(p.player_id)}">
            ${escapeHtml(p.name)} (${p.totalGoals} gol${p.totalGoals === 1 ? '' : 'es'})
          </option>
        `).join('')}
      `;
  };

  fill('local', state.playersLocal || []);
  fill('visitante', state.playersVisitante || []);
};

const initScorersEditor = async (matchId, meta) => {
  if (!bodyEl) return;
  const section = bodyEl.querySelector('.scorers-editor');
  if (!section) return;

  const statusEl = section.querySelector('.scorers-status');
  const saveBtn = section.querySelector('.btn-save-scorers');
  const editPanel = section.querySelector('.scorers-edit-panel');
  const toggleBtn = section.querySelector('.btn-toggle-scorers-edit');

  if (statusEl) statusEl.textContent = 'Cargando goleadores...';

  const state = await loadScorerStateForMatch(meta);
  if (!state) {
    if (statusEl) statusEl.textContent = 'No se pudo cargar el editor de goleadores.';
    return;
  }

  fillScorersSelects(section, state);
  renderSideScorersList(section, 'local', state);
  renderSideScorersList(section, 'visitante', state);
  renderScorersSummary(section, state);

  if (statusEl) statusEl.textContent = '';

  if (editPanel) editPanel.hidden = true;
  if (toggleBtn) {
    toggleBtn.textContent = 'Editar goleadores';
    toggleBtn.addEventListener('click', () => {
      if (!editPanel) return;
      const isHidden = editPanel.hidden;
      editPanel.hidden = !isHidden;
      toggleBtn.textContent = isHidden ? 'Cerrar edición' : 'Editar goleadores';
    });
  }

  section.querySelectorAll('.btn-add-goal').forEach(btn => {
    btn.addEventListener('click', () => {
      const side = btn.getAttribute('data-side');
      const sel = section.querySelector(`select[data-side="${side}"]`);
      if (!sel) return;
      const value = sel.value;
      if (!value) return;

      const res = addGoalToState(matchId, side, value);
      if (res.success) {
        const st = getScorerState(matchId);
        renderSideScorersList(section, side, st);
        renderScorersSummary(section, st);
      } else {
        alert(res.error || 'No se pudo añadir gol');
      }
    });
  });

  section.addEventListener('click', (e) => {
    const target = e.target;
    const matchState = getScorerState(matchId);
    if (!matchState) return;

    const btnPlus = target.closest && target.closest('.btn-plus-goal');
    const btnMinus = target.closest && target.closest('.btn-minus-goal');
    const btnRem = target.closest && target.closest('.btn-remove-scorer');

    if (btnPlus || btnMinus || btnRem) {
      e.preventDefault();
      const side = target.getAttribute('data-side') ||
        (target.closest('.scorers-col') && target.closest('.scorers-col').getAttribute('data-side'));
      const pid = target.getAttribute('data-player-id');
      if (!side || !pid) return;

      if (btnPlus) {
        const res = changeGoalCount(matchId, side, pid, +1);
        if (!res.success) alert(res.error || 'Error al cambiar goles');
      } else if (btnMinus) {
        changeGoalCount(matchId, side, pid, -1);
      } else if (btnRem) {
        removeScorer(matchId, side, pid);
      }

      renderSideScorersList(section, 'local', matchState);
      renderSideScorersList(section, 'visitante', matchState);
      renderScorersSummary(section, matchState);
    }
  });

  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      if (statusEl) statusEl.textContent = 'Guardando goleadores...';
      saveBtn.disabled = true;
      try {
        const res = await saveScorersToSupabase(matchId);
        if (statusEl) statusEl.textContent = res.msg || '';

        // ⚠️ RATINGS RANKED: Actualizados automáticamente por trigger SQL
        // El trigger 'trigger_update_ranked_ratings' en la tabla matches
        // actualiza automáticamente los ratings cuando se completa un partido ranked.
        // No es necesario llamar a updateRatingsAfterMatch() manualmente.

        const st = getScorerState(matchId);
        renderScorersSummary(section, st);
        if (editPanel && toggleBtn) {
          editPanel.hidden = true;
          toggleBtn.textContent = 'Editar goleadores';
        }
      } finally {
        saveBtn.disabled = false;
      }
    });
  }
};

// --- Red Cards ---

const renderRedCardsList = (sectionEl, side, state) => {
  if (!sectionEl || !state) return;
  const listEl = sectionEl.querySelector(`.redcards-list[data-side="${side}"]`);
  if (!listEl) return;

  const arr = (side === 'local' ? state.redLocal : state.redVisitante) || [];
  if (!arr.length) {
    listEl.innerHTML = `<li class="scorer-empty">Sin tarjetas rojas.</li>`;
    return;
  }

  listEl.innerHTML = arr.map(p => `
      <li class="scorer-item" data-player-id="${p.player_id}">
        <span class="scorer-name">${escapeHtml(p.name)}</span>
        <button type="button" class="btn-remove-red" data-player-id="${p.player_id}" data-side="${side}">✕</button>
      </li>
    `).join('');
};

const fillRedCardsSelects = (sectionEl, state) => {
  if (!sectionEl || !state) return;
  const fill = (side, allPlayers, currentRedPlayers) => {
    const sel = sectionEl.querySelector(`select[data-side="${side}"]`);
    if (!sel) return;
    const currentIds = new Set(currentRedPlayers.map(p => p.player_id));
    const available = allPlayers.filter(p => !currentIds.has(p.player_id));
    sel.innerHTML = `
        <option value="">Añadir jug. con roja…</option>
        ${available.map(p => `
          <option value="${escapeHtml(p.player_id)}">${escapeHtml(p.name)}</option>
        `).join('')}
      `;
  };
  fill('local', state.playersLocal || [], state.redLocal || []);
  fill('visitante', state.playersVisitante || [], state.redVisitante || []);
};

const initRedCardsEditor = async (matchId, meta) => {
  if (!bodyEl) return;
  const section = bodyEl.querySelector('.redcards-editor');
  if (!section) return;

  const statusEl = section.querySelector('.redcards-status');
  const saveBtn = section.querySelector('.btn-save-redcards');

  const state = await loadScorerStateForMatch(meta);
  if (!state) {
    if (statusEl) statusEl.textContent = 'Error cargando datos.';
    return;
  }

  const refreshUI = () => {
    fillRedCardsSelects(section, state);
    renderRedCardsList(section, 'local', state);
    renderRedCardsList(section, 'visitante', state);
    renderRedCardsSummary(section, state);
  };

  refreshUI();

  section.querySelectorAll('.btn-add-red').forEach(btn => {
    btn.addEventListener('click', () => {
      const side = btn.getAttribute('data-side');
      const sel = section.querySelector(`select[data-side="${side}"]`);
      if (!sel) return;
      const val = sel.value;
      if (!val) return;
      addRedCardToState(matchId, side, val);
      refreshUI();
    });
  });

  section.addEventListener('click', (e) => {
    const target = e.target;
    const btnRem = target.closest && target.closest('.btn-remove-red');
    if (btnRem) {
      e.preventDefault();
      const side = btnRem.getAttribute('data-side');
      const pid = btnRem.getAttribute('data-player-id');
      if (side && pid) {
        removeRedCardFromState(matchId, side, pid);
        refreshUI();
      }
    }
  });

  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      if (statusEl) statusEl.textContent = 'Guardando...';
      saveBtn.disabled = true;
      try {
        const res = await saveRedCardsFull(matchId);
        if (statusEl) statusEl.textContent = res.msg || '';
        const st = getScorerState(matchId);
        renderRedCardsSummary(section, st);
      } finally {
        saveBtn.disabled = false;
      }
    });
  }
};

// --- Injuries ---

const renderInjuriesList = (sectionEl, side, state) => {
  if (!sectionEl || !state) return;
  const listEl = sectionEl.querySelector(`.injuries-list[data-side="${side}"]`);
  if (!listEl) return;

  const arr = (side === 'local' ? state.injuriesLocal : state.injuriesVisitante) || [];
  if (!arr.length) {
    listEl.innerHTML = `<li class="scorer-empty">Sin lesiones.</li>`;
    return;
  }

  listEl.innerHTML = arr.map(p => `
      <li class="scorer-item" data-player-id="${p.player_id}">
        <span class="scorer-name">${escapeHtml(p.name)}</span>
        <button type="button" class="btn-remove-injury" data-player-id="${p.player_id}" data-side="${side}">✕</button>
      </li>
    `).join('');
};

const fillInjuriesSelects = (sectionEl, state) => {
  if (!sectionEl || !state) return;
  const fill = (side, allPlayers, currentInjured) => {
    const sel = sectionEl.querySelector(`select[data-side="${side}"]`);
    if (!sel) return;
    const currentIds = new Set(currentInjured.map(p => p.player_id));
    const available = allPlayers.filter(p => !currentIds.has(p.player_id));
    sel.innerHTML = `
        <option value="">Añadir lesionado…</option>
        ${available.map(p => `
          <option value="${escapeHtml(p.player_id)}">${escapeHtml(p.name)}</option>
        `).join('')}
      `;
  };
  fill('local', state.playersLocal || [], state.injuriesLocal || []);
  fill('visitante', state.playersVisitante || [], state.injuriesVisitante || []);
};

const initInjuriesEditor = async (matchId, meta) => {
  if (!bodyEl) return;
  const section = bodyEl.querySelector('.injuries-editor');
  if (!section) return;

  const statusEl = section.querySelector('.injuries-status');
  const saveBtn = section.querySelector('.btn-save-injuries');

  const state = await loadScorerStateForMatch(meta);
  if (!state) {
    if (statusEl) statusEl.textContent = 'Error cargando datos.';
    return;
  }

  const refreshUI = () => {
    fillInjuriesSelects(section, state);
    renderInjuriesList(section, 'local', state);
    renderInjuriesList(section, 'visitante', state);
    renderInjuriesSummary(section, state);
  };

  refreshUI();

  section.querySelectorAll('.btn-add-injury').forEach(btn => {
    btn.addEventListener('click', () => {
      const side = btn.getAttribute('data-side');
      const sel = section.querySelector(`select[data-side="${side}"]`);
      if (!sel) return;
      const val = sel.value;
      if (!val) return;
      addInjuryToState(matchId, side, val);
      refreshUI();
    });
  });

  section.addEventListener('click', (e) => {
    const target = e.target;
    const btnRem = target.closest && target.closest('.btn-remove-injury');
    if (btnRem) {
      e.preventDefault();
      const side = btnRem.getAttribute('data-side');
      const pid = btnRem.getAttribute('data-player-id');
      if (side && pid) {
        removeInjuryFromState(matchId, side, pid);
        refreshUI();
      }
    }
  });

  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      if (statusEl) statusEl.textContent = 'Guardando...';
      saveBtn.disabled = true;
      try {
        const res = await saveInjuriesFull(matchId);
        if (statusEl) statusEl.textContent = res.msg || '';
        const st = getScorerState(matchId);
        renderInjuriesSummary(section, st);
      } finally {
        saveBtn.disabled = false;
      }
    });
  }
};

// -----------------------------
// Ratings Upload Handler
// -----------------------------

const initRatingsUpload = (matchId, meta) => {
  if (!bodyEl || !matchId) return;
  
  const uploadBtn = bodyEl.querySelector('.upload-ratings-btn');
  const fileInput = bodyEl.querySelector('.ratings-file-input');
  
  if (!uploadBtn || !fileInput) return;
  
  uploadBtn.addEventListener('click', () => {
    fileInput.click();
  });
  
  fileInput.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    
    // Importar función de subida desde resultados.js
    try {
      // La función se definirá en resultados.js y se exportará
      // Por ahora, usaremos un evento personalizado para comunicarnos
      const uploadEvent = new CustomEvent('uploadRatingsImage', {
        detail: { matchId, file, buttonEl: uploadBtn, meta }
      });
      document.dispatchEvent(uploadEvent);
    } catch (err) {
      console.error('Error subiendo imagen de valoraciones:', err);
      alert('No se ha podido subir la imagen. Inténtalo de nuevo.');
    }
  });
};
