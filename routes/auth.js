const express = require('express');
const bcrypt = require('bcryptjs');
const { db } = require('../db');

const router = express.Router();

// Simple in-memory throttle: 8 failed attempts per IP per 15 minutes.
const failures = new Map();
const WINDOW_MS = 15 * 60 * 1000;
const tooMany = (ip) => {
  const f = failures.get(ip);
  return f && Date.now() - f.first < WINDOW_MS && f.count >= 8;
};
const recordFailure = (ip) => {
  const f = failures.get(ip);
  if (!f || Date.now() - f.first >= WINDOW_MS) failures.set(ip, { first: Date.now(), count: 1 });
  else f.count++;
};

router.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { error: null });
});

router.post('/login', (req, res) => {
  if (tooMany(req.ip)) return res.status(429).render('login', { error: 'Too many attempts. Try again in a few minutes.' });
  const { username = '', password = '' } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    recordFailure(req.ip);
    return res.status(401).render('login', { error: 'Wrong username or password.' });
  }
  failures.delete(req.ip);
  // Regenerate to avoid session fixation, then keep a fresh CSRF token.
  req.session.regenerate((err) => {
    if (err) throw err;
    req.session.user = { id: user.id, username: user.username, role: user.role };
    res.redirect(user.role === 'admin' ? '/' : '/attendance');
  });
});

router.post('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

module.exports = router;
