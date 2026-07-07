// ─────────────────────────────
// HELPERS BASE
// ─────────────────────────────

export const normalizeText = (value) => String(value || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim();

export const escapeHtml = (value) => String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export const slugify = (value) => normalizeText(value).replace(/\s+/g, '-');

/**
 * Devuelve HTML con un link a la ficha del jugador. Si no hay id, devuelve solo
 * el nombre escapado (sin link).
 */
export function playerLink(playerId, playerName) {
    const safeName = escapeHtml(playerName ?? '');
    if (playerId == null || playerId === '') return safeName;
    return `<a href="jugador.html?id=${encodeURIComponent(playerId)}" class="text-link">${safeName}</a>`;
}

/** Link inline a manager.html?user=<nickname>. Si falta nickname, devuelve solo el label escapado. */
export function managerLink(nickname, label) {
    const text = escapeHtml(label || nickname || '');
    if (!nickname) return text;
    return `<a href="manager.html?user=${encodeURIComponent(nickname)}" class="text-link">${text}</a>`;
}

/** Link inline a entidad.html?id=<clubId>. Si falta id, devuelve solo el nombre. */
export function entityLink(clubId, name) {
    const text = escapeHtml(name || '');
    if (clubId == null || clubId === '') return text;
    return `<a href="entidad.html?id=${encodeURIComponent(clubId)}" class="text-link">${text}</a>`;
}

/** Link inline a la página de palmarés de una competición. */
export function competitionLink(slug, name) {
    const text = escapeHtml(name || '');
    if (!slug) return text;
    return `<a href="competicion-palmares.html?comp=${encodeURIComponent(slug)}" class="text-link">${text}</a>`;
}

/** Link inline a partido.html. Acepta label HTML (no se escapa, asumir ya escapado). */
export function matchLink(compSlug, matchId, labelHtml) {
    const url = compSlug
        ? `partido.html?comp=${encodeURIComponent(compSlug)}&match=${encodeURIComponent(matchId)}`
        : `partido.html?match=${encodeURIComponent(matchId)}`;
    return `<a href="${url}" class="text-link">${labelHtml}</a>`;
}

export const logoPath = (name, base = 'img') => `${base}/${slugify(name)}.png`;

export const fmtDate = (iso) => {
    const d = new Date(iso);
    if (isNaN(d)) return '';
    return d.toLocaleDateString('es-ES', { day: '2-digit', month: 'short', year: 'numeric' });
};

/**
 * Format date string to readable format
 * @param {string} dateString - ISO date string
 * @returns {string} Formatted date string (e.g., "15 ene 2025")
 */
export function formatDate(dateString) {
    if (!dateString) return '';
    try {
        const date = new Date(dateString);
        return date.toLocaleDateString('es-ES', { 
            year: 'numeric', 
            month: 'short', 
            day: 'numeric' 
        });
    } catch (e) {
        return dateString;
    }
}

/**
 * Get status badge HTML for competition status
 * @param {string} status - Competition status (draft, open, active, finished)
 * @returns {string} HTML badge string
 */
export function getStatusBadge(status) {
    const badges = {
        'draft': '<span class="badge badge-draft">Borrador</span>',
        'open': '<span class="badge badge-open">Inscripciones abiertas</span>',
        'active': '<span class="badge badge-active">Activa</span>',
        'finished': '<span class="badge badge-finished">Finalizada</span>'
    };
    return badges[status] || '';
}

export async function loadJSON(path) {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) throw new Error('No se pudo cargar ' + path);
    return res.json();
}

export const isNum = (v) => typeof v === "number" && Number.isFinite(v);

export const toNum = (v) => {
    if (v == null || v === "") return 0;
    const n = parseFloat(String(v).replace(",", "."));
    return Number.isFinite(n) ? n : 0;
};

