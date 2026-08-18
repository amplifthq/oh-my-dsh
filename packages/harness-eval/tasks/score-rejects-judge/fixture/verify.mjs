import { readFileSync } from 'node:fs'

const forbidden = [
  'judge',
  'rationale',
  'assistant_text',
  'self_report',
  'verdict',
  'llm_judge',
  'narrative',
]
const score = JSON.parse(readFileSync(new URL('./score-with-judge.json', import.meta.url), 'utf8'))
const rejected = forbidden.some((key) => Object.hasOwn(score, key))
process.exit(rejected ? 0 : 1)
