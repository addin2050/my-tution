const pad = (n) => String(n).padStart(2, '0');
const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};

const today = () => fmt(new Date());
const addDays = (s, n) => {
  const d = parse(s);
  d.setDate(d.getDate() + n);
  return fmt(d);
};
const monthOf = (s) => s.slice(0, 7);
const addMonths = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + n, 1);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};
const monthLabel = (ym) =>
  new Date(`${ym}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
const fmtDate = (s) =>
  parse(s).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && fmt(parse(s)) === s;
const isMonth = (s) => typeof s === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(s);

const PRESETS = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['last_7_days', 'Last 7 days'],
  ['last_30_days', 'Last 30 days'],
  ['this_month', 'This month'],
  ['last_month', 'Last month'],
  ['custom', 'Custom'],
];

// Resolves a preset key (or custom from/to) into an inclusive { from, to, key }.
function resolveRange(key, from, to) {
  const t = today();
  const thisMonth = monthOf(t);
  switch (key) {
    case 'today':
      return { key, from: t, to: t };
    case 'yesterday': {
      const y = addDays(t, -1);
      return { key, from: y, to: y };
    }
    case 'last_7_days':
      return { key, from: addDays(t, -6), to: t };
    case 'last_30_days':
      return { key, from: addDays(t, -29), to: t };
    case 'last_month': {
      const lm = addMonths(thisMonth, -1);
      return { key, from: `${lm}-01`, to: addDays(`${thisMonth}-01`, -1) };
    }
    case 'custom':
      if (isDate(from) && isDate(to)) {
        return from <= to ? { key, from, to } : { key, from: to, to: from };
      }
    // fall through to the default when the custom dates are missing or invalid
    default:
      return { key: 'this_month', from: `${thisMonth}-01`, to: t };
  }
}

module.exports = {
  today, addDays, monthOf, addMonths, monthLabel, fmtDate, isDate, isMonth, resolveRange, PRESETS, fmt, parse,
};
