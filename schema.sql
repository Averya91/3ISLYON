CREATE TABLE IF NOT EXISTS reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','accepted','refused')),
  role TEXT NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  email TEXT NOT NULL,
  track TEXT DEFAULT '',
  year TEXT DEFAULT '',
  course TEXT DEFAULT '',
  date_from TEXT NOT NULL,
  date_to TEXT NOT NULL,
  reason TEXT NOT NULL,
  personal_use INTEGER NOT NULL DEFAULT 0,
  person_source TEXT DEFAULT 'manual',
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  fulfillment_status TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_reservations_email ON reservations(email);
CREATE INDEX IF NOT EXISTS idx_reservations_status ON reservations(status);

CREATE TABLE IF NOT EXISTS reservation_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id INTEGER NOT NULL,
  equipment_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY(reservation_id) REFERENCES reservations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_reservation_items_request ON reservation_items(reservation_id);

CREATE TABLE IF NOT EXISTS reservation_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id INTEGER NOT NULL,
  author TEXT NOT NULL CHECK(author IN ('user','staff')),
  message TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY(reservation_id) REFERENCES reservations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_reservation_messages_request ON reservation_messages(reservation_id);


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
