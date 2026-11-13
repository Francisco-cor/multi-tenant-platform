export function formatMoney(amountCents: number, currency: string): string {
  const amount = amountCents / 100;
  try {
    return new Intl.NumberFormat('es-ES', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${currency}`;
  }
}

export function formatDate(timestamp: number | string | Date): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('es-ES', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function formatDateOnly(timestamp: number | string | Date): string {
  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('es-ES', { dateStyle: 'medium' }).format(date);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function shortId(id: string, length = 10): string {
  if (id.length <= length) return id;
  return `${id.slice(0, length)}…`;
}

export function statusTone(status: string): 'positive' | 'warning' | 'danger' | 'neutral' {
  switch (status) {
    case 'active':
    case 'paid':
    case 'completed':
    case 'ready':
      return 'positive';
    case 'pending':
    case 'pending_payment':
    case 'processing':
    case 'invited':
      return 'warning';
    case 'failed':
    case 'cancelled':
    case 'suspended':
    case 'expired':
    case 'removed':
    case 'archived':
      return 'danger';
    default:
      return 'neutral';
  }
}

export function maxFileSizeLabel(): string {
  return '10 MB';
}
