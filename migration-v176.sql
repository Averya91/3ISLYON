
CREATE TABLE IF NOT EXISTS reservation_internal_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id INTEGER NOT NULL,
  author TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reservation_internal_notes_request ON reservation_internal_notes(reservation_id);
