// middleware/auth.js
//
// This file is the security gatekeeper. Every protected API route runs
// through `requireAuth` first — it checks the person is logged in.
// Routes that should only work for certain roles also use `requireRole`.
//
// This is what makes "manager sees only their site" a REAL rule and not
// just something hidden in the website's menu — even if someone tries
// to call the API directly (e.g. with Postman), these checks still apply.

const jwt = require("jsonwebtoken");

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization; // expected format: "Bearer <token>"

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Not logged in. Please log in again." });
  }

  const token = authHeader.split(" ")[1];

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // decoded contains: { id, role, name } — set at login time
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: "Session expired. Please log in again." });
  }
}

// Usage: requireRole('admin') or requireRole('admin', 'manager')
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: "You do not have permission to do this." });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
