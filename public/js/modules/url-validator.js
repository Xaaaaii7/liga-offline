/**
 * Validador de URLs
 * Herramienta de desarrollo para auditar enlaces y detectar problemas de contexto
 */

import { getPageZone, extractPageName, getCurrentPageName } from './navigation-zones.js';
import { getCompetitionFromURL } from './competition-context.js';

/**
 * Verifica si un enlace es interno
 * @param {string} href - URL del enlace
 * @returns {boolean}
 */
function isInternalLink(href) {
  try {
    const url = new URL(href, window.location.origin);
    return url.origin === window.location.origin;
  } catch (e) {
    return !href.startsWith('http://') && !href.startsWith('https://') && !href.startsWith('//');
  }
}

/**
 * Audita todos los enlaces en la página actual
 * @returns {Array<Object>} Array de issues encontrados
 */
export function auditLinks() {
  const links = document.querySelectorAll('a[href]');
  const issues = [];
  const currentComp = getCompetitionFromURL();
  
  console.log('[URL Validator] Auditing', links.length, 'links on page');
  
  links.forEach((link, index) => {
    const href = link.getAttribute('href');
    
    // Ignorar enlaces especiales
    if (!href || href === '#' || href.startsWith('#') || 
        href.startsWith('javascript:') || href.startsWith('mailto:') || 
        href.startsWith('tel:')) {
      return;
    }
    
    // Ignorar enlaces externos
    if (!isInternalLink(href)) {
      return;
    }
    
    // Ignorar enlaces marcados como no-intercept (pueden tener lógica especial)
    if (link.hasAttribute('data-no-intercept')) {
      return;
    }
    
    try {
      const targetPage = extractPageName(href);
      const targetZone = getPageZone(targetPage);
      const hasComp = href.includes('comp=');
      
      // Verificar si el enlace tiene el contexto correcto
      if (targetZone.requiresComp && !hasComp) {
        issues.push({
          link,
          href,
          targetPage,
          issue: 'MISSING_COMP',
          message: `Link to ${targetPage} requires 'comp' parameter but it's missing`,
          severity: 'error',
          index
        });
      }
      
      if (!targetZone.allowComp && hasComp) {
        issues.push({
          link,
          href,
          targetPage,
          issue: 'UNEXPECTED_COMP',
          message: `Link to ${targetPage} should not have 'comp' parameter`,
          severity: 'warning',
          index
        });
      }
      
      // Si estamos en una competición y el enlace va a otra página de competición
      // debería mantener el mismo comp
      const currentPage = getCurrentPageName();
      const currentZone = getPageZone(currentPage);
      
      if (currentZone.requiresComp && targetZone.requiresComp && currentComp) {
        const linkComp = new URLSearchParams(href.split('?')[1] || '').get('comp');
        if (hasComp && linkComp !== currentComp) {
          issues.push({
            link,
            href,
            targetPage,
            issue: 'DIFFERENT_COMP',
            message: `Link changes competition context from '${currentComp}' to '${linkComp}'`,
            severity: 'warning',
            index
          });
        }
      }
      
    } catch (e) {
      issues.push({
        link,
        href,
        targetPage: 'unknown',
        issue: 'PARSE_ERROR',
        message: `Error parsing link: ${e.message}`,
        severity: 'error',
        index
      });
    }
  });
  
  return issues;
}

/**
 * Muestra los resultados de la auditoría en la consola
 * @param {Array<Object>} issues - Array de issues
 */
function displayAuditResults(issues) {
  if (issues.length === 0) {
    console.log('%c✓ No issues found!', 'color: green; font-weight: bold; font-size: 14px');
    return;
  }
  
  console.group(`%c⚠ Found ${issues.length} issue(s)`, 'color: orange; font-weight: bold; font-size: 14px');
  
  const errors = issues.filter(i => i.severity === 'error');
  const warnings = issues.filter(i => i.severity === 'warning');
  
  if (errors.length > 0) {
    console.group(`%c❌ ${errors.length} Error(s)`, 'color: red; font-weight: bold');
    errors.forEach(issue => {
      console.log('%c' + issue.message, 'color: red');
      console.log('  Link:', issue.link);
      console.log('  Href:', issue.href);
      console.log('  Target:', issue.targetPage);
      console.log('---');
    });
    console.groupEnd();
  }
  
  if (warnings.length > 0) {
    console.group(`%c⚠ ${warnings.length} Warning(s)`, 'color: orange; font-weight: bold');
    warnings.forEach(issue => {
      console.log('%c' + issue.message, 'color: orange');
      console.log('  Link:', issue.link);
      console.log('  Href:', issue.href);
      console.log('  Target:', issue.targetPage);
      console.log('---');
    });
    console.groupEnd();
  }
  
  console.groupEnd();
}

/**
 * Audita todos los enlaces y muestra los resultados
 * Función principal para ejecutar desde la consola
 */
export function auditCompetitionLinks() {
  console.clear();
  console.log('%c🔍 Competition Links Audit', 'color: blue; font-weight: bold; font-size: 16px');
  console.log('Current page:', getCurrentPageName());
  console.log('Current competition:', getCompetitionFromURL() || 'None');
  console.log('---');
  
  const issues = auditLinks();
  displayAuditResults(issues);
  
  return issues;
}

/**
 * Resalta visualmente los enlaces problemáticos en la página
 * @param {Array<Object>} issues - Array de issues (opcional, se calculará si no se proporciona)
 */
export function highlightProblematicLinks(issues = null) {
  if (!issues) {
    issues = auditLinks();
  }
  
  // Limpiar resaltados anteriores
  document.querySelectorAll('.url-validator-highlight').forEach(el => {
    el.classList.remove('url-validator-highlight', 'url-validator-error', 'url-validator-warning');
    el.style.outline = '';
    el.style.outlineOffset = '';
  });
  
  // Añadir estilos si no existen
  if (!document.getElementById('url-validator-styles')) {
    const style = document.createElement('style');
    style.id = 'url-validator-styles';
    style.textContent = `
      .url-validator-highlight {
        position: relative;
      }
      .url-validator-error {
        outline: 2px solid red !important;
        outline-offset: 2px !important;
      }
      .url-validator-warning {
        outline: 2px solid orange !important;
        outline-offset: 2px !important;
      }
    `;
    document.head.appendChild(style);
  }
  
  // Resaltar enlaces problemáticos
  issues.forEach(issue => {
    issue.link.classList.add('url-validator-highlight');
    issue.link.classList.add(issue.severity === 'error' ? 'url-validator-error' : 'url-validator-warning');
    issue.link.title = issue.message;
  });
  
  console.log(`%cHighlighted ${issues.length} problematic link(s)`, 'color: blue; font-weight: bold');
}

/**
 * Audita y resalta en un solo paso
 */
export function auditAndHighlight() {
  const issues = auditCompetitionLinks();
  highlightProblematicLinks(issues);
  return issues;
}

// Exponer funciones globalmente para uso en consola
if (typeof window !== 'undefined') {
  window.auditCompetitionLinks = auditCompetitionLinks;
  window.highlightProblematicLinks = highlightProblematicLinks;
  window.auditAndHighlight = auditAndHighlight;
  
  console.log('%c[URL Validator] Available commands:', 'color: blue; font-weight: bold');
  console.log('  - window.auditCompetitionLinks()     → Audit all links');
  console.log('  - window.highlightProblematicLinks() → Highlight issues');
  console.log('  - window.auditAndHighlight()         → Audit + Highlight');
}

