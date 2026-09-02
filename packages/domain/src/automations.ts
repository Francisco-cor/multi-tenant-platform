export const AUTOMATION_TRIGGERS = [
  'order.created',
  'order.paid',
  'order.failed',
  'payment.paid',
  'payment.failed',
  'file.ready',
  'inventory.reserved',
] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

export const AUTOMATION_ACTION_TYPES = ['webhook', 'log', 'noop'] as const;
export type AutomationActionType = (typeof AUTOMATION_ACTION_TYPES)[number];

export interface AutomationCommand {
  version: number;
  type: AutomationActionType;
  params: Record<string, unknown>;
}

export const AUTOMATION_VERSION = 1;

export function validateAutomation(input: {
  trigger: string;
  action: unknown;
  version?: number | undefined;
}): { trigger: AutomationTrigger; action: AutomationCommand } {
  if (!(AUTOMATION_TRIGGERS as readonly string[]).includes(input.trigger)) {
    throw new Error(`automation_trigger_invalid:${input.trigger}`);
  }
  const version = input.version ?? AUTOMATION_VERSION;
  if (version !== 1) throw new Error(`automation_version_unsupported:${version}`);
  const action = input.action as Record<string, unknown>;
  if (!action || typeof action.type !== 'string') throw new Error('automation_action_invalid');
  if (!(AUTOMATION_ACTION_TYPES as readonly string[]).includes(action.type)) {
    throw new Error(`automation_action_type_invalid:${action.type}`);
  }
  // No eval, no function, no script — only versioned objects
  if (action.params !== undefined && typeof action.params !== 'object') {
    throw new Error('automation_params_invalid');
  }
  return {
    trigger: input.trigger as AutomationTrigger,
    action: {
      version,
      type: action.type as AutomationActionType,
      params: (action.params as Record<string, unknown>) ?? {},
    },
  };
}

export function isTriggerForEvent(trigger: AutomationTrigger, eventType: string): boolean {
  return trigger === eventType;
}
