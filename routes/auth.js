// routes/auth.js
//
// Handles: logging in, and changing your own password.

const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const db = require("../db/database");
const { requireAuth } = require("../middleware/auth");

const router = express.Router();

// POST /auth/login
// Body: { email, password }
router.post("/login", (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  const user = db.prepare("SELECT * FROM users WHERE email = ?").get(email.toLowerCase().trim());

  if (!user) {
    return res.status(401).json({ error: "Incorrect email or password." });
  }

  if (!user.is_active) {
    return res.status(403).json({ error: "This account has been disabled. Contact your administrator." });
  }

  if (user.approval_status === "pending") {
    return res.status(403).json({ error: "Your account is awaiting admin approval. Please check back soon." });
  }
  if (user.approval_status === "rejected") {
    return res.status(403).json({ error: "Your account request was not approved. Contact your administrator." });
  }

  const passwordMatches = bcrypt.compareSync(password, user.password_hash);
  if (!passwordMatches) {
    return res.status(401).json({ error: "Incorrect email or password." });
  }

  const token = jwt.sign(
    { id: user.id, name: user.name, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || "12h" }
  );

  db.prepare(
    "INSERT INTO audit_log (user_id, action, target_type, target_id) VALUES (?, 'login', 'user', ?)"
  ).run(user.id, user.id);

  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
});

// POST /auth/change-password
// Body: { currentPassword, newPassword }
// Requires login. Every user (including engineers) can change their own password.
router.post("/change-password", requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "Current and new password are both required." });
  }
  if (newPassword.length < 8) {
    return res.status(400).json({ error: "New password must be at least 8 characters." });
  }

  const user = db.prepare("SELECT * FROM users WHERE id = ?").get(req.user.id);
  const matches = bcrypt.compareSync(currentPassword, user.password_hash);
  if (!matches) {
    return res.status(401).json({ error: "Current password is incorrect." });
  }

  const newHash = bcrypt.hashSync(newPassword, 10);
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(newHash, user.id);

  res.json({ message: "Password updated successfully." });
});

module.exports = router;
