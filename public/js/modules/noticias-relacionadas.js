// Widget para mostrar las noticias relacionadas con una entidad concreta
// (jugador, equipo/manager, partido) embebido en la ficha correspondiente.
//
// Uso típico:
//   import { renderNoticiasRelacionadas } from '../modules/noticias-relacionadas.js';
//   await renderNoticiasRelacionadas(document.getElementById('noticias-jugador'),
//     { player_id: PLAYER_ID }, { limit: 5 });
//
// El widget consulta `noticias` filtrando por `angle_refs->>player_id` (o el
// campo correspondiente), hidrata firmas de periodistas y renderiza una lista
// compacta clicable. Cada ítem lleva al detalle filtrado en noticias-globales.
// Si no hay noticias relacionadas, no pinta nada (no rellena ni con vacío).

import { getSupabaseClient } from './supabase-client.js';
import { escapeHtml } from './utils.js';
import { ANGLE_LABELS, getSection } from './news-meta.js';

const fmtDate = (d) => {
    if (!d) return '';
    const date = new Date(d);
    const dd = String(date.getDate()).padStart(2, '0');
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    return `${dd}/${mm}/${date.getFullYear()}`;
};

/**
 * @param {HTMLElement} container — donde inyectar el bloque
 * @param {Object} ref — { player_id?, league_team_id?, league_team_ids?, match_uuid? }
 * @param {Object} options — { limit?: 5, title?: 'Noticias relacionadas', excludeKinds?: [] }
 */
export async function renderNoticiasRelacionadas(container, ref, options = {}) {
    if (!container) return;
    const { limit = 5, title = 'Noticias relacionadas', excludeKinds = [] } = options;

    let supabase;
    try {
        supabase = await getSupabaseClient();
    } catch (e) {
        console.warn('[noticias-relacionadas] no supabase:', e?.message);
        return;
    }

    let q = supabase.from('noticias')
        .select('*')
        .or('oculta.is.null,oculta.eq.false')
        .order('fecha', { ascending: false })
        .limit(limit);

    // Excluir tipos concretos (p. ej. 'match_chronicle', que tiene su propia
    // pestaña en partido.html). Conserva las de angle_kind nulo.
    if (Array.isArray(excludeKinds) && excludeKinds.length) {
        q = q.or(`angle_kind.is.null,angle_kind.not.in.(${excludeKinds.join(',')})`);
    }

    let allUrlParam = '';
    if (Array.isArray(ref?.league_team_ids) && ref.league_team_ids.length) {
        q = q.in('angle_refs->>league_team_id', ref.league_team_ids.map(String));
        allUrlParam = `league_team_id=${encodeURIComponent(ref.league_team_ids[0])}`;
    } else if (ref?.player_id != null) {
        q = q.eq('angle_refs->>player_id', String(ref.player_id));
        allUrlParam = `player_id=${encodeURIComponent(ref.player_id)}`;
    } else if (ref?.league_team_id != null) {
        q = q.eq('angle_refs->>league_team_id', String(ref.league_team_id));
        allUrlParam = `league_team_id=${encodeURIComponent(ref.league_team_id)}`;
    } else if (ref?.match_uuid != null) {
        q = q.eq('angle_refs->>match_uuid', String(ref.match_uuid));
        allUrlParam = `match_uuid=${encodeURIComponent(ref.match_uuid)}`;
    } else {
        return;
    }

    const { data: noticias, error } = await q;
    if (error) {
        console.warn('[noticias-relacionadas] query error:', error.message);
        return;
    }
    if (!noticias?.length) return;

    // Hidratar periodistas
    const journalistIds = [...new Set(noticias.map(n => n.journalist_id).filter(Boolean))];
    let journalistMap = new Map();
    if (journalistIds.length) {
        const { data: jrs } = await supabase
            .from('journalists')
            .select('id, name, voice')
            .in('id', journalistIds);
        journalistMap = new Map((jrs ?? []).map(j => [j.id, j]));
    }

    const allUrl = allUrlParam ? `noticias-globales.html?${allUrlParam}` : 'noticias-globales.html';

    const items = noticias.map(n => {
        const a = ANGLE_LABELS[n.angle_kind];
        const j = journalistMap.get(n.journalist_id);
        const section = j ? getSection(j.voice) : null;
        const fecha = fmtDate(n.fecha);
        return `
            <a class="noticia-rel-item" href="${allUrl}" data-noticia-id="${escapeHtml(n.id)}">
                ${a ? `<span class="news-badge noticia-rel-badge">${a.emoji} ${escapeHtml(a.label)}</span>` : ''}
                <span class="noticia-rel-titulo">${escapeHtml(n.titulo || '')}</span>
                <span class="noticia-rel-meta">
                    ${j ? `<em>${escapeHtml(j.name)}${section ? ` · ${escapeHtml(section)}` : ''}</em>` : ''}
                    ${fecha ? `<span class="noticia-rel-fecha">· ${escapeHtml(fecha)}</span>` : ''}
                </span>
            </a>
        `;
    }).join('');

    container.innerHTML = `
        <section class="noticias-rel">
            <div class="noticias-rel__header">
                <h3 class="noticias-rel__title">${escapeHtml(title)}</h3>
                <a class="noticias-rel__more" href="${allUrl}">Ver todas →</a>
            </div>
            <div class="noticias-rel__list">${items}</div>
        </section>
    `;
}
