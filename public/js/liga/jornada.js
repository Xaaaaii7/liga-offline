// "Lo mejor de la jornada" — versión compacta de liga-offline.
// El jornada.js original (744 líneas) mezcla quiniela/clips de vídeo/likes de
// gol/managers (todo excluido offline). Aquí se queda SOLO con el Best XI de la
// jornada: se extrajo la RPC get_best_xi_jornada y renderBestXiPitch() del
// original, reusando las clases .bestxi-* de jornada.css y img/campo-vertical.png.
import { getSupabaseClient } from '../modules/supabase-client.js';
import { escapeHtml, logoPath } from '../modules/utils.js';
import { getCompetitionFromURL, getCurrentCompetitionSlug, buildBreadcrumb, renderBreadcrumb } from '../modules/competition-context.js';
import { getCompetitionBySlug } from '../modules/competition-data.js';
import { loadCompetitionTheme } from '../modules/theme-loader.js';
import { FORMATION_TEMPLATES, DEFAULT_SYSTEM, groupFromPosition } from '../modules/formation.js';

const safeUrl = (url) => {
  if (!url) return '';
  const s = String(url).trim();
  return /^(https?:|\/|\.\/|\.\.\/|#)/i.test(s) ? s : '';
};

const POS_TO_LINE = { GK: 'POR', DEF: 'DEF', MID: 'MC', FWD: 'DEL' };

function shortName(name) {
  if (!name) return '?';
  const parts = String(name).trim().split(/\s+/);
  return parts.length === 1 ? parts[0] : parts[parts.length - 1];
}

// Copiado tal cual de jornada.js (lliga original).
function renderBestXiPitch(players) {
  if (!players || players.length === 0) return '';

  const enriched = players.map(p => ({ ...p, line: POS_TO_LINE[p.position] || groupFromPosition(p.position) }));

  const counts = { POR: 0, DEF: 0, MC: 0, DEL: 0 };
  enriched.forEach(p => { if (p.line && counts[p.line] != null) counts[p.line]++; });
  const detectedKey = `${counts.DEF}-${counts.MC}-${counts.DEL}`;
  const formationKey = FORMATION_TEMPLATES[detectedKey] ? detectedKey : DEFAULT_SYSTEM;

  const template = FORMATION_TEMPLATES[formationKey];
  const byLine = { POR: [], DEF: [], MC: [], DEL: [] };
  enriched.forEach(p => { if (p.line && byLine[p.line]) byLine[p.line].push(p); });

  const slotsAssigned = template.map(slot => {
    const pool = byLine[slot.line];
    return { slot, player: pool && pool.length ? pool.shift() : null };
  });

  const overflow = [...byLine.POR, ...byLine.DEF, ...byLine.MC, ...byLine.DEL];
  if (overflow.length) {
    slotsAssigned.forEach(entry => { if (!entry.player && overflow.length) entry.player = overflow.shift(); });
  }

  const renderSlot = ({ slot, player }) => {
    if (!player) return '';
    const safeCrest = safeUrl(player.club_crest);
    const teamLogoUrl = safeCrest || (player.team_nickname ? logoPath(player.team_nickname) : '');
    const nameSafe = escapeHtml(shortName(player.player_name));
    const teamSafe = escapeHtml(player.team_nickname || '');
    return `
      <div class="bestxi-pitch-slot" style="left:${slot.x}%;top:${slot.y}%">
        <img class="bestxi-pitch-badge" src="${escapeHtml(teamLogoUrl)}" alt="${teamSafe}" onerror="this.style.visibility='hidden'">
        <div class="bestxi-pitch-name">${nameSafe}</div>
      </div>
    `;
  };

  return `
    <section class="bestxi-section">
      <div class="bestxi-header">
        <h2 class="bestxi-title">Equipo de la jornada</h2>
        <div class="bestxi-formation">${escapeHtml(formationKey)}</div>
      </div>
      <div class="bestxi-pitch-wrap">
        <div class="bestxi-pitch">
          <img class="bestxi-pitch-bg" src="img/campo-vertical.png" alt="" onerror="this.src='';this.style.background='#1a4a1f'">
          ${slotsAssigned.map(renderSlot).join('')}
        </div>
      </div>
    </section>
  `;
}

(async () => {
  const slug = getCompetitionFromURL() || await getCurrentCompetitionSlug();
  const competition = await getCompetitionBySlug(slug);
  if (!competition) {
    document.getElementById('jornada-root').innerHTML = '<p>No se encontró la competición.</p>';
    return;
  }
  await loadCompetitionTheme(competition.id).catch(() => {});

  const supabase = await getSupabaseClient();
  const breadcrumbEl = document.getElementById('breadcrumb');
  const mountEl = document.getElementById('bestxi-mount');

  const params = new URLSearchParams(window.location.search);
  let jornada = Number(params.get('jornada')) || 1;

  async function loadBestXi(jornadaNum) {
    const { data, error } = await supabase.rpc('get_best_xi_jornada', {
      p_competition_id: competition.id,
      p_season: String(competition.season),
      p_jornada: jornadaNum,
    });
    if (error) { console.error('Error cargando Best XI:', error); return []; }
    return (data || []).map(row => ({
      player_id: row.player_id,
      player_name: row.player_name,
      position: row.player_position,
      avg_rating: row.avg_rating,
      matches_count: row.matches_count,
      league_team_id: row.league_team_id,
      team_nickname: row.team_nickname,
      club_crest: row.club_crest,
      position_order: row.position_order,
    }));
  }

  async function render() {
    document.getElementById('jornada-numero').textContent = `Jornada ${jornada}`;
    document.getElementById('jornada-title').textContent = `${competition.name} — Lo mejor de la jornada`;
    if (breadcrumbEl) renderBreadcrumb(breadcrumbEl, buildBreadcrumb(slug, competition.name, `Jornada ${jornada}`));

    const players = await loadBestXi(jornada);
    const html = renderBestXiPitch(players);
    mountEl.innerHTML = html || '<p class="muted">Aún no hay Best XI para esta jornada (no se han jugado partidos con valoraciones).</p>';

    const url = new URL(window.location.href);
    url.searchParams.set('jornada', jornada);
    window.history.replaceState({}, '', url);
  }

  document.getElementById('btn-jornada-prev').addEventListener('click', () => { if (jornada > 1) { jornada -= 1; render(); } });
  document.getElementById('btn-jornada-next').addEventListener('click', () => { jornada += 1; render(); });

  await render();
})();
