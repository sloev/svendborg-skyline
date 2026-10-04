-- Importeret materiale (f.eks. fra Wikimedia Commons): kilde og licens, som skal vises ved bidraget.
ALTER TABLE submissions ADD COLUMN source_url TEXT NOT NULL DEFAULT '';
ALTER TABLE submissions ADD COLUMN license TEXT NOT NULL DEFAULT '';
ALTER TABLE submissions ADD COLUMN license_url TEXT NOT NULL DEFAULT '';
CREATE INDEX idx_submissions_source ON submissions (source_url);
