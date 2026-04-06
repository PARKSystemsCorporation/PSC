/**
 * Gemma Theia IDE — Terminal Agent Frontend Module
 */

import { ContainerModule } from '@theia/core/shared/inversify';
import {
    bindViewContribution,
    FrontendApplicationContribution,
    WidgetFactory,
} from '@theia/core/lib/browser';
import { CommandContribution } from '@theia/core/lib/common/command';
import { Command, CommandRegistry } from '@theia/core/lib/common/command';
import { AbstractViewContribution, FrontendApplication } from '@theia/core/lib/browser';
import { AiTerminalAgent } from './ai-terminal-agent';
import { AiTerminalWidget, AI_TERMINAL_WIDGET_ID } from './ai-terminal-widget';
import { injectable } from '@theia/core/shared/inversify';

const TOGGLE_TERMINAL_AGENT: Command = {
    id: 'gemma.toggleTerminalAgent',
    label: 'Gemma AI: Toggle Terminal Agent',
    category: 'AI',
};

@injectable()
class AiTerminalContribution extends AbstractViewContribution<AiTerminalWidget>
    implements FrontendApplicationContribution {

    constructor() {
        super({
            widgetId: AI_TERMINAL_WIDGET_ID,
            widgetName: 'Terminal Agent',
            defaultWidgetOptions: {
                area: 'bottom',
                rank: 200,
            },
            toggleCommandId: TOGGLE_TERMINAL_AGENT.id,
        });
    }

    async initializeLayout(app: FrontendApplication): Promise<void> {
        // Don't auto-open, let user activate via command
    }
}

export default new ContainerModule(bind => {
    bind(AiTerminalAgent).toSelf().inSingletonScope();

    bind(AiTerminalWidget).toSelf();
    bind(WidgetFactory).toDynamicValue(ctx => ({
        id: AiTerminalWidget.ID,
        createWidget: () => ctx.container.get<AiTerminalWidget>(AiTerminalWidget),
    })).inSingletonScope();

    bindViewContribution(bind, AiTerminalContribution);
    bind(FrontendApplicationContribution).toService(AiTerminalContribution);
});
