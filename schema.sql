CREATE TABLE IF NOT EXISTS bookings (
  booking_id BIGINT PRIMARY KEY,
  coworker_id BIGINT NOT NULL,
  coworker_full_name TEXT,
  resource_name TEXT,
  from_time_utc TIMESTAMPTZ NOT NULL,
  to_time_utc TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL,
  payload JSONB NOT NULL,
  fetched_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_bookings_coworker_id ON bookings (coworker_id);
CREATE INDEX IF NOT EXISTS idx_bookings_time ON bookings (from_time_utc, to_time_utc);

CREATE TABLE IF NOT EXISTS dedicated_members (
  coworker_id BIGINT PRIMARY KEY,
  coworker_userid BIGINT,
  full_name TEXT,
  tariff_names TEXT,
  payload JSONB NOT NULL,
  updated_at_utc TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS job_state (
  job_name TEXT PRIMARY KEY,
  last_run_utc TIMESTAMPTZ NOT NULL
);
