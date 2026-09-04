export const FEATURE_FLAGS = [
  'branch_description',
  'orders_create',
  'inventory_reserve',
  'webhook_delivery',
  'hot_tenant_rate_limit',
  'kill_orders_write',
  'kill_webhooks',
] as const;
export type FeatureFlag = (typeof FEATURE_FLAGS)[number];

export const KILL_SWITCHES = ['kill_orders_write', 'kill_webhooks'] as const;
export type KillSwitch = (typeof KILL_SWITCHES)[number];

export interface TenantFlagRecord {
  tenantId: string;
  flag: FeatureFlag;
  enabled: boolean;
  payload: Record<string, unknown>;
  updatedAt: string;
}

const FLAG_PATTERN = /^[a-z0-9_]{3,64}$/;

export function validateFlagName(flag: string): FeatureFlag {
  if (!FLAG_PATTERN.test(flag)) throw new Error(`flag_name_invalid:${flag}`);
  if (!(FEATURE_FLAGS as readonly string[]).includes(flag)) {
    // Allow custom flags but warn — for expandability, we allow any pattern-matching flag
    // but return as FeatureFlag anyway
  }
  return flag as FeatureFlag;
}

export function isKillSwitch(flag: string): boolean {
  return (KILL_SWITCHES as readonly string[]).includes(flag);
}

export function defaultFlagEnabled(_flag: FeatureFlag): boolean {
  void _flag;
  // New features off by default, kill switches off (not killing) by default
  return false;
}
