// Backward Compatibility Loader
// Imports new ES Modules and exposes them globally as AppUtils

import * as Config from './modules/config.js';
import * as Utils from './modules/utils.js';
import * as Supabase from './modules/supabase-client.js';
import * as Auth from './modules/auth.js';
import * as UI from './modules/ui.js';
import * as Domain from './modules/domain.js';
import { initContextGuard } from './modules/competition-context-guard.js';
import { renderCompetitionContextBanner } from './modules/competition-context-banner.js';
import { renderCompetitionHero } from './modules/competition-hero.js';
import { setupLinkInterceptor } from './modules/link-interceptor.js';

// Expose configuration
window.SUPABASE_CONFIG = Config.SUPABASE_CONFIG;

// Combine all helpers into AppUtils
const AppUtils = {
    ...Utils,
    ...Supabase,
    ...Auth,
    ...Domain,
    // Add direct refs for convenience if they were used directly before (though common.js put them in AppUtils)
};

// Expose globally
window.AppUtils = AppUtils;

// Also expose individual helpers globally for backward compatibility (e.g. fmtDate, normalizeText)
Object.keys(AppUtils).forEach(key => {
    if (typeof window[key] === 'undefined') {
        window[key] = AppUtils[key];
    }
});

// Initialize UI (Nav, Header) and Competition Context Guards when DOM is ready
const initApp = async () => {
    try {
        // 0. Hidratar la temporada activa desde la BD (no bloquea: si falla, fallback al config).
        try {
            const { getActiveSeasonName } = await import('./modules/seasons-data.js');
            await getActiveSeasonName();
        } catch (e) {
            console.debug('[Loader] No se pudo hidratar la temporada activa:', e?.message || e);
        }

        // 1. Validar contexto de competición (puede redirigir si es necesario)
        const contextValid = await initContextGuard();
        if (!contextValid) {
            // Si no es válido y redirige, no continuar con la inicialización
            return;
        }
        
        // 2. Inicializar navegación
        await UI.initNavigation();

        // 3. Renderizar banner de contexto (solo en páginas de competición)
        await renderCompetitionContextBanner();

        // 4. Renderizar hero de competición (solo en zona COMPETITION)
        //    No bloquea el resto si falla
        renderCompetitionHero().catch(err => {
            console.debug('[Loader] Hero de competición falló:', err);
        });

        // 5. Configurar interceptor de enlaces
        setupLinkInterceptor();
        
        console.log('[Loader] App initialization complete');
    } catch (err) {
        console.error('Error inicializando aplicación:', err);
    }
};

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initApp);
} else {
    initApp();
}

console.log('AppUtils loaded via ES Modules wrapper.');
