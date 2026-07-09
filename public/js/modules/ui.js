import { getCurrentUser, getCurrentProfile, logout } from './auth.js';
import { escapeHtml } from './utils.js';
import { getCompetitionFromURL, buildURLWithCompetition } from './competition-context.js';
import { renderCompetitionSelector } from './competition-selector.js';
import { getCurrentPageName, getPageZone } from './navigation-zones.js';

export async function renderUserSection() {
    // liga-offline no tiene auth (un solo jugador local): no se pinta la
    // sección de usuario (Login / Mi Perfil / Dashboard / Logout) del original.
    return;
}

// eslint-disable-next-line no-unused-vars
async function _renderUserSectionOnline() {
    const header = document.querySelector('.site-header');
    if (!header) return;

    let container = document.getElementById('user-section');
    if (!container) {
        container = document.createElement('div');
        container.id = 'user-section';
        container.className = 'user-section';
        header.appendChild(container);
    }

    const user = await getCurrentUser();
    if (!user) {
        container.innerHTML = `<a href="login.html">Login</a>`;
        return;
    }

    const profile = await getCurrentProfile();
    const safeName = escapeHtml(profile?.nickname || user.email);

    // Verificar si el usuario es admin (super admin o admin de alguna competición)
    let isAnyAdmin = false;
    if (profile?.is_super_admin || profile?.is_admin) {
        // Super admin o admin global
        isAnyAdmin = true;
    } else {
        // Verificar si es admin de alguna competición
        try {
            const { getUserAdminCompetitions } = await import('./competition-permissions.js');
            const adminCompetitions = await getUserAdminCompetitions();
            isAnyAdmin = adminCompetitions && adminCompetitions.length > 0;
        } catch (e) {
            console.debug('Error verificando competiciones admin:', e);
        }
    }

    // Dashboard solo aparece si está logueado, al lado del nombre
    // Dashboard nunca debe tener el parámetro comp
    let html = `<span class="user-name">${safeName}</span>`;
    html += ` | <a href="profile.html">Mi Perfil</a>`;
    html += ` | <a href="dashboard.html">Dashboard</a>`;
    if (isAnyAdmin) {
        html += ` | <a href="admin.html">Admin</a>`;
    }
    html += ` | <a href="#" id="logout-btn">Logout</a>`;

    container.innerHTML = html;

    const logoutBtn = document.getElementById('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            await logout();
        });
    }
}

export async function initNavigation() {
    // Obtener el parámetro comp de la URL si existe (lo necesitamos para el logo también)
    let competitionSlug = getCompetitionFromURL();

    // Si no hay parámetro en la URL pero estamos en una página de liga, intentar obtenerlo del contexto
    if (!competitionSlug) {
        const currentPage = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
        const ligaPages = ['liga.html', 'clasificacion.html', 'resultados.html', 'jornada.html', 'club.html',
            'pichichi.html', 'clubs.html', 'jugadores.html', 'noticias.html',
            'reglas.html', 'directos.html', 'partido.html', 'calculadora.html', 'quiniela.html'];
        if (ligaPages.includes(currentPage)) {
            try {
                const { getCurrentCompetitionSlug } = await import('./competition-context.js');
                competitionSlug = await getCurrentCompetitionSlug();
            } catch (e) {
                console.debug('No se pudo obtener competitionSlug del contexto:', e);
            }
        }
    }

    // ✔ Convertir automáticamente el LOGO del header en enlace
    const headerLogo = document.querySelector('.site-header .logo');
    if (headerLogo) {
        // Determinar el comportamiento del logo según la zona
        const currentZone = getPageZone(getCurrentPageName());
        let logoHref = 'index.html';
        let logoClickHandler = null;

        // Si estamos en zona de competición, el logo va a liga.html con el contexto
        if (currentZone.name === 'COMPETITION' || currentZone.name === 'ADMIN') {
            if (competitionSlug) {
                logoHref = buildURLWithCompetition('liga.html', competitionSlug);
            } else {
                // Si no hay competitionSlug pero estamos en zona de competición, ir a competitions.html
                logoHref = 'competitions.html';
            }
        }

        // Crear o actualizar el wrapper del logo
        let wrapper = headerLogo.closest('a');
        if (!wrapper) {
            wrapper = document.createElement('a');
            wrapper.style.display = 'inline-block';
            headerLogo.parentNode.insertBefore(wrapper, headerLogo);
            wrapper.appendChild(headerLogo);
        }

        wrapper.href = logoHref;
        wrapper.setAttribute('data-logo-link', 'true');

        console.log('[UI] Logo href set to:', logoHref, 'for zone:', currentZone.name);
    }

    // Detectar la zona actual usando getPageZone() (necesario para toda la función)
    const currentPage = (location.pathname.split('/').pop() || 'index.html').toLowerCase();
    const currentZone = getPageZone(currentPage);
    const isGlobalPage = currentZone.name === 'GLOBAL' || currentZone.name === 'ADMIN_GLOBAL';
    
    const header = document.querySelector('.site-header');
    const nav = document.getElementById('main-nav');
    if (nav && header) {
        // Detectar si estamos en una página de landing (para compatibilidad con código existente)
        const isLandingPage = (currentPage === 'index.html' && document.body.classList.contains('page-landing')) ||
            currentPage === 'competitions.html' ||
            currentPage === 'dashboard.html';

        let links;

        // Verificar si estamos en páginas de estadísticas globales (antes de construir el menú)
        const globalStatsPages = ['estadisticas-globales.html', 'jugadores-globales.html', 'pichichi-globales.html'];
        const isGlobalStatsPage = isGlobalPage && globalStatsPages.includes(currentPage);
        
        console.log('[UI Navigation] Debug:', {
            currentPage,
            isGlobalPage,
            isGlobalStatsPage,
            currentZone: currentZone.name,
            globalStatsPages,
            pathname: location.pathname,
            zonePages: currentZone.pages
        });

        // ── Nav de liga-offline ──────────────────────────────────────────
        // Menú recortado: solo páginas que existen en la app offline. El
        // original tenía Noticias/Periodistas/Quiniela/En directo/etc.
        // (sistemas excluidos) — aquí se quedan fuera. Dentro de una
        // competición se mantiene el ?comp= vía buildURLWithCompetition (más
        // abajo), que respeta la lista de páginas globales sin comp.
        if (isGlobalPage) {
            // Home / crear competición (sin contexto de competición).
            links = [
                ['index.html', 'Inicio'],
                ['crear-competicion.html', 'Crear competición']
            ];
        } else {
            // Dentro de una competición — réplica de la nav real, recortada a
            // las páginas que existen offline (fuera Noticias/Directos/Quiniela/
            // Calculadora/Palmarés/managers). buildURLWithCompetition (abajo)
            // mantiene el ?comp= salvo en index.html.
            links = [
                ['index.html', 'Inicio'],
                ['clasificacion.html', 'Clasificación'],
                ['resultados.html', 'Partidos'],
                ['clubs.html', 'Clubs'],
                {
                    type: 'dropdown',
                    label: 'Stats',
                    items: [
                        ['estadisticas.html', 'Jugadores'],
                        ['jugadores.html', 'Equipos'],
                        ['pichichi.html', 'Pichichi'],
                        ['jornada.html', 'Lo mejor de la jornada']
                    ]
                },
                ['configurar-competicion.html', 'Configurar']
            ];
        }

        // Construir los enlaces, manteniendo el parámetro comp si existe
        // Excepto para dashboard, index.html y competitions.html que nunca deben tener comp
        console.log('[UI Navigation] Construyendo HTML del menú con', links.length, 'enlaces');
        nav.innerHTML = links
            .map((link) => {
                // Si es un objeto dropdown
                if (typeof link === 'object' && link.type === 'dropdown') {
                    const submenuItems = link.items
                        .map(([href, label]) => {
                            let finalHref = href;
                            // Si hay un competitionSlug y no es dashboard/index.html/competitions.html y estamos en páginas de liga (no globales), mantener el parámetro comp
                            // Las páginas globales de estadísticas nunca deben tener el parámetro comp
                            if (competitionSlug && href !== 'dashboard.html' && href !== 'index.html' && href !== 'competitions.html' && !isGlobalPage && !isGlobalStatsPage) {
                                finalHref = buildURLWithCompetition(href, competitionSlug);
                            }
                            return `<a href="${finalHref}" data-href="${href}" class="nav-submenu-item">${label}</a>`;
                        })
                        .join('');
                    
                    const dropdownHTML = `
                        <div class="nav-dropdown">
                            <button class="nav-dropdown-toggle" type="button" aria-expanded="false">
                                ${link.label}
                                <span class="nav-dropdown-arrow">▼</span>
                            </button>
                            <div class="nav-dropdown-menu">
                                ${submenuItems}
                            </div>
                        </div>
                    `;
                    console.log('[UI Navigation] Dropdown generado:', link.label, 'con', link.items.length, 'items');
                    return dropdownHTML;
                }
                
                // Enlace normal
                const [href, label] = link;
                let finalHref = href;
                // Si hay un competitionSlug y no es dashboard/index.html/competitions.html y estamos en páginas de liga, mantener el parámetro comp
                if (competitionSlug && href !== 'dashboard.html' && href !== 'index.html' && href !== 'competitions.html' && !isGlobalPage) {
                    finalHref = buildURLWithCompetition(href, competitionSlug);
                }
                return `<a href="${finalHref}" data-href="${href}">${label}</a>`;
            })
            .join('');

        console.log('[UI Navigation] HTML del menú generado, longitud:', nav.innerHTML.length);
        console.log('[UI Navigation] Elementos dropdown encontrados:', nav.querySelectorAll('.nav-dropdown').length);

        // Activar link y manejar submenú
        const pageToCompare = currentPage;
        // Verificar tanto páginas de competición como páginas globales de estadísticas
        const isInStatsPage = pageToCompare === 'jugadores.html' || pageToCompare === 'estadisticas.html' || 
                             pageToCompare === 'pichichi.html' || pageToCompare === 'competicion-palmares.html' ||
                             pageToCompare === 'jugadores-globales.html' || pageToCompare === 'estadisticas-globales.html' || 
                             pageToCompare === 'pichichi-globales.html';

        // Activar enlaces normales
        nav.querySelectorAll('a:not(.nav-submenu-item)').forEach(a => {
            const href = a.getAttribute('data-href') || '';
            const hrefFile = href.split('/').pop().toLowerCase();
            if (hrefFile === pageToCompare) {
                a.classList.add('active');
            }
        });

        // Activar elementos del submenú y abrir el dropdown si estamos en una página de estadísticas
        nav.querySelectorAll('.nav-submenu-item').forEach(a => {
            const href = a.getAttribute('data-href') || '';
            const hrefFile = href.split('/').pop().toLowerCase();
            if (hrefFile === pageToCompare) {
                a.classList.add('active');
                // Abrir el dropdown si estamos en una página de estadísticas
                const dropdown = a.closest('.nav-dropdown');
                if (dropdown) {
                    const toggle = dropdown.querySelector('.nav-dropdown-toggle');
                    const menu = dropdown.querySelector('.nav-dropdown-menu');
                    if (toggle && menu) {
                        toggle.setAttribute('aria-expanded', 'true');
                        dropdown.classList.add('open');
                    }
                }
            }
        });

        // Agregar event listeners para los dropdowns
        nav.querySelectorAll('.nav-dropdown-toggle').forEach(toggle => {
            toggle.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const dropdown = toggle.closest('.nav-dropdown');
                const menu = dropdown.querySelector('.nav-dropdown-menu');
                const isOpen = dropdown.classList.contains('open');
                
                // Cerrar otros dropdowns
                nav.querySelectorAll('.nav-dropdown').forEach(d => {
                    if (d !== dropdown) {
                        d.classList.remove('open');
                        d.querySelector('.nav-dropdown-toggle')?.setAttribute('aria-expanded', 'false');
                    }
                });
                
                // Toggle del dropdown actual
                if (isOpen) {
                    dropdown.classList.remove('open');
                    toggle.setAttribute('aria-expanded', 'false');
                } else {
                    dropdown.classList.add('open');
                    toggle.setAttribute('aria-expanded', 'true');
                }
            });
        });

        // Cerrar dropdowns al hacer click fuera
        document.addEventListener('click', (e) => {
            if (!e.target.closest('.nav-dropdown')) {
                nav.querySelectorAll('.nav-dropdown').forEach(dropdown => {
                    dropdown.classList.remove('open');
                    dropdown.querySelector('.nav-dropdown-toggle')?.setAttribute('aria-expanded', 'false');
                });
            }
        });

        // Cerrar dropdown al hacer click en un item del submenú
        nav.querySelectorAll('.nav-submenu-item').forEach(item => {
            item.addEventListener('click', () => {
                const dropdown = item.closest('.nav-dropdown');
                if (dropdown) {
                    dropdown.classList.remove('open');
                    dropdown.querySelector('.nav-dropdown-toggle')?.setAttribute('aria-expanded', 'false');
                }
            });
        });

        // Botón hamburguesa si no existe
        if (!document.getElementById('menu-toggle')) {
            const btn = document.createElement('button');
            btn.id = 'menu-toggle';
            btn.className = 'menu-toggle';
            btn.setAttribute('aria-label', 'Abrir menú');
            btn.setAttribute('aria-expanded', 'false');
            btn.innerHTML = '<span></span><span></span><span></span>';
            header.insertBefore(btn, nav);

            btn.addEventListener('click', () => {
                const open = header.classList.toggle('open');
                btn.setAttribute('aria-expanded', String(open));
            });
        }
    }

    // Renderizar info de usuario (login/admin/logout)
    // En la landing page, solo mostrar si está logueado
    renderUserSection().catch(console.error);

    // Renderizar selector de competición en páginas de liga (no en páginas globales)
    if (!isGlobalPage) {
        renderCompetitionSelector().catch(console.error);
    }
}
