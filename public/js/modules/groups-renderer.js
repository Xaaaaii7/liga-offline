/**
 * Módulo para renderizar tablas de grupos
 * 
 * IMPORTANTE: No modifica la lógica existente
 * Solo proporciona funciones para renderizar grupos visualmente
 */

/**
 * Renderiza las tablas de grupos en un contenedor HTML
 * @param {HTMLElement} container - Contenedor donde renderizar
 * @param {Object} groupsData - Datos de los grupos (de getMixedStandings)
 * @param {Object} options - Opciones de renderizado
 * @returns {void}
 */
export function renderGroups(container, groupsData, options = {}) {
    if (!container || !groupsData) {
        console.error('Container o groupsData no proporcionado');
        return;
    }

    const {
        showQualified = true,
        qualifiesPerGroup = 1
    } = options;

    // Limpiar contenedor
    container.innerHTML = '';

    // Crear estructura de grupos
    const groupsEl = document.createElement('div');
    groupsEl.className = 'groups-container';

    Object.keys(groupsData).forEach(groupName => {
        const groupStandings = groupsData[groupName];
        const groupEl = renderGroupTable(groupName, groupStandings, showQualified, qualifiesPerGroup);
        groupsEl.appendChild(groupEl);
    });

    container.appendChild(groupsEl);
}

/**
 * Renderiza una tabla de grupo individual
 * @param {string} groupName - Nombre del grupo
 * @param {Array} standings - Clasificación del grupo
 * @param {boolean} showQualified
 * @param {number} qualifiesPerGroup
 * @returns {HTMLElement}
 */
function renderGroupTable(groupName, standings, showQualified, qualifiesPerGroup) {
    const groupEl = document.createElement('div');
    groupEl.className = 'group-table-container';

    const title = document.createElement('h3');
    title.className = 'group-title';
    title.textContent = groupName;
    groupEl.appendChild(title);

    const table = document.createElement('table');
    table.className = 'group-table';

    // Header
    const thead = document.createElement('thead');
    thead.innerHTML = `
        <tr>
            <th>Pos</th>
            <th>Equipo</th>
            <th>PJ</th>
            <th>G</th>
            <th>E</th>
            <th>P</th>
            <th>GF</th>
            <th>GC</th>
            <th>DG</th>
            <th>Pts</th>
        </tr>
    `;
    table.appendChild(thead);

    // Body
    const tbody = document.createElement('tbody');
    standings.forEach((team, index) => {
        const isQualified = showQualified && index < qualifiesPerGroup;
        const row = document.createElement('tr');
        row.className = isQualified ? 'group-qualified' : '';

        row.innerHTML = `
            <td>${index + 1}</td>
            <td>${escapeHtml(getTeamName(team))}</td>
            <td>${team.played || 0}</td>
            <td>${team.won || 0}</td>
            <td>${team.drawn || 0}</td>
            <td>${team.lost || 0}</td>
            <td>${team.goals_for || 0}</td>
            <td>${team.goals_against || 0}</td>
            <td>${team.goal_difference || 0}</td>
            <td><strong>${team.points || 0}</strong></td>
        `;

        if (isQualified) {
            row.innerHTML += '<td><span class="qualified-badge">✓ Clasificado</span></td>';
        }

        tbody.appendChild(row);
    });
    table.appendChild(tbody);

    groupEl.appendChild(table);
    return groupEl;
}

/**
 * Obtiene el nombre del equipo desde los datos
 * @param {Object} teamData
 * @returns {string}
 */
function getTeamName(teamData) {
    // teamData debe tener team_name (se pasa desde calculateGroupStandings)
    // o team_id como fallback
    return teamData.team_name || `Equipo ${teamData.team_id}`;
}

/**
 * Escapa HTML
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

