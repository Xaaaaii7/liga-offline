import { getBestEleven, getMonthlyAwards } from './palmares-data.js';
import { renderTeamAward, renderPlayerAward, renderBestEleven, renderMonthlyAwards } from './palmares-renderer.js';

/**
 * Module for rendering palmares modal with all details
 */

/**
 * Render complete palmares modal
 * @param {Object} palmares - Palmares data with team and player info
 */
export const renderPalmaresModal = async (palmares) => {
    const bodyEl = document.getElementById('palmares-body');
    const titleEl = document.getElementById('palmares-title');

    if (!bodyEl || !titleEl) return;

    const competition = palmares.competition;
    const competitionName = competition?.name || 'Competición';
    const season = palmares.season || competition?.season || '';
    const competitionId = competition?.id || palmares.competition_id;

    titleEl.textContent = `🏆 Palmarés ${competitionName} ${season}`;

    // Load Best XI
    const bestEleven = await getBestEleven(palmares.id);

    // Load Monthly Awards
    console.log('[Palmares Modal] Loading monthly awards for competition:', competitionId);
    const monthlyAwards = competitionId ? await getMonthlyAwards(competitionId) : [];
    console.log('[Palmares Modal] Monthly awards loaded:', monthlyAwards?.length || 0, 'awards');

    bodyEl.innerHTML = `
    <div class="palmares-content">
      <!-- Team Awards Section -->
      <section class="palmares-section">
        <h3 class="section-title">🏅 Premios de Equipos</h3>
        <div class="awards-grid">
          ${renderTeamAward('🥇', 'Campeón', palmares.winner_team)}
          ${renderTeamAward('🥈', 'Subcampeón', palmares.runner_up_team)}
          ${renderTeamAward('⚽', 'Equipo más goleador', palmares.top_scorer_team)}
          ${renderTeamAward('🛡️', 'Mejor defensa', palmares.best_defense_team)}
          ${renderTeamAward('🎯', 'Mayor posesión', palmares.most_possession_team)}
          ${renderTeamAward('🤝', 'Juego más limpio', palmares.cleanest_team)}
          ${renderTeamAward('📊', 'Pases más precisos', palmares.most_accurate_passes_team)}
          ${renderTeamAward('🎲', 'Tiro más eficaz', palmares.most_efficient_shooting_team)}
          ${renderTeamAward('🔒', 'Defensa más efectiva', palmares.most_effective_defense_team)}
          ${renderTeamAward('⭐', 'Equipo MVP', palmares.mvp_team)}
        </div>
      </section>

      <!-- Player Awards Section -->
      <section class="palmares-section">
        <h3 class="section-title">👤 Premios Individuales</h3>
        <div class="awards-grid">
          ${renderPlayerAward('⚽', 'Pichichi', palmares.top_scorer_player, palmares.top_scorer_goals ? `${palmares.top_scorer_goals} goles` : null)}
          ${renderPlayerAward('⭐', 'MVP', palmares.mvp_player)}
          ${renderPlayerAward('🛡️', 'Mejor Defensa', palmares.best_defender_player)}
          ${renderPlayerAward('🎯', 'Mejor Centrocampista', palmares.best_midfielder_player)}
          ${renderPlayerAward('🚀', 'Mejor Delantero', palmares.best_forward_player)}
          ${renderPlayerAward('🧤', 'Mejor Portero', palmares.best_goalkeeper_player)}
        </div>
      </section>

      <!-- Best XI Section -->
      <section class="palmares-section">
        <h3 class="section-title">⚡ Equipo de la Liga</h3>
        ${renderBestEleven(bestEleven, palmares.mvp_team)}
      </section>

      <!-- Monthly Awards Section -->
      ${monthlyAwards && monthlyAwards.length > 0 ? `
        <section class="palmares-section monthly-awards-section">
          <h3 class="section-title">📅 Premios del Mes</h3>
          ${renderMonthlyAwards(monthlyAwards)}
        </section>
      ` : ''}

      ${palmares.auto_generated ? `
        <div class="palmares-footer">
          <p class="hint small">
            <em>Palmarés generado automáticamente al finalizar la competición</em>
          </p>
        </div>
      ` : ''}
    </div>
  `;
};

