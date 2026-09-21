-- Store an encrypted webhook signing secret; secret_hash remains for non-reversible lookup/audit.
alter table webhook_endpoints
  add column if not exists secret_ciphertext text;
