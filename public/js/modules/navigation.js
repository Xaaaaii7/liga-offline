/**
 * Navigation Controls Module
 * 
 * Provides reusable navigation controls for prev/next button patterns.
 */

/**
 * Creates navigation controls for prev/next buttons
 * 
 * @param {Object} config - Configuration object
 * @param {HTMLElement} config.prevBtn - Previous button element
 * @param {HTMLElement} config.nextBtn - Next button element
 * @param {number} config.minValue - Minimum value (inclusive)
 * @param {number} config.maxValue - Maximum value (inclusive)
 * @param {number} config.initialValue - Starting value
 * @param {Function} config.onUpdate - Async callback when value changes, receives new value
 * @param {HTMLElement} [config.labelEl] - Optional label element to update
 * @param {Function} [config.formatLabel] - Optional label formatter function
 * @returns {{getCurrent: Function, setCurrent: Function, updateNav: Function}}
 * 
 * @example
 * const nav = createNavigationControls({
 *   prevBtn: document.getElementById('prev'),
 *   nextBtn: document.getElementById('next'),
 *   labelEl: document.getElementById('label'),
 *   minValue: 1,
 *   maxValue: 10,
 *   initialValue: 1,
 *   onUpdate: async (value) => {
 *     await renderContent(value);
 *   },
 *   formatLabel: (val) => `Page ${val}`
 * });
 */
export function createNavigationControls(config) {
    const {
        prevBtn,
        nextBtn,
        minValue,
        maxValue,
        initialValue,
        onUpdate,
        labelEl = null,
        formatLabel = (val) => `${val}`
    } = config;

    let current = initialValue;

    /**
     * Update navigation button states and label
     */
    const updateNav = () => {
        if (prevBtn) prevBtn.disabled = current <= minValue;
        if (nextBtn) nextBtn.disabled = current >= maxValue;
        if (labelEl) labelEl.textContent = formatLabel(current);
    };

    // Previous button handler
    prevBtn?.addEventListener('click', async () => {
        if (current > minValue) {
            current--;
            if (onUpdate) await onUpdate(current);
            updateNav();
        }
    });

    // Next button handler
    nextBtn?.addEventListener('click', async () => {
        if (current < maxValue) {
            current++;
            if (onUpdate) await onUpdate(current);
            updateNav();
        }
    });

    // Set initial state
    updateNav();

    // Return API
    return {
        /**
         * Get current value
         * @returns {number}
         */
        getCurrent: () => current,

        /**
         * Set current value programmatically
         * @param {number} val - New value
         */
        setCurrent: (val) => {
            if (val >= minValue && val <= maxValue) {
                current = val;
                updateNav();
            }
        },

        /**
         * Manually trigger navigation state update
         */
        updateNav
    };
}
