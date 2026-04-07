/**
 * Gemma Theia IDE — Connection Manager Widget
 * ===============================================
 * Tab-based UI for switching between Local and Railway connections.
 * Shows QR code for mobile scanning, connection status, and latency.
 */

import * as React from 'react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { ConnectionManagerService, ConnectionMode, ConnectionInfo, SetupStatus, ModelOption } from './connection-manager-service';

export const CONNECTION_MANAGER_WIDGET_ID = 'gemma-connection-manager';

@injectable()
export class ConnectionManagerWidget extends ReactWidget {

    static readonly ID = CONNECTION_MANAGER_WIDGET_ID;
    static readonly LABEL = 'Setup';

    @inject(ConnectionManagerService)
    protected readonly connectionService!: ConnectionManagerService;

    private connectionInfo: ConnectionInfo | null = null;
    private isStartingTunnel: boolean = false;
    private activeTab: 'setup' | 'local' | 'railway' = 'setup';
    private setupStatus: SetupStatus | null = null;
    private isRefreshingSetup: boolean = false;
    private setupError: string | null = null;
    private hfToken: string = '';
    private selectedLocalModel: string = '';
    private isUploadingLocalModel: boolean = false;
    private isLocalDropTarget: boolean = false;
    private localFileInput: HTMLInputElement | null = null;

    @postConstruct()
    protected init(): void {
        this.id = ConnectionManagerWidget.ID;
        this.title.label = ConnectionManagerWidget.LABEL;
        this.title.caption = 'Gemma Setup';
        this.title.iconClass = 'codicon codicon-settings-gear';
        this.title.closable = true;
        this.addClass('gemma-connection-widget');

        this.connectionService.onInfoUpdate(info => {
            this.connectionInfo = info;
            this.update();
        });

        this.connectionService.onSetupUpdate(status => {
            this.setupStatus = status;
            this.update();
        });

        void this.refreshSetupStatus();
        this.connectionService.switchMode('local');
        this.update();
    }

    private async refreshSetupStatus(): Promise<void> {
        this.isRefreshingSetup = true;
        this.update();
        const status = await this.connectionService.loadSetupStatus();
        if (status) {
            this.setupStatus = status;
            this.setupError = null;
            if (this.selectedLocalModel && !status.local_models.some(model => model.filename === this.selectedLocalModel)) {
                this.selectedLocalModel = '';
            }
        } else {
            this.setupError = 'Unable to load AI setup status.';
        }
        this.isRefreshingSetup = false;
        this.update();
    }

    private handleTabSwitch(mode: ConnectionMode): void {
        this.connectionService.switchMode(mode);
    }

    private handleMainTabSwitch(tab: 'setup' | 'local' | 'railway'): void {
        this.activeTab = tab;
        if (tab === 'local' || tab === 'railway') {
            this.handleTabSwitch(tab);
        }
        this.update();
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

    private async handleModelSetup(model: ModelOption): Promise<void> {
        this.setupError = null;
        try {
            await this.connectionService.downloadAndConfigureModel(model.name, this.hfToken);
        } catch (err: any) {
            this.setupError = err.message || 'Failed to configure model.';
        }
        await this.refreshSetupStatus();
    }

    private async handleLocalModelSetup(filename: string): Promise<void> {
        this.setupError = null;
        try {
            await this.connectionService.configureLocalModel(filename);
        } catch (err: any) {
            this.setupError = err.message || 'Failed to configure local model.';
        }
        await this.refreshSetupStatus();
    }

    private async handleLocalFileUpload(file: File): Promise<void> {
        this.setupError = null;
        this.isUploadingLocalModel = true;
        this.update();
        try {
            const filename = await this.connectionService.uploadLocalModel(file);
            this.selectedLocalModel = filename;
            await this.connectionService.configureLocalModel(filename);
        } catch (err: any) {
            this.setupError = err.message || 'Failed to upload local model.';
        } finally {
            this.isUploadingLocalModel = false;
            this.isLocalDropTarget = false;
            await this.refreshSetupStatus();
        }
    }

    private openLocalFilePicker(): void {
        this.localFileInput?.click();
    }

    private copyUrl(url: string): void {
        navigator.clipboard.writeText(url).catch(() => {});
    }

    protected render(): React.ReactNode {
        const info = this.connectionInfo || this.connectionService.info;
        const setup = this.setupStatus;
        const supportedModels = setup?.models.filter(model => model.supported_in_app) || [];
        const localModels = setup?.local_models || [];
        const chosenLocalModel = localModels.some(model => model.filename === this.selectedLocalModel)
            ? this.selectedLocalModel
            : (localModels[0]?.filename || '');

        return (
            <div className="gemma-conn-container">
                {/* Tab Bar */}
                <div className="gemma-conn-tabs">
                    <button
                        className={`gemma-conn-tab ${this.activeTab === 'setup' ? 'active' : ''}`}
                        onClick={() => this.handleMainTabSwitch('setup')}
                    >
                        <span className="codicon codicon-settings-gear" />
                        AI Setup
                    </button>
                    <button
                        className={`gemma-conn-tab ${this.activeTab === 'local' ? 'active' : ''}`}
                        onClick={() => this.handleMainTabSwitch('local')}
                    >
                        <span className="codicon codicon-home" />
                        Local Network
                    </button>
                    <button
                        className={`gemma-conn-tab ${this.activeTab === 'railway' ? 'active' : ''}`}
                        onClick={() => this.handleMainTabSwitch('railway')}
                    >
                        <span className="codicon codicon-cloud" />
                        Railway Tunnel
                    </button>
                </div>

                {/* Connection Panel */}
                <div className="gemma-conn-panel">
                    {this.activeTab !== 'setup' && (
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
                    )}

                    {this.activeTab === 'setup' && (
                        <div className="gemma-conn-content">
                            <div className="gemma-setup-header">
                                <div>
                                    <h3>AI Setup</h3>
                                    <p>Bring the IDE up first, then configure AI when you are ready. Local GGUF files work without any hosted API.</p>
                                </div>
                                <button
                                    className="gemma-btn gemma-btn-primary"
                                    onClick={() => this.refreshSetupStatus()}
                                    disabled={this.isRefreshingSetup}
                                >
                                    {this.isRefreshingSetup ? 'Refreshing...' : 'Refresh Scan'}
                                </button>
                            </div>

                            {setup && (
                                <div className={`gemma-setup-banner ${setup.configured ? 'ready' : 'needs-setup'}`}>
                                    <strong>
                                        {setup.configured
                                            ? (setup.backend_ready ? 'AI is configured and reachable.' : 'Model is configured. AI service is still starting up.')
                                            : 'No model configured yet.'}
                                    </strong>
                                    <span>
                                        {setup.gpu.nvidia
                                            ? `Detected ${setup.gpu.device_name} with ${setup.gpu.vram_gb}GB VRAM.`
                                            : 'No NVIDIA GPU detected. CPU mode is still available with a smaller model.'}
                                    </span>
                                    <span>
                                        Recommended model: <code>{setup.recommended_model}</code>
                                    </span>
                                </div>
                            )}

                            {setup?.download.status === 'running' && (
                                <div className="gemma-setup-banner info">
                                    <strong>Downloading and applying {setup.download.model}...</strong>
                                    <span>The AI service will come online automatically after the download finishes.</span>
                                </div>
                            )}

                            {setup?.download.status === 'completed' && (
                                <div className="gemma-setup-banner ready">
                                    <strong>{setup.download.model} was downloaded and applied.</strong>
                                    <span>If the AI status still says disconnected for a minute or two, hit Refresh Scan.</span>
                                </div>
                            )}

                            {(this.setupError || setup?.download.error) && (
                                <div className="gemma-setup-banner error">
                                    <strong>Setup needs attention.</strong>
                                    <span>{this.setupError || setup?.download.error}</span>
                                </div>
                            )}

                            <div className="gemma-token-panel">
                                <h4>Hugging Face Access</h4>
                                <p>
                                    Only needed if you want the app to download a model for you. If you already have a GGUF file,
                                    place it in <code>{setup?.host_models_dir || setup?.models_dir || '/models'}</code> and use it from the local files section below.
                                </p>
                                <input
                                    className="gemma-token-input"
                                    type="password"
                                    placeholder="hf_xxxxxxxxxxxxxxxxxxxx"
                                    value={this.hfToken}
                                    onChange={event => {
                                        this.hfToken = event.currentTarget.value;
                                        this.update();
                                    }}
                                />
                            </div>

                            <div className="gemma-token-panel">
                                <h4>Local GGUF Files</h4>
                                <p>
                                    Drop a <code>.gguf</code> file into <code>{setup?.host_models_dir || setup?.models_dir || '/models'}</code>, click <strong>Refresh Scan</strong>,
                                    then choose it here. This keeps inference fully local.
                                </p>
                                <input
                                    ref={element => { this.localFileInput = element; }}
                                    type="file"
                                    accept=".gguf"
                                    style={{ display: 'none' }}
                                    onChange={event => {
                                        const file = event.currentTarget.files?.[0];
                                        if (file) {
                                            void this.handleLocalFileUpload(file);
                                        }
                                        event.currentTarget.value = '';
                                    }}
                                />
                                <div
                                    className={`gemma-drop-zone ${this.isLocalDropTarget ? 'dragging' : ''}`}
                                    onDragOver={event => {
                                        event.preventDefault();
                                        if (!this.isLocalDropTarget) {
                                            this.isLocalDropTarget = true;
                                            this.update();
                                        }
                                    }}
                                    onDragLeave={event => {
                                        event.preventDefault();
                                        if (this.isLocalDropTarget) {
                                            this.isLocalDropTarget = false;
                                            this.update();
                                        }
                                    }}
                                    onDrop={event => {
                                        event.preventDefault();
                                        this.isLocalDropTarget = false;
                                        const file = event.dataTransfer.files?.[0];
                                        if (file) {
                                            void this.handleLocalFileUpload(file);
                                        } else {
                                            this.update();
                                        }
                                    }}
                                >
                                    <div className="gemma-drop-zone-title">
                                        {this.isUploadingLocalModel ? 'Uploading local model...' : 'Drag and drop a .gguf here'}
                                    </div>
                                    <div className="gemma-drop-zone-subtitle">
                                        {this.isUploadingLocalModel
                                            ? 'The IDE will scan and configure it automatically.'
                                            : 'Or browse for a model file from your computer.'}
                                    </div>
                                    <button
                                        className="gemma-btn gemma-btn-secondary"
                                        onClick={() => this.openLocalFilePicker()}
                                        disabled={this.isUploadingLocalModel}
                                    >
                                        Browse for GGUF
                                    </button>
                                </div>
                                {localModels.length > 0 ? (
                                    <div className="gemma-local-picker">
                                        <label htmlFor="gemma-local-model-select">Detected local models</label>
                                        <div className="gemma-local-picker-row">
                                            <select
                                                id="gemma-local-model-select"
                                                className="gemma-local-select"
                                                value={chosenLocalModel}
                                                onChange={event => {
                                                    this.selectedLocalModel = event.currentTarget.value;
                                                    this.update();
                                                }}
                                            >
                                                {localModels.map(model => (
                                                    <option key={model.filename} value={model.filename}>
                                                        {model.filename} ({model.size_gb} GB)
                                                    </option>
                                                ))}
                                            </select>
                                            <button
                                                className="gemma-btn gemma-btn-primary"
                                                onClick={() => void this.handleLocalModelSetup(chosenLocalModel)}
                                                disabled={!chosenLocalModel || this.isUploadingLocalModel || setup?.download.status === 'running'}
                                            >
                                                Use Selected Model
                                            </button>
                                        </div>
                                        <div className="gemma-model-meta">
                                            <span className="gemma-model-pill downloaded">Detected locally</span>
                                            {setup?.desired_model === chosenLocalModel && chosenLocalModel && (
                                                <span className="gemma-model-pill selected">Current choice</span>
                                            )}
                                        </div>
                                    </div>
                                ) : (
                                    <div className="gemma-setup-banner info">
                                        <strong>No local GGUF files found yet.</strong>
                                        <span>Add a model file to <code>{setup?.host_models_dir || setup?.models_dir || '/models'}</code> and refresh the scan.</span>
                                    </div>
                                )}
                            </div>

                            <div className="gemma-model-grid">
                                {supportedModels.map(model => {
                                    const isRecommended = setup?.recommended_model === model.name;
                                    const isSelected = setup?.desired_model === model.name;
                                    const isBusy = setup?.download.status === 'running';
                                    const buttonLabel = model.downloaded
                                        ? (isSelected ? 'Use This Model Again' : 'Use This Model')
                                        : 'Download and Use';

                                    return (
                                        <div key={model.name} className={`gemma-model-card ${isRecommended ? 'recommended' : ''}`}>
                                            <div className="gemma-model-card-top">
                                                <div>
                                                    <h4>{model.name}</h4>
                                                    <p>{model.description}</p>
                                                </div>
                                                <span className="gemma-model-size">{model.size_gb} GB</span>
                                            </div>
                                            <div className="gemma-model-meta">
                                                <span className={`gemma-model-pill ${model.downloaded ? 'downloaded' : 'missing'}`}>
                                                    {model.downloaded ? 'Downloaded' : 'Not downloaded'}
                                                </span>
                                                {isRecommended && <span className="gemma-model-pill recommended">Recommended</span>}
                                                {isSelected && <span className="gemma-model-pill selected">Current choice</span>}
                                            </div>
                                            <button
                                                className="gemma-btn gemma-btn-primary gemma-model-action"
                                                onClick={() => this.handleModelSetup(model)}
                                                disabled={isBusy}
                                            >
                                                {buttonLabel}
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {/* Local Mode */}
                    {this.activeTab === 'local' && (
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
                    {this.activeTab === 'railway' && (
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
                    .gemma-setup-header {
                        display: flex;
                        align-items: flex-start;
                        justify-content: space-between;
                        gap: 12px;
                        margin-bottom: 16px;
                    }
                    .gemma-setup-banner {
                        display: flex;
                        flex-direction: column;
                        gap: 6px;
                        padding: 12px 14px;
                        border-radius: 8px;
                        margin-bottom: 16px;
                        border: 1px solid var(--theia-panel-border);
                        font-size: 13px;
                    }
                    .gemma-setup-banner.ready {
                        background: rgba(76, 175, 80, 0.12);
                    }
                    .gemma-setup-banner.needs-setup,
                    .gemma-setup-banner.info {
                        background: rgba(255, 152, 0, 0.12);
                    }
                    .gemma-setup-banner.error {
                        background: rgba(244, 67, 54, 0.12);
                    }
                    .gemma-model-grid {
                        display: grid;
                        grid-template-columns: 1fr;
                        gap: 12px;
                    }
                    .gemma-token-panel {
                        border: 1px solid var(--theia-panel-border);
                        border-radius: 10px;
                        padding: 14px;
                        margin-bottom: 16px;
                        background: var(--theia-editor-background);
                    }
                    .gemma-token-panel h4 {
                        margin: 0 0 6px 0;
                        font-size: 14px;
                    }
                    .gemma-token-panel p {
                        margin: 0 0 10px 0;
                        font-size: 12px;
                        opacity: 0.8;
                    }
                    .gemma-token-input {
                        width: 100%;
                        box-sizing: border-box;
                        padding: 10px 12px;
                        border-radius: 8px;
                        border: 1px solid var(--theia-panel-border);
                        background: var(--theia-input-background);
                        color: var(--theia-input-foreground);
                        font: inherit;
                    }
                    .gemma-drop-zone {
                        display: flex;
                        flex-direction: column;
                        align-items: center;
                        justify-content: center;
                        gap: 10px;
                        padding: 18px;
                        margin-bottom: 14px;
                        border-radius: 10px;
                        border: 2px dashed var(--theia-panel-border);
                        background: rgba(33, 150, 243, 0.06);
                        text-align: center;
                        transition: border-color 0.2s, background 0.2s;
                    }
                    .gemma-drop-zone.dragging {
                        border-color: var(--theia-focusBorder);
                        background: rgba(33, 150, 243, 0.14);
                    }
                    .gemma-drop-zone-title {
                        font-size: 14px;
                        font-weight: 600;
                    }
                    .gemma-drop-zone-subtitle {
                        font-size: 12px;
                        opacity: 0.8;
                    }
                    .gemma-local-picker label {
                        display: block;
                        margin-bottom: 6px;
                        font-size: 12px;
                        opacity: 0.8;
                    }
                    .gemma-local-picker-row {
                        display: flex;
                        gap: 10px;
                        align-items: center;
                    }
                    .gemma-local-select {
                        flex: 1;
                        min-width: 0;
                        padding: 10px 12px;
                        border-radius: 8px;
                        border: 1px solid var(--theia-panel-border);
                        background: var(--theia-input-background);
                        color: var(--theia-input-foreground);
                        font: inherit;
                    }
                    .gemma-model-card {
                        border: 1px solid var(--theia-panel-border);
                        border-radius: 10px;
                        padding: 14px;
                        background: var(--theia-editor-background);
                    }
                    .gemma-model-card.recommended {
                        box-shadow: inset 0 0 0 1px var(--theia-focusBorder);
                    }
                    .gemma-model-card-top {
                        display: flex;
                        align-items: flex-start;
                        justify-content: space-between;
                        gap: 12px;
                    }
                    .gemma-model-card-top h4 {
                        margin: 0 0 6px 0;
                        font-size: 14px;
                    }
                    .gemma-model-card-top p {
                        margin: 0;
                        font-size: 12px;
                        opacity: 0.8;
                    }
                    .gemma-model-size {
                        font-size: 12px;
                        opacity: 0.75;
                        white-space: nowrap;
                    }
                    .gemma-model-meta {
                        display: flex;
                        gap: 8px;
                        flex-wrap: wrap;
                        margin: 12px 0;
                    }
                    .gemma-model-pill {
                        display: inline-flex;
                        align-items: center;
                        border-radius: 999px;
                        padding: 4px 8px;
                        font-size: 11px;
                        border: 1px solid var(--theia-panel-border);
                    }
                    .gemma-model-pill.downloaded {
                        background: rgba(76, 175, 80, 0.12);
                    }
                    .gemma-model-pill.missing {
                        background: rgba(255, 152, 0, 0.12);
                    }
                    .gemma-model-pill.recommended {
                        background: rgba(33, 150, 243, 0.12);
                    }
                    .gemma-model-pill.selected {
                        background: rgba(156, 39, 176, 0.12);
                    }
                    .gemma-model-action {
                        width: 100%;
                        justify-content: center;
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
