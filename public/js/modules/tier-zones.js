/**
 * Zonas de clasificación.
 *
 * Hay dos modos:
 *
 * 1) **Config-driven** (preferente): la competición trae
 *    `config.standings_zones = [{from, to, slug, label, color}]` con posiciones
 *    1-based. Se pinta cada fila y cabecera con el color de su zona.
 *    Usado por las ligas 26-27 (Voll Damm, Estrella Damm).
 *
 * 2) **Legacy proporcional** (fallback): si la competición no tiene
 *    `standings_zones`, se aplica el reparto 8/4/4 escalado desde la liga
 *    principal 25-26 de 22 equipos (verde top-8, amarillo 9-12, rojo
 *    últimos 4) con labels Voll Damm directo / previa / Free Damm previa.
 */

// Tamaño de referencia de la liga 25-26 (legacy)
const REF_SIZE = 22;
const REF_TOP = 8;
const REF_MID = 4;
const REF_BOTTOM = 4;

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Devuelve un color hexadecimal validado o `null`. Evita inyección al
 * usar el valor en `style="--zone-color: ..."`.
 */
export function safeHexColor(value) {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  return HEX_RE.test(v) ? v : null;
}

/**
 * Calcula los tamaños de cada zona legacy para una liga de N equipos.
 * Garantiza que no se solapen y que cada zona tenga al menos 1 equipo
 * (salvo que el total sea demasiado pequeño).
 */
export function getZoneCounts(totalTeams) {
  if (!Number.isFinite(totalTeams) || totalTeams < 6) {
    return { top: 0, mid: 0, bottom: 0 };
  }

  let top = Math.max(1, Math.round((totalTeams * REF_TOP) / REF_SIZE));
  let mid = Math.max(0, Math.round((totalTeams * REF_MID) / REF_SIZE));
  let bottom = Math.max(1, Math.round((totalTeams * REF_BOTTOM) / REF_SIZE));

  while (top + mid + bottom > totalTeams && mid > 0) {
    mid--;
  }
  while (top + bottom > totalTeams) {
    if (bottom > 1) bottom--;
    else if (top > 1) top--;
    else break;
  }

  return { top, mid, bottom };
}

/**
 * Devuelve la clase de zona legacy para una posición 0-based.
 * @returns {'tier-top'|'tier-mid'|'tier-bottom'|''}
 */
export function getTierClass(pos, totalTeams) {
  const { top, mid, bottom } = getZoneCounts(totalTeams);
  if (top === 0) return '';

  const redStart = totalTeams - bottom;
  if (pos >= redStart) return 'tier-bottom';
  if (pos < top) return 'tier-top';
  if (pos < top + mid && pos < redStart) return 'tier-mid';
  return '';
}

/**
 * Resuelve las zonas de una clasificación.
 *
 * @param {Object} opts
 * @param {number} opts.totalTeams
 * @param {Array<{from:number,to:number,slug?:string,label?:string,color?:string}>} [opts.standingsZones]
 *
 * @returns {{
 *   mode: 'config'|'legacy',
 *   getRow: (pos:number) => { className: string, color: string|null, label: string|null, slug: string|null },
 *   headers: Array<{ startPos:number, count:number, label:string, color:string|null, slug:string|null, variant:string }>
 * }}
 *
 * `pos` y `startPos` son 0-based.
 */
export function resolveZones({ totalTeams, standingsZones } = {}) {
  const len = Number.isFinite(totalTeams) ? totalTeams : 0;

  if (Array.isArray(standingsZones) && standingsZones.length > 0) {
    const byPos = new Map();
    const headers = [];

    const sorted = [...standingsZones]
      .filter(z => Number.isFinite(z?.from) && Number.isFinite(z?.to))
      .sort((a, b) => a.from - b.from);

    for (const z of sorted) {
      const from = Math.max(1, z.from | 0);
      const to = Math.min(len, Math.max(from, z.to | 0));
      if (from > len) continue;

      const count = to - from + 1;
      const color = safeHexColor(z.color);
      const label = typeof z.label === 'string' && z.label.trim() ? z.label : (z.slug || '');
      const slug = typeof z.slug === 'string' ? z.slug : null;

      headers.push({
        startPos: from - 1,
        count,
        label,
        color,
        slug,
        variant: 'custom',
      });

      for (let p = from; p <= to; p++) {
        if (!byPos.has(p - 1)) {
          byPos.set(p - 1, { color, label, slug });
        }
      }
    }

    return {
      mode: 'config',
      getRow: (pos) => {
        const z = byPos.get(pos);
        if (!z) return { className: '', color: null, label: null, slug: null };
        return { className: 'zoned', color: z.color, label: z.label, slug: z.slug };
      },
      headers,
    };
  }

  // Legacy fallback
  const { top, mid, bottom } = getZoneCounts(len);
  const midStart = top;
  const bottomStart = len - bottom;

  const headers = [];
  if (top > 0) {
    headers.push({ startPos: 0, count: top, label: 'Voll Damm directo', color: null, slug: 'tier-top', variant: 'top' });
  }
  if (mid > 0 && midStart < bottomStart) {
    headers.push({ startPos: midStart, count: mid, label: 'Voll Damm previa', color: null, slug: 'tier-mid', variant: 'mid' });
  }
  if (bottom > 0) {
    headers.push({ startPos: bottomStart, count: bottom, label: 'Free Damm previa', color: null, slug: 'tier-bottom', variant: 'bottom' });
  }

  return {
    mode: 'legacy',
    getRow: (pos) => ({
      className: getTierClass(pos, len),
      color: null,
      label: null,
      slug: null,
    }),
    headers,
  };
}
