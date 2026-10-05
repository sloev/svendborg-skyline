-- Strukturerede data til søgning: entiteter (personer, skibe, bygninger, firmaer, steder, køretøjer)
-- som JSON-liste af [type, navn], og årstal udledt af "Hvornår" (eller sat i admin).
ALTER TABLE submissions ADD COLUMN entities TEXT NOT NULL DEFAULT '[]';
ALTER TABLE submissions ADD COLUMN year_from INTEGER;
ALTER TABLE submissions ADD COLUMN year_to INTEGER;
CREATE INDEX idx_submissions_years ON submissions (year_from, year_to);
