const express = require('express');
const bcrypt = require('bcryptjs');
const { db, getSetting } = require('../db');
const { today, monthOf } = require('../lib/dates');
const { fmtStudentNo } = require('../lib/studentId');
const { dailyCode, codeRequired, windowStatus } = require('../lib/checkin');

// The student app: students sign in with their Student ID and a 4-digit PIN and mark themselves present.
// It has its own session key (req.session.student) and never grants access to any staff page.
const router = express.Router();

// 4-digit PINs are guessable, so failed attempts are limited per student and per address.
const THROTTLE_MS = 15 * 60 * 1000;
const attempts = new Map();
const isLocked = (key, max) => {
  const a = attempts.get(key);
  return !!a && Date.now() - a.first < THROTTLE_MS && a.count >= max;
};
const addFailure = (key) => {
  const a = attempts.get(key);
  if (!a || Date.now() - a.first >= THROTTLE_MS) attempts.set(key, { first: Date.now(), count: 1 });
  else a.count++;
};
// Compared against when the ID is unknown, so response time doesn't reveal which IDs exist.
const DUMMY_HASH = bcrypt.hashSync('0000', 8);

const loadStudent = (req) => {
  const id = req.session.student?.id;
  if (!id) return null;
  return db
    .prepare(
      `SELECT s.id, s.student_no, s.name, s.class_id, c.grade FROM students s
       JOIN classes c ON c.id = s.class_id WHERE s.id = ? AND s.status = 'active'`
    )
    .get(id);
};

const requireStudent = (req, res, next) => {
  const student = loadStudent(req);
  if (!student) {
    delete req.session.student;
    return res.redirect('/student/login');
  }
  req.student = student;
  next();
};

// What the student can do right now.
function todayState(student) {
  const t = today();
  const row = db.prepare('SELECT status, source, marked_at FROM attendance WHERE student_id = ? AND date = ?').get(student.id, t);
  if (row) return { kind: 'marked', row };
  if (db.prepare('SELECT 1 FROM no_class WHERE class_id = ? AND date = ?').get(student.class_id, t)) return { kind: 'noclass' };
  const w = windowStatus();
  if (!w.open) return { kind: 'closed', message: w.message };
  return { kind: 'open', codeRequired: codeRequired() };
}

router.get('/manifest.webmanifest', (req, res) => {
  res.type('application/manifest+json').json({
    name: `${getSetting('center_name')} Attendance`,
    short_name: 'Attendance',
    start_url: '/student',
    scope: '/student',
    display: 'standalone',
    background_color: '#080a14',
    theme_color: '#6d5ef0',
    icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  });
});

router.get('/login', (req, res) => {
  if (loadStudent(req)) return res.redirect('/student');
  res.render('student_login', { error: null, studentNo: '' });
});

router.post('/login', (req, res) => {
  const studentNo = String(req.body.student_no || '').trim();
  const pin = String(req.body.pin || '').trim();
  const idKey = `id:${studentNo}`;
  const ipKey = `ip:${req.ip}`;
  const show = (status, error) => res.status(status).render('student_login', { error, studentNo });

  if (isLocked(idKey, 5) || isLocked(ipKey, 20)) return show(429, 'Too many wrong tries. Please wait 15 minutes, or ask your teacher.');

  const student = /^\d{1,9}$/.test(studentNo)
    ? db.prepare("SELECT id, pin_hash FROM students WHERE student_no = ? AND status = 'active'").get(Number(studentNo))
    : null;
  const ok = bcrypt.compareSync(pin, student?.pin_hash || DUMMY_HASH) && !!student?.pin_hash;
  if (!ok) {
    addFailure(idKey);
    addFailure(ipKey);
    return show(401, 'Wrong ID or PIN. Ask your teacher if you have no PIN yet.');
  }

  attempts.delete(idKey);
  // Fresh session on sign-in, but keep a staff login in the same browser (useful on a shared tablet).
  const staff = req.session.user;
  req.session.regenerate((err) => {
    if (err) throw err;
    if (staff) req.session.user = staff;
    req.session.student = { id: student.id };
    res.redirect('/student');
  });
});

router.get('/', requireStudent, (req, res) => {
  const s = req.student;
  const t = today();
  const counts = { present: 0, late: 0, absent: 0 };
  for (const r of db
    .prepare("SELECT status, COUNT(*) AS n FROM attendance WHERE student_id = ? AND substr(date, 1, 7) = ? GROUP BY status")
    .all(s.id, monthOf(t))) {
    counts[r.status] = r.n;
  }
  const days = counts.present + counts.late + counts.absent;
  res.render('student_home', {
    s,
    state: todayState(s),
    counts,
    percent: days ? Math.round(((counts.present + counts.late) / days) * 100) : null,
    recent: db.prepare('SELECT date, status, source FROM attendance WHERE student_id = ? ORDER BY date DESC LIMIT 14').all(s.id),
    studentNoLabel: fmtStudentNo(s.student_no),
  });
});

router.post('/checkin', requireStudent, (req, res) => {
  const s = req.student;
  const t = today();
  const back = (msg) => {
    req.session.flash = msg;
    res.redirect('/student');
  };
  const state = todayState(s);
  if (state.kind === 'marked') return back('Your attendance for today is already recorded.');
  if (state.kind === 'noclass') return back('There is no class today.');
  if (state.kind === 'closed') return back(state.message);

  if (state.codeRequired) {
    const codeKey = `code:${s.id}`;
    if (isLocked(codeKey, 5)) return back('Too many wrong codes. Please ask your teacher to mark you.');
    if (String(req.body.code || '').trim() !== dailyCode(t)) {
      addFailure(codeKey);
      return back("That code isn't right. The teacher shows today's code in class.");
    }
    attempts.delete(codeKey);
  }

  db.prepare(
    "INSERT OR IGNORE INTO attendance (student_id, date, status, source, marked_at) VALUES (?, ?, 'present', 'self', datetime('now', 'localtime'))"
  ).run(s.id, t);
  back("You're marked present. Have a good class!");
});

router.post('/logout', (req, res) => {
  delete req.session.student;
  res.redirect('/student/login');
});

module.exports = router;
