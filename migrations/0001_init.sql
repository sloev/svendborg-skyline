-- One contribution ("bidrag") = a story + zero or more files.
CREATE TABLE submissions (
  id             TEXT PRIMARY KEY,
  created_at     TEXT NOT NULL,
  published_at   TEXT,
  -- uploading | review | published | hidden
  status         TEXT NOT NULL DEFAULT 'uploading',
  title          TEXT NOT NULL DEFAULT '',
  story          TEXT NOT NULL DEFAULT '',
  period         TEXT NOT NULL DEFAULT '',
  place          TEXT NOT NULL DEFAULT '',
  perspective    TEXT NOT NULL DEFAULT '',
  relation       TEXT NOT NULL DEFAULT '',
  name           TEXT NOT NULL DEFAULT '',
  email          TEXT NOT NULL DEFAULT '',
  show_name      INTEGER NOT NULL DEFAULT 0,
  share_location INTEGER NOT NULL DEFAULT 0,
  contact_ok     INTEGER NOT NULL DEFAULT 0,
  upload_token   TEXT NOT NULL,
  ip_hash        TEXT NOT NULL DEFAULT '',
  user_agent     TEXT NOT NULL DEFAULT '',
  reports        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_submissions_status ON submissions (status, published_at);
CREATE INDEX idx_submissions_ip ON submissions (ip_hash, created_at);

CREATE TABLE items (
  id             TEXT PRIMARY KEY,
  submission_id  TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  position       INTEGER NOT NULL,
  -- image | video | audio | document
  kind           TEXT NOT NULL,
  original_key   TEXT NOT NULL,
  original_name  TEXT NOT NULL,
  original_type  TEXT NOT NULL DEFAULT '',
  original_size  INTEGER NOT NULL,
  original_last_modified TEXT NOT NULL DEFAULT '',
  upload_id      TEXT,
  -- uploading | pending | processing | ready | failed
  status         TEXT NOT NULL DEFAULT 'uploading',
  attempts       INTEGER NOT NULL DEFAULT 0,
  claimed_at     TEXT,
  error          TEXT NOT NULL DEFAULT '',
  display_key    TEXT,
  thumb_key      TEXT,
  poster_key     TEXT,
  width          INTEGER,
  height         INTEGER,
  duration       REAL,
  taken_at       TEXT,
  camera         TEXT,
  lat            REAL,
  lon            REAL,
  metadata       TEXT,          -- full exiftool dump (JSON), never public
  archive_path   TEXT,          -- where the original lives in Google Drive
  original_deleted INTEGER NOT NULL DEFAULT 0,
  processed_at   TEXT
);
CREATE INDEX idx_items_submission ON items (submission_id, position);
CREATE INDEX idx_items_status ON items (status);

CREATE TABLE reports (
  submission_id  TEXT NOT NULL,
  ip_hash        TEXT NOT NULL,
  reason         TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL,
  PRIMARY KEY (submission_id, ip_hash)
);
