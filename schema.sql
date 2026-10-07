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
  fulfillment_status TEXT NOT NULL DEFAULT '',
  account_manager TEXT NOT NULL DEFAULT '',
  rentman_project_id INTEGER,
  pickup_token TEXT NOT NULL DEFAULT '',
  last_reminder_at TEXT NOT NULL DEFAULT ''
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

-- V17.0 magasin platform
CREATE TABLE IF NOT EXISTS magasin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL CHECK(role IN ('admin','staff')),
  first_name TEXT NOT NULL,last_name TEXT NOT NULL,birth_date TEXT NOT NULL,track TEXT NOT NULL,
  school_year TEXT NOT NULL CHECK(school_year IN ('A1','A2','A3')),email TEXT NOT NULL UNIQUE,phone TEXT NOT NULL,
  photo_base64 TEXT NOT NULL DEFAULT '',password_hash TEXT NOT NULL,password_salt TEXT NOT NULL,
  totp_secret TEXT NOT NULL DEFAULT '',totp_enabled INTEGER NOT NULL DEFAULT 0,active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS magasin_sessions (token_hash TEXT PRIMARY KEY,user_id INTEGER NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS equipment_alternatives (equipment_id INTEGER NOT NULL,alternative_equipment_id INTEGER NOT NULL,created_by INTEGER,created_at TEXT NOT NULL,PRIMARY KEY(equipment_id,alternative_equipment_id));
CREATE TABLE IF NOT EXISTS equipment_units (id INTEGER PRIMARY KEY AUTOINCREMENT,equipment_id INTEGER NOT NULL,label TEXT NOT NULL,barcode TEXT NOT NULL UNIQUE,serial_number TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'available',notes TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reservation_unit_events (id INTEGER PRIMARY KEY AUTOINCREMENT,reservation_id INTEGER NOT NULL,unit_id INTEGER NOT NULL,phase TEXT NOT NULL,condition_status TEXT NOT NULL DEFAULT 'ok',comment TEXT NOT NULL DEFAULT '',photo_base64 TEXT NOT NULL DEFAULT '',actor TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reservation_incidents (id INTEGER PRIMARY KEY AUTOINCREMENT,reservation_id INTEGER NOT NULL,equipment_id INTEGER,unit_id INTEGER,type TEXT NOT NULL,comment TEXT NOT NULL DEFAULT '',photo_base64 TEXT NOT NULL DEFAULT '',actor TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS reservation_document_files (id INTEGER PRIMARY KEY AUTOINCREMENT,reservation_id INTEGER NOT NULL,type TEXT NOT NULL,name TEXT NOT NULL,mime_type TEXT NOT NULL,data_base64 TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL);
