import { dump as dumpYaml, load as loadYaml } from 'js-yaml'

export interface SkillDocument {
  slug: string
  description: string
  whenToUse?: string
  body: string
}

export interface SkillWritePlan {
  action: 'create' | 'update'
  after: string
  before?: string
  warnings: string[]
}

export interface SkillInput {
  slug: string
  description: string
  whenToUse?: string
  body: string
}

export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/
export const DESCRIPTION_MAX_CHARS = 500
export const BODY_MAX_BYTES = 32 * 1024

const FRONTMATTER_PATTERN = /^---\n([\s\S]*?)\n---\n/
const FRONTMATTER_KEYS = ['name', 'description', 'whenToUse'] as const

function requireSingleLine(value: unknown, field: string, maxChars: number): string {
  if (typeof value !== 'string') throw new Error(`skill ${field} must be a string`)
  const trimmed = value.trim()
  if (!trimmed) throw new Error(`skill ${field} must not be empty`)
  if (trimmed.includes('\n')) throw new Error(`skill ${field} must be a single line`)
  if (trimmed.length > maxChars) {
    throw new Error(`skill ${field} must be at most ${maxChars} characters (got ${trimmed.length})`)
  }
  return trimmed
}

export function validateSkillInput(input: SkillInput): SkillDocument {
  if (typeof input.slug !== 'string' || !SLUG_PATTERN.test(input.slug)) {
    throw new Error(
      'skill slug must be 1-41 characters of lowercase letters, digits, and hyphens, ' +
        `starting with a letter or digit (got ${JSON.stringify(input.slug)})`,
    )
  }
  const description = requireSingleLine(input.description, 'description', DESCRIPTION_MAX_CHARS)
  const whenToUse =
    input.whenToUse === undefined ||
    (typeof input.whenToUse === 'string' && !input.whenToUse.trim())
      ? undefined
      : requireSingleLine(input.whenToUse, 'whenToUse', DESCRIPTION_MAX_CHARS)
  if (typeof input.body !== 'string') throw new Error('skill body must be a string')
  const body = input.body.trim()
  if (!body) throw new Error('skill body must not be empty')
  const bodyBytes = Buffer.byteLength(body, 'utf8')
  if (bodyBytes > BODY_MAX_BYTES) {
    throw new Error(`skill body must be at most ${BODY_MAX_BYTES} bytes (got ${bodyBytes})`)
  }
  const document: SkillDocument = { slug: input.slug, description, body }
  if (whenToUse !== undefined) document.whenToUse = whenToUse
  return document
}

export function renderSkillMarkdown(document: SkillDocument): string {
  const entries: Array<[string, string]> = [
    ['name', document.slug],
    ['description', document.description],
  ]
  if (document.whenToUse !== undefined) entries.push(['whenToUse', document.whenToUse])
  const frontmatter = entries
    .map(([key, value]) => dumpYaml({ [key]: value }, { lineWidth: -1 }))
    .join('')
  return `---\n${frontmatter}---\n\n${document.body}\n`
}

export function parseSkillMarkdown(content: string): SkillDocument {
  const match = FRONTMATTER_PATTERN.exec(content)
  if (!match) throw new Error('skill markdown must start with YAML frontmatter delimited by ---')
  let data: unknown
  try {
    data = loadYaml(match[1])
  } catch (error) {
    throw new Error(`skill frontmatter is not valid YAML: ${String(error)}`)
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('skill frontmatter must be a YAML mapping')
  }
  const record = data as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!(FRONTMATTER_KEYS as readonly string[]).includes(key)) {
      throw new Error(`unknown skill frontmatter key ${JSON.stringify(key)}`)
    }
  }
  return validateSkillInput({
    slug: record.name as string,
    description: record.description as string,
    whenToUse: record.whenToUse as string | undefined,
    body: content.slice(match[0].length).trim(),
  })
}

interface SecretHeuristic {
  pattern: RegExp
  label: string
}

const SECRET_HEURISTICS: SecretHeuristic[] = [
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}/, label: 'an "sk-…" style API key' },
  { pattern: /\bAKIA[0-9A-Z]{16}\b/, label: 'an AWS access key id' },
  { pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/, label: 'a GitHub token' },
  { pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/, label: 'a GitHub fine-grained token' },
  { pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, label: 'a PEM private key block' },
  {
    pattern: /\b[A-Z][A-Z0-9_]*_(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*['"]?[^\s'"]{8,}/,
    label: 'a credential-style assignment',
  },
]

export function detectSecretLikeContent(content: string): string[] {
  const warnings: string[] = []
  for (const { pattern, label } of SECRET_HEURISTICS) {
    if (pattern.test(content)) {
      warnings.push(
        `content contains what looks like ${label}; skills are stored as plain text — ` +
          'replace secrets with placeholders before saving',
      )
    }
  }
  return warnings
}

export function planSkillWrite(document: SkillDocument, existingContent?: string): SkillWritePlan {
  const after = renderSkillMarkdown(document)
  const warnings = detectSecretLikeContent(after)
  if (existingContent === undefined) return { action: 'create', after, warnings }
  return { action: 'update', after, before: existingContent, warnings }
}
