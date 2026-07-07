/**
 * Módulo de renderizado de palmarés
 * Funciones reutilizables para renderizar componentes de palmarés
 * Usado tanto en la página de palmarés como en el modal
 */

import { escapeHtml } from './utils.js';

// Helper para slugificar (mismo patrón que liga/index.js, club.js, etc.).
const slug = (str) => {
    if (!str) return '';
    const fromGlobal = window.CoreStats?.slug || window.AppUtils?.slugify;
    if (fromGlobal) return fromGlobal(str);
    return String(str)
        .toLowerCase()
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
};

const safeUrl = (url) => {
  if (!url) return '';
  const s = String(url).trim();
  return /^(https?:|\/|\.\/|\.\.\/|#)/i.test(s) ? s : '';
};

const playerPhotoSrc = (name) => name ? `img/jugadores/${slug(name)}.jpg` : '';
const teamLogoSrc = (team) => team ? `img/${slug(team)}.png` : '';

/**
 * Render a team award card
 * @param {string} icon - Award icon
 * @param {string} title - Award title
 * @param {Object} team - Team object
 * @returns {string} HTML
 */
export function renderTeamAward(icon, title, team) {
    const teamName = team ? (team.nickname || team.userNickname || team.display_name || 'Equipo') : '—';
    const hasWinner = !!team;
    // Preferir crest_url de la BD; fallback a img/{slug(nickname)}.png
    const crestSrc = team?.club?.crest_url || teamLogoSrc(team?.nickname || team?.display_name);

    const mediaHtml = hasWinner && crestSrc
        ? `<img src="${escapeHtml(safeUrl(crestSrc))}" alt="" class="award-photo award-photo-team" loading="lazy" onerror="this.style.display='none'">`
        : '';

    return `
    <div class="award-card ${hasWinner ? '' : 'award-empty'}">
      <div class="award-icon">${icon}</div>
      <div class="award-content">
        <div class="award-title">${title}</div>
        ${mediaHtml}
        <div class="award-winner">${escapeHtml(teamName)}</div>
      </div>
    </div>
  `;
}

/**
 * Render a player award card
 * @param {string} icon - Award icon
 * @param {string} title - Award title
 * @param {Object} player - Player object
 * @param {string} extra - Extra info (e.g., goals)
 * @returns {string} HTML
 */
export function renderPlayerAward(icon, title, player, extra = null) {
    const playerName = player ? (player.name || 'Jugador') : '—';
    const hasWinner = !!player;
    const extraInfo = extra ? `<span class="award-extra">${escapeHtml(extra)}</span>` : '';
    const photoSrc = hasWinner ? playerPhotoSrc(player.name) : '';

    const mediaHtml = photoSrc
        ? `<img src="${photoSrc}" alt="" class="award-photo award-photo-player" loading="lazy" onerror="this.style.display='none'">`
        : '';

    return `
    <div class="award-card ${hasWinner ? '' : 'award-empty'}">
      <div class="award-icon">${icon}</div>
      <div class="award-content">
        <div class="award-title">${title}</div>
        ${mediaHtml}
        <div class="award-winner">${escapeHtml(playerName)} ${extraInfo}</div>
      </div>
    </div>
  `;
}

/**
 * Render Best XI formation
 * @param {Array} players - Best XI players
 * @param {Object} mvpTeam - MVP team
 * @returns {string} HTML
 */
export function renderBestEleven(players, mvpTeam) {
    if (!players || players.length === 0) {
        return '<p class="hint">No hay equipo ideal disponible.</p>';
    }

    // Helper function to get slug (from CoreStats or window.AppUtils)
    const slug = window.CoreStats?.slug || window.AppUtils?.slugify || ((str) => {
        if (!str) return '';
        return String(str)
            .toLowerCase()
            .normalize('NFD')
            .replace(/[\u0300-\u036f]/g, '')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '');
    });

    const logoPath = (team) => team ? `img/${slug(team)}.png` : null;

    // Group by position, including team info
    const byPosition = {
        GK: [],
        DEF: [],
        MID: [],
        FWD: []
    };

    players.forEach(p => {
        if (p.player && byPosition[p.position]) {
            byPosition[p.position].push({
                ...p.player,
                team: p.team
            });
        }
    });

    const mvpTeamName = mvpTeam ? (mvpTeam.nickname || mvpTeam.userNickname || mvpTeam.display_name || 'Equipo MVP') : null;

    // Helper to render a player card with team badge
    const renderPlayerCard = (player) => {
        const teamNickname = player.team?.nickname;
        const teamLogo = teamNickname ? logoPath(teamNickname) : null;
        
        return `
            <div class="player-card">
                ${teamLogo ? `
                    <img
                        src="${teamLogo}"
                        alt="Escudo ${escapeHtml(teamNickname)}"
                        class="player-card-badge"
                        onerror="this.style.visibility='hidden'">
                ` : ''}
                <span class="player-card-name">${escapeHtml(player.name)}</span>
            </div>
        `;
    };

    return `
    <div class="best-eleven">
      ${mvpTeamName ? `
        <div class="best-eleven-mvp">
          <span class="label">⭐ Entrenador:</span>
          <span class="value">${escapeHtml(mvpTeamName)}</span>
        </div>
      ` : ''}
      
      <div class="formation">
        <div class="formation-line">
          <div class="formation-label">Delanteros</div>
          <div class="formation-players">
            ${byPosition.FWD.map(renderPlayerCard).join('')}
          </div>
        </div>

        <div class="formation-line">
          <div class="formation-label">Centrocampistas</div>
          <div class="formation-players">
            ${byPosition.MID.map(renderPlayerCard).join('')}
          </div>
        </div>

        <div class="formation-line">
          <div class="formation-label">Defensas</div>
          <div class="formation-players">
            ${byPosition.DEF.map(renderPlayerCard).join('')}
          </div>
        </div>

        <div class="formation-line">
          <div class="formation-label">Portero</div>
          <div class="formation-players">
            ${byPosition.GK.map(renderPlayerCard).join('')}
          </div>
        </div>
      </div>
    </div>
  `;
}

/**
 * Render monthly awards
 * @param {Array} monthlyAwards - Array of monthly award objects
 * @returns {string} HTML
 */
export function renderMonthlyAwards(monthlyAwards) {
    if (!monthlyAwards || monthlyAwards.length === 0) {
        return '<p class="hint">No hay premios del mes disponibles.</p>';
    }

    return `
    <div class="monthly-awards-grid">
      ${monthlyAwards.map(award => {
          const periodLabel = `Período ${award.period_number} (Jornadas ${award.start_jornada}-${award.end_jornada})`;
          const playerName = award.player_name || '—';
          const playerRating = award.player_avg_rating ? award.player_avg_rating.toFixed(2) : '—';
          const coachName = award.coach_team_nickname || award.coach_team_display_name || '—';
          const coachScore = award.coach_avg_mvp_score ? award.coach_avg_mvp_score.toFixed(2) : '—';

          return `
        <div class="monthly-award-card">
          <div class="monthly-award-header">
            <span class="monthly-award-period">${escapeHtml(periodLabel)}</span>
          </div>
          <div class="monthly-award-content">
            <div class="monthly-award-item">
              <div class="monthly-award-icon">⭐</div>
              <div class="monthly-award-info">
                <div class="monthly-award-label">Jugador del Mes</div>
                <div class="monthly-award-winner">${escapeHtml(playerName)}</div>
                ${award.player_avg_rating ? `<div class="monthly-award-meta">Rating: ${playerRating}</div>` : ''}
              </div>
            </div>
            <div class="monthly-award-item">
              <div class="monthly-award-icon">🏆</div>
              <div class="monthly-award-info">
                <div class="monthly-award-label">Entrenador del Mes</div>
                <div class="monthly-award-winner">${escapeHtml(coachName)}</div>
                ${award.coach_avg_mvp_score ? `<div class="monthly-award-meta">MVP Score: ${coachScore}</div>` : ''}
              </div>
            </div>
          </div>
        </div>
      `;
      }).join('')}
    </div>
  `;
}


