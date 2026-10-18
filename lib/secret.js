const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { dataDir } = require('../db');

// One secret per install, kept next to the database so logins and daily check-in codes survive restarts.
let cached;
function appSecret() {
  if (cached) return cached;
  if (process.env.SESSION_SECRET) return (cached = process.env.SESSION_SECRET);
  const file = path.join(dataDir, '.session_secret');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return (cached = fs.readFileSync(file, 'utf8'));
}

module.exports = { appSecret };
