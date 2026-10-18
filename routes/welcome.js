const express = require('express');
const { db } = require('../db');

const router = express.Router();

// Landing page after login: what the center is, who to contact, and shortcuts into the app.
// Fees are deliberately not shown here because teachers can see this page too.
router.get('/welcome', (req, res) => {
  const classes = db.prepare('SELECT grade FROM classes WHERE active = 1 ORDER BY grade').all();
  res.render('welcome', { classes });
});

module.exports = router;
