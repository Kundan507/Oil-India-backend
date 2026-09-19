// db/seed.js
//
// Run this once with: npm run seed
// It creates demo users, sites, and tasks so you can log in and test
// the system immediately, instead of starting from a completely empty
// database. Safe to re-run — it clears old demo data first.

const bcrypt = require("bcryptjs");
const db = require("./database");

function run() {
  console.log("Seeding database with demo data...");

  db.exec(`
    DELETE FROM audit_log;
    DELETE FROM task_updates;
    DELETE FROM tasks;
    DELETE FROM site_assignments;
    DELETE FROM sites;
    DELETE FROM users;
  `);

  // NOTE: In production, never use these passwords. Each real user should
  // set their own password on first login (see /auth/change-password).
  const passwordHash = bcrypt.hashSync("password123", 10);

  const insertUser = db.prepare(
    `INSERT INTO users (name, email, password_hash, role) VALUES (?, ?, ?, ?)`
  );

  const admin = insertUser.run("R. Bordoloi", "admin@oilindia.in", passwordHash, "admin");
  const mgr1 = insertUser.run("S. Hazarika", "hazarika.mgr@oilindia.in", passwordHash, "manager");
  const mgr2 = insertUser.run("P. Deka", "deka.mgr@oilindia.in", passwordHash, "manager");
  const eng1 = insertUser.run("A. Gogoi", "gogoi.eng@oilindia.in", passwordHash, "engineer");
  const eng2 = insertUser.run("M. Saikia", "saikia.eng@oilindia.in", passwordHash, "engineer");
  const eng3 = insertUser.run("K. Phukan", "phukan.eng@oilindia.in", passwordHash, "engineer");

  const insertSite = db.prepare(
    `INSERT INTO sites (name, location, start_latitude, start_longitude, end_latitude, end_longitude, start_date, end_date, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  // Real approximate coordinates for these Assam locations, so the map view
  // has something accurate to show. Each site now has a start point and an
  // end point (e.g. a pipeline running between two places), connected by a
  // line on the map. Start/end dates give the timeline-based On Time /
  // Delayed calculation something to work with:
  // - site1: started a while ago, well ahead of schedule -> should read On Time
  // - site2: started a while ago, behind where it should be -> should read Delayed
  // - site3: just started -> should read On Time (expected % is still low)
  const site1 = insertSite.run(
    "Duliajan Pipeline Extension", "Duliajan, Assam",
    27.3667, 95.3333, 27.4200, 95.4100,
    "2026-08-01", "2026-10-15", admin.lastInsertRowid
  );
  const site2 = insertSite.run(
    "Numaligarh Booster Station", "Numaligarh, Assam",
    26.6667, 93.7167, 26.7300, 93.8000,
    "2026-08-10", "2026-09-20", admin.lastInsertRowid
  );
  const site3 = insertSite.run(
    "Baghjan Well Pad Upgrade", "Baghjan, Assam",
    27.5333, 95.4167, 27.5800, 95.4700,
    "2026-09-06", "2026-11-30", admin.lastInsertRowid
  );

  const insertAssignment = db.prepare(
    `INSERT INTO site_assignments (user_id, site_id) VALUES (?, ?)`
  );

  insertAssignment.run(mgr1.lastInsertRowid, site1.lastInsertRowid);
  insertAssignment.run(mgr1.lastInsertRowid, site2.lastInsertRowid);
  insertAssignment.run(mgr2.lastInsertRowid, site3.lastInsertRowid);
  insertAssignment.run(eng1.lastInsertRowid, site1.lastInsertRowid);
  insertAssignment.run(eng2.lastInsertRowid, site2.lastInsertRowid);
  insertAssignment.run(eng3.lastInsertRowid, site3.lastInsertRowid);

  const insertTask = db.prepare(`
    INSERT INTO tasks (site_id, name, assigned_to, planned_start, planned_end, planned_pct, actual_pct, status, last_update, remarks)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  insertTask.run(
    site1.lastInsertRowid, "Trench Excavation - Ch. 4+200 to 6+000", eng1.lastInsertRowid,
    "2026-08-01", "2026-09-10", 100, 100, "approved", "2026-09-08",
    "Completed ahead of schedule, soil condition favourable."
  );
  insertTask.run(
    site1.lastInsertRowid, "Pipe Laying - Ch. 4+200 to 5+000", eng1.lastInsertRowid,
    "2026-09-05", "2026-09-25", 70, 40, "pending", "2026-09-13",
    "Delay due to material delivery held at Dibrugarh depot."
  );
  insertTask.run(
    site2.lastInsertRowid, "Foundation - Booster Pump Skid", eng2.lastInsertRowid,
    "2026-08-10", "2026-09-12", 100, 85, "pending", "2026-09-12",
    "Curing time extended by 3 days."
  );
  insertTask.run(
    site3.lastInsertRowid, "Instrumentation Cabling", eng3.lastInsertRowid,
    "2026-09-06", "2026-09-28", 55, 60, "pending", "2026-09-13",
    "Slightly ahead, spare cable drums available on site."
  );

  console.log("Done. Demo accounts (all use password: password123):");
  console.log("  Admin    -> admin@oilindia.in");
  console.log("  Manager  -> hazarika.mgr@oilindia.in");
  console.log("  Manager  -> deka.mgr@oilindia.in");
  console.log("  Engineer -> gogoi.eng@oilindia.in");
  console.log("  Engineer -> saikia.eng@oilindia.in");
  console.log("  Engineer -> phukan.eng@oilindia.in");
}

run();
