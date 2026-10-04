-- Kreditering / ophavsret (påkrævet) og om den må vises offentligt.
ALTER TABLE submissions ADD COLUMN credit TEXT NOT NULL DEFAULT '';
ALTER TABLE submissions ADD COLUMN show_credit INTEGER NOT NULL DEFAULT 0;
-- Hash af teksten, så den samme spam ikke kan sendes igen og igen.
ALTER TABLE submissions ADD COLUMN text_hash TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_submissions_text_hash ON submissions (text_hash, created_at);
-- Mislykkede admin-logins (brute force-beskyttelse).
CREATE TABLE auth_failures (
  ip_hash TEXT NOT NULL,
  at      TEXT NOT NULL
);
CREATE INDEX idx_auth_failures ON auth_failures (ip_hash, at);
