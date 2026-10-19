import { colors } from '../ui/theme';
import type { OrderStatus } from './types';

export const ORDER_STATUS: Record<OrderStatus, { label: string; color: string }> = {
  new: { label: 'New', color: colors.textMuted },
  producing: { label: 'In production', color: colors.accent },
  ready: { label: 'Ready to send', color: colors.warn },
  delivered: { label: 'Delivered · unpaid', color: colors.warn },
  paid: { label: 'Paid', color: colors.good },
  cancelled: { label: 'Cancelled', color: colors.textFaint },
};
