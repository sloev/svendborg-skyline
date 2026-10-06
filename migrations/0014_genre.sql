-- Bidragets art: personlig (folks egne historier og billeder), dokument (avisudklip, bøger, rapporter,
-- arkivtekster) eller andet (andet indsamlet materiale, fx billeder fra andre arkiver og fotodelingssider).
ALTER TABLE submissions ADD COLUMN genre TEXT NOT NULL DEFAULT 'personlig';
UPDATE submissions SET genre = 'andet' WHERE coalesce(source_url, '') <> '';
UPDATE submissions SET genre = 'dokument'
  WHERE coalesce(source_url, '') <> ''
    AND (NOT EXISTS (SELECT 1 FROM items WHERE submission_id = submissions.id)
         OR EXISTS (SELECT 1 FROM items WHERE submission_id = submissions.id AND kind = 'document'));
