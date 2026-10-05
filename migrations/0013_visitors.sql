-- Antal unikke besøgende (uden cookies). counters holder tallet; visit_hashes er en hash af IP og
-- browser med et salt, der skifter hver dag, så samme enhed kun tæller én gang pr. døgn. Hashes
-- slettes efter to dage, og de kan ikke føres tilbage til en IP-adresse.
CREATE TABLE counters (name TEXT PRIMARY KEY, n INTEGER NOT NULL DEFAULT 0);
INSERT INTO counters (name, n) VALUES ('visitors', 0);
CREATE TABLE visit_hashes (day TEXT NOT NULL, hash TEXT NOT NULL, PRIMARY KEY (day, hash));
