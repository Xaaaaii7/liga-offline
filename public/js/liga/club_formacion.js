// js/club_formacion.js
import {
  FORMATION_TEMPLATES,
  DEFAULT_SYSTEM,
  groupFromPosition,
  resolveClubIdFromNickname,
  resolveLeagueTeamIdFromNickname,
  loadSquadForClub,
  calculateAndLoadFormationForClub
} from '../modules/formation.js';
import { getSupabaseConfig } from '../modules/supabase-client.js';
import { getCompetitionFromURL, getCurrentCompetitionSlug } from '../modules/competition-context.js';
import { getCompetitionBySlug } from '../modules/competition-data.js';
import { playerLink, escapeHtml, logoPath } from '../modules/utils.js';

(async () => {
  const CLUB = window.CLUB_NAME;
  const root = document.getElementById("tab-formacion");

  if (!CLUB || !root) return;

  // --- Obtener contexto de competición ---
  let competitionId = null;
  try {
    const competitionSlug = getCompetitionFromURL() || await getCurrentCompetitionSlug();
    if (competitionSlug) {
      const competition = await getCompetitionBySlug(competitionSlug);
      if (competition) {
        competitionId = competition.id;
      }
    }
  } catch (e) {
    console.warn('Error obteniendo contexto de competición:', e);
    // Continuar sin filtro de competición (compatibilidad hacia atrás)
  }

  // ==========================
  //  ESTADO EN MEMORIA
  // ==========================
  let state = {
    clubId: null, // Para cargar squad (jugadores del club)
    leagueTeamId: null, // Para cargar/guardar formación (equipo del usuario)
    squad: [],
    system: DEFAULT_SYSTEM,
    slots: new Map(), // slot_index -> player_id (o null)
    formationId: null,
    editMode: false,
    season: null, // Storing season here for consistency
    competitionId: null // Storing competitionId for saves
  };

  function findPlayerName(playerId) {
    if (!playerId) return "";
    const p = state.squad.find(x => x.id === playerId);
    return p ? p.name : "";
  }

  // ==========================
  //  RENDER: pitch vertical (bloque 6c)
  // ==========================
  function shortName(n) {
    if (!n) return '?';
    const parts = String(n).trim().split(/\s+/);
    return parts.length === 1 ? parts[0] : parts[parts.length - 1];
  }

  function renderFormationView() {
    const system = state.system || DEFAULT_SYSTEM;
    const template = FORMATION_TEMPLATES[system] || FORMATION_TEMPLATES[DEFAULT_SYSTEM];
    const crestUrl = logoPath(CLUB);

    // 1) Resolver players asignados (state.slots: Map slot_index -> player_id)
    //    y agruparlos por su LÍNEA NATURAL (groupFromPosition), ignorando
    //    el slot_index del DB porque a veces deja un MC en hueco DEF, etc.
    const byLine = { POR: [], DEF: [], MC: [], DEL: [] };
    const orphans = [];
    state.slots.forEach((playerId) => {
      if (!playerId) return;
      const player = state.squad.find(p => p.id === playerId);
      if (!player) return;
      const line = groupFromPosition(player.position);
      if (line && byLine[line]) byLine[line].push(player);
      else orphans.push(player);
    });

    // 2) Asignar a los slots del template emparejando por línea
    const assigned = template.map(slot => {
      const pool = byLine[slot.line];
      return { slot, player: pool && pool.length ? pool.shift() : null };
    });

    // 3) Overflow: lo que sobre (línea con más jugadores de lo esperado u
    //    orphans) rellena slots vacíos.
    const overflow = [...byLine.POR, ...byLine.DEF, ...byLine.MC, ...byLine.DEL, ...orphans];
    if (overflow.length) {
      assigned.forEach(entry => {
        if (!entry.player && overflow.length) entry.player = overflow.shift();
      });
    }

    const slotsHtml = assigned.map(({ slot, player }) => {
      if (!player) {
        return `
          <div class="club-formation-pitch-slot club-formation-pitch-slot--empty" style="left:${slot.x}%;top:${slot.y}%">
            <div class="club-formation-pitch-empty">${escapeHtml(slot.line)}</div>
          </div>
        `;
      }
      const nameSafe = escapeHtml(shortName(player.name));
      return `
        <div class="club-formation-pitch-slot" style="left:${slot.x}%;top:${slot.y}%">
          <img class="club-formation-pitch-badge" src="${escapeHtml(crestUrl)}" alt="" onerror="this.style.visibility='hidden'">
          <div class="club-formation-pitch-name">${playerLink(player.id, nameSafe)}</div>
        </div>
      `;
    }).join('');

    const hasAnyAssigned = state.slots && state.slots.size > 0;
    const hint = hasAnyAssigned
      ? 'Formación calculada automáticamente con los mejores jugadores del equipo.'
      : 'No hay formación calculada todavía.';

    root.innerHTML = `
      <section class="club-formation-section">
        <div class="club-formation-head">
          <h3>Formación</h3>
          <div class="club-formation-system-chip">${escapeHtml(system)}</div>
        </div>
        <div class="club-formation-pitch-wrap">
          <div class="club-formation-pitch">
            <img class="club-formation-pitch-bg" src="img/campo-vertical.png" alt="" onerror="this.src='';this.style.background='#1a4a1f'">
            ${slotsHtml}
          </div>
        </div>
        <p class="club-formation-hint">${hint}</p>
      </section>
    `;
  }

  // ==========================
  //  RENDER: MODO EDICIÓN (ELIMINADO - FORMACIONES SOLO LECTURA)
  // ==========================
  // NOTA: renderFormationEdit() ha sido eliminada porque las formaciones ahora son solo lectura
  // y se calculan automáticamente. Este código se mantiene comentado para referencia.
  /*
  function renderFormationEdit() {
    const system = state.system || DEFAULT_SYSTEM;
    const template = FORMATION_TEMPLATES[system] || FORMATION_TEMPLATES[DEFAULT_SYSTEM];

    // Campo (igual que en vista normal)
    const slotsHtml = template.map(slot => {
      const playerId = state.slots.get(slot.index);
      const name = findPlayerName(playerId) || "";
      const label = name || slot.line;

      return `
        <button
          class="club-formation-slot"
          data-slot="${slot.index}"
          style="top:${slot.y}%;left:${slot.x}%"
        >
          <div>${label}</div>
        </button>
      `;
    }).join("");

    // Options de sistemas
    const systemsOptions = Object.keys(FORMATION_TEMPLATES)
      .map(sys => `<option value="${sys}" ${sys === system ? "selected" : ""}>${sys}</option>`)
      .join("");

    // Preparamos selects por línea (POR / DEF / MC / DEL)
    const groupsOrder = ["POR", "DEF", "MC", "DEL"];
    const groupLabels = {
      POR: "Portero",
      DEF: "Defensas",
      MC: "Mediocampo",
      DEL: "Delanteros"
    };

    const editorGroupsHtml = groupsOrder.map(line => {
      const lineSlots = template.filter(s => s.line === line);
      if (!lineSlots.length) return "";

      // 🔥 NUEVO: Todos los jugadores disponibles en todos los slots
      const eligiblePlayers = state.squad;

      const slotsHtml = lineSlots.map(slot => {
        const currentId = state.slots.get(slot.index) || "";
        const options = [
          `<option value="">(vacío)</option>`,
          ...eligiblePlayers.map(p => `
        <option value="${p.id}" ${String(p.id) === String(currentId) ? "selected" : ""}>
          ${p.name}
        </option>
      `)
        ].join("");

        return `
      <div class="club-formation-editor-slot">
        <span>${slot.line}</span>
        <select data-slot-index="${slot.index}">
          ${options}
        </select>
      </div>
    `;
      }).join("");

      return `
    <div class="club-formation-editor-group">
      <div class="club-formation-editor-group-title">${groupLabels[line] || line}</div>
      ${slotsHtml}
    </div>
  `;
    }).join("");


    root.innerHTML = `
      <div class="club-box" style="grid-column:span 12">
        <h3>Formación</h3>

        <div class="club-formation-wrapper">
          <div class="club-formation-field club-formation-edit" id="formation-field">
            <img src="img/campo-vertical.png" alt="Campo" class="club-formation-bg">
            ${slotsHtml}
          </div>

          <div class="club-formation-editor">
            <div>
              <label for="formation-system-select">Sistema de juego</label>
              <select id="formation-system-select">
                ${systemsOptions}
              </select>
            </div>

            <div class="club-formation-editor-groups">
              ${editorGroupsHtml}
            </div>

            <div class="club-formation-actions">
              <button type="button" id="formation-cancel-btn">Cancelar</button>
              <button type="button" id="formation-save-btn">Guardar</button>
            </div>

            <p class="club-formation-hint">
              En móvil: selecciona el sistema arriba y asigna jugadores en los desplegables. El campo muestra una vista previa.
            </p>
          </div>
        </div>
      </div>
    `;

    // Eventos: cambio de sistema
    const systemSelect = document.getElementById("formation-system-select");
    if (systemSelect) {
      systemSelect.addEventListener("change", () => {
        const newSystem = systemSelect.value;
        if (!FORMATION_TEMPLATES[newSystem]) return;
        state.system = newSystem;
        // al cambiar sistema, reseteamos asignaciones (más simple)
        state.slots = new Map();
        renderFormationEdit();
      });
    }

    // Eventos: cambio de jugador en slot
    root.querySelectorAll("select[data-slot-index]").forEach(sel => {
      sel.addEventListener("change", () => {
        const slotIndex = Number(sel.getAttribute("data-slot-index"));
        const val = sel.value;
        if (!Number.isFinite(slotIndex)) return;
        if (!val) {
          state.slots.delete(slotIndex);
        } else {
          const playerId = Number(val);
          state.slots.set(slotIndex, playerId);
        }
        // solo actualizamos la vista de campo, para no perder focus de selects
        const fieldEl = document.getElementById("formation-field");
        if (fieldEl) {
          const system = state.system || DEFAULT_SYSTEM;
          const template = FORMATION_TEMPLATES[system] || FORMATION_TEMPLATES[DEFAULT_SYSTEM];
          const newSlotsHtml = template.map(slot => {
            const playerId = state.slots.get(slot.index);
            const name = findPlayerName(playerId) || "";
            const label = name || slot.line;
            return `
              <button
                class="club-formation-slot"
                data-slot="${slot.index}"
                style="top:${slot.y}%;left:${slot.x}%"
              >
                <div>${label}</div>
              </button>
            `;
          }).join("");
          fieldEl.innerHTML = `
            <img src="img/campo-vertical.png" alt="Campo" class="club-formation-bg">
            ${newSlotsHtml}
          `;
        }
      });
    });

    // Botones Guardar / Cancelar
    const cancelBtn = document.getElementById("formation-cancel-btn");
    const saveBtn = document.getElementById("formation-save-btn");

    if (cancelBtn) {
      cancelBtn.addEventListener("click", () => {
        state.editMode = false;
        renderFormationView();
      });
    }

    if (saveBtn) {
      saveBtn.addEventListener("click", () => {
        // Call exported save function
        saveFormationToDb(state.leagueTeamId, state.season, state.system, state.slots, state.formationId, state.competitionId)
          .then(res => {
            if (!res.ok) {
              alert(res.msg || "Error al guardar");
              return;
            }
            if (res.formationId) state.formationId = res.formationId;
            state.editMode = false;
            alert(res.msg);
            renderFormationView();
          })
          .catch(err => {
            console.error("Error guardando formación:", err);
            alert("Error inesperado guardando la formación.");
          });
      });
    }
  }
  */

  // ==========================
  //  INIT
  // ==========================
  try {
    root.innerHTML = `
      <div class="club-box" style="grid-column:span 12">
        <h3>Formación</h3>
        <p class="muted">Cargando formación del club…</p>
      </div>
    `;

    // Resolver league_team_id para la formación (equipo del usuario)
    const leagueTeamId = await resolveLeagueTeamIdFromNickname(CLUB, competitionId);
    
    // Resolver club_id para cargar la plantilla (jugadores del club)
    const clubId = await resolveClubIdFromNickname(CLUB, competitionId);

    // Obtener season para guardar (puede venir de la competición o de la config)
    let season = getSupabaseConfig().season;
    if (competitionId) {
      try {
        const { getCurrentCompetition } = await import('../modules/competitions.js');
        const comp = await getCurrentCompetition();
        if (comp?.season) {
          season = comp.season;
        }
      } catch (e) {
        // Fallback a config si no se puede obtener de la competición
      }
    }
    state.season = season;
    state.competitionId = competitionId;

    if (!leagueTeamId) {
      root.innerHTML = `
        <div class="club-box" style="grid-column:span 12">
          <h3>Formación</h3>
          <p class="muted">
            No se pudo resolver el <code>league_team_id</code> para <strong>${CLUB}</strong>.
          </p>
        </div>
      `;
      return;
    }

    // Cargar squad usando club_id (los jugadores están asociados al club)
    // Calcular y cargar formación automática usando league_team_id
    const [squad, formation] = await Promise.all([
      clubId ? loadSquadForClub(clubId, competitionId) : Promise.resolve([]),
      calculateAndLoadFormationForClub(leagueTeamId, competitionId)
    ]);

    state.clubId = clubId;
    state.leagueTeamId = leagueTeamId;
    state.squad = squad;

    if (formation) {
      state.system = formation.system || DEFAULT_SYSTEM;
      state.slots = formation.slots || new Map();
      state.formationId = formation.id;
    } else {
      state.system = DEFAULT_SYSTEM;
      state.slots = new Map();
      state.formationId = null;
    }

    renderFormationView();
  } catch (e) {
    console.error("Error inicializando formación:", e);
    root.innerHTML = `
      <div class="club-box" style="grid-column:span 12">
        <h3>Formación</h3>
        <p class="muted">No se pudo cargar la formación del club.</p>
      </div>
    `;
  }
})();
