/**
 * Gemma Theia IDE — Terminal Agent Frontend Module
 */

import { ContainerModule, injectable, unmanaged } from '@theia/core/shared/inversify';
import {
    bindViewContribution,
    FrontendApplicationContribution,
    WidgetFactory,
    AbstractViewContribution,
    FrontendApplication,
} from '@theia/core/lib/browser';
import { Command } from '@theia/core/lib/common/command';
import { AiTerminalAgent } from './ai-terminal-agent';
import { AiTerminalWidget, AI_TERMINAL_WIDGET_ID } from './ai-terminal-widget';

const TOGGLE_TERMINAL_AGENT: Command = {
    id: 'gemma.toggleTerminalAgent',
    label: 'Gemma AI: Toggle Terminal Agent',
    category: 'AI',
};

@injectable()
class AiTerminalContribution extends AbstractViewContribution<AiTerminalWidget>
    implements FrontendApplicationContribution {

    // `@unmanaged()` is required here because AbstractViewContribution's constructor
    // takes plain widget options rather than an injectable service.
    // @ts-expect-error Inversify's constructor-parameter decorator types are too narrow here.
    constructor(@unmanaged() _viewOptions: unknown) {
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
