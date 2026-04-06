/**
 * Gemma Theia IDE — Connection Manager Service
 * ================================================
 * Manages the two connection modes:
 * - LOCAL: Direct LAN access (same WiFi network)
 * - RAILWAY: Cloud tunnel via Railway for internet access
 */

import { injectable } from '@theia/core/shared/inversify';
import { Emitter, Event } from '@theia/core';

export type ConnectionMode = 'local' | 'railway';

export interface ModelOption {
    name: string;
    downloaded: boolean;
    size_gb: number;
    description: string;
    format: string;
    filename?: string;
    supported_in_app?: boolean;
}

export interface SetupStatus {
    configured: boolean;
    backend: string;
    desired_model: string;
    recommended_model: string;
    backend_ready: boolean;
    gpu: {
        nvidia: boolean;
        vram_gb: number;
        device_name: string;
    };
    models: ModelOption[];
    download: {
        status: 'idle' | 'running' | 'completed' | 'error';
        model?: string | null;
        error?: string | null;
        started_at?: number | null;
        finished_at?: number | null;
    };
}

export interface ConnectionInfo {
    mode: ConnectionMode;
    url: string;
    status: 'connected' | 'connecting' | 'disconnected' | 'error';
    qrCodeData?: string;
    localIp?: string;
    railwayUrl?: string;
    railwayProjectId?: string;
    latency?: number;
}

@injectable()
export class ConnectionManagerService {

    private _mode: ConnectionMode = 'local';
    private _info: ConnectionInfo = {
        mode: 'local',
        url: '',
        status: 'disconnected',
    };

    private readonly onModeChangeEmitter = new Emitter<ConnectionMode>();
    readonly onModeChange: Event<ConnectionMode> = this.onModeChangeEmitter.event;

    private readonly onInfoUpdateEmitter = new Emitter<ConnectionInfo>();
    readonly onInfoUpdate: Event<ConnectionInfo> = this.onInfoUpdateEmitter.event;

    private _setupStatus: SetupStatus | null = null;
    private readonly onSetupUpdateEmitter = new Emitter<SetupStatus>();
    readonly onSetupUpdate: Event<SetupStatus> = this.onSetupUpdateEmitter.event;

    get mode(): ConnectionMode {
        return this._mode;
    }

    get info(): ConnectionInfo {
        return { ...this._info };
    }

    get setupStatus(): SetupStatus | null {
        return this._setupStatus ? { ...this._setupStatus } : null;
    }

    async loadSetupStatus(): Promise<SetupStatus | null> {
        try {
            const resp = await fetch('/api/setup/status');
            if (!resp.ok) {
                throw new Error(`Setup status failed: ${resp.status}`);
            }
            const data = await resp.json() as SetupStatus;
            this._setupStatus = data;
            this.onSetupUpdateEmitter.fire(data);
            return data;
        } catch {
            return null;
        }
    }

    async downloadAndConfigureModel(model: string): Promise<void> {
        const resp = await fetch('/api/setup/download-and-configure', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model }),
        });

        if (!resp.ok) {
            const errorText = await resp.text();
            throw new Error(errorText || 'Failed to start model setup');
        }

        await this.loadSetupStatus();
    }

    /**
     * Switch connection mode (Local <-> Railway).
     */
    async switchMode(mode: ConnectionMode): Promise<void> {
        this._mode = mode;
        this._info.mode = mode;
        this._info.status = 'connecting';
        this.onModeChangeEmitter.fire(mode);
        this.onInfoUpdateEmitter.fire(this._info);

        if (mode === 'local') {
            await this.setupLocalConnection();
        } else {
            await this.setupRailwayConnection();
        }
    }

    /**
     * Set up local LAN connection — detect IP and generate QR code.
     */
    private async setupLocalConnection(): Promise<void> {
        try {
            // Fetch local IP from the backend
            const resp = await fetch('/api/connection/local-ip');
            if (resp.ok) {
                const data = await resp.json();
                this._info.localIp = data.ip;
                this._info.url = `http://${data.ip}:3000`;
            } else {
                // Fallback: use window location
                this._info.url = `${window.location.protocol}//${window.location.hostname}:3000`;
                this._info.localIp = window.location.hostname;
            }

            // Generate QR code data (URL for mobile to scan)
            this._info.qrCodeData = this.generateQRData(this._info.url);
            this._info.status = 'connected';

            // Start latency ping
            this.pingLatency();

        } catch (err) {
            this._info.status = 'error';
        }

        this.onInfoUpdateEmitter.fire(this._info);
    }

    /**
     * Set up Railway tunnel connection.
     */
    private async setupRailwayConnection(): Promise<void> {
        try {
            const resp = await fetch('/api/connection/railway-status');
            if (resp.ok) {
                const data = await resp.json();
                this._info.railwayUrl = data.url;
                this._info.railwayProjectId = data.projectId;
                this._info.url = data.url;
                this._info.qrCodeData = this.generateQRData(data.url);
                this._info.status = 'connected';
            } else {
                // Railway not configured yet
                this._info.status = 'disconnected';
                this._info.url = '';
            }
        } catch {
            this._info.status = 'error';
        }

        this.onInfoUpdateEmitter.fire(this._info);
    }

    /**
     * Start the Railway tunnel.
     */
    async startRailwayTunnel(): Promise<string> {
        const resp = await fetch('/api/connection/railway-start', { method: 'POST' });
        if (!resp.ok) {
            throw new Error('Failed to start Railway tunnel');
        }
        const data = await resp.json();
        this._info.railwayUrl = data.url;
        this._info.url = data.url;
        this._info.qrCodeData = this.generateQRData(data.url);
        this._info.status = 'connected';
        this.onInfoUpdateEmitter.fire(this._info);
        return data.url;
    }

    /**
     * Stop the Railway tunnel.
     */
    async stopRailwayTunnel(): Promise<void> {
        await fetch('/api/connection/railway-stop', { method: 'POST' });
        this._info.railwayUrl = undefined;
        this._info.url = '';
        this._info.status = 'disconnected';
        this.onInfoUpdateEmitter.fire(this._info);
    }

    /**
     * Measure round-trip latency.
     */
    private async pingLatency(): Promise<void> {
        try {
            const start = performance.now();
            await fetch('/api/connection/ping');
            this._info.latency = Math.round(performance.now() - start);
        } catch {
            this._info.latency = undefined;
        }
    }

    /**
     * Generate QR code data URL (simple text encoding — rendered by the widget).
     */
    private generateQRData(url: string): string {
        // Return the URL to be rendered as QR by the widget's canvas
        return url;
    }

    dispose(): void {
        this.onModeChangeEmitter.dispose();
        this.onInfoUpdateEmitter.dispose();
        this.onSetupUpdateEmitter.dispose();
    }
}
