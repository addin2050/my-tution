// Student IDs are shown as 4 digits (0001, 0002, ...); they keep growing past 9999 without truncating.
const fmtStudentNo = (n) => String(n ?? 0).padStart(4, '0');

module.exports = { fmtStudentNo };
