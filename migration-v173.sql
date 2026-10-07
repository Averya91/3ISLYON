PRAGMA foreign_keys=OFF;

CREATE TABLE magasin_users_v173 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL CHECK(role IN ('admin','staff')),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  track TEXT NOT NULL DEFAULT '',
  school_year TEXT NOT NULL DEFAULT '',
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

INSERT INTO magasin_users_v173 (
  id,role,first_name,last_name,track,school_year,email,phone,photo_base64,
  password_hash,password_salt,totp_secret,totp_enabled,active,created_at,updated_at
)
SELECT
  id,role,first_name,last_name,
  COALESCE(track,''),COALESCE(school_year,''),email,phone,photo_base64,
  password_hash,password_salt,totp_secret,totp_enabled,active,created_at,updated_at
FROM magasin_users;

DROP TABLE magasin_users;
ALTER TABLE magasin_users_v173 RENAME TO magasin_users;
CREATE INDEX IF NOT EXISTS idx_magasin_users_email ON magasin_users(email);

PRAGMA foreign_keys=ON;
