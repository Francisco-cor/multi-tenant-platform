# Data migrations

There are no data backfills in the current identity slice. Add resumable
data-only migrations here when an expand-contract change needs them. Keep
large backfills separate from schema DDL and make each step safe to retry.
