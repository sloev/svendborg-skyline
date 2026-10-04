-- Full-resolution re-encoded file (photos: A3 @ 300 dpi JPEG). display_key is the screen-sized version.
ALTER TABLE items ADD COLUMN full_key TEXT;
-- GPS location is always kept and shown now.
UPDATE submissions SET share_location = 1;
