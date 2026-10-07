ALTER TABLE reservations ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
ALTER TABLE reservations ADD COLUMN fulfillment_status TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS reservation_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id INTEGER NOT NULL,
  author TEXT NOT NULL CHECK(author IN ('user','staff')),
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  data_base64 TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reservation_attachments_request ON reservation_attachments(reservation_id);

CREATE TABLE IF NOT EXISTS reservation_activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id INTEGER NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  details TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reservation_activity_request ON reservation_activity(reservation_id);

CREATE TABLE IF NOT EXISTS reservation_documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id INTEGER NOT NULL,
  type TEXT NOT NULL CHECK(type IN ('devis','facture')),
  total REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reservation_documents_request ON reservation_documents(reservation_id);
