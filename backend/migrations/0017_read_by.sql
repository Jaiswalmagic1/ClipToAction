-- How a reel was read: by hearing it, or by watching it (D78, 2026-09-09).
--
-- NULL means the default and it is what every reel saved before today is: downloaded by
-- the PC and written down from its sound (D4, D28). 'watch' means somebody chose, for that
-- one reel, to have the model look at the video instead.
--
-- The column is not decoration. `claimQueue` refuses to hand out a source with it set, and
-- that is the whole of "the YouTube path removes the download": while a watch is in flight
-- the PC never sees the reel, so it is never fetched from YouTube at all. It is put back to
-- NULL the moment a watch fails, so a reel can never be stranded between the two routes.
ALTER TABLE sources ADD COLUMN read_by TEXT;

-- And when it was chosen. A watch runs inside one request; if that request dies part-way
-- nothing is left to clear the column above, so without this clock the reel would sit out
-- of the PC's queue for ever with no summary and nothing on screen saying why.
ALTER TABLE sources ADD COLUMN read_by_at INTEGER;
