// server.js
//
// This is the entry point. Run it with: npm start
// It starts an HTTP server that both the website and the mobile app
// will talk to, using the exact same API endpoints.

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const authRoutes = require("./routes/auth");
const siteRoutes = require("./routes/sites");
const taskRoutes = require("./routes/tasks");
const userRoutes = require("./routes/users");
const reportRoutes = require("./routes/reports");

const app = express();

// Make sure the uploads folder exists (for site photos)
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

app.use(cors()); // In production, restrict this to your actual website/app domains
app.use(express.json());
app.use("/uploads", express.static(uploadsDir)); // serves uploaded site photos

// Simple health check — useful to confirm the server is alive
app.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

app.use("/auth", authRoutes);
app.use("/sites", siteRoutes);
app.use("/tasks", taskRoutes);
app.use("/users", userRoutes);
app.use("/reports", reportRoutes);

// Catch-all error handler — prevents raw stack traces from leaking to users
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "Something went wrong on the server." });
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`Oil India Tracker backend running on http://localhost:${PORT}`);
});
