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
