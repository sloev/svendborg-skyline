-- Kommentarer på bidrag. Starter som 'pending' og vises først, når en admin har godkendt dem
-- (medmindre COMMENT_MODERATION = "auto"). Tre anmeldelser skjuler en kommentar igen.
CREATE TABLE comments (
  id            TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  created_at    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',   -- pending | published | hidden
  name          TEXT NOT NULL,
  body          TEXT NOT NULL,
  ip_hash       TEXT NOT NULL DEFAULT '',          -- ryddes efter 30 dage
  text_hash     TEXT NOT NULL,
  ticket        TEXT NOT NULL UNIQUE,              -- hver billet kan kun bruges én gang
  spam_score    INTEGER NOT NULL DEFAULT 0,
  spam_reasons  TEXT NOT NULL DEFAULT '',
  reports       INTEGER NOT NULL DEFAULT 0,
  is_test       INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_comments_submission ON comments (submission_id, status, created_at);
CREATE INDEX idx_comments_ip ON comments (ip_hash, created_at);
CREATE INDEX idx_comments_text ON comments (text_hash, created_at);
CREATE INDEX idx_comments_status ON comments (status, created_at);

CREATE TABLE comment_reports (
  comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
  ip_hash    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (comment_id, ip_hash)
);
