// Mini renderer markdown → HTML para los cuerpos de noticias generadas
// por el news-writer. NO es un parser completo (no soporta tablas, code
// blocks multilinea, blockquotes anidados, imágenes con alt text complejo).
// Cubre exactamente lo que produce nuestro Lambda:
//   - Headers (# .. ######)
//   - Párrafos (separados por línea en blanco)
//   - Bold (**texto**) e itálica (*texto* o _texto_)
//   - Listas no ordenadas (- item, * item) y ordenadas (1. item)
//   - Links [texto](url)
//   - Horizontal rule (---)
//   - Inline code (`texto`)
//
// Sanitización: el texto se pasa por escapeHtml ANTES de aplicar reglas
// markdown, así cualquier <script> u HTML del modelo queda neutralizado.
// Solo emitimos tags conocidos por nosotros, y los hrefs van por safeUrl.

import { escapeHtml } from './utils.js';

const safeUrl = (url) => {
    if (!url) return '#';
    const s = String(url).trim();
    return /^(https?:|\/|\.\/|\.\.\/|#)/i.test(s) ? s : '#';
};

/**
 * Heurística para distinguir cuerpos markdown (escritos por el news-writer)
 * de cuerpos HTML legacy (escritos en el editor admin). Cuando la noticia
 * tiene `journalist_id` no null, viene del news-writer y es markdown.
 * Como fallback miramos si el cuerpo arranca con un header markdown o tiene
 * marcadores típicos sin tags HTML.
 */
export function looksLikeMarkdown(noticia) {
    if (!noticia) return false;
    if (noticia.journalist_id != null) return true;
    const c = String(noticia.cuerpo ?? '').trim();
    if (!c) return false;
    if (/<\/?(p|div|br|strong|em|h[1-6]|ul|ol|li|a|img)\b/i.test(c)) return false;
    return /^#{1,6}\s|\n#{1,6}\s|\*\*[^*]+\*\*/.test(c);
}

export function renderMarkdown(md) {
    if (md == null) return '';
    const text = String(md).replace(/\r\n/g, '\n').trim();
    if (!text) return '';

    // Dividir en bloques por línea(s) en blanco
    const blocks = text.split(/\n{2,}/);
    return blocks.map(renderBlock).filter(Boolean).join('\n');
}

function renderBlock(block) {
    const trimmed = block.trim();
    if (!trimmed) return '';

    // Horizontal rule (línea entera de guiones)
    if (/^-{3,}$/.test(trimmed)) return '<hr>';

    // Heading
    const h = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
        const level = h[1].length;
        return `<h${level}>${renderInline(h[2])}</h${level}>`;
    }

    const lines = trimmed.split('\n');

    // Lista ordenada (todas las líneas empiezan por "1. ", "2. "...)
    if (lines.every(l => /^\d+\.\s+/.test(l))) {
        const items = lines.map(l => `<li>${renderInline(l.replace(/^\d+\.\s+/, ''))}</li>`).join('');
        return `<ol>${items}</ol>`;
    }

    // Lista no ordenada (todas las líneas empiezan por "- " o "* ")
    if (lines.every(l => /^[-*]\s+/.test(l))) {
        const items = lines.map(l => `<li>${renderInline(l.replace(/^[-*]\s+/, ''))}</li>`).join('');
        return `<ul>${items}</ul>`;
    }

    // Párrafo: las líneas individuales dentro de un mismo bloque se unen con <br>
    const inner = lines.map(renderInline).join('<br>');
    return `<p>${inner}</p>`;
}

function renderInline(text) {
    // 1. Escape HTML primero — todo lo que entre será texto plano salvo
    //    los tags que generemos nosotros más abajo.
    let html = escapeHtml(text);

    // 2. Inline code: `texto` (antes de los demás para no comer asteriscos dentro)
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // 3. Links: [texto](url)
    html = html.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) =>
        `<a href="${safeUrl(u)}" target="_blank" rel="noopener">${t}</a>`);

    // 4. Bold: **texto** (antes de italic; no permite asteriscos dentro)
    html = html.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');

    // 5. Italic asterisco: *texto* — solo si los * están en frontera de palabra
    //    o tras espacio/inicio. Evita matchear "5 * 3" o asteriscos sueltos.
    html = html.replace(/(^|[\s(>])\*([^\s*][^*\n]*?[^\s*]|[^\s*])\*(?=$|[\s.,!?;:)])/g, '$1<em>$2</em>');

    // 6. Italic underscore: _texto_ — mismas reglas
    html = html.replace(/(^|[\s(>])_([^\s_][^_\n]*?[^\s_]|[^\s_])_(?=$|[\s.,!?;:)])/g, '$1<em>$2</em>');

    return html;
}
