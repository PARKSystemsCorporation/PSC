/**
 * Gemma Theia IDE — Terminal Agent Widget
 * ==========================================
 * Panel widget showing the agent's plan, step status, and execution controls.
 */

import * as React from 'react';
import { injectable, inject, postConstruct } from '@theia/core/shared/inversify';
import { ReactWidget } from '@theia/core/lib/browser/widgets/react-widget';
import { AiTerminalAgent, AgentPlan, AgentStep } from './ai-terminal-agent';

export const AI_TERMINAL_WIDGET_ID = 'gemma-ai-terminal-agent';

@injectable()
export class AiTerminalWidget extends ReactWidget {

    static readonly ID = AI_TERMINAL_WIDGET_ID;
    static readonly LABEL = 'Terminal Agent';

    @inject(AiTerminalAgent)
    protected readonly agent: AiTerminalAgent;

    private taskInput: string = '';
    private logs: string[] = [];
    private plan: AgentPlan | null = null;

    @postConstruct()
    protected init(): void {
        this.id = AiTerminalWidget.ID;
        this.title.label = AiTerminalWidget.LABEL;
        this.title.caption = 'Gemma AI Terminal Agent';
        this.title.iconClass = 'codicon codicon-terminal';
        this.title.closable = true;
        this.addClass('gemma-terminal-agent-widget');

        this.agent.onPlanUpdate(plan => {
            this.plan = plan;
            this.update();
        });

        this.agent.onLog(msg => {
            this.logs.push(msg);
            if (this.logs.length > 200) this.logs.shift();
            this.update();
        });

        // Handle command execution requests
        this.agent.onCommandRequest(({ step, callback }) => {
            // In a real implementation, this would create a terminal and execute the command
            // For now, we simulate by logging and calling back
            this.logs.push(`[Exec] $ ${step.command}`);
            this.update();
            // The actual terminal integration would go here
            setTimeout(() => callback('Command queued for execution'), 100);
        });

        this.update();
    }

    private async handlePlan(): Promise<void> {
        const task = this.taskInput.trim();
        if (!task) return;

        this.taskInput = '';
        this.update();

        try {
            await this.agent.planTask(task);
        } catch (err: any) {
            this.logs.push(`[Error] ${err.message}`);
            this.update();
        }
    }

    private async handleExecute(): Promise<void> {
        try {
            await this.agent.executePlan();
        } catch (err: any) {
            this.logs.push(`[Error] ${err.message}`);
            this.update();
        }
    }

    private handleReset(): void {
        this.agent.reset();
        this.logs = [];
        this.update();
    }

    private getStepIcon(status: AgentStep['status']): string {
        switch (status) {
            case 'pending': return 'codicon-circle-outline';
            case 'running': return 'codicon-loading codicon-modifier-spin';
            case 'success': return 'codicon-check';
            case 'failed': return 'codicon-error';
            case 'skipped': return 'codicon-debug-step-over';
            default: return 'codicon-circle-outline';
        }
    }

    private getStatusColor(status: AgentStep['status']): string {
        switch (status) {
            case 'success': return '#4caf50';
            case 'failed': return '#f44336';
            case 'running': return '#2196f3';
            case 'skipped': return '#9e9e9e';
            default: return 'inherit';
        }
    }

    protected render(): React.ReactNode {
        return (
            <div className="gemma-agent-container">
                {/* Task Input */}
                <div className="gemma-agent-input-area">
                    <textarea
                        className="gemma-agent-input"
                        value={this.taskInput}
                        placeholder="Describe a task... (e.g., 'Set up a new Express.js project with TypeScript')"
                        rows={3}
                        onChange={e => { this.taskInput = (e.target as HTMLTextAreaElement).value; this.update(); }}
                        onKeyDown={e => {
                            if (e.key === 'Enter' && !e.shiftKey) {
                                e.preventDefault();
                                this.handlePlan();
                            }
                        }}
                    />
                    <div className="gemma-agent-toolbar">
                        <button
                            className="gemma-btn gemma-btn-primary"
                            onClick={() => this.handlePlan()}
                            disabled={!this.taskInput.trim()}
                        >
                            <span className="codicon codicon-lightbulb" /> Plan
                        </button>
                        {this.plan?.status === 'awaiting_confirmation' && (
                            <button className="gemma-btn gemma-btn-success" onClick={() => this.handleExecute()}>
                                <span className="codicon codicon-play" /> Execute All
                            </button>
                        )}
                        <button className="gemma-btn gemma-btn-secondary" onClick={() => this.handleReset()}>
                            <span className="codicon codicon-refresh" /> Reset
                        </button>
                        <label className="gemma-agent-auto-toggle">
                            <input
                                type="checkbox"
                                checked={this.agent.isAutoExecute}
                                onChange={e => { this.agent.isAutoExecute = (e.target as HTMLInputElement).checked; }}
                            />
                            Auto-execute
                        </label>
                    </div>
                </div>

                {/* Plan */}
                {this.plan && (
                    <div className="gemma-agent-plan">
                        <div className="gemma-agent-plan-header">
                            <strong>Plan:</strong> {this.plan.task}
                            <span className={`gemma-agent-status gemma-status-${this.plan.status}`}>
                                {this.plan.status}
                            </span>
                        </div>
                        <div className="gemma-agent-steps">
                            {this.plan.steps.map((step, i) => (
                                <div key={step.id} className={`gemma-step gemma-step-${step.status}`}>
                                    <span className={`gemma-step-icon codicon ${this.getStepIcon(step.status)}`}
                                        style={{ color: this.getStatusColor(step.status) }}
                                    />
                                    <div className="gemma-step-content">
                                        <div className="gemma-step-desc">
                                            <span className="gemma-step-num">{i + 1}.</span>
                                            {step.description}
                                        </div>
                                        <code className="gemma-step-cmd">$ {step.command}</code>
                                        {step.output && (
                                            <pre className="gemma-step-output">{step.output}</pre>
                                        )}
                                        {step.error && (
                                            <pre className="gemma-step-error">{step.error}</pre>
                                        )}
                                    </div>
                                    {step.status === 'pending' && (
                                        <button
                                            className="gemma-step-run"
                                            onClick={() => this.agent.executeStep(i)}
                                            title="Run this step"
                                        >
                                            <span className="codicon codicon-play" />
                                        </button>
                                    )}
                                </div>
                            ))}
                        </div>
                    </div>
                )}

                {/* Log */}
                <div className="gemma-agent-log">
                    {this.logs.map((log, i) => (
                        <div key={i} className="gemma-log-line">{log}</div>
                    ))}
                </div>

                <style>{`
                    .gemma-agent-container {
                        display: flex;
                        flex-direction: column;
                        height: 100%;
                        background: var(--theia-editor-background);
                        color: var(--theia-foreground);
                        font-family: var(--theia-ui-font-family);
                    }
                    .gemma-agent-input-area {
                        padding: 10px;
                        border-bottom: 1px solid var(--theia-panel-border);
                    }
                    .gemma-agent-input {
                        width: 100%;
                        background: var(--theia-input-background);
                        color: var(--theia-input-foreground);
                        border: 1px solid var(--theia-input-border);
                        border-radius: 4px;
                        padding: 8px;
                        font-size: 13px;
                        resize: none;
                        box-sizing: border-box;
                    }
                    .gemma-agent-toolbar {
                        display: flex;
                        gap: 6px;
                        align-items: center;
                        margin-top: 6px;
                    }
                    .gemma-btn {
                        display: flex;
                        align-items: center;
                        gap: 4px;
                        padding: 4px 10px;
                        border: none;
                        border-radius: 4px;
                        cursor: pointer;
                        font-size: 12px;
                        color: var(--theia-button-foreground);
                    }
                    .gemma-btn-primary { background: var(--theia-button-background); }
                    .gemma-btn-success { background: #388e3c; }
                    .gemma-btn-secondary { background: var(--theia-button-secondaryBackground); color: var(--theia-button-secondaryForeground); }
                    .gemma-btn:disabled { opacity: 0.5; cursor: default; }
                    .gemma-agent-auto-toggle {
                        display: flex;
                        align-items: center;
                        gap: 4px;
                        font-size: 12px;
                        margin-left: auto;
                        opacity: 0.8;
                    }
                    .gemma-agent-plan {
                        flex: 1;
                        overflow-y: auto;
                        padding: 10px;
                    }
                    .gemma-agent-plan-header {
                        display: flex;
                        align-items: center;
                        gap: 8px;
                        margin-bottom: 10px;
                        font-size: 13px;
                    }
                    .gemma-agent-status {
                        padding: 2px 8px;
                        border-radius: 10px;
                        font-size: 11px;
                        font-weight: 600;
                    }
                    .gemma-status-planning { background: #1565c0; }
                    .gemma-status-awaiting_confirmation { background: #f57f17; color: #000; }
                    .gemma-status-executing { background: #2196f3; }
                    .gemma-status-completed { background: #388e3c; }
                    .gemma-status-failed { background: #c62828; }
                    .gemma-step {
                        display: flex;
                        align-items: flex-start;
                        gap: 8px;
                        padding: 6px 0;
                        border-bottom: 1px solid var(--theia-panel-border);
                    }
                    .gemma-step-icon { margin-top: 2px; }
                    .gemma-step-content { flex: 1; }
                    .gemma-step-desc { font-size: 13px; margin-bottom: 2px; }
                    .gemma-step-num { opacity: 0.6; margin-right: 4px; }
                    .gemma-step-cmd {
                        display: block;
                        font-size: 12px;
                        padding: 4px 8px;
                        background: var(--theia-textCodeBlock-background);
                        border-radius: 3px;
                        font-family: var(--theia-code-font-family);
                    }
                    .gemma-step-output, .gemma-step-error {
                        font-size: 11px;
                        padding: 4px 8px;
                        margin-top: 4px;
                        border-radius: 3px;
                        font-family: var(--theia-code-font-family);
                        max-height: 100px;
                        overflow-y: auto;
                    }
                    .gemma-step-output { background: var(--theia-textCodeBlock-background); }
                    .gemma-step-error { background: rgba(244,67,54,0.15); color: #ef9a9a; }
                    .gemma-step-run {
                        background: none;
                        border: none;
                        cursor: pointer;
                        color: var(--theia-foreground);
                        opacity: 0.6;
                        padding: 4px;
                    }
                    .gemma-step-run:hover { opacity: 1; }
                    .gemma-agent-log {
                        max-height: 120px;
                        overflow-y: auto;
                        padding: 6px 10px;
                        font-family: var(--theia-code-font-family);
                        font-size: 11px;
                        border-top: 1px solid var(--theia-panel-border);
                        opacity: 0.7;
                    }
                    .gemma-log-line { padding: 1px 0; }
                `}</style>
            </div>
        );
    }
}
