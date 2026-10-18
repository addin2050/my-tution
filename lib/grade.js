const GRADES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

// Returns a valid grade number from user input, or null for "all classes".
const parseGrade = (v) => (GRADES.includes(Number(v)) ? Number(v) : null);

module.exports = { GRADES, parseGrade };
