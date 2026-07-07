/**
 * Sistema de tabs para los hubs de admin (manage-competition, admin global).
 *
 * Marcado esperado:
 *   <nav class="admin-tabs" role="tablist">
 *     <a href="#" data-tab="resumen" role="tab">Resumen</a>
 *     ...
 *   </nav>
 *   <div class="admin-tab-panel" data-tab-panel="resumen">...</div>
 *   <div class="admin-tab-panel" data-tab-panel="equipos">...</div>
 *
 * La tab activa se guarda en `?tab=` y persiste con `history.replaceState`,
 * así los enlaces externos pueden apuntar a una tab concreta.
 */
export function initAdminTabs(options = {}) {
  const {
    defaultTab = null,
    onTabChange = null,
    paramName = 'tab'
  } = options;

  const tabs = Array.from(document.querySelectorAll('.admin-tabs [data-tab]'));
  const panels = Array.from(document.querySelectorAll('[data-tab-panel]'));

  if (!tabs.length || !panels.length) {
    console.warn('[admin-tabs] No se encontraron tabs o panels');
    return { activate: () => {}, current: () => null };
  }

  const validTabs = new Set(tabs.map(t => t.dataset.tab));
  const fallback = defaultTab && validTabs.has(defaultTab)
    ? defaultTab
    : tabs[0].dataset.tab;

  let current = null;

  function activate(tabName, { updateUrl = true } = {}) {
    if (!validTabs.has(tabName)) tabName = fallback;
    if (tabName === current) return;

    tabs.forEach(t => {
      const active = t.dataset.tab === tabName;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    panels.forEach(p => {
      p.hidden = p.dataset.tabPanel !== tabName;
    });

    if (updateUrl) {
      const url = new URL(window.location);
      url.searchParams.set(paramName, tabName);
      window.history.replaceState({}, '', url);
    }

    current = tabName;
    if (onTabChange) {
      try { onTabChange(tabName); } catch (e) { console.error('[admin-tabs] onTabChange error', e); }
    }
  }

  // Tab inicial: ?tab=… si es válido, sino fallback.
  const params = new URLSearchParams(window.location.search);
  const initial = params.get(paramName);
  activate(validTabs.has(initial) ? initial : fallback, { updateUrl: false });

  // Listeners.
  tabs.forEach(t => {
    t.addEventListener('click', (e) => {
      e.preventDefault();
      activate(t.dataset.tab);
    });
  });

  // Permite que código externo cambie de tab.
  return {
    activate,
    current: () => current
  };
}

/**
 * Muestra/oculta una tab dinámicamente (p.ej. la tab "Bracket" solo en copas).
 */
export function setTabVisible(tabName, visible) {
  document.querySelectorAll(`.admin-tabs [data-tab="${tabName}"]`).forEach(t => {
    t.hidden = !visible;
  });
}
