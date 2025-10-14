CREATE TABLE IF NOT EXISTS bookings (
  booking_id BIGINT PRIMARY KEY,
  coworker_id BIGINT,
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

CREATE TABLE IF NOT EXISTS visitors (
  visitor_id            BIGINT PRIMARY KEY,
  coworker_id           BIGINT,
  coworker_full_name    TEXT,
  full_name             TEXT,
  email                 TEXT,
  visitor_code          TEXT,
  phone_number          TEXT,
  notes                 TEXT,
  expected_arrival_utc  TIMESTAMPTZ,
  arrived               BOOLEAN DEFAULT FALSE,
  arrival_date_utc      TIMESTAMPTZ,
  departure_date_utc    TIMESTAMPTZ,
  is_tour               BOOLEAN DEFAULT FALSE,
  payload               JSONB NOT NULL,
  fetched_at_utc        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_visitors_expected_arrival ON visitors (expected_arrival_utc);
CREATE INDEX IF NOT EXISTS idx_visitors_arrived ON visitors (arrived);

