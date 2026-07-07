/**
 * Render generic table
 * @param {HTMLElement} container - Target container
 * @param {Object} options
 * @param {string[]} options.headers - Array of header strings
 * @param {string} options.rowsHtml - HTML string for tbody
 * @param {string} [options.className] - Table classes ex: "tabla tabla-compact"
 */
export function renderTable(container, { headers, rowsHtml, className = "tabla tabla-compact" }) {
    if (!container) return;
    const ths = headers.map(h => `<th>${h}</th>`).join('');
    container.innerHTML = `
      <table class="${className}">
        <thead>
          <tr>${ths}</tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    `;
}

/**
 * Render loading state
 * @param {HTMLElement} container 
 * @param {string} text 
 */
export function renderLoader(container, text = "Cargando...") {
    if (!container) return;
    container.innerHTML = `<p class="muted">${text}</p>`;
}

/**
 * Render error state
 * @param {HTMLElement} container 
 * @param {string} text 
 */
export function renderError(container, text = "Ha ocurrido un error.") {
    if (!container) return;
    container.innerHTML = `<p class="muted">${text}</p>`;
}

/**
 * Render empty state
 * @param {HTMLElement} container 
 * @param {string} text 
 */
export function renderEmpty(container, text = "No hay datos disponibles.") {
    if (!container) return;
    container.innerHTML = `<p class="muted">${text}</p>`;
}

/**
 * Render generic card/HTML content
 * @param {HTMLElement} container 
 * @param {string} html 
 */
export function renderContent(container, html) {
    if (!container) return;
    container.innerHTML = html;
}
