/**
 * Gemma Theia IDE — Mobile UI Frontend Module
 * ===============================================
 * Injects mobile-responsive CSS, PWA manifest, viewport meta,
 * and touch gesture handlers into the Theia application.
 */

import { ContainerModule } from '@theia/core/shared/inversify';
import { FrontendApplicationContribution, FrontendApplication } from '@theia/core/lib/browser';
import { injectable } from '@theia/core/shared/inversify';

@injectable()
class MobileUIContribution implements FrontendApplicationContribution {

    async onStart(app: FrontendApplication): Promise<void> {
        this.injectViewportMeta();
        this.injectMobileCSS();
        this.injectPWAManifest();
        this.setupTouchGestures();
        this.detectMobileDevice();
    }

    /**
     * Ensure proper viewport for mobile devices.
     */
    private injectViewportMeta(): void {
        let meta = document.querySelector('meta[name="viewport"]');
        if (!meta) {
            meta = document.createElement('meta');
            meta.setAttribute('name', 'viewport');
            document.head.appendChild(meta);
        }
        meta.setAttribute('content',
            'width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover'
        );

        // Apple web app meta tags
        const appleMeta = document.createElement('meta');
        appleMeta.setAttribute('name', 'apple-mobile-web-app-capable');
        appleMeta.setAttribute('content', 'yes');
        document.head.appendChild(appleMeta);

        const statusBar = document.createElement('meta');
        statusBar.setAttribute('name', 'apple-mobile-web-app-status-bar-style');
        statusBar.setAttribute('content', 'black-translucent');
        document.head.appendChild(statusBar);

        const appTitle = document.createElement('meta');
        appTitle.setAttribute('name', 'apple-mobile-web-app-title');
        appTitle.setAttribute('content', 'Gemma IDE');
        document.head.appendChild(appTitle);

        // Theme color
        const themeColor = document.createElement('meta');
        themeColor.setAttribute('name', 'theme-color');
        themeColor.setAttribute('content', '#1e1e1e');
        document.head.appendChild(themeColor);
    }

    /**
     * Inject mobile responsive styles.
     */
    private injectMobileCSS(): void {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = '/mobile-styles.css';
        document.head.appendChild(link);

        // Also inject critical inline styles immediately
        const style = document.createElement('style');
        style.textContent = `
            html, body {
                overscroll-behavior: none;
                -webkit-overflow-scrolling: touch;
            }
            @media (pointer: coarse) {
                .theia-TreeNode { min-height: 36px !important; }
                button, .theia-button { min-height: 36px !important; min-width: 36px !important; }
            }
        `;
        document.head.appendChild(style);
    }

    /**
     * Inject PWA manifest link.
     */
    private injectPWAManifest(): void {
        const link = document.createElement('link');
        link.rel = 'manifest';
        link.href = '/manifest.json';
        document.head.appendChild(link);

        // Register service worker if available
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/sw.js').catch(() => {
                // Service worker not available — that's fine
            });
        }
    }

    /**
     * Set up touch gesture handlers for navigation.
     */
    private setupTouchGestures(): void {
        let startX = 0;
        let startY = 0;
        const threshold = 50;

        document.addEventListener('touchstart', (e: TouchEvent) => {
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
        }, { passive: true });

        document.addEventListener('touchend', (e: TouchEvent) => {
            const endX = e.changedTouches[0].clientX;
            const endY = e.changedTouches[0].clientY;
            const deltaX = endX - startX;
            const deltaY = endY - startY;

            // Only handle horizontal swipes
            if (Math.abs(deltaX) > threshold && Math.abs(deltaX) > Math.abs(deltaY) * 2) {
                if (deltaX > 0 && startX < 30) {
                    // Swipe right from left edge — open file explorer
                    this.togglePanel('left', true);
                } else if (deltaX < 0 && startX > window.innerWidth - 30) {
                    // Swipe left from right edge — open AI chat
                    this.togglePanel('right', true);
                }
            }
        }, { passive: true });
    }

    /**
     * Toggle side panels on mobile.
     */
    private togglePanel(side: 'left' | 'right', show: boolean): void {
        const selector = side === 'left' ? '.theia-left-side-panel' : '.theia-right-side-panel';
        const panel = document.querySelector(selector);
        if (panel) {
            if (show) {
                panel.classList.add('visible');
                this.showOverlay();
            } else {
                panel.classList.remove('visible');
                this.hideOverlay();
            }
        }
    }

    private showOverlay(): void {
        let overlay = document.querySelector('.gemma-mobile-overlay') as HTMLElement;
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'gemma-mobile-overlay';
            overlay.addEventListener('click', () => {
                this.togglePanel('left', false);
                this.togglePanel('right', false);
            });
            document.body.appendChild(overlay);
        }
        overlay.classList.add('active');
    }

    private hideOverlay(): void {
        const overlay = document.querySelector('.gemma-mobile-overlay');
        if (overlay) {
            overlay.classList.remove('active');
        }
    }

    /**
     * Detect mobile device and add CSS class.
     */
    private detectMobileDevice(): void {
        const isMobile = /iPhone|iPad|iPod|Android/i.test(navigator.userAgent) ||
            (navigator.maxTouchPoints > 0 && window.innerWidth < 1024);

        if (isMobile) {
            document.body.classList.add('gemma-mobile-device');
        }

        const isIPad = /iPad/i.test(navigator.userAgent) ||
            (navigator.maxTouchPoints > 0 && /Mac/i.test(navigator.userAgent));

        if (isIPad) {
            document.body.classList.add('gemma-ipad-device');
        }
    }
}

export default new ContainerModule(bind => {
    bind(MobileUIContribution).toSelf().inSingletonScope();
    bind(FrontendApplicationContribution).toService(MobileUIContribution);
});
