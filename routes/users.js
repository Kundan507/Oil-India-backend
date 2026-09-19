// routes/users.js
//
// Handles user accounts. Two people can create accounts here now:
// - Admin can create anyone (admin/manager/engineer), always pre-approved
// - Manager can create an engineer, but it starts as "pending" until
//   an admin approves it. This is what lets a manager build their own
//   team without being able to grant themselves unchecked new logins.

const express = require("express");
const bcrypt = require("bcryptjs");
const db = require("../db/database");
const { requireAuth, requireRole } = require("../middleware/auth");

const router = express.Router();

// GET /users
// Admin: sees everyone. Manager: sees only engineers they personally
// created (their own team), plus their own account.
router.get("/", requireAuth, requireRole("admin", "manager"), (req, res) => {
  let users;
  if (req.user.role === "admin") {
    users = db
      .prepare(
        "SELECT id, name, email, role, is_active, approval_status, created_by, created_at FROM users ORDER BY role, name"
      )
      .all();
  } else {
    users = db
      .prepare(
        `SELECT id, name, email, role, is_active, approval_status, created_by, created_at
         FROM users
         WHERE created_by = ? AND role = 'engineer'
         ORDER BY name`
      )
      .all(req.user.id);
  }
  res.json(users);
});

// GET /users/pending
// Admin only. Lists every account waiting on approval (created by a
// manager), so the admin has one place to review and act on requests.
router.get("/pending", requireAuth, requireRole("admin"), (req, res) => {
  const pending = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.role, u.created_at,
              creator.name AS created_by_name
       FROM users u
       LEFT JOIN users creator ON creator.id = u.created_by
       WHERE u.approval_status = 'pending'
       ORDER BY u.created_at ASC`
    )
    .all();
  res.json(pending);
});

// POST /users
// Admin: creates any role, account is immediately approved and active.
// Manager: can only create an 'engineer' account, which starts as
// 'pending' and cannot log in until an admin approves it.
// Body: { name, email, password, role }
router.post("/", requireAuth, requireRole("admin", "manager"), (req, res) => {
  const { name, email, password, role } = req.body;

  if (!name || !email || !password || !role) {
    return res.status(400).json({ error: "Name, email, password, and role are all required." });
  }
  if (!["admin", "manager", "engineer"].includes(role)) {
    return res.status(400).json({ error: "Role must be admin, manager, or engineer." });
  }
  if (req.user.role === "manager" && role !== "engineer") {
    return res.status(403).json({ error: "Managers can only add engineers." });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }

  const existing = db.prepare("SELECT id FROM users WHERE email = ?").get(email.toLowerCase().trim());
  if (existing) {
    return res.status(409).json({ error: "A user with this email already exists." });
  }

  const passwordHash = bcrypt.hashSync(password, 10);
  const approvalStatus = req.user.role === "manager" ? "pending" : "approved";

  const result = db
    .prepare(
      "INSERT INTO users (name, email, password_hash, role, approval_status, created_by) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .run(name, email.toLowerCase().trim(), passwordHash, role, approvalStatus, req.user.id);

  db.prepare(
    "INSERT INTO audit_log (user_id, action, target_type, target_id, details) VALUES (?, 'create_user', 'user', ?, ?)"
  ).run(
    req.user.id,
    result.lastInsertRowid,
    `Created ${role} account for ${name}${approvalStatus === "pending" ? " (awaiting admin approval)" : ""}`
  );

  res.status(201).json({
    id: result.lastInsertRowid,
    name,
    email,
    role,
    approvalStatus,
    message:
      approvalStatus === "pending"
        ? "Engineer added. Their login will work once an admin approves the account."
        : "Account created.",
  });
});

// PATCH /users/:id/approve
// Admin only. Approves a pending account (usually an engineer a
// manager just added), letting them log in for the first time.
router.patch("/:id/approve", requireAuth, requireRole("admin"), (req, res) => {
  const userId = req.params.id;
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) return res.status(404).json({ error: "User not found." });
  if (user.approval_status !== "pending") {
    return res.status(400).json({ error: "This account is not awaiting approval." });
  }

  db.prepare("UPDATE users SET approval_status = 'approved' WHERE id = ?").run(userId);

  db.prepare(
    "INSERT INTO audit_log (user_id, action, target_type, target_id, details) VALUES (?, 'approve_user', 'user', ?, ?)"
  ).run(req.user.id, userId, `Approved ${user.role} account for ${user.name}`);

  res.json({ message: `${user.name}'s account has been approved. They can now log in.` });
});

// PATCH /users/:id/reject
// Admin only. Rejects a pending account request.
router.patch("/:id/reject", requireAuth, requireRole("admin"), (req, res) => {
  const userId = req.params.id;
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) return res.status(404).json({ error: "User not found." });
  if (user.approval_status !== "pending") {
    return res.status(400).json({ error: "This account is not awaiting approval." });
  }

  db.prepare("UPDATE users SET approval_status = 'rejected' WHERE id = ?").run(userId);

  db.prepare(
    "INSERT INTO audit_log (user_id, action, target_type, target_id, details) VALUES (?, 'reject_user', 'user', ?, ?)"
  ).run(req.user.id, userId, `Rejected ${user.role} account request for ${user.name}`);

  res.json({ message: `${user.name}'s account request has been rejected.` });
});

// PATCH /users/:id/deactivate
// Admin only. Disables a user's login without deleting their history.
router.patch("/:id/deactivate", requireAuth, requireRole("admin"), (req, res) => {
  const userId = req.params.id;
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) return res.status(404).json({ error: "User not found." });

  db.prepare("UPDATE users SET is_active = 0 WHERE id = ?").run(userId);

  db.prepare(
    "INSERT INTO audit_log (user_id, action, target_type, target_id) VALUES (?, 'deactivate_user', 'user', ?)"
  ).run(req.user.id, userId);

  res.json({ message: `${user.name}'s account has been disabled.` });
});

// DELETE /users/:id
// Admin only. Permanently deletes a manager or engineer account.
// Admins cannot delete their own account or another admin's account
// through this route, to avoid ever locking everyone out of the system.
// Any tasks that were assigned to this person are unassigned (not
// deleted) so the work itself and its history stay intact \u2014 only the
// login/account is removed. Site assignments for this person are
// cleared automatically via the existing cascading foreign key.
router.delete("/:id", requireAuth, requireRole("admin"), (req, res) => {
  const userId = req.params.id;
  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
  if (!user) return res.status(404).json({ error: "User not found." });

  if (Number(userId) === req.user.id) {
    return res.status(400).json({ error: "You cannot delete your own account." });
  }
  if (user.role === "admin") {
    return res.status(400).json({ error: "Admin accounts cannot be deleted from here." });
  }

  // Unassign (don't delete) any tasks this person was handling, so the
  // task and its submission history remain for the record.
  db.prepare("UPDATE tasks SET assigned_to = NULL WHERE assigned_to = ?").run(userId);

  db.prepare("DELETE FROM users WHERE id = ?").run(userId);

  db.prepare(
    "INSERT INTO audit_log (user_id, action, target_type, target_id, details) VALUES (?, 'delete_user', 'user', ?, ?)"
  ).run(req.user.id, userId, `Deleted ${user.role} account for ${user.name}`);

  res.json({ message: `${user.name}'s account has been permanently deleted.` });
});

module.exports = router;
