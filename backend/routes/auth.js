const express = require("express");
const jwt = require("jsonwebtoken");
const User = require("../models/User");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "blitzboard_dev_secret";

function signToken(user) {
  return jwt.sign(
    {
      userId: user._id.toString(),
      username: user.username,
      isGuest: user.isGuest,
    },
    JWT_SECRET,
    { expiresIn: "7d" }
  );
}

// ─── Register ────────────────────────────────────────────────────────────────
router.post("/register", async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");

    if (username.length < 3 || username.length > 20) {
      return res.status(400).json({ error: "Username must be 3-20 characters" });
    }
    if (!/^[a-zA-Z0-9_]+$/.test(username)) {
      return res.status(400).json({ error: "Username may only contain letters, numbers and underscores" });
    }
    if (!password) {
      return res.status(400).json({ error: "Password is required" });
    }

    const existing = await User.findOne({ username });
    if (existing) {
      return res.status(409).json({ error: "Username already taken" });
    }

    const user = await User.create({ username, password });
    return res.status(201).json({ token: signToken(user) });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(409).json({ error: "Username already taken" });
    }
    console.error("Register error:", err);
    return res.status(500).json({ error: "Registration failed" });
  }
});

// ─── Login ───────────────────────────────────────────────────────────────────
router.post("/login", async (req, res) => {
  try {
    const username = String(req.body?.username || "").trim();
    const password = String(req.body?.password || "");

    if (!username || !password) {
      return res.status(400).json({ error: "Username and password are required" });
    }

    const user = await User.findOne({ username });
    if (!user || user.isGuest || !user.password) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    const ok = await user.comparePassword(password);
    if (!ok) {
      return res.status(401).json({ error: "Invalid username or password" });
    }

    return res.json({ token: signToken(user) });
  } catch (err) {
    console.error("Login error:", err);
    return res.status(500).json({ error: "Login failed" });
  }
});

// ─── Guest ───────────────────────────────────────────────────────────────────
router.post("/guest", async (_req, res) => {
  try {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    let username;

    // Guests are real DB entries so their games can be associated later.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      let suffix = "";
      for (let i = 0; i < 4; i += 1) {
        suffix += chars[Math.floor(Math.random() * chars.length)];
      }
      username = `Guest_${suffix}`;

      const exists = await User.findOne({ username });
      if (!exists) break;
      username = null;
    }

    if (!username) {
      return res.status(500).json({ error: "Could not create guest account" });
    }

    const user = await User.create({ username, isGuest: true });
    return res.status(201).json({ token: signToken(user) });
  } catch (err) {
    if (err?.code === 11000) {
      return res.status(500).json({ error: "Could not create guest account" });
    }
    console.error("Guest error:", err);
    return res.status(500).json({ error: "Guest login failed" });
  }
});

module.exports = router;
