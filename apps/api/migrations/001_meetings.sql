CREATE TABLE IF NOT EXISTS meetings (
  id uuid PRIMARY KEY,
  join_code varchar(64) NOT NULL UNIQUE,
  title varchar(160) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
