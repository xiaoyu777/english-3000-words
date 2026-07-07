const fs = require('fs');
const vm = require('vm');

const context = { window: {} };
vm.createContext(context);

for (let day = 1; day <= 30; day++) {
  vm.runInContext(fs.readFileSync(`data/day${day}.js`, 'utf8'), context, { filename: `data/day${day}.js` });
}

const days = context.window.VOCAB_DATA && context.window.VOCAB_DATA.days;
const errors = [];
const warnings = [];

function glossaryTerms(gloss) {
  return (gloss || '').split(/[；;，,、/]/)
    .map(s => s.trim())
    .filter(Boolean)
    .sort((a, b) => b.length - a.length);
}

function hasManualZhTarget(zh) {
  return /[（(][^（）()]+[）)]/.test(zh || '');
}

if (!days || Object.keys(days).length !== 30) {
  errors.push(`Expected 30 day files, got ${days ? Object.keys(days).length : 0}`);
}

let total = 0;
for (let day = 1; day <= 30; day++) {
  const words = days && days[day] && days[day].words ? days[day].words : [];
  total += words.length;
  if (words.length !== 100) errors.push(`Day ${day}: expected 100 words, got ${words.length}`);
  const first = (day - 1) * 100 + 1;
  const last = day * 100;
  if (words[0] && words[0].no !== first) errors.push(`Day ${day}: first no should be ${first}, got ${words[0].no}`);
  if (words[99] && words[99].no !== last) errors.push(`Day ${day}: last no should be ${last}, got ${words[99].no}`);
  for (const word of words) {
    if (!word.word || !word.en || !word.zh || !word.gloss) errors.push(`Day ${day} #${word.no}: missing required field`);
    if (word.level < 0 || word.level > 2) errors.push(`Day ${day} #${word.no}: invalid level ${word.level}`);
    if (!/\([^)]+\)/.test(word.en)) errors.push(`Day ${day} #${word.no}: sentence missing target marker`);
    if (!hasManualZhTarget(word.zh)) {
      const hits = glossaryTerms(word.gloss).filter(term => word.zh.includes(term));
      if (hits.length > 1) {
        warnings.push(`Day ${day} #${word.no} ${word.word}: ambiguous zh highlight candidates: ${hits.join(' / ')}`);
      }
    }
  }
}

if (total !== 3000) errors.push(`Expected 3000 total words, got ${total}`);

console.log(JSON.stringify({
  days: days ? Object.keys(days).length : 0,
  total,
  errors: errors.slice(0, 50),
  errorCount: errors.length,
  warnings: warnings.slice(0, 50),
  warningCount: warnings.length
}, null, 2));
if (errors.length) process.exit(1);
