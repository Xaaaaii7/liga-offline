/**
 * Hero de competición — banda superior con identidad visual de la competición.
 * Se inyecta entre <header> y <main> en páginas de zona COMPETITION.
 *
 * Muestra: logo + nombre + temporada + tipo + métricas de estado + líder actual.
 */

import { getCurrentPageName, getPageZone } from './navigation-zones.js';
import { getCurrentCompetition } from './competitions.js';
import { getSupabaseClient } from './supabase-client.js';
import { escapeHtml } from './utils.js';

const HERO_ID = 'competition-hero';

const TYPE_LABEL = {
  league: 'Liga',
  cup: 'Copa',
  mixed: 'Mixto',
  ranked: 'Ranked'
};

/**
 * Carga métricas de estado de la competición.
 * Robusto: cada query puede fallar de forma independiente sin romper el hero.
 */
async function loadHeroStats(competitionId, competitionType) {
  const supa = await getSupabaseClient();

  const tasks = [
    supa.from('league_teams')
      .select('id', { count: 'exact', head: true })
      .eq('competition_id', competitionId),
    supa.from('matches')
      .select('id', { count: 'exact', head: true })
      .eq('competition_id', competitionId)
      .not('home_goals', 'is', null)
      .not('away_goals', 'is', null),
    supa.from('matches')
      .select('id', { count: 'exact', head: true })
      .eq('competition_id', competitionId),
    supa.from('matches')
      // Sin embed round:rounds (offline no tiene esa FK → 400). round_id ya
      // es el número de jornada directamente.
      .select('round_id')
      .eq('competition_id', competitionId)
      .not('home_goals', 'is', null)
      .order('round_id', { ascending: false })
      .limit(1)
  ];

  // Líder solo si es liga — league_standings es una vista; no se puede embeber
  // league_teams() vía PostgREST (no infiere FK desde una vista → 400). Se hace
  // la query plana y luego, si hay líder, se piden league_teams + clubs aparte.
  if (competitionType === 'league') {
    tasks.push(
      supa.from('league_standings')
        .select('league_team_id, pts, g, pj')
        .eq('competition_id', competitionId)
        .order('pts', { ascending: false })
        .limit(1)
    );
  }

  const results = await Promise.allSettled(tasks);
  const [teamsR, playedR, totalR, lastRoundR, leaderR] = results;

  const getCount = r => (r.status === 'fulfilled' ? r.value.count ?? null : null);
  const getData = r => (r.status === 'fulfilled' ? r.value.data ?? null : null);

  const lastRoundArr = getData(lastRoundR);
  const leaderArr = getData(leaderR);
  let leader = Array.isArray(leaderArr) && leaderArr[0] ? leaderArr[0] : null;

  // Enriquecer al líder con info del league_team y club (queries separadas).
  if (leader?.league_team_id) {
    try {
      const { data: lt } = await supa
        .from('league_teams')
        .select('id, nickname, display_name, club_id, user_id')
        .eq('id', leader.league_team_id)
        .maybeSingle();

      let userNickname = null;
      let club = null;
      if (lt?.user_id) {
        const { data: u } = await supa
          .from('users')
          .select('nickname')
          .eq('id', lt.user_id)
          .maybeSingle();
        userNickname = u?.nickname || null;
      }
      if (lt?.club_id) {
        const { data: c } = await supa
          .from('clubs')
          .select('name, crest_url')
          .eq('id', lt.club_id)
          .maybeSingle();
        club = c || null;
      }
      leader = {
        ...leader,
        league_teams: lt ? { ...lt, userNickname, clubs: club } : null
      };
    } catch (e) {
      console.debug('[comp-hero] No se pudo enriquecer líder:', e);
    }
  }

  return {
    numTeams: getCount(teamsR),
    numMatchesPlayed: getCount(playedR),
    numMatchesTotal: getCount(totalR),
    // Jornada visible = rounds.number (1..N), no round_id (PK global). Ver
    // nota en stats-data.js: solo coincidían por azar en Liga Principal 25-26.
    currentJornada: Array.isArray(lastRoundArr) && lastRoundArr[0]
      ? (lastRoundArr[0].round?.number ?? lastRoundArr[0].round_id ?? null)
      : null,
    leader
  };
}

/**
 * Construye el HTML del hero. Acepta competition y stats; stats puede ser null
 * mientras se cargan las métricas.
 */
function buildHeroHtml(competition, stats) {
  const name = escapeHtml(competition.name || 'Competición');
  const season = escapeHtml(competition.season || '');
  const typeLabel = TYPE_LABEL[competition.competition_type] || '';
  const isOfficial = !!competition.is_official;

  const logoSrc = competition.logo_url || 'img/logo.png';
  const logoHtml = `<img class="comp-hero-logo" src="${escapeHtml(logoSrc)}" alt="" onerror="this.style.visibility='hidden'">`;

  const eyebrowParts = [];
  if (season) eyebrowParts.push(`Temporada ${season}`);
  if (typeLabel) eyebrowParts.push(typeLabel);
  if (isOfficial) eyebrowParts.push('Oficial');
  const eyebrow = eyebrowParts.join(' · ');

  // Métricas: solo se renderizan cuando stats está listo
  let metaHtml = '';
  if (stats) {
    const chips = [];
    if (stats.currentJornada != null) {
      chips.push(`<span class="comp-hero-chip"><strong>J${stats.currentJornada}</strong> jornada</span>`);
    }
    if (stats.numTeams != null) {
      chips.push(`<span class="comp-hero-chip"><strong>${stats.numTeams}</strong> equipos</span>`);
    }
    if (stats.numMatchesPlayed != null && stats.numMatchesTotal != null) {
      chips.push(`<span class="comp-hero-chip"><strong>${stats.numMatchesPlayed}/${stats.numMatchesTotal}</strong> partidos</span>`);
    } else if (stats.numMatchesPlayed != null) {
      chips.push(`<span class="comp-hero-chip"><strong>${stats.numMatchesPlayed}</strong> partidos jugados</span>`);
    }
    if (chips.length) {
      metaHtml = `<div class="comp-hero-meta">${chips.join('')}</div>`;
    }
  }

  // Líder (solo ligas)
  let leaderHtml = '';
  if (stats?.leader) {
    const lt = stats.leader.league_teams || {};
    const clubs = lt.clubs || {};
    const leaderName = lt.nickname || lt.userNickname || lt.display_name || clubs.name || '—';
    const leaderCrest = clubs.crest_url || null;
    const pts = stats.leader.pts ?? 0;
    const wins = stats.leader.g ?? 0;

    leaderHtml = `
      <div class="comp-hero-leader">
        <span class="comp-hero-leader-label">🏆 Líder</span>
        ${leaderCrest
          ? `<img class="comp-hero-leader-crest" src="${escapeHtml(leaderCrest)}" alt="" onerror="this.style.display='none'">`
          : `<div class="comp-hero-leader-crest comp-hero-leader-crest-empty" aria-hidden="true"></div>`
        }
        <div class="comp-hero-leader-body">
          <strong>${escapeHtml(leaderName)}</strong>
          <span>${pts} pts · ${wins}G</span>
        </div>
      </div>
    `;
  }

  return `
    <div class="comp-hero-inner">
      <div class="comp-hero-brand">
        ${logoHtml}
        <div class="comp-hero-titles">
          ${eyebrow ? `<div class="comp-hero-eyebrow">${eyebrow}</div>` : ''}
          <h2 class="comp-hero-title">${name}</h2>
          ${metaHtml}
        </div>
      </div>
      ${leaderHtml}
    </div>
  `;
}

/**
 * Punto de entrada: renderiza el hero si estamos en una página de competición.
 * No bloquea si falla la carga de métricas — se muestra con lo que haya.
 */
export async function renderCompetitionHero() {
  const zone = getPageZone(getCurrentPageName());
  if (zone.name !== 'COMPETITION') return;

  let competition;
  try {
    competition = await getCurrentCompetition();
  } catch (e) {
    console.debug('[comp-hero] No se pudo obtener la competición:', e);
    return;
  }
  if (!competition) return;

  // Encontrar o crear el contenedor del hero
  let heroEl = document.getElementById(HERO_ID);
  if (!heroEl) {
    const header = document.querySelector('.site-header');
    const main = document.querySelector('main');
    if (!main) return;
    heroEl = document.createElement('section');
    heroEl.id = HERO_ID;
    heroEl.className = 'comp-hero';
    // Insertar entre header y main; si no hay header, antes del main
    if (header && header.nextSibling) {
      header.parentNode.insertBefore(heroEl, header.nextSibling);
    } else {
      main.parentNode.insertBefore(heroEl, main);
    }
  }

  // Render inicial sin stats (se ve instantáneamente)
  heroEl.innerHTML = buildHeroHtml(competition, null);

  // Cargar métricas en segundo plano y actualizar
  try {
    const stats = await loadHeroStats(competition.id, competition.competition_type);
    heroEl.innerHTML = buildHeroHtml(competition, stats);
  } catch (e) {
    console.debug('[comp-hero] Error cargando stats:', e);
    // Dejamos el hero sin stats; mejor eso que nada
  }
}
