-- Filernes fulde metadata gemmes ikke længere; kun dato, kamera, GPS og størrelse.
-- Ryd de dumps, der blev gemt før.
UPDATE items SET metadata = NULL WHERE metadata IS NOT NULL;
