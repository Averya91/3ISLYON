ALTER TABLE reservations ADD COLUMN rentman_project_id INTEGER;
ALTER TABLE reservations ADD COLUMN pickup_token TEXT NOT NULL DEFAULT '';
ALTER TABLE reservations ADD COLUMN last_reminder_at TEXT NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS magasin_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK(role IN ('admin','staff')),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  birth_date TEXT NOT NULL,
  track TEXT NOT NULL,
  school_year TEXT NOT NULL CHECK(school_year IN ('A1','A2','A3')),
  email TEXT NOT NULL UNIQUE,
  phone TEXT NOT NULL,
  photo_base64 TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  totp_secret TEXT NOT NULL DEFAULT '',
  totp_enabled INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_magasin_users_email ON magasin_users(email);

CREATE TABLE IF NOT EXISTS magasin_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_magasin_sessions_user ON magasin_sessions(user_id);

CREATE TABLE IF NOT EXISTS equipment_alternatives (
  equipment_id INTEGER NOT NULL,
  alternative_equipment_id INTEGER NOT NULL,
  created_by INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY(equipment_id, alternative_equipment_id)
);

CREATE TABLE IF NOT EXISTS equipment_units (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  barcode TEXT NOT NULL UNIQUE,
  serial_number TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available','prepared','out','maintenance','missing')),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_equipment_units_equipment ON equipment_units(equipment_id);

CREATE TABLE IF NOT EXISTS reservation_unit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id INTEGER NOT NULL,
  unit_id INTEGER NOT NULL,
  phase TEXT NOT NULL CHECK(phase IN ('prepare','checkout','return')),
  condition_status TEXT NOT NULL DEFAULT 'ok' CHECK(condition_status IN ('ok','damaged','missing','not_returned')),
  comment TEXT NOT NULL DEFAULT '',
  photo_base64 TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_unit_events_reservation ON reservation_unit_events(reservation_id);

CREATE TABLE IF NOT EXISTS reservation_incidents (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id INTEGER NOT NULL,
  equipment_id INTEGER,
  unit_id INTEGER,
  type TEXT NOT NULL,
  comment TEXT NOT NULL DEFAULT '',
  photo_base64 TEXT NOT NULL DEFAULT '',
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_incidents_reservation ON reservation_incidents(reservation_id);

CREATE TABLE IF NOT EXISTS reservation_document_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id INTEGER NOT NULL,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  data_base64 TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_document_files_reservation ON reservation_document_files(reservation_id);
