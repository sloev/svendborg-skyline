-- Hard spending guard: count billable R2 operations per month and bytes stored.
CREATE TABLE usage (
  month    TEXT PRIMARY KEY,          -- YYYY-MM (UTC)
  class_a  INTEGER NOT NULL DEFAULT 0 -- R2 Class A operations (writes) this month
);
-- Size of the re-encoded files of an item (originals are counted via original_size until deleted).
ALTER TABLE items ADD COLUMN stored_bytes INTEGER NOT NULL DEFAULT 0;
