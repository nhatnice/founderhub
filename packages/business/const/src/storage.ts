export const StorageBlockReason = {
  MonthlyCapReached: 'monthly_cap_reached',
  NoPaymentMethod: 'no_payment_method',
  OverageNotEnabled: 'overage_not_enabled',
  SubscriptionPastDue: 'subscription_past_due',
  SubscriptionUnpaid: 'subscription_unpaid',
  UpgradeRequired: 'upgrade_required',
  WithinLimit: 'within_limit',
} as const;

export type StorageBlockReason = (typeof StorageBlockReason)[keyof typeof StorageBlockReason];
