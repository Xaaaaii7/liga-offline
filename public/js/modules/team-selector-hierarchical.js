/**
 * Módulo de selección jerárquica de equipos
 * Flujo simplificado: Liga → Equipo → Ver Plantilla (opcional)
 */

import { getSupabaseClient } from './supabase-client.js';
import { escapeHtml } from './utils.js';

// Estado de navegación
let navigationState = {
  currentLevel: 'league',  // league → team
  selectedLeague: null,
  selectedTeam: null,
  onConfirm: null
};

/**
 * Inicia el selector jerárquico de equipos
 * @param {Function} onConfirmCallback - Callback cuando se selecciona un equipo
 * @returns {Promise<Object>} El equipo seleccionado
 */
export async function showTeamSelector(onConfirmCallback) {
  return new Promise((resolve) => {
    navigationState = {
      currentLevel: 'league',
      selectedLeague: null,
      selectedTeam: null,
      onConfirm: (team) => {
        resolve(team);
        if (onConfirmCallback) onConfirmCallback(team);
      }
    };
    
    showLeagueSelection();
  });
}

/**
 * Muestra el selector de ligas
 */
async function showLeagueSelection() {
  navigationState.currentLevel = 'league';
  
  const supabase = await getSupabaseClient();
  
  // Obtener ligas con conteo de equipos
  const { data: leagues, error } = await supabase
    .from('leagues')
    .select(`
      id,
      name,
      short_name,
      country,
      clubs:clubs(count)
    `)
    .order('name', { ascending: true });
  
  if (error) {
    console.error('Error cargando ligas:', error);
    return;
  }
  
  // Filtrar ligas que tienen equipos
  const leaguesWithTeams = leagues.filter(l => l.clubs && l.clubs[0]?.count > 0);
  
  renderLeagueSelector(leaguesWithTeams);
}

/**
 * Renderiza el selector de ligas en el modal
 */
function renderLeagueSelector(leagues) {
  const container = document.getElementById('team-selector-content');
  if (!container) return;
  
  const html = `
    <div class="selector-header">
      <h3>Selecciona una Liga</h3>
    </div>
    
    <div class="league-grid">
      ${leagues.map(league => `
        <button class="league-card" data-league-id="${league.id}">
          <div class="league-flag">${getCountryFlag(league.country)}</div>
          <div class="league-info">
            <h4>${escapeHtml(league.name)}</h4>
            <p class="league-country">${escapeHtml(league.country)}</p>
            <span class="league-count">${league.clubs[0]?.count || 0} equipos</span>
          </div>
        </button>
      `).join('')}
    </div>
  `;
  
  container.innerHTML = html;
  
  // Event listeners
  container.querySelectorAll('.league-card').forEach(btn => {
    btn.addEventListener('click', () => {
      const leagueId = parseInt(btn.getAttribute('data-league-id'));
      const league = leagues.find(l => l.id === leagueId);
      selectLeague(league);
    });
  });
  
  // No hay botón atrás en el primer nivel
  updateBackButton(false);
}

/**
 * Selecciona una liga y muestra sus equipos
 */
async function selectLeague(league) {
  navigationState.selectedLeague = league;
  navigationState.currentLevel = 'team';
  
  await showTeamSelection(league.id);
}

/**
 * Muestra los equipos de una liga
 */
async function showTeamSelection(leagueId) {
  const supabase = await getSupabaseClient();
  
  const { data: teams, error } = await supabase
    .from('clubs')
    .select('id, name, short_name, crest_url')
    .eq('league_id', leagueId)
    .order('name', { ascending: true });
  
  if (error) {
    console.error('Error cargando equipos:', error);
    return;
  }
  
  // Filtrar solo equipos disponibles si existe el filtro
  let filteredTeams = teams;
  if (window.availableTeamIds && window.availableTeamIds.size > 0) {
    filteredTeams = teams.filter(t => window.availableTeamIds.has(t.id));
  }
  
  renderTeamSelector(filteredTeams);
}

/**
 * Renderiza el selector de equipos
 */
function renderTeamSelector(teams) {
  const container = document.getElementById('team-selector-content');
  if (!container) return;
  
  const html = `
    <div class="selector-header">
      <h3>${escapeHtml(navigationState.selectedLeague.name)}</h3>
      <p class="selector-subtitle">Selecciona tu equipo</p>
    </div>
    
    <div class="team-grid">
      ${teams.map(team => `
        <div class="team-selection-card" data-team-id="${team.id}">
          <div class="team-crest-container">
            <img src="${team.crest_url || 'img/logo.png'}" 
                 alt="${escapeHtml(team.name)}" 
                 class="team-crest"
                 onerror="this.src='img/logo.png'">
          </div>
          <h4 class="team-name">${escapeHtml(team.short_name || team.name)}</h4>
          <div class="team-actions">
            <button class="btn-view-squad btn-sm btn-secondary" data-team-id="${team.id}">
              Ver Plantilla
            </button>
            <button class="btn-select-team btn-sm btn-primary" data-team-id="${team.id}">
              Seleccionar
            </button>
          </div>
        </div>
      `).join('')}
    </div>
  `;
  
  container.innerHTML = html;
  
  // Event listeners para Ver Plantilla
  container.querySelectorAll('.btn-view-squad').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const teamId = parseInt(btn.getAttribute('data-team-id'));
      const team = teams.find(t => t.id === teamId);
      showSquadModal(team);
    });
  });
  
  // Event listeners para Seleccionar
  container.querySelectorAll('.btn-select-team').forEach(btn => {
    btn.addEventListener('click', () => {
      const teamId = parseInt(btn.getAttribute('data-team-id'));
      const team = teams.find(t => t.id === teamId);
      confirmTeamSelection(team);
    });
  });
  
  // Mostrar botón atrás
  updateBackButton(true);
}

/**
 * Confirma la selección del equipo
 */
function confirmTeamSelection(team) {
  navigationState.selectedTeam = team;
  
  if (navigationState.onConfirm) {
    navigationState.onConfirm(team);
  }
}

/**
 * Muestra el modal de plantilla del equipo
 */
async function showSquadModal(team) {
  const supabase = await getSupabaseClient();
  
  // Obtener jugadores del equipo
  const { data: memberships, error } = await supabase
    .from('player_club_memberships')
    .select(`
      player:players(
        id,
        name,
        position,
        nationality,
        date_of_birth
      )
    `)
    .eq('club_id', team.id)
    .eq('is_current', true);
  
  if (error) {
    console.error('Error cargando plantilla:', error);
    alert('Error al cargar la plantilla');
    return;
  }
  
  const players = memberships?.map(m => m.player) || [];
  
  // Agrupar por posición (usando lógica de agrupamiento)
  const byPosition = {
    'Goalkeeper': [],
    'Defender': [],
    'Midfielder': [],
    'Attacker': []
  };
  
  players.forEach(p => {
    const pos = (p.position || '').toLowerCase();
    
    // Porteros
    if (pos.includes('goalkeeper') || pos.includes('portero') || pos === 'gk') {
      byPosition['Goalkeeper'].push(p);
    }
    // Defensas
    else if (
      pos.includes('defence') || pos.includes('back') ||
      pos.includes('defensa') || pos === 'cb' || 
      pos === 'lb' || pos === 'rb' || pos === 'rwb' || pos === 'lwb'
    ) {
      byPosition['Defender'].push(p);
    }
    // Delanteros (antes de midfield porque "attacking midfield" contiene "midfield")
    else if (
      pos.includes('offence') || pos.includes('forward') ||
      pos.includes('striker') || pos.includes('winger') ||
      pos.includes('delantero') || pos === 'fw' || 
      pos === 'st' || pos === 'lw' || pos === 'rw'
    ) {
      byPosition['Attacker'].push(p);
    }
    // Centrocampistas
    else if (pos.includes('midfield') || pos.includes('medio') || pos.includes('mid')) {
      byPosition['Midfielder'].push(p);
    }
    // Por defecto, centrocampista
    else {
      byPosition['Midfielder'].push(p);
    }
  });
  
  renderSquadModal(team, byPosition, players.length);
}

/**
 * Renderiza el modal de plantilla
 */
function renderSquadModal(team, playersByPosition, totalPlayers) {
  // Crear modal si no existe
  let backdrop = document.getElementById('squad-modal-backdrop');
  if (!backdrop) {
    backdrop = document.createElement('div');
    backdrop.id = 'squad-modal-backdrop';
    backdrop.className = 'modal-backdrop';
    document.body.appendChild(backdrop);
  }
  
  const html = `
    <div class="modal-content modal-large" id="squad-modal">
      <button class="modal-close" id="squad-modal-close">×</button>
      
      <div class="squad-header">
        <img src="${team.crest_url || 'img/logo.png'}" 
             alt="${escapeHtml(team.name)}" 
             class="squad-team-logo"
             onerror="this.src='img/logo.png'">
        <div>
          <h2>${escapeHtml(team.name)}</h2>
          <p class="squad-subtitle">${totalPlayers} jugadores en plantilla</p>
        </div>
      </div>
      
      ${Object.entries(playersByPosition).map(([position, players]) => {
        if (players.length === 0) return '';
        
        return `
          <div class="position-section">
            <h3 class="position-title">${getPositionName(position)} (${players.length})</h3>
            <div class="players-grid">
              ${players.map(p => `
                <div class="player-card-mini">
                  <div class="player-number">${getPlayerAge(p.date_of_birth)}</div>
                  <div class="player-info-mini">
                    <div class="player-name-mini">${escapeHtml(p.name)}</div>
                    <div class="player-nat">${p.nationality || '—'}</div>
                  </div>
                </div>
              `).join('')}
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;
  
  backdrop.innerHTML = html;
  backdrop.style.display = 'flex';
  
  // Event listener para cerrar
  document.getElementById('squad-modal-close').addEventListener('click', closeSquadModal);
  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) closeSquadModal();
  });
}

/**
 * Cierra el modal de plantilla
 */
function closeSquadModal() {
  const backdrop = document.getElementById('squad-modal-backdrop');
  if (backdrop) {
    backdrop.style.display = 'none';
  }
}

/**
 * Actualiza la visibilidad del botón atrás
 */
function updateBackButton(show) {
  const backBtn = document.getElementById('team-selector-back-btn');
  if (backBtn) {
    backBtn.style.display = show ? 'block' : 'none';
  }
}

/**
 * Vuelve al nivel anterior
 */
export function goBack() {
  if (navigationState.currentLevel === 'team') {
    // Volver a ligas
    navigationState.selectedLeague = null;
    navigationState.currentLevel = 'league';
    showLeagueSelection();
  }
}

// Helpers

function getCountryFlag(country) {
  const flags = {
    'Italy': '🇮🇹',
    'England': '🏴󠁧󠁢󠁥󠁮󠁧󠁿',
    'Spain': '🇪🇸',
    'Germany': '🇩🇪',
    'France': '🇫🇷',
    'Portugal': '🇵🇹',
    'Monaco': '🇲🇨'
  };
  return flags[country] || '⚽';
}

function getPositionName(position) {
  const names = {
    'Goalkeeper': 'Porteros',
    'Defender': 'Defensas',
    'Midfielder': 'Centrocampistas',
    'Attacker': 'Delanteros'
  };
  return names[position] || position;
}

function getPlayerAge(dateOfBirth) {
  if (!dateOfBirth) return '—';
  const today = new Date();
  const birth = new Date(dateOfBirth);
  let age = today.getFullYear() - birth.getFullYear();
  const monthDiff = today.getMonth() - birth.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birth.getDate())) {
    age--;
  }
  return age;
}

