const crypto = require('crypto');
const { getSetting } = require('../db');
const { appSecret } = require('./secret');

// Rules for students marking their own attendance. All optional and off by default.

// A 4-digit code that changes every day. Nothing is stored: it is derived from the date and the app secret,
// so staff can read it on the attendance page and students must type it in.
const dailyCode = (date) =>
  String(crypto.createHmac('sha256', appSecret()).update(`checkin:${date}`).digest().readUInt32BE(0) % 10000).padStart(4, '0');

const codeRequired = () => getSetting('checkin_code_required') === '1';

const to12h = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
};

// Is self check-in open right now? Blank start/end means no limit on that side.
function windowStatus(now = new Date()) {
  const start = getSetting('checkin_start') || '';
  const end = getSetting('checkin_end') || '';
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  if (start && hhmm < start) return { open: false, message: `Check-in opens at ${to12h(start)}.` };
  if (end && hhmm > end) return { open: false, message: `Check-in closed at ${to12h(end)}. Ask your teacher.` };
  return { open: true, message: '' };
}

const isTime = (v) => /^([01]\d|2[0-3]):[0-5]\d$/.test(v);

module.exports = { dailyCode, codeRequired, windowStatus, isTime, to12h };
