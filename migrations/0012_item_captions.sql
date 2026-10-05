-- Billedtekst pr. fil, så teksten hører til det rigtige billede i bidrag med flere filer.
ALTER TABLE items ADD COLUMN caption TEXT NOT NULL DEFAULT '';
