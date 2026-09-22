-- Keep the previous webhook secret briefly so queued deliveries survive rotation.
alter table webhook_endpoints
  add column if not exists secret_version integer not null default 1,
  add column if not exists previous_secret_ciphertext text,
  add column if not exists previous_secret_version integer,
  add column if not exists previous_secret_expires_at timestamptz;

alter table webhook_deliveries
  add column if not exists secret_version integer not null default 1;

update webhook_deliveries delivery
set secret_version = endpoint.secret_version
from webhook_endpoints endpoint
where endpoint.id = delivery.endpoint_id
  and delivery.secret_version = 1
  and endpoint.secret_version <> 1;

create index if not exists webhook_deliveries_secret_version_idx
  on webhook_deliveries (endpoint_id, secret_version, status);
