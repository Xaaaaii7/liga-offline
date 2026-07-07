/**
 * Reusable Modal Management Module
 * 
 * Provides a consistent way to manage modal dialogs across the application.
 * Handles opening, closing, backdrop clicks, and escape key events automatically.
 * 
 * @example
 * import { Modal } from './modules/modal.js';
 * 
 * const newsModal = new Modal('news-backdrop', 'news-close');
 * newsModal.onClose = () => {
 *   // Custom cleanup logic
 * };
 * newsModal.open();
 */

export class Modal {
    /**
     * Create a new Modal instance
     * @param {string} backdropId - ID of the backdrop element
     * @param {string} closeButtonId - ID of the close button element
     */
    constructor(backdropId, closeButtonId) {
        this.backdrop = document.getElementById(backdropId);
        this.closeBtn = document.getElementById(closeButtonId);

        if (!this.backdrop) {
            console.warn(`Modal: backdrop element #${backdropId} not found`);
        }

        this._initListeners();
        this.close(); // Ensure closed initially
    }

    /**
     * Open the modal
     */
    open() {
        if (!this.backdrop) return;

        this.backdrop.hidden = false;
        document.body.style.overflow = 'hidden';

        // Call custom onOpen hook if provided
        if (typeof this.onOpen === 'function') {
            this.onOpen();
        }
    }

    /**
     * Close the modal
     */
    close() {
        if (!this.backdrop) return;

        this.backdrop.hidden = true;
        document.body.style.overflow = '';

        // Call custom onClose hook if provided
        if (typeof this.onClose === 'function') {
            this.onClose();
        }
    }

    /**
     * Check if modal is currently open
     * @returns {boolean}
     */
    isOpen() {
        return this.backdrop && !this.backdrop.hidden;
    }

    /**
     * Initialize event listeners for modal controls
     * @private
     */
    _initListeners() {
        // Close button click
        this.closeBtn?.addEventListener('click', () => this.close());

        // Backdrop click (clicking outside modal content)
        this.backdrop?.addEventListener('click', (e) => {
            if (e.target === this.backdrop) {
                this.close();
            }
        });

        // Escape key
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.isOpen()) {
                this.close();
            }
        });
    }

    /**
     * Hook called when modal opens (override in your code)
     * @type {Function|null}
     */
    onOpen = null;

    /**
     * Hook called when modal closes (override in your code)
     * Use this for cleanup logic like clearing content
     * @type {Function|null}
     */
    onClose = null;
}

/**
 * Helper function to create a simple modal instance
 * @param {string} backdropId 
 * @param {string} closeButtonId 
 * @param {Object} options - Optional configuration
 * @param {Function} options.onOpen - Called when modal opens
 * @param {Function} options.onClose - Called when modal closes
 * @returns {Modal}
 */
export function createModal(backdropId, closeButtonId, options = {}) {
    const modal = new Modal(backdropId, closeButtonId);

    if (options.onOpen) modal.onOpen = options.onOpen;
    if (options.onClose) modal.onClose = options.onClose;

    return modal;
}
