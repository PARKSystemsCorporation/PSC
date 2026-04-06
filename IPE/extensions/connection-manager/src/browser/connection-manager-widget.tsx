/**
 * Gemma Theia IDE — Connection Manager Widget
 * ===============================================
 * Tab-based UI for switching between Local and Railway connections.
 * Shows QR code for mobile scanning, connection status, and latency.
 */

import * as React from 'react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { ConnectionManagerService, ConnectionMode, ConnectionInfo } from './connection-manager-service';

export const CONNECTION_MANAGER_WIDGET_ID = 'gemma-connection-manager';

@injectable()
export class ConnectionManagerWidget extends ReactWidget {

    static readonly ID = CONNECTION_MANAGER_WIDGET_ID;
    static readonly LABEL = 'Connections';

    @inject(ConnectionManagerService)
    protected readonly connectionService: ConnectionManagerService;

    private connectionInfo: ConnectionInfo | null = null;
    private isStartingTunnel: boolean = false;

    @postConstruct()
    protected init(): void {
        this.id = ConnectionManagerWidget.ID;
        this.title.label = ConnectionManagerWidget.LABEL;
        this.title.caption = 'Connection Manager - Local & Railway';
        this.title.iconClass = 'codicon codicon-plug';
        this.title.closable = true;
        this.addClass('gemma-connection-widget');

        this.connectionService.onInfoUpdate(info => {
            this.connectionInfo = info;
            this.update();
        });

        // Initialize with local mode
        this.connectionService.switchMode('local');
        this.update();
    }

    private handleTabSwitch(mode: ConnectionMode): void {
        this.connectionService.switchMode(mode);
    }

    private async handleStartTunnel(): Promise<void> {
        this.isStartingTunnel = true;
        this.update();
        try {
            await this.connectionService.startRailwayTunnel();
        } catch (err: any) {
            console.error('Failed to start tunnel:', err);
        }
        this.isStartingTunnel = false;
        this.update();
    }

    private async handleStopTunnel(): Promise<void> {
        await this.connectionService.stopRailwayTunnel();
    }

    private copyUrl(url: string): void {
        navigator.clipboard.writeText(url).catch(() => {});
    }

    protected render(): React.ReactNode {
        const info = this.connectionInfo || this.connectionService.info;
        const currentMode = this.connectionService.mode;

        return (
            <div className="gemma-conn-container">
                {/* Tab Bar */}
                <div className="gemma-conn-tabs">
                    <button
                        className={`gemma-conn-tab ${currentMode === 'local' ? 'active' : ''}`}
                        onClick={() => this.handleTabSwitch('local')}
                    >
                        <span className="codicon codicon-home" />
                        Local Network
                    </button>
                    <button
                        className={`gemma-conn-tab ${currentMode === 'railway' ? 'active' : ''}`}
                        onClick={() => this.handleTabSwitch('railway')}
                    >
                        <span className="codicon codicon-cloud" />
                        Railway Tunnel
                    </button>
                </div>

                {/* Connection Panel */}
                <div className="gemma-conn-panel">
                    {/* Status Bar */}
                    <div className="gemma-conn-status-bar">
                        <span className={`gemma-conn-dot gemma-conn-${info.status}`} />
                        <span className="gemma-conn-status-text">
                            {info.status === 'connected' ? 'Connected' :
                             info.status === 'connecting' ? 'Connecting...' :
                             info.status === 'error' ? 'Error' : 'Disconnected'}
                        </span>
                        {info.latency !== undefined && (
                            <span className="gemma-conn-latency">{info.latency}ms</span>
                        )}
                    </div>

                    {/* Local Mode */}
                    {currentMode === 'local' && (
                        <div className="gemma-conn-content">
                            <h3>Local Network Access</h3>
                            <p>Connect your iPad or phone on the same WiFi network.</p>

                            {info.url && (
                                <div className="gemma-conn-url-box">
                                    <label>Access URL:</label>
                                    <div className="gemma-conn-url-row">
                                        <code className="gemma-conn-url">{info.url}</code>
                                        <button
                                            className="gemma-conn-copy-btn"
                                            onClick={() => this.copyUrl(info.url)}
                                            title="Copy URL"
                                        >
                                            <span className="codicon codicon-copy" />
                                        </button>
                                    </div>
                                </div>
                            )}

                            {/* QR Code Placeholder */}
                            <div className="gemma-conn-qr">
                                <div className="gemma-conn-qr-placeholder">
                                    <span className="codicon codicon-device-mobile" style={{ fontSize: '48px' }} />
                                    <p>Scan with your device camera</p>
                                    {info.qrCodeData && (
                                        <canvas
                                            ref={canvas => {
                                                if (canvas && info.qrCodeData) {
                                                    this.renderQR(canvas, info.qrCodeData);
                                                }
                                            }}
                                            width={200}
                                            height={200}
                                            className="gemma-qr-canvas"
                                        />
                                    )}
                                </div>
                            </div>

                            <div className="gemma-conn-instructions">
                                <h4>Setup Instructions:</h4>
                                <ol>
                                    <li>Ensure your iPad/phone is on the same WiFi network</li>
                                    <li>Open Safari or Chrome on your device</li>
                                    <li>Navigate to the URL above (or scan QR code)</li>
                                    <li>The IDE loads as a full web app</li>
                                    <li><strong>Tip:</strong> Add to Home Screen for app-like experience</li>
                                </ol>
                            </div>
                        </div>
                    )}

                    {/* Railway Mode */}
                    {currentMode === 'railway' && (
                        <div className="gemma-conn-content">
                            <h3>Railway Cloud Tunnel</h3>
                            <p>Access your IDE from anywhere over the internet via Railway.</p>

                            {info.railwayUrl ? (
                                <div className="gemma-conn-url-box">
                                    <label>Public URL:</label>
                                    <div className="gemma-conn-url-row">
                                        <code className="gemma-conn-url">{info.railwayUrl}</code>
                                        <button
                                            className="gemma-conn-copy-btn"
                                            onClick={() => this.copyUrl(info.railwayUrl!)}
                                            title="Copy URL"
                                        >
                                            <span className="codicon codicon-copy" />
                                        </button>
                                    </div>
                                    <button
                                        className="gemma-btn gemma-btn-danger"
                                        onClick={() => this.handleStopTunnel()}
                                        style={{ marginTop: '8px' }}
                                    >
                                        <span className="codicon codicon-debug-stop" /> Stop Tunnel
                                    </button>
                                </div>
                            ) : (
                                <div className="gemma-conn-setup">
                                    <button
                                        className="gemma-btn gemma-btn-primary gemma-btn-large"
                                        onClick={() => this.handleStartTunnel()}
                                        disabled={this.isStartingTunnel}
                                    >
                                        {this.isStartingTunnel ? (
                                            <><span className="codicon codicon-loading codicon-modifier-spin" /> Starting Tunnel...</>
                                        ) : (
                                            <><span className="codicon codicon-cloud-upload" /> Start Railway Tunnel</>
                                        )}
                                    </button>

                                    <div className="gemma-conn-instructions">
                                        <h4>Prerequisites:</h4>
                                        <ol>
                                            <li>Install Railway CLI: <code>npm i -g @railway/cli</code></li>
                                            <li>Login: <code>railway login</code></li>
                                            <li>The tunnel creates a secure HTTPS endpoint</li>
                                            <li>Access from any device, any network</li>
                                        </ol>
                                    </div>
                                </div>
                            )}

                            {info.qrCodeData && info.railwayUrl && (
                                <div className="gemma-conn-qr">
                                    <div className="gemma-conn-qr-placeholder">
                                        <span className="codicon codicon-globe" style={{ fontSize: '48px' }} />
                                        <p>Scan to access remotely</p>
                                        <canvas
                                            ref={canvas => {
                                                if (canvas && info.qrCodeData) {
                                                    this.renderQR(canvas, info.qrCodeData);
                                                }
                                            }}
                                            width={200}
                                            height={200}
                                            className="gemma-qr-canvas"
                                        />
                                    </div>
                                </div>
                            )}
                        </div>
                    )}
                </div>

                <style>{`
                    .gemma-conn-container {
                        display: flex;
                        flex-direction: column;
                        height: 100%;
                        background: var(--theia-editor-background);
                        color: var(--theia-foreground);
                    }
                    .gemma-conn-tabs {
                        display: flex;
                        border-bottom: 2px solid var(--theia-panel-border);
                    }
                    .gemma-conn-tab {
                        flex: 1;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        gap: 6px;
                        padding: 10px 16px;
                        border: none;
                        background: transparent;
                        color: var(--theia-foreground);
                        font-size: 13px;
                        cursor: pointer;
                        border-bottom: 2px solid transparent;
                        margin-bottom: -2px;
                        transition: all 0.2s;
                    }
                    .gemma-conn-tab:hover {
                        background: var(--theia-list-hoverBackground);
                    }
                    .gemma-conn-tab.active {
                        border-bottom-color: var(--theia-focusBorder);
                        font-weight: 600;
                    }
                    .gemma-conn-panel {
                        flex: 1;
                        overflow-y: auto;
                        padding: 16px;
                    }
                    .gemma-conn-status-bar {
                        display: flex;
                        align-items: center;
                        gap: 6px;
                        margin-bottom: 16px;
                        padding: 6px 10px;
                        background: var(--theia-titleBar-activeBackground);
                        border-radius: 4px;
                        font-size: 12px;
                    }
                    .gemma-conn-dot {
                        width: 8px;
                        height: 8px;
                        border-radius: 50%;
                    }
                    .gemma-conn-connected { background: #4caf50; }
                    .gemma-conn-connecting { background: #ff9800; animation: pulse 1s infinite; }
                    .gemma-conn-disconnected { background: #9e9e9e; }
                    .gemma-conn-error { background: #f44336; }
                    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
                    .gemma-conn-latency {
                        margin-left: auto;
                        opacity: 0.6;
                    }
                    .gemma-conn-content h3 {
                        margin: 0 0 8px 0;
                        font-size: 16px;
                    }
                    .gemma-conn-content p {
                        margin: 0 0 16px 0;
                        opacity: 0.8;
                        font-size: 13px;
                    }
                    .gemma-conn-url-box {
                        margin-bottom: 16px;
                    }
                    .gemma-conn-url-box label {
                        display: block;
                        font-size: 12px;
                        opacity: 0.7;
                        margin-bottom: 4px;
                    }
                    .gemma-conn-url-row {
                        display: flex;
                        align-items: center;
                        gap: 6px;
                    }
                    .gemma-conn-url {
                        flex: 1;
                        padding: 8px 12px;
                        background: var(--theia-textCodeBlock-background);
                        border-radius: 4px;
                        font-size: 14px;
                        font-family: var(--theia-code-font-family);
                        user-select: all;
                    }
                    .gemma-conn-copy-btn {
                        background: var(--theia-button-secondaryBackground);
                        color: var(--theia-button-secondaryForeground);
                        border: none;
                        border-radius: 4px;
                        padding: 8px;
                        cursor: pointer;
                    }
                    .gemma-conn-qr {
                        display: flex;
                        justify-content: center;
                        margin: 20px 0;
                    }
                    .gemma-conn-qr-placeholder {
                        text-align: center;
                        padding: 20px;
                        border: 2px dashed var(--theia-panel-border);
                        border-radius: 8px;
                    }
                    .gemma-qr-canvas {
                        margin-top: 12px;
                        border-radius: 4px;
                    }
                    .gemma-conn-instructions {
                        margin-top: 16px;
                    }
                    .gemma-conn-instructions h4 {
                        margin: 0 0 8px 0;
                        font-size: 13px;
                    }
                    .gemma-conn-instructions ol {
                        padding-left: 20px;
                        font-size: 13px;
                        line-height: 1.8;
                    }
                    .gemma-conn-instructions code {
                        padding: 2px 6px;
                        background: var(--theia-textCodeBlock-background);
                        border-radius: 3px;
                        font-size: 12px;
                    }
                    .gemma-btn-large {
                        padding: 10px 20px;
                        font-size: 14px;
                    }
                    .gemma-btn-danger {
                        background: #c62828;
                        color: #fff;
                    }
                    .gemma-conn-setup {
                        text-align: center;
                        margin: 20px 0;
                    }
                `}</style>
            </div>
        );
    }

    /**
     * Simple QR code renderer using canvas.
     * In production, you'd use a library like 'qrcode' — this draws a placeholder grid.
     */
    private renderQR(canvas: HTMLCanvasElement, data: string): void {
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const size = 200;
        const cellSize = 5;
        const modules = Math.floor(size / cellSize);

        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, size, size);

        // Simple hash-based pattern (placeholder — use qrcode.js in production)
        ctx.fillStyle = '#000000';
        let hash = 0;
        for (let i = 0; i < data.length; i++) {
            hash = ((hash << 5) - hash) + data.charCodeAt(i);
            hash |= 0;
        }

        for (let y = 0; y < modules; y++) {
            for (let x = 0; x < modules; x++) {
                // Position detection patterns (corners)
                if (this.isPositionPattern(x, y, modules)) {
                    ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
                    continue;
                }
                // Data cells (deterministic pseudo-random from hash + position)
                const val = Math.abs(hash ^ (x * 31 + y * 37)) % 3;
                if (val === 0) {
                    ctx.fillRect(x * cellSize, y * cellSize, cellSize, cellSize);
                }
            }
        }
    }

    private isPositionPattern(x: number, y: number, modules: number): boolean {
        // Top-left, top-right, bottom-left finder patterns
        const patternSize = 7;
        const inTopLeft = x < patternSize && y < patternSize;
        const inTopRight = x >= modules - patternSize && y < patternSize;
        const inBottomLeft = x < patternSize && y >= modules - patternSize;

        if (!inTopLeft && !inTopRight && !inBottomLeft) return false;

        let px = x, py = y;
        if (inTopRight) px = x - (modules - patternSize);
        if (inBottomLeft) py = y - (modules - patternSize);

        // Outer border, inner white, center
        if (px === 0 || px === 6 || py === 0 || py === 6) return true;
        if (px === 1 || px === 5 || py === 1 || py === 5) return false;
        if (px >= 2 && px <= 4 && py >= 2 && py <= 4) return true;

        return false;
    }
}
