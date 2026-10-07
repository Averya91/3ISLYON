ALTER TABLE local_equipment ADD COLUMN equipment_type TEXT NOT NULL DEFAULT 'physical_item';
ALTER TABLE local_equipment ADD COLUMN properties_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE local_equipment ADD COLUMN contents_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE local_equipment ADD COLUMN accessories_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE local_equipment ADD COLUMN suppliers_json TEXT NOT NULL DEFAULT '[]';
ALTER TABLE local_equipment ADD COLUMN storage_location_id INTEGER;

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
