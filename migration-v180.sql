CREATE TABLE IF NOT EXISTS local_equipment (
  equipment_id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'Autre',
  description TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL DEFAULT 1,
  source TEXT NOT NULL DEFAULT 'rentman',
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
