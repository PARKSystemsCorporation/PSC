/**
 * Gemma Theia IDE — Connection Manager Frontend Module
 */

import { ContainerModule, injectable, inject } from '@theia/core/shared/inversify';
import {
    bindViewContribution,
    FrontendApplicationContribution,
    WidgetFactory,
    AbstractViewContribution,
    FrontendApplication,
} from '@theia/core/lib/browser';
import { Command } from '@theia/core/lib/common/command';
import { ConnectionManagerService } from './connection-manager-service';
import { ConnectionManagerWidget, CONNECTION_MANAGER_WIDGET_ID } from './connection-manager-widget';

const TOGGLE_CONNECTIONS: Command = {
    id: 'gemma.openSetup',
    label: 'Gemma: Open Setup',
    category: 'Gemma',
};

@injectable()
class ConnectionManagerContribution extends AbstractViewContribution<ConnectionManagerWidget>
    implements FrontendApplicationContribution {

    @inject(ConnectionManagerService)
    protected readonly connectionService: ConnectionManagerService;

    constructor() {
        super({
            widgetId: CONNECTION_MANAGER_WIDGET_ID,
            widgetName: 'Setup',
            defaultWidgetOptions: {
                area: 'right',
                rank: 200,
            },
            toggleCommandId: TOGGLE_CONNECTIONS.id,
        });
    }

    async initializeLayout(app: FrontendApplication): Promise<void> {
        const status = await this.connectionService.loadSetupStatus();
        if (status && !status.configured) {
            window.setTimeout(async () => {
                const shouldOpenSetup = window.confirm(
                    'No AI model is configured yet. Open setup now?'
                );
                if (shouldOpenSetup) {
                    await this.openView({ activate: true, reveal: true });
                }
            }, 1200);
        }
    }
}

export default new ContainerModule(bind => {
    bind(ConnectionManagerService).toSelf().inSingletonScope();

    bind(ConnectionManagerWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(ctx => ({
        id: ConnectionManagerWidget.ID,
        createWidget: () => ctx.container.get<ConnectionManagerWidget>(ConnectionManagerWidget),
    })).inSingletonScope();

    bindViewContribution(bind, ConnectionManagerContribution);
    bind(FrontendApplicationContribution).toService(ConnectionManagerContribution);
});
