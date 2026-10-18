process.env.TZ = process.env.TZ || 'Asia/Kolkata';

const express = require('express');
const session = require('express-session');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { allSettings, dataDir } = require('./db');
const SqliteStore = require('./lib/sessionStore');
const { ensureDues } = require('./lib/fees');
const dates = require('./lib/dates');

const app = express();
const isProd = process.env.NODE_ENV === 'production';

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
if (isProd) app.set('trust proxy', 1);
app.disable('x-powered-by');

// Persist a generated session secret so logins survive restarts.
function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const file = path.join(dataDir, '.session_secret');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(file, 'utf8');
}

app.use(express.static(path.join(__dirname, 'public'), { maxAge: isProd ? '1d' : 0 }));
app.use(express.urlencoded({ extended: false }));
app.use(
  session({
    store: new SqliteStore(),
    secret: sessionSecret(),
    resave: false,
    saveUninitialized: true,
    cookie: { httpOnly: true, sameSite: 'lax', secure: isProd ? 'auto' : false, maxAge: 7 * 86400 * 1000 },
  })
);

app.use((req, res, next) => {
  res.set({
    'X-Frame-Options': 'DENY',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
  });
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(16).toString('hex');
  if (req.method === 'POST') {
    const sent = Buffer.from(String(req.body?._csrf || ''));
    const real = Buffer.from(req.session.csrf);
    if (sent.length !== real.length || !crypto.timingSafeEqual(sent, real)) {
      return res.status(403).send('Invalid or expired form. Go back, refresh the page and try again.');
    }
  }
  const settings = allSettings();
  const fmtMoney = (n) => `${settings.currency}${Number(n || 0).toLocaleString('en-IN')}`;
  Object.assign(res.locals, {
    csrf: req.session.csrf,
    user: req.session.user || null,
    settings,
    fmtMoney,
    className: (c) => `${c.grade}${c.division}`,
    ...dates,
    flash: req.session.flash,
    currentPath: req.path,
  });
  delete req.session.flash;
  next();
});

const requireLogin = (req, res, next) => (req.session.user ? next() : res.redirect('/login'));
const requireAdmin = (req, res, next) => {
  if (req.session.user.role === 'admin') return next();
  return req.method === 'GET'
    ? res.redirect('/attendance')
    : res.status(403).render('error', { message: 'Admins only.' });
};

app.use(require('./routes/auth'));
app.use(requireLogin);
app.use(require('./routes/attendance'));
app.use(requireAdmin);
app.use(require('./routes/dashboard'));
app.use(require('./routes/students'));
app.use(require('./routes/fees'));
app.use(require('./routes/reports'));
app.use(require('./routes/settings'));

app.use((req, res) => res.status(404).render('error', { message: 'Page not found.' }));
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).render('error', { message: 'Something went wrong.' });
});

ensureDues();
setInterval(ensureDues, 6 * 3600 * 1000).unref();

const port = process.env.PORT || 3000;
const host = process.env.HOST || '127.0.0.1';
app.listen(port, host, () => console.log(`Tuition app listening on http://${host}:${port}`));
