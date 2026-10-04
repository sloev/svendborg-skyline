-- Automatisk NSFW-vurdering af billeder, video og dokumenter (0–1). NULL = ikke vurderet.
ALTER TABLE items ADD COLUMN nsfw REAL;
