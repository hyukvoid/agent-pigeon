import { readFileSync } from 'node:fs';

const t = readFileSync('README.md', 'utf8');
const fences = (t.match(/```/g) ?? []).length;
console.log('fences:', fences, 'balanced:', fences % 2 === 0, 'lines:', t.split('\n').length);
console.log('card image ref:', t.includes('docs/share/flight-card.svg'));
const heads = t.split('\n').filter((l) => l.startsWith('## ')).map((l) => l.slice(3));
console.log('sections:', JSON.stringify(heads));
const banned = [
  'correctness', 'intelligence', 'productivity', 'superior', 'token saving',
  'bug detection', 'dead-end', 'dead end', 'smarter', 'best model',
];
const lower = t.toLowerCase();
for (const b of banned) {
  if (lower.includes(b)) console.log('BANNED WORD PRESENT:', b);
}
console.log('claim scan done');
