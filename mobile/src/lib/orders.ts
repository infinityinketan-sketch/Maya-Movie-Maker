import { colors } from '../ui/theme';
import type { AdOrder, OrderStatus } from './types';

export const ORDER_STATUS: Record<OrderStatus, { label: string; color: string }> = {
  awaiting_advance: { label: 'Waiting for advance', color: colors.danger },
  new: { label: 'Advance received', color: colors.textMuted },
  producing: { label: 'In production', color: colors.accent },
  ready: { label: 'Ready to send', color: colors.warn },
  delivered: { label: 'Delivered · unpaid', color: colors.warn },
  paid: { label: 'Paid', color: colors.good },
  cancelled: { label: 'Cancelled', color: colors.textFaint },
};

/** Same rule as the server: half the price, rounded up, before any work starts. */
export function minAdvance(priceInr: number): number {
  return Math.ceil(priceInr / 2);
}

export function received(o: Pick<AdOrder, 'status' | 'price_inr' | 'advance_inr'>): number {
  if (o.status === 'cancelled') return o.advance_inr;
  return o.status === 'paid' ? o.price_inr : o.advance_inr;
}

export function balance(o: Pick<AdOrder, 'status' | 'price_inr' | 'advance_inr'>): number {
  if (o.status === 'cancelled' || o.status === 'paid') return 0;
  return Math.max(0, o.price_inr - o.advance_inr);
}
