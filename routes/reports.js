// routes/reports.js
//
// Handles: planned vs actual summary data, and the audit log view.

const express = require("express");
const db = require("../db/database");
const { requireAuth, requireRole } = require("../middleware/auth");
const { getAccessibleSiteIds } = require("../middleware/scope");

const router = express.Router();

// Same timeline-aware calculation used in routes/sites.js \u2014 duplicated
// here in a tiny form rather than imported, to keep each route file
// self-contained and easy to reason about independently.
function computeExpectedPct(startDate, endDate) {
  if (!startDate || !endDate) return null;
  const start = new Date(startDate).getTime();
  const end = new Date(endDate).getTime();
  const now = Date.now();
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;
  if (now <= start) return 0;
  if (now >= end) return 100;
  return Math.round(((now - start) / (end - start)) * 100);
}

// GET /reports/summary
// Returns planned vs actual rollup per site, scoped to what this user can
// see, plus the timeline-based expected % and status (On Time/Delayed)
// wherever the site has a start and end date set.
router.get("/summary", requireAuth, (req, res) => {
  const siteIds = getAccessibleSiteIds(req.user);
  if (siteIds.length === 0) return res.json([]);

  const placeholders = siteIds.map(() => "?").join(",");
  const sites = db.prepare(`SELECT * FROM sites WHERE id IN (${placeholders})`).all(...siteIds);

  const summary = sites.map((site) => {
    const tasks = db.prepare("SELECT planned_pct, actual_pct FROM tasks WHERE site_id = ?").all(site.id);
    const planned = tasks.length ? Math.round(tasks.reduce((a, t) => a + t.planned_pct, 0) / tasks.length) : 0;
    const actual = tasks.length ? Math.round(tasks.reduce((a, t) => a + t.actual_pct, 0) / tasks.length) : 0;

    const expectedPct = computeExpectedPct(site.start_date, site.end_date);
    let timelineStatus = null;
    if (expectedPct !== null) {
      const gap = expectedPct - actual;
      timelineStatus = actual >= 100 || gap <= 0 ? "on_track" : gap <= 10 ? "watch" : "delayed";
    }

    return {
      siteId: site.id,
      siteName: site.name,
      plannedPct: planned,
      actualPct: actual,
      variance: actual - planned,
      taskCount: tasks.length,
      startDate: site.start_date,
      endDate: site.end_date,
      expectedPct,
      timelineStatus,
    };
  });

  res.json(summary);
});

// GET /reports/activity?range=week|month
// Returns every approved submission within the given time range, scoped
// to the sites this user can see. This powers the Weekly Report and
// Monthly Report views for both Admin and Manager \u2014 each row shows
// exactly when a task was updated/completed and by how much.
router.get("/activity", requireAuth, (req, res) => {
  const range = req.query.range === "month" ? "month" : "week";
  const daysBack = range === "month" ? 30 : 7;

  const siteIds = getAccessibleSiteIds(req.user);
  if (siteIds.length === 0) return res.json({ range, entries: [], totals: {} });

  const placeholders = siteIds.map(() => "?").join(",");
  const cutoff = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();

  const entries = db
    .prepare(
      `SELECT
         tu.id,
         tu.task_id,
         tu.pct,
         tu.status,
         tu.submitted_at,
         tu.reviewed_at,
         t.name AS task_name,
         t.site_id,
         s.name AS site_name,
         u.name AS submitted_by_name
       FROM task_updates tu
       JOIN tasks t ON t.id = tu.task_id
       JOIN sites s ON s.id = t.site_id
       JOIN users u ON u.id = tu.submitted_by
       WHERE t.site_id IN (${placeholders})
         AND tu.submitted_at >= ?
       ORDER BY tu.submitted_at DESC`
    )
    .all(...siteIds, cutoff);

  const tasksCompletedInRange = db
    .prepare(
      `SELECT COUNT(*) AS count FROM tasks
       WHERE site_id IN (${placeholders}) AND completed_at >= ?`
    )
    .get(...siteIds, cutoff).count;

  const totals = {
    totalUpdates: entries.length,
    approvedUpdates: entries.filter((e) => e.status === "approved").length,
    pendingUpdates: entries.filter((e) => e.status === "pending").length,
    tasksCompleted: tasksCompletedInRange,
  };

  res.json({ range, entries, totals });
});

// GET /audit-log
// Admin only. Full activity history.
router.get("/audit-log", requireAuth, requireRole("admin"), (req, res) => {
  const logs = db
    .prepare(
      `SELECT al.*, u.name AS actor_name
       FROM audit_log al
       LEFT JOIN users u ON u.id = al.user_id
       ORDER BY al.created_at DESC
       LIMIT 200`
    )
    .all();
  res.json(logs);
});

module.exports = router;
