// routes/sites.js
//
// Handles: viewing sites (filtered by role), creating/deleting sites
// (admin only), and assigning managers/engineers to a site.

const express = require("express");
const db = require("../db/database");
const { requireAuth, requireRole } = require("../middleware/auth");
const { getAccessibleSiteIds } = require("../middleware/scope");

const router = express.Router();

// Works out, given a site's start/end date and today's date, what
// percentage of the project SHOULD be complete by now (a straight-line
// expectation across the timeline), and compares it to actual progress
// to decide On Time vs Delayed. This is the timeline-aware version of
// status \u2014 it replaces the old "compare to planned %" approach, which
// couldn't tell the difference between "just started, right on
// schedule" and "just started, badly behind".
function computeTimelineStatus(startDate, endDate, actualPct) {
  if (!startDate || !endDate) {
    // No timeline set for this site yet \u2014 caller falls back to the
    // simpler planned-vs-actual comparison.
    return { expectedPct: null, status: null };
  }

  const start = new Date(startDate).getTime();
  const end = new Date(endDate).getTime();
  const now = Date.now();

  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) {
    return { expectedPct: null, status: null };
  }

  let expectedPct;
  if (now <= start) {
    expectedPct = 0;
  } else if (now >= end) {
    expectedPct = 100;
  } else {
    expectedPct = Math.round(((now - start) / (end - start)) * 100);
  }

  const gap = expectedPct - actualPct;
  let status;
  if (actualPct >= 100) status = "on_track"; // fully done, regardless of date
  else if (gap <= 0) status = "on_track"; // ahead of or exactly on the expected pace
  else if (gap <= 10) status = "watch";
  else status = "delayed";

  return { expectedPct, status };
}

// Safely converts a value coming from the request body into a number
// for latitude/longitude, or returns null if it's empty/missing.
// Throws a clear error if something was actually typed but isn't a
// valid number \u2014 this is the fix for the earlier bug where a bad
// value silently became null and the pin just vanished with no
// explanation.
function parseCoordinate(value, fieldLabel) {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  if (Number.isNaN(num)) {
    throw new Error(`${fieldLabel} must be a valid number (e.g. 27.3667).`);
  }
  if (num < -90 && fieldLabel.toLowerCase().includes("latitude")) {
    throw new Error(`${fieldLabel} must be between -90 and 90.`);
  }
  return num;
}

// GET /sites
// Returns only the sites this logged-in user is allowed to see.
// Includes start/end point coordinates (for the map view's pins and
// connecting line), start/end dates, a live progress rollup, the
// timeline-based expected-vs-actual status, and a short "currently
// happening" summary from the most recently updated task.
router.get("/", requireAuth, (req, res) => {
  const siteIds = getAccessibleSiteIds(req.user);

  if (siteIds.length === 0) {
    return res.json([]);
  }

  const placeholders = siteIds.map(() => "?").join(",");
  const sites = db
    .prepare(`SELECT * FROM sites WHERE id IN (${placeholders}) ORDER BY name`)
    .all(...siteIds);

  const withProgress = sites.map((site) => {
    const tasks = db.prepare("SELECT planned_pct, actual_pct, name, last_update FROM tasks WHERE site_id = ?").all(site.id);
    const planned = tasks.length ? Math.round(tasks.reduce((a, t) => a + t.planned_pct, 0) / tasks.length) : 0;
    const actual = tasks.length ? Math.round(tasks.reduce((a, t) => a + t.actual_pct, 0) / tasks.length) : 0;

    const recentTask = tasks
      .filter((t) => t.last_update)
      .sort((a, b) => (a.last_update < b.last_update ? 1 : -1))[0];

    const timeline = computeTimelineStatus(site.start_date, site.end_date, actual);

    return {
      ...site,
      plannedProgress: planned,
      actualProgress: actual,
      expectedProgress: timeline.expectedPct, // null if no start/end date set
      timelineStatus: timeline.status, // "on_track" | "watch" | "delayed" | null
      currentActivity: recentTask ? recentTask.name : null,
      lastActivityAt: recentTask ? recentTask.last_update : null,
    };
  });

  res.json(withProgress);
});

// POST /sites
// Admin only. Body: { name, location, startLatitude, startLongitude,
// endLatitude, endLongitude, startDate, endDate, managerId }
// The start/end point coordinates are optional but needed for the map
// view's pins and the line connecting them (e.g. a pipeline running
// between two physical points). startDate/endDate (YYYY-MM-DD) drive
// the On Time / Delayed calculation. managerId is optional \u2014 if
// given, that manager is assigned in the same step.
router.post("/", requireAuth, requireRole("admin"), (req, res) => {
  const { name, location, startLatitude, startLongitude, endLatitude, endLongitude, startDate, endDate, managerId } = req.body;
  if (!name) return res.status(400).json({ error: "Site name is required." });

  if (startDate && endDate && new Date(endDate) <= new Date(startDate)) {
    return res.status(400).json({ error: "End date must be after the start date." });
  }

  let sLat, sLng, eLat, eLng;
  try {
    sLat = parseCoordinate(startLatitude, "Start latitude");
    sLng = parseCoordinate(startLongitude, "Start longitude");
    eLat = parseCoordinate(endLatitude, "End latitude");
    eLng = parseCoordinate(endLongitude, "End longitude");
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const result = db
    .prepare(
      `INSERT INTO sites (name, location, start_latitude, start_longitude, end_latitude, end_longitude, start_date, end_date, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(name, location || null, sLat, sLng, eLat, eLng, startDate || null, endDate || null, req.user.id);

  const siteId = result.lastInsertRowid;

  db.prepare(
    "INSERT INTO audit_log (user_id, action, target_type, target_id, details) VALUES (?, 'create_site', 'site', ?, ?)"
  ).run(req.user.id, siteId, name);

  let assignedManager = null;
  if (managerId) {
    const manager = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'manager'").get(managerId);
    if (!manager) {
      return res.status(400).json({ error: "Selected manager was not found." });
    }
    db.prepare("INSERT INTO site_assignments (user_id, site_id) VALUES (?, ?)").run(managerId, siteId);
    db.prepare(
      "INSERT INTO audit_log (user_id, action, target_type, target_id, details) VALUES (?, 'assign_site', 'site', ?, ?)"
    ).run(req.user.id, siteId, `Assigned ${manager.name} while creating ${name}`);
    assignedManager = { id: manager.id, name: manager.name };
  }

  res.status(201).json({
    id: siteId, name, location,
    startLatitude: sLat, startLongitude: sLng, endLatitude: eLat, endLongitude: eLng,
    startDate, endDate, assignedManager,
  });
});

// DELETE /sites/:id
// Admin only. Deletes a site and everything under it (assignments,
// tasks, and each task's submission history) via cascading foreign
// keys already defined in the schema. This cannot be undone, so the
// frontend should confirm with the admin before calling this.
router.delete("/:id", requireAuth, requireRole("admin"), (req, res) => {
  const siteId = req.params.id;
  const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(siteId);
  if (!site) return res.status(404).json({ error: "Site not found." });

  db.prepare("DELETE FROM sites WHERE id = ?").run(siteId);

  db.prepare(
    "INSERT INTO audit_log (user_id, action, target_type, target_id, details) VALUES (?, 'delete_site', 'site', ?, ?)"
  ).run(req.user.id, siteId, `Deleted site "${site.name}" and all its tasks`);

  res.json({ message: `${site.name} and all its tasks have been deleted.` });
});

// PATCH /sites/:id
// Admin only. Updates a site's timeline (start/end date) or basic
// details after creation \u2014 useful if dates weren't set at creation
// time or need correcting.
// Body: any of { name, location, startLatitude, startLongitude, endLatitude, endLongitude, startDate, endDate }
router.patch("/:id", requireAuth, requireRole("admin"), (req, res) => {
  const siteId = req.params.id;
  const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(siteId);
  if (!site) return res.status(404).json({ error: "Site not found." });

  const name = req.body.name ?? site.name;
  const location = req.body.location ?? site.location;
  const startDate = req.body.startDate ?? site.start_date;
  const endDate = req.body.endDate ?? site.end_date;

  let sLat, sLng, eLat, eLng;
  try {
    sLat = req.body.startLatitude !== undefined ? parseCoordinate(req.body.startLatitude, "Start latitude") : site.start_latitude;
    sLng = req.body.startLongitude !== undefined ? parseCoordinate(req.body.startLongitude, "Start longitude") : site.start_longitude;
    eLat = req.body.endLatitude !== undefined ? parseCoordinate(req.body.endLatitude, "End latitude") : site.end_latitude;
    eLng = req.body.endLongitude !== undefined ? parseCoordinate(req.body.endLongitude, "End longitude") : site.end_longitude;
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  if (startDate && endDate && new Date(endDate) <= new Date(startDate)) {
    return res.status(400).json({ error: "End date must be after the start date." });
  }

  db.prepare(
    `UPDATE sites SET name = ?, location = ?, start_latitude = ?, start_longitude = ?, end_latitude = ?, end_longitude = ?, start_date = ?, end_date = ? WHERE id = ?`
  ).run(name, location, sLat, sLng, eLat, eLng, startDate, endDate, siteId);

  db.prepare(
    "INSERT INTO audit_log (user_id, action, target_type, target_id, details) VALUES (?, 'update_site', 'site', ?, ?)"
  ).run(req.user.id, siteId, `Updated timeline/details for ${name}`);

  res.json({ message: "Site updated." });
});

// GET /sites/assignable-users
// Admin only. Returns managers and engineers not yet tied to any
// particular site filter \u2014 used to populate the "assign user to site"
// dropdown in the admin dashboard.
router.get("/assignable-users", requireAuth, requireRole("admin"), (req, res) => {
  const users = db
    .prepare("SELECT id, name, email, role FROM users WHERE role IN ('manager', 'engineer') AND is_active = 1 ORDER BY role, name")
    .all();
  res.json(users);
});

// POST /sites/:id/assign
// Admin only. Assigns a manager or engineer to a site.
// Body: { userId }
router.post("/:id/assign", requireAuth, requireRole("admin"), (req, res) => {
  const siteId = req.params.id;
  const { userId } = req.body;

  const site = db.prepare("SELECT * FROM sites WHERE id = ?").get(siteId);
  if (!site) return res.status(404).json({ error: "Site not found." });

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) return res.status(404).json({ error: "User not found." });

  try {
    db.prepare("INSERT INTO site_assignments (user_id, site_id) VALUES (?, ?)").run(userId, siteId);
  } catch (err) {
    return res.status(400).json({ error: "This user is already assigned to this site." });
  }

  res.status(201).json({ message: `${user.name} assigned to ${site.name}.` });
});

// GET /sites/:id/engineers
// Admin or Manager (if they have access to this site). Returns the list
// of engineers who belong to this site \u2014 used to populate the "assign
// to" dropdown when creating a new task, so a manager can only ever
// pick from their own team.
router.get("/:id/engineers", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const siteId = req.params.id;
  const accessibleSiteIds = getAccessibleSiteIds(req.user);

  if (!accessibleSiteIds.includes(Number(siteId))) {
    return res.status(403).json({ error: "You do not have access to this site." });
  }

  const engineers = db
    .prepare(
      `SELECT DISTINCT u.id, u.name, u.email, u.approval_status
       FROM users u
       WHERE u.role = 'engineer'
         AND u.is_active = 1
         AND (
           u.id IN (SELECT user_id FROM site_assignments WHERE site_id = ?)
           OR u.id IN (SELECT assigned_to FROM tasks WHERE site_id = ? AND assigned_to IS NOT NULL)
           OR u.created_by = ?
         )
       ORDER BY u.name`
    )
    .all(siteId, siteId, req.user.id);

  res.json(engineers);
});

// GET /sites/:id/assignments
// Admin only. Lists who (which managers/engineers) are currently
// assigned to this site \u2014 shown next to the assign form so the admin
// can see the current state before adding someone new.
router.get("/:id/assignments", requireAuth, requireRole("admin"), (req, res) => {
  const siteId = req.params.id;
  const assignments = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.role
       FROM site_assignments sa
       JOIN users u ON u.id = sa.user_id
       WHERE sa.site_id = ?
       ORDER BY u.role, u.name`
    )
    .all(siteId);
  res.json(assignments);
});

module.exports = router;
