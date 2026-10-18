const express = require('express');

const router = express.Router();

// Landing page after login: what the center is, who to contact, and shortcuts into the app.
// Fees are deliberately not shown here because teachers can see this page too.
router.get('/welcome', (req, res) => {
  res.render('welcome');
});

module.exports = router;
