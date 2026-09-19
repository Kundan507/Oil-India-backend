// routes/tasks.js
//
// This is the heart of the system: tasks represent the PLANNED schedule,
// and task_updates represent ACTUAL progress reported from the field.
// When an engineer submits an update, it links to its task by task_id —
// that link is the "schedule-linking" the whole project is named for.

const express = require("express");
const multer = require("multer");
const path = require("path");
const db = require("../db/database");
const { requireAuth, requireRole } = require("../middleware/auth");
const { getAccessibleSiteIds, getAccessibleTask } = require("../middleware/scope");
const { uploadSitePhoto } = require("../lib/supabase");

const router = express.Router();

// --- File upload setup for site photos ---
// Uses memory storage (not disk) because the file needs to go straight
// to Supabase Storage, not sit on this server's own disk. This also
// makes the backend safe to run on hosting platforms that don't keep
// local files between restarts.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 }, // 8MB max per photo
  fileFilter: (req, file, cb) => {
    const allowed = [".jpg", ".jpeg", ".png", ".webp"];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  },
});

// Attaches the most recent task_update (including its photo URL and
// GPS coordinates, if any) to each task row. This lets the Approval
// Center and dashboards show the submitted photo without a second
// round-trip per task.
function attachLatestUpdate(tasks) {
  return tasks.map((task) => {
    const latest = db
      .prepare("SELECT * FROM task_updates WHERE task_id = ? ORDER BY submitted_at DESC LIMIT 1")
      .get(task.id);
    return {
      ...task,
      latestPhotoUrl: latest ? latest.photo_path : null,
      latestGpsLat: latest ? latest.gps_lat : null,
      latestGpsLng: latest ? latest.gps_lng : null,
    };
  });
}

// GET /tasks
// Optional query: ?siteId=3  (only meaningful for admin/manager viewing a specific site)
// Returns tasks scoped to what this user is allowed to see.
router.get("/", requireAuth, (req, res) => {
  const { siteId } = req.query;

  let tasks;
  if (req.user.role === "engineer") {
    tasks = db.prepare("SELECT * FROM tasks WHERE assigned_to = ? ORDER BY planned_start").all(req.user.id);
  } else {
    const accessibleSiteIds = getAccessibleSiteIds(req.user);
    if (accessibleSiteIds.length === 0) return res.json([]);

    if (siteId) {
      if (!accessibleSiteIds.includes(Number(siteId))) {
        return res.status(403).json({ error: "You do not have access to this site." });
      }
      tasks = db.prepare("SELECT * FROM tasks WHERE site_id = ? ORDER BY planned_start").all(siteId);
    } else {
      const placeholders = accessibleSiteIds.map(() => "?").join(",");
      tasks = db
        .prepare(`SELECT * FROM tasks WHERE site_id IN (${placeholders}) ORDER BY planned_start`)
        .all(...accessibleSiteIds);
    }
  }

  res.json(attachLatestUpdate(tasks));
});

// POST /tasks
// Admin OR Manager. Creates a new schedule task under a site.
// - Admin can create a task under ANY site.
// - Manager can create a task ONLY under a site they are assigned to,
//   and can only assign it to an engineer who belongs to that same site.
//   This is enforced here on the server, not just hidden in the UI, so
//   a manager cannot create tasks on someone else's site even by
//   calling the API directly with a different siteId.
// Body: { siteId, name, assignedTo, plannedStart, plannedEnd, plannedPct }
router.post("/", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { siteId, name, assignedTo, plannedStart, plannedEnd, plannedPct } = req.body;

  if (!siteId || !name) {
    return res.status(400).json({ error: "Site and task name are required." });
  }

  if (req.user.role === "manager") {
    const accessibleSiteIds = getAccessibleSiteIds(req.user);
    if (!accessibleSiteIds.includes(Number(siteId))) {
      return res.status(403).json({ error: "You can only create tasks for sites assigned to you." });
    }

    if (assignedTo) {
      const assignedUser = db.prepare("SELECT role, created_by FROM users WHERE id = ?").get(assignedTo);
      if (!assignedUser || assignedUser.role !== "engineer") {
        return res.status(400).json({ error: "Tasks can only be assigned to a site engineer." });
      }

      // An engineer counts as "this manager's" if either:
      // - they're already linked to this site (via assignment or an
      //   existing task), or
      // - this manager is the one who created their account (covers a
      //   brand-new engineer who has no site history yet)
      const engineerBelongsToSite = db
        .prepare(
          `SELECT 1 FROM site_assignments WHERE user_id = ? AND site_id = ?
           UNION
           SELECT 1 FROM tasks WHERE assigned_to = ? AND site_id = ?`
        )
        .get(assignedTo, siteId, assignedTo, siteId);

      const managerCreatedThisEngineer = assignedUser.created_by === req.user.id;

      if (!engineerBelongsToSite && !managerCreatedThisEngineer) {
        return res.status(403).json({ error: "You can only assign tasks to engineers on your own team." });
      }
    }
  }

  const result = db
    .prepare(
      `INSERT INTO tasks (site_id, name, assigned_to, planned_start, planned_end, planned_pct)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(siteId, name, assignedTo || null, plannedStart || null, plannedEnd || null, plannedPct || 0);

  db.prepare(
    "INSERT INTO audit_log (user_id, action, target_type, target_id, details) VALUES (?, 'create_task', 'task', ?, ?)"
  ).run(req.user.id, result.lastInsertRowid, name);

  res.status(201).json({ id: result.lastInsertRowid, message: "Task created." });
});

// POST /tasks/:id/updates
// Engineer submits actual progress for their task. This is the main
// "data capture" endpoint used from the field (website or mobile app).
// Uses multipart/form-data because it can include a photo.
//
// Form fields: pct, remarks, gpsLat, gpsLng, photo (file, optional)
router.post("/:id/updates", requireAuth, upload.single("photo"), async (req, res) => {
  const taskId = req.params.id;
  const task = getAccessibleTask(req.user, taskId);

  if (!task) {
    return res.status(403).json({ error: "You do not have access to this task." });
  }
  if (req.user.role !== "engineer") {
    return res.status(403).json({ error: "Only the assigned engineer can submit progress for a task." });
  }
  if (task.assigned_to !== req.user.id) {
    return res.status(403).json({ error: "This task is not assigned to you." });
  }

  const { pct, remarks, gpsLat, gpsLng } = req.body;
  const pctValue = Number(pct);

  if (Number.isNaN(pctValue) || pctValue < 0 || pctValue > 100) {
    return res.status(400).json({ error: "Progress percentage must be between 0 and 100." });
  }

  // Upload the photo to Supabase Storage (cloud) if one was attached.
  // This happens before we touch the database, so if the upload fails
  // we don't end up with a half-saved update.
  let photoPath = null;
  if (req.file) {
    try {
      photoPath = await uploadSitePhoto(req.file.buffer, req.file.originalname, req.file.mimetype);
    } catch (uploadErr) {
      return res.status(502).json({ error: uploadErr.message });
    }
  }

  const now = new Date().toISOString();

  const insertUpdate = db.prepare(`
    INSERT INTO task_updates (task_id, submitted_by, pct, remarks, photo_path, gps_lat, gps_lng, status, submitted_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)
  `);
  const updateResult = insertUpdate.run(
    taskId,
    req.user.id,
    pctValue,
    remarks || null,
    photoPath,
    gpsLat ? Number(gpsLat) : null,
    gpsLng ? Number(gpsLng) : null,
    now
  );

  // Update the task's live snapshot too, so dashboards can read straight
  // from `tasks` without joining task_updates every time.
  db.prepare(
    `UPDATE tasks SET actual_pct = ?, remarks = ?, status = 'pending', last_update = ? WHERE id = ?`
  ).run(pctValue, remarks || task.remarks, now, taskId);

  db.prepare(
    "INSERT INTO audit_log (user_id, action, target_type, target_id, details) VALUES (?, 'submit_progress', 'task', ?, ?)"
  ).run(req.user.id, taskId, `Reported ${pctValue}% complete`);

  res.status(201).json({ id: updateResult.lastInsertRowid, message: "Progress submitted for approval." });
});

// POST /tasks/:id/approve
// Manager or admin approves the latest pending update.
router.post("/:id/approve", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const taskId = req.params.id;
  const task = getAccessibleTask(req.user, taskId);
  if (!task) return res.status(403).json({ error: "You do not have access to this task." });

  const latestUpdate = db
    .prepare("SELECT * FROM task_updates WHERE task_id = ? AND status = 'pending' ORDER BY submitted_at DESC LIMIT 1")
    .get(taskId);

  if (!latestUpdate) {
    return res.status(400).json({ error: "There is no pending update to approve for this task." });
  }

  const now = new Date().toISOString();
  db.prepare("UPDATE task_updates SET status = 'approved', reviewed_by = ?, reviewed_at = ? WHERE id = ?")
    .run(req.user.id, now, latestUpdate.id);

  // Record the exact date this task was approved at 100% complete \u2014
  // this is the date the Weekly/Monthly reports group completions by.
  // Only set once, the first time it reaches approved-at-100, so it
  // doesn't get overwritten by later unrelated approvals.
  const isFullyComplete = latestUpdate.pct >= 100;
  if (isFullyComplete) {
    db.prepare("UPDATE tasks SET status = 'approved', completed_at = COALESCE(completed_at, ?) WHERE id = ?")
      .run(now, taskId);
  } else {
    db.prepare("UPDATE tasks SET status = 'approved' WHERE id = ?").run(taskId);
  }

  db.prepare(
    "INSERT INTO audit_log (user_id, action, target_type, target_id) VALUES (?, 'approve_task', 'task', ?)"
  ).run(req.user.id, taskId);

  res.json({ message: "Task update approved." });
});

// POST /tasks/:id/reject
// Manager or admin sends the update back to the engineer for correction.
// Body: { reason }
router.post("/:id/reject", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const taskId = req.params.id;
  const { reason } = req.body;
  const task = getAccessibleTask(req.user, taskId);
  if (!task) return res.status(403).json({ error: "You do not have access to this task." });

  const latestUpdate = db
    .prepare("SELECT * FROM task_updates WHERE task_id = ? AND status = 'pending' ORDER BY submitted_at DESC LIMIT 1")
    .get(taskId);

  if (!latestUpdate) {
    return res.status(400).json({ error: "There is no pending update to reject for this task." });
  }

  const now = new Date().toISOString();
  db.prepare("UPDATE task_updates SET status = 'rejected', reviewed_by = ?, reviewed_at = ? WHERE id = ?")
    .run(req.user.id, now, latestUpdate.id);
  db.prepare("UPDATE tasks SET status = 'rejected', remarks = ? WHERE id = ?")
    .run(reason ? `Sent back: ${reason}` : "Sent back for correction", taskId);

  db.prepare(
    "INSERT INTO audit_log (user_id, action, target_type, target_id, details) VALUES (?, 'reject_task', 'task', ?, ?)"
  ).run(req.user.id, taskId, reason || null);

  res.json({ message: "Task update sent back to engineer." });
});

// GET /tasks/:id/history
// Full submission history for one task (audit trail).
router.get("/:id/history", requireAuth, (req, res) => {
  const taskId = req.params.id;
  const task = getAccessibleTask(req.user, taskId);
  if (!task) return res.status(403).json({ error: "You do not have access to this task." });

  const history = db
    .prepare(
      `SELECT tu.*, u.name AS submitted_by_name
       FROM task_updates tu
       JOIN users u ON u.id = tu.submitted_by
       WHERE tu.task_id = ?
       ORDER BY tu.submitted_at DESC`
    )
    .all(taskId);

  res.json(history);
});

// DELETE /tasks/:id
// Admin can delete any task. Manager can delete a task only on a site
// they're assigned to (checked via getAccessibleTask, same rule used
// everywhere else for a manager's reach). Deleting a task also removes
// its full submission history (task_updates) via the cascading foreign
// key already defined in the schema.
router.delete("/:id", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const taskId = req.params.id;
  const task = getAccessibleTask(req.user, taskId);
  if (!task) return res.status(403).json({ error: "You do not have access to this task." });

  db.prepare("DELETE FROM tasks WHERE id = ?").run(taskId);

  db.prepare(
    "INSERT INTO audit_log (user_id, action, target_type, target_id, details) VALUES (?, 'delete_task', 'task', ?, ?)"
  ).run(req.user.id, taskId, `Deleted task "${task.name}"`);

  res.json({ message: "Task deleted." });
});

module.exports = router;
