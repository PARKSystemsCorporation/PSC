/**
 * Gemma Theia IDE — Connection Manager Frontend Module
 */

import { ContainerModule } from '@theia/core/shared/inversify';
import {
    bindViewContribution,
    FrontendApplicationContribution,
    WidgetFactory,
} from '@theia/core/lib/browser';
import { AbstractViewContribution, FrontendApplication } from '@theia/core/lib/browser';
import { Command } from '@theia/core/lib/common/command';
import { injectable } from '@theia/core/shared/inversify';
import { ConnectionManagerService } from './connection-manager-service';
import { ConnectionManagerWidget, CONNECTION_MANAGER_WIDGET_ID } from './connection-manager-widget';

const TOGGLE_CONNECTIONS: Command = {
    id: 'gemma.toggleConnections',
    label: 'Gemma: Toggle Connection Manager',
    category: 'Connection',
};

@injectable()
class ConnectionManagerContribution extends AbstractViewContribution<ConnectionManagerWidget>
    implements FrontendApplicationContribution {

    constructor() {
        super({
            widgetId: CONNECTION_MANAGER_WIDGET_ID,
            widgetName: 'Connections',
            defaultWidgetOptions: {
                area: 'right',
                rank: 200,
            },
            toggleCommandId: TOGGLE_CONNECTIONS.id,
        });
    }

    async initializeLayout(app: FrontendApplication): Promise<void> {
        // Don't auto-open
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
