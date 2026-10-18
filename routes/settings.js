const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { db, setSetting } = require('../db');
const { isMonth } = require('../lib/dates');
const { isTime } = require('../lib/checkin');
const { ensureDues } = require('../lib/fees');

const router = express.Router();

const render = (res, extra = {}) =>
  res.render('settings', {
    classes: db.prepare('SELECT * FROM classes ORDER BY grade, division').all(),
    users: db.prepare('SELECT id, username, role FROM users ORDER BY role, username').all(),
    appUrl: `${res.req.protocol}://${res.req.get('host')}/student`,
    withoutPin: db.prepare("SELECT COUNT(*) AS n FROM students WHERE status = 'active' AND pin_hash IS NULL").get().n,
    ...extra,
  });

const back = (req, res, msg) => {
  req.session.flash = msg;
  res.redirect('/settings');
};

router.get('/settings', (req, res) => render(res));

router.post('/settings/center', (req, res) => {
  const { center_name, center_address, center_phone, currency, academic_start } = req.body;
  if (!String(center_name || '').trim()) return back(req, res, 'Center name is required.');
  if (!isMonth(academic_start)) return back(req, res, 'Pick a valid academic start month.');
  setSetting('center_name', center_name.trim());
  setSetting('center_address', String(center_address || '').trim());
  setSetting('center_phone', String(center_phone || '').trim());
  setSetting('tagline', String(req.body.tagline || '').trim().slice(0, 120));
  setSetting('about_text', String(req.body.about_text || '').trim().slice(0, 1500));
  setSetting('currency', String(currency || '₹').trim().slice(0, 4) || '₹');
  setSetting('academic_start', academic_start);
  ensureDues();
  back(req, res, 'Settings saved.');
});

// Fee changes apply to months billed from now on; existing dues keep the amount they were created with.
router.post('/settings/fees', (req, res) => {
  const upd = db.prepare('UPDATE classes SET monthly_fee = ? WHERE id = ?');
  const setActive = db.prepare('UPDATE classes SET active = ? WHERE id = ?');
  const students = db.prepare("SELECT COUNT(*) AS n FROM students WHERE class_id = ? AND status = 'active'");
  const kept = [];
  db.transaction(() => {
    for (const c of db.prepare('SELECT id, grade, division FROM classes').all()) {
      const fee = Number(req.body[`fee_${c.id}`]);
      if (Number.isInteger(fee) && fee >= 0) upd.run(fee, c.id);
      const wantShown = req.body[`show_${c.id}`] === '1';
      if (!wantShown && students.get(c.id).n > 0) kept.push(`Class ${c.grade}`);
      else setActive.run(wantShown ? 1 : 0, c.id);
    }
  })();
  back(
    req,
    res,
    kept.length
      ? `Saved. ${kept.join(', ')} still ha${kept.length > 1 ? 've' : 's'} active students, so ${kept.length > 1 ? 'they stay' : 'it stays'} visible.`
      : 'Saved. Fees apply to months billed from now on.'
  );
});

// Rules for the student app. Everything is optional; the defaults let any signed-in student check in.
router.post('/settings/checkin', (req, res) => {
  const start = String(req.body.checkin_start || '');
  const end = String(req.body.checkin_end || '');
  if ((start && !isTime(start)) || (end && !isTime(end))) return back(req, res, 'Use times like 15:30.');
  if (start && end && start >= end) return back(req, res, 'The check-in end time must be after the start time.');
  setSetting('checkin_code_required', req.body.checkin_code_required === '1' ? '1' : '0');
  setSetting('checkin_start', start);
  setSetting('checkin_end', end);
  back(req, res, 'Student check-in rules saved.');
});

// Gives every active student without a PIN a new one and shows them once (printable). PINs are stored hashed.
router.post('/settings/pins', (req, res) => {
  const rows = db
    .prepare(
      `SELECT s.id, s.student_no, s.name, c.grade FROM students s JOIN classes c ON c.id = s.class_id
       WHERE s.status = 'active' AND s.pin_hash IS NULL ORDER BY c.grade, s.name`
    )
    .all();
  const set = db.prepare('UPDATE students SET pin_hash = ? WHERE id = ?');
  db.transaction(() => {
    for (const r of rows) {
      r.pin = String(crypto.randomInt(0, 10000)).padStart(4, '0');
      set.run(bcrypt.hashSync(r.pin, 8), r.id);
    }
  })();
  res.set('Cache-Control', 'no-store');
  res.render('pin_cards', { rows, appUrl: `${req.protocol}://${req.get('host')}/student` });
});

router.post('/settings/teachers', (req, res) => {
  const username = String(req.body.username || '').trim();
  const password = String(req.body.password || '');
  if (!/^[\w.-]{3,30}$/.test(username)) return back(req, res, 'Username must be 3-30 letters, numbers, dot, dash or underscore.');
  if (password.length < 8) return back(req, res, 'Password must be at least 8 characters.');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return back(req, res, 'That username is taken.');
  db.prepare("INSERT INTO users (username, password_hash, role) VALUES (?, ?, 'teacher')").run(username, bcrypt.hashSync(password, 10));
  back(req, res, `Teacher "${username}" added.`);
});

router.post('/settings/teachers/:id/delete', (req, res) => {
  const changed = db.prepare("DELETE FROM users WHERE id = ? AND role = 'teacher'").run(req.params.id).changes;
  back(req, res, changed ? 'Teacher removed.' : 'Nothing removed.');
});

router.post('/settings/password', (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.user.id);
  if (!bcrypt.compareSync(String(req.body.current || ''), user.password_hash)) return back(req, res, 'Current password is wrong.');
  if (String(req.body.next || '').length < 8) return back(req, res, 'New password must be at least 8 characters.');
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(req.body.next, 10), user.id);
  back(req, res, 'Password changed.');
});

// Year-end: every grade moves up one (1 -> 2 ... 9 -> 10) and grade 10 graduates. Division is kept.
router.post('/settings/promote', (req, res) => {
  if (req.body.confirm !== 'PROMOTE') return back(req, res, 'Type PROMOTE to confirm.');
  db.transaction(() => {
    db.prepare("UPDATE students SET status = 'graduated' WHERE status = 'active' AND class_id IN (SELECT id FROM classes WHERE grade = 10)").run();
    for (let g = 9; g >= 1; g--) {
      db.prepare(
        `UPDATE students SET class_id = (SELECT n.id FROM classes n JOIN classes o ON o.id = students.class_id
                                          WHERE n.grade = o.grade + 1 AND n.division = o.division)
         WHERE status = 'active' AND class_id IN (SELECT id FROM classes WHERE grade = ?)`
      ).run(g);
    }
  })();
  // A promoted student must never end up in a hidden class.
  db.prepare("UPDATE classes SET active = 1 WHERE active = 0 AND id IN (SELECT class_id FROM students WHERE status = 'active')").run();
  ensureDues();
  back(req, res, 'Students promoted. Grade 10 students are now marked graduated.');
});

module.exports = router;
