// middleware/scope.js
//
// These helpers answer one question everywhere in the app:
// "Is this user ALLOWED to see/touch this particular site or task?"
//
// This logic lives in ONE place so it's applied consistently, instead of
// being copy-pasted (and possibly forgotten) in every route.

const db = require("../db/database");

// Returns an array of site IDs this user is allowed to see.
// - admin -> every site
// - manager -> only sites they are assigned to
// - engineer -> only the site(s) their tasks belong to
function getAccessibleSiteIds(user) {
  if (user.role === "admin") {
    const rows = db.prepare("SELECT id FROM sites").all();
    return rows.map((r) => r.id);
  }

  if (user.role === "manager") {
    const rows = db
      .prepare("SELECT site_id FROM site_assignments WHERE user_id = ?")
      .all(user.id);
    return rows.map((r) => r.site_id);
  }

  if (user.role === "engineer") {
    const rows = db
      .prepare("SELECT DISTINCT site_id FROM tasks WHERE assigned_to = ?")
      .all(user.id);
    return rows.map((r) => r.site_id);
  }

  return [];
}

// Checks whether a given site ID is inside this user's accessible list.
function canAccessSite(user, siteId) {
  return getAccessibleSiteIds(user).includes(Number(siteId));
}

// Checks whether a given task belongs to a site (or, for engineers, is
// directly assigned to them). Returns the task row if allowed, else null.
function getAccessibleTask(user, taskId) {
  const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  if (!task) return null;

  if (user.role === "admin") return task;
  if (user.role === "manager") {
    return canAccessSite(user, task.site_id) ? task : null;
  }
  if (user.role === "engineer") {
    return task.assigned_to === user.id ? task : null;
  }
  return null;
}

module.exports = { getAccessibleSiteIds, canAccessSite, getAccessibleTask };
