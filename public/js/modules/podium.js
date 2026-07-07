/**
 * Módulo de podio visual para rankings
 * Renderiza un top-3 en forma de podio (2° · 1° · 3°) antes de una tabla.
 *
 * Uso:
 *   renderPodium(container, items, {
 *     getName: it => it.nombre,
 *     getValue: it => it.gf,
 *     valueLabel: 'goles',
 *     getSubtitle: it => `${it.pj} PJ`,     // opcional
 *     getImg: it => `img/${slug(it.nombre)}.png`, // opcional
 *     imgRounded: 'square' | 'circle',      // 'square' por defecto (escudos)
 *   });
 *
 * - Si items tiene menos de 3, se renderizan solo los disponibles.
 * - Si items está vacío, se limpia el contenedor.
 */

import { escapeHtml } from './utils.js';

const CROWN = `
  <svg class="podium-crown" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
    <path d="M5 18h14l1.5-9-4.5 3-3.5-5-3.5 5L4.5 9 6 18zM4 20h16v2H4z"/>
  </svg>
`;

function formatValue(v) {
  if (v == null || v === '') return '—';
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return String(v);
    return v.toFixed(2);
  }
  return String(v);
}

export function renderPodium(container, items, config = {}) {
  if (!container) return;

  const {
    getName,
    getValue,
    valueLabel = '',
    getSubtitle = null,
    getImg = null,
    imgRounded = 'square',
    getHref = null
  } = config;

  if (!Array.isArray(items) || items.length === 0) {
    container.innerHTML = '';
    return;
  }

  if (typeof getName !== 'function' || typeof getValue !== 'function') {
    console.warn('[podium] getName y getValue son obligatorios');
    container.innerHTML = '';
    return;
  }

  const top = items.slice(0, 3);
  // Orden visual: 2°, 1°, 3° (el 1° queda en el centro, más alto)
  const visualOrder = [top[1], top[0], top[2]].filter(Boolean);

  const cardHtml = (item, rank) => {
    if (!item) return '';
    const name = escapeHtml(getName(item) || '—');
    const value = escapeHtml(formatValue(getValue(item)));
    const subtitle = getSubtitle ? escapeHtml(getSubtitle(item) || '') : '';
    const imgSrc = getImg ? getImg(item) : null;
    const href = getHref ? getHref(item) : null;

    const imgHtml = imgSrc
      ? `<img class="podium-avatar podium-avatar-${imgRounded}" src="${escapeHtml(imgSrc)}" alt="" onerror="this.style.visibility='hidden'">`
      : `<div class="podium-avatar podium-avatar-${imgRounded} podium-avatar-empty" aria-hidden="true"></div>`;

    const rankLabel = rank === 1 ? CROWN : `<span class="podium-rank-num">${rank}</span>`;
    const rankClass = `podium-card podium-rank-${rank}`;

    const inner = `
      <div class="podium-rank-badge">${rankLabel}</div>
      ${imgHtml}
      <div class="podium-name" title="${name}">${name}</div>
      ${subtitle ? `<div class="podium-subtitle">${subtitle}</div>` : ''}
      <div class="podium-value">${value}</div>
      ${valueLabel ? `<div class="podium-value-label">${escapeHtml(valueLabel)}</div>` : ''}
    `;

    if (href) {
      return `<a href="${escapeHtml(href)}" class="${rankClass} podium-card-link">${inner}</a>`;
    }
    return `<div class="${rankClass}">${inner}</div>`;
  };

  container.className = 'podium';
  container.innerHTML = visualOrder
    .map(item => {
      const rank = top.indexOf(item) + 1;
      return cardHtml(item, rank);
    })
    .join('');
}
