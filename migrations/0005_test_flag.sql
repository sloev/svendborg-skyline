-- Bidrag lavet af den automatiske test (GitHub Actions). Vises aldrig offentligt og slettes af testen.
ALTER TABLE submissions ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;
