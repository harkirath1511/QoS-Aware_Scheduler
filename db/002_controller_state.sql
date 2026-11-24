CREATE TABLE IF NOT EXISTS controller_state (
  singleton boolean PRIMARY KEY CHECK (singleton),
  cloud_state text NOT NULL,
  observed_at bigint NOT NULL
);
