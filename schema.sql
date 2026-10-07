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
  first_name TEXT NOT NULL,last_name TEXT NOT NULL,track TEXT NOT NULL DEFAULT '',
  school_year TEXT NOT NULL DEFAULT '',email TEXT NOT NULL UNIQUE,phone TEXT NOT NULL,
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


CREATE TABLE IF NOT EXISTS reservation_internal_notes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reservation_id INTEGER NOT NULL,
  author TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reservation_internal_notes_request ON reservation_internal_notes(reservation_id);

CREATE TABLE IF NOT EXISTS local_equipment (
  equipment_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Autre',
  description TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'rentman',
  equipment_type TEXT NOT NULL DEFAULT 'physical_item',
  properties_json TEXT NOT NULL DEFAULT '{}',
  contents_json TEXT NOT NULL DEFAULT '[]',
  accessories_json TEXT NOT NULL DEFAULT '[]',
  suppliers_json TEXT NOT NULL DEFAULT '[]',
  storage_location_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS equipment_recommendation_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  equipment_id INTEGER NOT NULL,
  keywords TEXT NOT NULL,
  weight INTEGER NOT NULL DEFAULT 10,
  note TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_equipment_rules_equipment ON equipment_recommendation_rules(equipment_id);
CREATE INDEX IF NOT EXISTS idx_units_equipment_status ON equipment_units(equipment_id,status);


CREATE TABLE IF NOT EXISTS storage_locations (
 id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL UNIQUE,description TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS equipment_suppliers (
 id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,contact_name TEXT NOT NULL DEFAULT '',email TEXT NOT NULL DEFAULT '',phone TEXT NOT NULL DEFAULT '',website TEXT NOT NULL DEFAULT '',notes TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS equipment_supplier_links (
 equipment_id INTEGER NOT NULL,supplier_id INTEGER NOT NULL,reference TEXT NOT NULL DEFAULT '',purchase_price REAL,PRIMARY KEY(equipment_id,supplier_id)
);
CREATE TABLE IF NOT EXISTS equipment_contents (
 parent_equipment_id INTEGER NOT NULL,child_equipment_id INTEGER NOT NULL,quantity INTEGER NOT NULL DEFAULT 1,kind TEXT NOT NULL DEFAULT 'content',PRIMARY KEY(parent_equipment_id,child_equipment_id,kind)
);
CREATE INDEX IF NOT EXISTS idx_local_equipment_location ON local_equipment(storage_location_id);


CREATE TABLE IF NOT EXISTS equipment_categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#EA3E43',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS equipment_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '#64748B',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS equipment_tag_links (
  equipment_id INTEGER NOT NULL,
  tag_id INTEGER NOT NULL,
  PRIMARY KEY(equipment_id,tag_id)
);
CREATE INDEX IF NOT EXISTS idx_equipment_tag_links_equipment ON equipment_tag_links(equipment_id);
CREATE INDEX IF NOT EXISTS idx_equipment_tag_links_tag ON equipment_tag_links(tag_id);
