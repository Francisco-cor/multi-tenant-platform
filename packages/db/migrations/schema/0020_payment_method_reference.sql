-- Persist the provider payment method reference without storing card data.
alter table payment_attempts
  add column if not exists payment_method_id text;
