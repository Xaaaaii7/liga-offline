import {
    fmtDate,
    isNum,
    escapeHtml
} from './utils.js';

import { getCrestOrLogo } from './manager-crests.js';
import { getSupabaseClient, usePglite } from './supabase-client.js';

// Simula (o re-simula) un partido IA-vs-IA. En Tauri/PWA (PGlite) corre el
// motor en el navegador y aplica el SQL directamente contra PGlite; con backend
// Node usa los endpoints /api/simulate y /api/resimulate del server.
async function runSimulate(uuid, { resimulate = false } = {}) {
    if (usePglite()) {
        const [{ simulateMatchToSql }, { getPgliteDb, flushPglitePersist }] = await Promise.all([
            import('./simulate-engine.js'),
            import('./pglite-client.js'),
        ]);
        const db = await getPgliteDb();
        if (resimulate) {
            // Mismo borrado que resimulateMatch() del server.mjs.
            await db.exec(`
                DELETE FROM match_team_stats     WHERE match_uuid = ${uuid};
                DELETE FROM goal_events          WHERE match_uuid = ${uuid};
                DELETE FROM match_red_cards      WHERE match_uuid = ${uuid};
                DELETE FROM match_yellow_cards   WHERE match_uuid = ${uuid};
                DELETE FROM match_substitutions  WHERE match_uuid = ${uuid};
                DELETE FROM match_injuries       WHERE match_uuid = ${uuid};
                DELETE FROM match_player_ratings WHERE match_uuid = ${uuid};
                DELETE FROM player_suspensions   WHERE origin_match_uuid = ${uuid};
                UPDATE matches SET home_goals = NULL, away_goals = NULL, resolved_administratively = false WHERE match_uuid = ${uuid};
            `);
        }
        const sb = await getSupabaseClient();
        const sql = await simulateMatchToSql(sb, uuid);
        await db.exec(sql);
        await flushPglitePersist(); // guardar el snapshot antes de que la app recargue
        return;
    }
    const res = await fetch(resimulate ? '/api/resimulate' : '/api/simulate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ match_uuid: uuid }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
}

// URL safe para usar en href: rechaza javascript: / data: / vbscript:.
const safeUrl = (url) => {
  if (!url) return '#';
  const s = String(url).trim();
  return /^(https?:|\/|\.\/|\.\.\/|#|mailto:)/i.test(s) ? s : '#';
};

import {
    getCityForKey,
    loadSuspensionsForMatches,
    ensureStatsIndex
} from './resultados-data.js';

import {
    fetchWeatherForCity
} from './resultados-utils.js';

// liga-offline: sin subida de foto por OCR (lambda AWS) ni streaming Twitch.
const MATCH_UPLOAD = {
    enabled: false,
    presignEndpoint: 'https://d39ra5ecf4.execute-api.eu-west-1.amazonaws.com/prod/presign-match-upload'
};

export const STREAM_START = {
    enabled: false,
    liveChannelUrl: 'https://d39ra5ecf4.execute-api.eu-west-1.amazonaws.com/prod/live-channel',
    startStreamEndpoint: 'https://d39ra5ecf4.execute-api.eu-west-1.amazonaws.com/prod/start-stream'
};

// Cache de canales en directo (se refresca cada 60s)
let _liveChannelsCache = null;
let _liveChannelsCacheTime = 0;
const LIVE_CHANNELS_TTL = 60_000; // 60s

export async function fetchLiveChannelsSet() {
    const now = Date.now();
    if (_liveChannelsCache && (now - _liveChannelsCacheTime) < LIVE_CHANNELS_TTL) {
        return _liveChannelsCache;
    }
    try {
        const res = await fetch(STREAM_START.liveChannelUrl, { cache: 'no-store' });
        if (!res.ok) return _liveChannelsCache || new Set();
        const data = await res.json();
        const channels = (data?.channels || []).map(ch => ch.toLowerCase());
        _liveChannelsCache = new Set(channels);
        _liveChannelsCacheTime = now;
        return _liveChannelsCache;
    } catch {
        return _liveChannelsCache || new Set();
    }
}

function isStreamLive(streamUrl, liveChannels) {
    if (!streamUrl || !liveChannels.size) return false;
    // Extraer canal de la URL: https://www.twitch.tv/{channel}
    try {
        const url = new URL(streamUrl);
        const channel = url.pathname.replace(/^\//, '').toLowerCase();
        return liveChannels.has(channel);
    } catch {
        return false;
    }
}

export const renderJornada = async (jornadas, num, jornadaWrap, labelEl, currentNavCallback, isAdmin = false, isRanked = false) => {
    const j = jornadas.find(x => x.numero === num);
    if (!j) {
        jornadaWrap.innerHTML = `<p class="hint">No se ha encontrado la jornada ${escapeHtml(num)}.</p>`;
        return;
    }

    const labelParts = [`Jornada ${j.numero}`];
    if (j.fecha) labelParts.push(fmtDate(j.fecha));
    if (labelEl) labelEl.textContent = labelParts.join(' · ');

    const partidos = j.partidos || [];
    if (!partidos.length) {
        jornadaWrap.innerHTML = `<p class="hint">Esta jornada no tiene partidos definidos.</p>`;
        return;
    }

    // Slug de competición para links de apuestas (comp de la URL actual)
    const compSlugForLinks = new URLSearchParams(window.location.search).get('comp') || '';

    // Cargar índice de stats + set de equipos controlados por humano.
    // Offline: sin quiniela (manager-predictions) ni canales Twitch en directo.
    const competitionId = partidos[0]?.competition_id || null;
    let statsIndex = {};
    const liveChannels = new Set();
    const predsSummary = new Map();
    let humanTeamIds = new Set();
    try {
        const [si, humans] = await Promise.all([
            ensureStatsIndex(competitionId).catch(() => ({})),
            (async () => {
                if (!competitionId) return new Set();
                const supa = await getSupabaseClient();
                const { data } = await supa
                    .from('league_teams')
                    .select('id, is_human_controlled')
                    .eq('competition_id', competitionId)
                    .eq('is_human_controlled', true);
                return new Set((data || []).map(t => t.id));
            })().catch(() => new Set()),
        ]);
        statsIndex = si;
        humanTeamIds = humans;
    } catch (err) {
        console.warn('Error cargando stats/equipos humanos:', err);
    }

    const cardsHtml = partidos.map((p, idx) => {
        const pid = p.id || `J${j.numero}-P${idx + 1}`;
        const gl = isNum(p.goles_local) ? p.goles_local : null;
        const gv = isNum(p.goles_visitante) ? p.goles_visitante : null;
        const marcador = (gl !== null && gv !== null) ? `${gl} – ${gv}` : '-';
        const jugado = (gl !== null && gv !== null);

        let chipText = '';
        let chipClass = '';
        if (jugado) {
            if (gl > gv) {
                chipText = 'Victoria local';
                chipClass = 'chip chip-pos';
            } else if (gl < gv) {
                chipText = 'Victoria visitante';
                chipClass = 'chip chip-neg';
            } else {
                chipText = 'Empate';
                chipClass = 'chip';
            }
        }
        const chipHTML = chipText
            ? `<span class="result-chip ${chipClass}">${chipText}</span>`
            : '';

        const matchIsLive = !jugado && isStreamLive(p.stream, liveChannels);
        const liveChipHTML = matchIsLive
            ? '<span class="chip chip-live">EN DIRECTO</span>'
            : '';

        const pidSafe = escapeHtml(pid);
        const localSafe = escapeHtml(p.local);
        const visitanteSafe = escapeHtml(p.visitante);

        // Stream → icono pequeño integrado en el slot derecho (no fila inferior).
        const streamIconHTML = p.stream
            ? `<a class="result-mini-icon ${matchIsLive ? 'is-live' : ''}"
                href="${escapeHtml(safeUrl(p.stream))}"
                target="_blank"
                rel="noopener noreferrer"
                title="${matchIsLive ? 'Ver directo' : 'Ver VOD'}"
                aria-label="${matchIsLive ? 'Ver directo' : 'Ver VOD'}"
                onclick="event.stopPropagation()">${matchIsLive ? '🔴' : '📺'}</a>`
            : '';

        const uploadHTML = (isAdmin && MATCH_UPLOAD.enabled)
            ? `<div class="result-upload">
             <button type="button"
                     class="upload-photo-btn"
                     data-partido-id="${pidSafe}">
               Subir imagen
             </button>
           </div>`
            : '';

        const resultEditScoreHTML = (isRanked && !jugado)
            ? `<div class="result-edit-score">
             <div>
               <input type="number" min="0" data-side="local" placeholder="0" aria-label="Goles ${localSafe}">
               <span>–</span>
               <input type="number" min="0" data-side="visitante" placeholder="0" aria-label="Goles ${visitanteSafe}">
               <button type="button" class="btn-save-result-card" data-partido-id="${pidSafe}">Guardar resultado</button>
               <span class="result-edit-score-status" aria-live="polite"></span>
             </div>
           </div>`
            : '';

        const streamStartHTML = (STREAM_START.enabled && !jugado)
            ? `<div class="result-stream-start">
             <button type="button" class="start-stream-btn" data-partido-id="${pidSafe}">
               Iniciar stream
             </button>
           </div>`
            : '';

        // liga-offline: en un partido no jugado de un equipo humano, botón para
        // registrar el resultado a mano (entrar-resultado.html). Los partidos
        // IA-vs-IA se resolverán con el botón "simular jornada" (pendiente).
        const esHumano = humanTeamIds.has(p.local_team_id) || humanTeamIds.has(p.visitante_team_id);
        const registrarHTML = (!jugado && esHumano && p.match_uuid)
            ? `<a class="btn btn-sm btn-primary result-registrar" href="entrar-resultado.html?match=${p.match_uuid}&comp=${encodeURIComponent(compSlugForLinks)}" onclick="event.stopPropagation()">Registrar resultado</a>`
            : '';

        // Partido de humano YA jugado → editar el resultado (el mismo formulario
        // carga los datos actuales y permite corregirlos).
        const editarHTML = (jugado && esHumano && p.match_uuid)
            ? `<a class="btn btn-sm btn-outline result-editar" href="entrar-resultado.html?match=${p.match_uuid}&comp=${encodeURIComponent(compSlugForLinks)}" onclick="event.stopPropagation()">✏️ Editar resultado</a>`
            : '';

        // Partido IA-vs-IA no jugado → botón simular (llama a /api/simulate).
        const simularHTML = (!jugado && !esHumano && p.match_uuid)
            ? `<button type="button" class="btn btn-sm btn-secondary result-simular" data-match-uuid="${p.match_uuid}" onclick="event.stopPropagation()">🤖 Simular</button>`
            : '';

        // Partido IA-vs-IA YA jugado → botón re-simular (vuelve a tirar el resultado).
        const resimularHTML = (jugado && !esHumano && p.match_uuid)
            ? `<button type="button" class="btn btn-sm btn-outline result-resimular" data-match-uuid="${p.match_uuid}" onclick="event.stopPropagation()">🔄 Re-simular</button>`
            : '';

        const cityName = getCityForKey(p.local);
        const meteoPlaceholder = cityName
            ? `<div class="result-meteo muted"
                 data-city="${escapeHtml(cityName)}"
                 data-partido-id="${pidSafe}">
             Meteo cargando…
           </div>`
            : '';

        // Pill de quiniela (solo winner_1x2). El total y los porcentajes son
        // pronósticos 1X2; las apuestas de marcador exacto / scorer NO entran
        // aquí (son tipos distintos, se ven solo en partido.html tab Apuestas).
        const predSummary = predsSummary.get(p.match_uuid);
        let predsPillHTML = '';
        if (predSummary && predSummary.total > 0) {
            const linkBase = `partido.html?comp=${encodeURIComponent(compSlugForLinks)}&match=${pidSafe}&tab=apuestas`;
            const totalLabel = `${predSummary.total} pronóstico${predSummary.total === 1 ? '' : 's'} 1X2`;
            if (jugado) {
                const tag = predSummary.resolved
                    ? `${predSummary.hits}/${predSummary.resolved} aciertos`
                    : 'sin resolver';
                predsPillHTML = `<a class="result-preds-pill result-preds-pill-played" href="${linkBase}" title="Quiniela del grupo · ${totalLabel}" onclick="event.stopPropagation()">
                  <span class="rpp-icon" aria-hidden="true">🎲</span>
                  <span class="rpp-text">${predSummary.total} apuesta${predSummary.total === 1 ? '' : 's'} · ${tag}</span>
                </a>`;
            } else {
                const pct = (n) => Math.round((n / predSummary.total) * 100);
                const pH = pct(predSummary.home), pX = pct(predSummary.draw), pA = pct(predSummary.away);
                predsPillHTML = `<a class="result-preds-pill" href="${linkBase}" title="Quiniela del grupo · ${totalLabel}" onclick="event.stopPropagation()">
                  <span class="rpp-icon" aria-hidden="true">🎲</span>
                  <span class="rpp-bar">
                    <span class="rpp-seg rpp-seg-1" style="width:${pH}%"></span>
                    <span class="rpp-seg rpp-seg-x" style="width:${pX}%"></span>
                    <span class="rpp-seg rpp-seg-2" style="width:${pA}%"></span>
                  </span>
                  <span class="rpp-text">${pH}%·<b>1</b> ${pX}%·<b>X</b> ${pA}%·<b>2</b></span>
                </a>`;
            }
        }

        const arbitroDisplayName = p.arbitro_nombre || p.arbitro_mote;
        const arbitroChip = (p.arbitro_id && arbitroDisplayName)
            ? `<a class="result-referee"
                  href="arbitro.html?id=${p.arbitro_id}"
                  title="Ver ficha del árbitro"
                  onclick="event.stopPropagation()">
                 <span class="result-referee-icon" aria-hidden="true">⚖️</span>
                 <span class="result-referee-name">${escapeHtml(arbitroDisplayName)}</span>
               </a>`
            : '';

        // Verificar si faltan goleadores (solo si NO es administrativo y está jugado)
        const missingHome = p.missing_home_scorers || 0;
        const missingAway = p.missing_away_scorers || 0;
        const hasMissingScorers = jugado && 
                                   !p.resolved_administratively && 
                                   (missingHome > 0 || missingAway > 0);
        
        const missingScorersTotal = (missingHome || 0) + (missingAway || 0);
        const missingScorersBadge = hasMissingScorers
            ? `<span class="result-mini-badge result-mini-badge-warn" title="Faltan goleadores${missingHome > 0 ? ` · ${localSafe}: ${missingHome}` : ''}${missingAway > 0 ? ` · ${visitanteSafe}: ${missingAway}` : ''}">⚠ ${missingScorersTotal} goles</span>`
            : '';

        // Verificar si hay estadísticas de equipo para mostrar el enlace "Ver estadísticas"
        const matchStats = statsIndex[pid] || {};
        const localTeamId = p.local_team_id;
        const visitTeamId = p.visitante_team_id;
        const localStats = localTeamId && matchStats[`_team_id_${localTeamId}`]
            ? matchStats[`_team_id_${localTeamId}`]
            : (matchStats[p.local] || {});
        const visitStats = visitTeamId && matchStats[`_team_id_${visitTeamId}`]
            ? matchStats[`_team_id_${visitTeamId}`]
            : (matchStats[p.visitante] || {});
        const hasStats = (Object.keys(localStats).length > 0 || Object.keys(visitStats).length > 0);

        // Mostrar aviso solo si el partido está jugado y no tiene ningún rating
        const hasRatings = p.has_ratings || false;
        const missingRatingsBadge = (jugado && !hasRatings && p.match_uuid)
            ? `<span class="result-mini-badge result-mini-badge-info" title="Faltan estadísticas de jugadores">📊 sin notas</span>`
            : '';

        // Slot izquierdo: chip mínimo (FIN / EN VIVO / día + hora).
        const horaCorta = p.hora ? String(p.hora).slice(0, 5) : '';
        const fechaISO = p.fecha || j.fecha || null;
        const fechaDate = fechaISO ? new Date(fechaISO) : null;
        const fechaCorta = (fechaDate && !isNaN(fechaDate))
            ? fechaDate.toLocaleDateString('es-ES', { weekday: 'short', day: '2-digit', month: 'short' })
            : '';
        let slotIzqContent;
        if (jugado) slotIzqContent = '<span class="result-row-status-mini played">FIN</span>';
        else if (matchIsLive) slotIzqContent = '<span class="chip chip-live result-row-live">EN VIVO</span>';
        else if (horaCorta || fechaCorta) {
            slotIzqContent =
                (fechaCorta ? `<span class="result-row-date">${escapeHtml(fechaCorta)}</span>` : '') +
                (horaCorta ? `<span class="result-row-time">${escapeHtml(horaCorta)}</span>` : '');
        }
        else slotIzqContent = '';
        const slotIzqHTML = `<div class="result-row-slot-time">${slotIzqContent}</div>`;

        // Slot derecho: chip resultado + badges + icono stream + Detalles
        const slotDerHTML = `
          <div class="result-row-slot-actions">
            ${chipHTML}
            ${missingScorersBadge}
            ${missingRatingsBadge}
            ${streamIconHTML}
            ${hasStats ? '<span class="result-link">Detalles ▸</span>' : ''}
          </div>
        `;

        return `
        <article class="result-row ${jugado ? 'result-played' : 'result-pending'}">
          <button class="result-row-main partido-card"
                  data-partido-id="${pidSafe}"
                  aria-label="Ver estadísticas del partido">
            ${slotIzqHTML}
            <div class="result-row-teams">
              <div class="result-row-team home">
                <span class="result-row-team-name">${localSafe}</span>
                <img class="result-row-badge" src="${escapeHtml(getCrestOrLogo(p.local, p.season))}"
                     alt="Escudo ${localSafe}"
                     onerror="this.style.visibility='hidden'">
              </div>
              <span class="result-row-score">${marcador}</span>
              <div class="result-row-team away">
                <img class="result-row-badge" src="${escapeHtml(getCrestOrLogo(p.visitante, p.season))}"
                     alt="Escudo ${visitanteSafe}"
                     onerror="this.style.visibility='hidden'">
                <span class="result-row-team-name">${visitanteSafe}</span>
              </div>
            </div>
            ${slotDerHTML}
          </button>
          ${(meteoPlaceholder || arbitroChip || predsPillHTML)
            ? `<div class="result-row-extras">${meteoPlaceholder}${arbitroChip}${predsPillHTML}</div>`
            : ''}
          ${uploadHTML || resultEditScoreHTML || streamStartHTML || registrarHTML || editarHTML || simularHTML || resimularHTML
            ? `<div class="result-row-actions-row">${uploadHTML}${resultEditScoreHTML}${streamStartHTML}${registrarHTML}${editarHTML}${simularHTML}${resimularHTML}</div>`
            : ''}
        </article>
      `;
    }).join('');

    jornadaWrap.innerHTML = `
      <section class="results-list">
        ${cardsHtml}
      </section>
    `;

    // Botones "Simular" (partidos IA-vs-IA) → endpoint /api/simulate del
    // server.mjs (la simulación corre en Node), luego recarga para ver el
    // resultado. Simula por match_uuid (matches.id no es único entre ligas).
    jornadaWrap.querySelectorAll('.result-simular').forEach(btn => {
        btn.addEventListener('click', async () => {
            const uuid = Number(btn.dataset.matchUuid);
            if (!uuid) return;
            const prev = btn.textContent;
            btn.disabled = true;
            btn.textContent = 'Simulando…';
            try {
                await runSimulate(uuid);
                window.location.reload();
            } catch (e) {
                console.error('Error simulando:', e);
                btn.disabled = false;
                btn.textContent = prev;
                alert('No se pudo simular el partido: ' + e.message);
            }
        });
    });

    // Botones "Re-simular" (partidos IA-vs-IA ya jugados) → /api/resimulate:
    // borra el resultado y los eventos y vuelve a tirar el partido.
    jornadaWrap.querySelectorAll('.result-resimular').forEach(btn => {
        btn.addEventListener('click', async () => {
            const uuid = Number(btn.dataset.matchUuid);
            if (!uuid) return;
            if (!confirm('¿Re-simular este partido? Se descartará el resultado actual y sus eventos.')) return;
            const prev = btn.textContent;
            btn.disabled = true;
            btn.textContent = 'Re-simulando…';
            try {
                await runSimulate(uuid, { resimulate: true });
                window.location.reload();
            } catch (e) {
                console.error('Error re-simulando:', e);
                btn.disabled = false;
                btn.textContent = prev;
                alert('No se pudo re-simular el partido: ' + e.message);
            }
        });
    });

    // Meteo async — la query usa data-partido-id (en el propio .result-meteo)
    // porque el placeholder vive fuera del .partido-card en la nueva fila estirada.
    partidos.forEach((p, idx) => {
        const cityName = getCityForKey(p.local);
        if (!cityName) return;

        const pid = p.id || `J${j.numero}-P${idx + 1}`;
        const meteoEl = jornadaWrap.querySelector(`.result-meteo[data-partido-id="${CSS.escape(String(pid))}"]`);
        if (!meteoEl) return;

        fetchWeatherForCity(cityName)
            .then(cat => {
                if (currentNavCallback && currentNavCallback() !== num) return;
                // Si no hay datos (geo falló, red caída, etc.) escondemos el placeholder
                // en vez de dejarlo en "Cargando…".
                if (!cat) {
                    meteoEl.remove();
                    return;
                }
                meteoEl.textContent = `${cat.emoji} ${cat.label} · ${cityName}`;
            })
            .catch(() => {
                if (meteoEl && meteoEl.isConnected) meteoEl.remove();
            });
    });

    // Suspensions
    // assuming hasSupabase is true if this module is loaded/used properly
    if (partidos.length > 0) {
        loadSuspensionsForMatches(partidos)
            .then(suspensionsMap => {
                if (currentNavCallback && currentNavCallback() !== num) return;

                Object.keys(suspensionsMap).forEach(mId => {
                    const cardBtn = jornadaWrap.querySelector(`.partido-card[data-partido-id="${mId}"]`);
                    if (!cardBtn) return;
                    const susList = suspensionsMap[mId];
                    if (!susList || !susList.length) return;

                    // La fila modernizada ya no tiene `.result-status-line`; colgamos
                    // las sanciones del propio `.result-row` (article contenedor).
                    const row = cardBtn.closest('.result-row') || cardBtn.parentNode;
                    if (!row) return;

                    // Check if suspensions already exist to prevent duplicates
                    const existing = row.querySelector('.result-suspensions');
                    if (existing) return;

                    const div = document.createElement('div');
                    div.className = 'result-suspensions';
                    div.style.padding = '0 16px 12px';
                    div.style.fontSize = '0.8rem';
                    div.style.color = '#ef4444';

                    const sancionados = susList.filter(s => s.reason === 'red_card' || !s.reason);
                    const lesionados = susList.filter(s => s.reason === 'injury');

                    let html = '';
                    if (sancionados.length) {
                        const names = sancionados.map(s => `${escapeHtml(s.playerName)} (${escapeHtml(s.teamName)})`).join(', ');
                        html += `<div style="color:#ef4444"><strong>Sancionados:</strong> ${names}</div>`;
                    }
                    if (lesionados.length) {
                        const names = lesionados.map(s => `${escapeHtml(s.playerName)} (${escapeHtml(s.teamName)})`).join(', ');
                        html += `<div style="color:#f59e0b"><strong>Lesionados:</strong> ${names}</div>`;
                    }
                    div.innerHTML = html;
                    // Insertar dentro de la fila, justo tras el botón principal (y
                    // antes de extras/acciones si las hay queda igual de visible).
                    row.appendChild(div);
                });
            })
            .catch(err => console.warn('Error loading suspensions', err));
    }
};
