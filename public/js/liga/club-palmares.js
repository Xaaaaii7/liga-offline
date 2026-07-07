import {
    getLeagueTeamIdFromNickname,
    getTeamMvpJornadas,
    getTeamMvpMonths,
    getTeamBestPlayersJornada,
    getTeamBestPlayersMonth,
    getTeamBestXiPlayers,
    getTeamCompetitionTitles
} from '../modules/club-palmares-data.js';
import { getCompetitionFromURL, getCurrentCompetitionSlug } from '../modules/competition-context.js';
import { getCompetitionBySlug } from '../modules/competition-data.js';
import { getSupabaseClient } from '../modules/supabase-client.js';
import { escapeHtml } from '../modules/utils.js';

/**
 * Module for rendering club palmares tab
 */

let isInitialized = false;
let currentData = null;

/**
 * Render club palmares tab
 * @param {string} clubNickname - Club nickname
 * @param {number} competitionId - Competition ID
 * @param {string} season - Season
 */
export async function renderClubPalmares(clubNickname, competitionId, season) {
    const panel = document.getElementById('tab-palmares');
    if (!panel) return;

    // Show loading state
    panel.innerHTML = '<p class="hint">Cargando palmarés...</p>';

    try {
        // Get league_team_id from nickname
        const leagueTeamId = await getLeagueTeamIdFromNickname(clubNickname, competitionId);
        if (!leagueTeamId) {
            panel.innerHTML = '<p class="hint">No se pudo encontrar el equipo.</p>';
            return;
        }

        // Load all data in parallel
        const [
            mvpJornadas,
            mvpMonths,
            bestPlayersJornada,
            bestPlayersMonth,
            bestXiPlayers,
            competitionTitles
        ] = await Promise.all([
            getTeamMvpJornadas(leagueTeamId, competitionId, season),
            getTeamMvpMonths(leagueTeamId, competitionId, season),
            getTeamBestPlayersJornada(leagueTeamId, competitionId, season),
            getTeamBestPlayersMonth(leagueTeamId, competitionId, season),
            getTeamBestXiPlayers(leagueTeamId, competitionId, season),
            getTeamCompetitionTitles(leagueTeamId, competitionId)
        ]);

        // Store data for reuse
        currentData = {
            mvpJornadas,
            mvpMonths,
            bestPlayersJornada,
            bestPlayersMonth,
            bestXiPlayers,
            competitionTitles
        };

        // Render all sections
        panel.innerHTML = `
            <div class="club-palmares-container">
                ${renderTeamSection(mvpJornadas, mvpMonths, competitionTitles)}
                ${renderPlayersSection(bestPlayersJornada, bestPlayersMonth, bestXiPlayers)}
            </div>
        `;

    } catch (err) {
        console.error('Error rendering club palmares:', err);
        panel.innerHTML = '<p class="hint">Error cargando el palmarés.</p>';
    }
}

/**
 * Render team awards section
 */
function renderTeamSection(mvpJornadas, mvpMonths, competitionTitles) {
    const hasTeamAwards = mvpJornadas.length > 0 || mvpMonths.length > 0 || competitionTitles;

    if (!hasTeamAwards) {
        return `
            <section class="club-palmares-section">
                <h3>🏆 Premios del Equipo</h3>
                <p class="hint">Aún no hay premios del equipo registrados.</p>
            </section>
        `;
    }

    return `
        <section class="club-palmares-section">
            <h3>🏆 Premios del Equipo</h3>
            
            ${mvpJornadas.length > 0 ? `
                <div class="club-palmares-item">
                    <h4>⭐ MVP de la Jornada</h4>
                    <div class="club-palmares-list">
                        ${mvpJornadas.map(mvp => `
                            <div class="club-palmares-badge">
                                <span class="badge-label">Jornada ${mvp.jornada}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
            ` : ''}
            
            ${mvpMonths.length > 0 ? `
                <div class="club-palmares-item">
                    <h4>📅 MVP del Mes</h4>
                    <div class="club-palmares-list">
                        ${mvpMonths.map(month => `
                            <div class="club-palmares-badge">
                                <span class="badge-label">Período ${month.period_number}</span>
                                <span class="badge-meta">Jornadas ${month.start_jornada}-${month.end_jornada}</span>
                                ${month.coach_avg_mvp_score ? `<span class="badge-meta">Score: ${month.coach_avg_mvp_score.toFixed(2)}</span>` : ''}
                            </div>
                        `).join('')}
                    </div>
                </div>
            ` : ''}
            
            ${competitionTitles ? renderCompetitionTitles(competitionTitles) : ''}
        </section>
    `;
}

/**
 * Render competition titles
 */
function renderCompetitionTitles(titles) {
    const titleLabels = {
        winner: '🥇 Campeón',
        runner_up: '🥈 Subcampeón',
        top_scorer_team: '⚽ Equipo más goleador',
        best_defense_team: '🛡️ Mejor defensa',
        most_possession_team: '🎯 Mayor posesión',
        cleanest_team: '🤝 Juego más limpio',
        most_accurate_passes_team: '📊 Pases más precisos',
        most_efficient_shooting_team: '🎲 Tiro más eficaz',
        most_effective_defense_team: '🔒 Defensa más efectiva',
        mvp_team: '⭐ Equipo MVP'
    };

    const activeTitles = Object.entries(titles)
        .filter(([key, value]) => value === true)
        .map(([key]) => titleLabels[key] || key);

    if (activeTitles.length === 0) return '';

    return `
        <div class="club-palmares-item">
            <h4>🏅 Títulos de Competición</h4>
            <div class="club-palmares-list">
                ${activeTitles.map(title => `
                    <div class="club-palmares-badge club-palmares-title">
                        <span class="badge-label">${title}</span>
                    </div>
                `).join('')}
            </div>
        </div>
    `;
}

/**
 * Render players awards section
 */
function renderPlayersSection(bestPlayersJornada, bestPlayersMonth, bestXiPlayers) {
    const hasPlayerAwards = bestPlayersJornada.length > 0 || bestPlayersMonth.length > 0 || bestXiPlayers.length > 0;

    if (!hasPlayerAwards) {
        return `
            <section class="club-palmares-section">
                <h3>👤 Premios de Jugadores</h3>
                <p class="hint">Aún no hay premios de jugadores registrados.</p>
            </section>
        `;
    }

    return `
        <section class="club-palmares-section">
            <h3>👤 Premios de Jugadores</h3>
            
            ${bestPlayersJornada.length > 0 ? `
                <div class="club-palmares-item">
                    <h4>⭐ Mejor Jugador de la Jornada</h4>
                    <div class="club-palmares-list">
                        ${bestPlayersJornada.map(player => `
                            <div class="club-palmares-badge">
                                <span class="badge-label">${escapeHtml(player.player_name)}</span>
                                <span class="badge-meta">Jornada ${player.jornada}</span>
                                ${player.avg_rating ? `<span class="badge-meta">Rating: ${player.avg_rating.toFixed(2)}</span>` : ''}
                            </div>
                        `).join('')}
                    </div>
                </div>
            ` : ''}
            
            ${bestPlayersMonth.length > 0 ? `
                <div class="club-palmares-item">
                    <h4>📅 Mejor Jugador del Mes</h4>
                    <div class="club-palmares-list">
                        ${bestPlayersMonth.map(player => `
                            <div class="club-palmares-badge">
                                <span class="badge-label">${escapeHtml(player.player_name)}</span>
                                <span class="badge-meta">Período ${player.period_number} (Jornadas ${player.start_jornada}-${player.end_jornada})</span>
                                ${player.player_avg_rating ? `<span class="badge-meta">Rating: ${player.player_avg_rating.toFixed(2)}</span>` : ''}
                            </div>
                        `).join('')}
                    </div>
                </div>
            ` : ''}
            
            ${bestXiPlayers.length > 0 ? `
                <div class="club-palmares-item">
                    <h4>⚡ Jugadores en Best XI</h4>
                    <div class="club-palmares-list">
                        ${bestXiPlayers.map(player => `
                            <div class="club-palmares-badge">
                                <span class="badge-label">${escapeHtml(player.player_name)}</span>
                                <span class="badge-meta">${player.count} ${player.count === 1 ? 'vez' : 'veces'}</span>
                                ${player.player_position ? `<span class="badge-meta">${escapeHtml(player.player_position)}</span>` : ''}
                            </div>
                        `).join('')}
                    </div>
                </div>
            ` : ''}
        </section>
    `;
}

/**
 * Initialize palmares tab
 */
(async () => {
    if (isInitialized) return;

    // Wait for DOM to be ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    async function init() {
        // Get competition context
        let competitionId = null;
        let season = null;
        let clubNickname = window.CLUB_NAME;

        if (!clubNickname) {
            console.warn('[Club Palmares] No CLUB_NAME found');
            return;
        }

        try {
            const competitionSlug = getCompetitionFromURL() || await getCurrentCompetitionSlug();
            if (competitionSlug) {
                const competition = await getCompetitionBySlug(competitionSlug);
                if (competition) {
                    competitionId = competition.id;
                    season = competition.season;
                }
            }

            // If no season from competition, try to get from Supabase config
            if (!season) {
                const supabase = await getSupabaseClient();
                if (supabase) {
                    const { data: config } = await supabase
                        .from('supabase_config')
                        .select('season')
                        .limit(1)
                        .maybeSingle();
                    if (config?.season) {
                        season = config.season;
                    }
                }
            }

            if (!competitionId || !season) {
                console.warn('[Club Palmares] Missing competitionId or season');
                return;
            }

            // Set up tab click handler
            const palmaresTab = document.querySelector('[data-tab="palmares"]');
            if (palmaresTab) {
                palmaresTab.addEventListener('click', () => {
                    // Load data when tab is clicked (lazy loading)
                    if (!currentData) {
                        renderClubPalmares(clubNickname, competitionId, season);
                    }
                });
            }

            isInitialized = true;
        } catch (err) {
            console.error('[Club Palmares] Error initializing:', err);
        }
    }
})();

