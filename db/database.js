// db/database.js
//
// This file creates the database file (oilindia.db) the first time the
// server runs, and defines every table the system needs. SQLite stores
// everything in one file on disk — perfect for getting started and for
// small-to-medium deployments. When Oil India scales up to many
// concurrent users, the same table structure can be moved to PostgreSQL
// with very few code changes (the SQL below is intentionally kept
// standard, not SQLite-specific, wherever possible).

const Database = require("better-sqlite3");
const path = require("path");

const dbPath = path.join(__dirname, "oilindia.db");
const db = new Database(dbPath);

// Enforce foreign key constraints (SQLite has this off by default)
db.pragma("foreign_keys = ON");

// ---------------------------------------------------------------------
// TABLE: users
// Every person who can log in: admin, manager, or engineer.
// ---------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin', 'manager', 'engineer')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  approval_status TEXT NOT NULL DEFAULT 'approved'
                  CHECK (approval_status IN ('pending', 'approved', 'rejected')),
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Migration: add the new columns automatically if this database was
// created by an older version of the app, so existing accounts keep
// working (they default to 'approved' so nobody already using the
// system suddenly gets locked out).
const userColumns = db.prepare("PRAGMA table_info(users)").all().map((c) => c.name);
if (!userColumns.includes("approval_status")) {
  db.exec("ALTER TABLE users ADD COLUMN approval_status TEXT NOT NULL DEFAULT 'approved'");
}
if (!userColumns.includes("created_by")) {
  db.exec("ALTER TABLE users ADD COLUMN created_by INTEGER REFERENCES users(id)");
}

// ---------------------------------------------------------------------
// TABLE: sites
// Each infrastructure project / physical site.
// ---------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS sites (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  location         TEXT,
  start_latitude   REAL,
  start_longitude  REAL,
  end_latitude     REAL,
  end_longitude    REAL,
  start_date       TEXT,
  end_date         TEXT,
  created_by       INTEGER REFERENCES users(id),
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// Migration safety net: if this table already existed from an earlier
// version of the app, add the new columns without wiping existing data.
// The old single latitude/longitude columns (if present from a very old
// database) are left in place but no longer used for new sites — this
// avoids breaking anyone who already has that column.
const siteColumns = db.prepare("PRAGMA table_info(sites)").all().map((c) => c.name);
if (!siteColumns.includes("start_latitude")) {
  db.exec("ALTER TABLE sites ADD COLUMN start_latitude REAL");
  // If an old single latitude/longitude pair exists, carry it over as
  // the start point so existing sites don't lose their map position.
  if (siteColumns.includes("latitude")) {
    db.exec("UPDATE sites SET start_latitude = latitude WHERE latitude IS NOT NULL");
  }
}
if (!siteColumns.includes("start_longitude")) {
  db.exec("ALTER TABLE sites ADD COLUMN start_longitude REAL");
  if (siteColumns.includes("longitude")) {
    db.exec("UPDATE sites SET start_longitude = longitude WHERE longitude IS NOT NULL");
  }
}
if (!siteColumns.includes("end_latitude")) {
  db.exec("ALTER TABLE sites ADD COLUMN end_latitude REAL");
}
if (!siteColumns.includes("end_longitude")) {
  db.exec("ALTER TABLE sites ADD COLUMN end_longitude REAL");
}
if (!siteColumns.includes("start_date")) {
  db.exec("ALTER TABLE sites ADD COLUMN start_date TEXT");
}
if (!siteColumns.includes("end_date")) {
  db.exec("ALTER TABLE sites ADD COLUMN end_date TEXT");
}

// ---------------------------------------------------------------------
// TABLE: site_assignments
// Which manager(s) and engineer(s) belong to which site.
// This is the table that makes "manager sees only their site" possible.
// ---------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS site_assignments (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id   INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  site_id   INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  UNIQUE(user_id, site_id)
);
`);

// ---------------------------------------------------------------------
// TABLE: tasks
// Each schedule line-item (from the planning stage) that execution
// data gets linked to. This is the "schedule-linking" core of the system.
// ---------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id        INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  assigned_to    INTEGER REFERENCES users(id),
  planned_start  TEXT,
  planned_end    TEXT,
  planned_pct    INTEGER NOT NULL DEFAULT 0,
  actual_pct     INTEGER NOT NULL DEFAULT 0,
  status         TEXT NOT NULL DEFAULT 'not_started'
                 CHECK (status IN ('not_started', 'pending', 'approved', 'rejected')),
  last_update    TEXT,
  remarks        TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// ---------------------------------------------------------------------
// TABLE: task_updates
// Every single progress submission is stored here permanently, even
// after it is approved or rejected. This is the audit trail for
// "who reported what, when" — never overwritten, only added to.
// ---------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS task_updates (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id        INTEGER NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  submitted_by   INTEGER NOT NULL REFERENCES users(id),
  pct            INTEGER NOT NULL,
  remarks        TEXT,
  photo_path     TEXT,
  gps_lat        REAL,
  gps_lng        REAL,
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by    INTEGER REFERENCES users(id),
  reviewed_at    TEXT,
  submitted_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

// task_updates.photo_path now stores a full Supabase Storage URL instead
// of a local file path (e.g. "/uploads/xyz.jpg"). No schema change needed
// since it was already a TEXT column — just documenting the new meaning.

// Track exactly when a task was marked 100% and approved — this is what
// the weekly/monthly reports group by. Added as a migration so existing
// databases upgrade safely.
const taskColumns = db.prepare("PRAGMA table_info(tasks)").all().map((c) => c.name);
if (!taskColumns.includes("completed_at")) {
  db.exec("ALTER TABLE tasks ADD COLUMN completed_at TEXT");
}

// ---------------------------------------------------------------------
// TABLE: audit_log
// A record of every important action for accountability.
// ---------------------------------------------------------------------
db.exec(`
CREATE TABLE IF NOT EXISTS audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id),
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   INTEGER,
  details     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

module.exports = db;
