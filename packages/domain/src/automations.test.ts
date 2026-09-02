import { describe, expect, it } from 'vitest';
import { validateAutomation, AUTOMATION_TRIGGERS } from './automations.js';

describe('automations versioned commands', () => {
  it('validates trigger and version', () => {
    expect(AUTOMATION_TRIGGERS).toContain('order.paid');
    const ok = validateAutomation({ trigger: 'order.paid', action: { type: 'log', params: { msg: 'hi' } }, version: 1 });
    expect(ok.trigger).toBe('order.paid');
    expect(ok.action.type).toBe('log');
    expect(ok.action.version).toBe(1);
  });

  it('rejects invalid trigger or unsupported version', () => {
    expect(() => validateAutomation({ trigger: 'invalid', action: { type: 'log' } })).toThrow(/automation_trigger_invalid/);
    expect(() => validateAutomation({ trigger: 'order.paid', action: { type: 'log' }, version: 99 })).toThrow(/automation_version_unsupported/);
  });

  it('rejects arbitrary code — only versioned types allowed', () => {
    expect(() => validateAutomation({ trigger: 'order.paid', action: { type: 'eval', code: 'rm -rf' } } as unknown as { trigger: string; action: unknown })).toThrow(/automation_action_type_invalid/);
    expect(() => validateAutomation({ trigger: 'order.paid', action: { type: 'webhook', params: 'not-object' } as unknown as { type: string; params: unknown } })).toThrow(/automation_params_invalid/);
  });

  it('defaults to version 1 when not provided', () => {
    const r = validateAutomation({ trigger: 'file.ready', action: { type: 'noop' } });
    expect(r.action.version).toBe(1);
  });
});
