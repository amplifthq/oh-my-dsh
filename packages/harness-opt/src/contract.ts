/**
 * Locked opt_control action surface.
 *
 * A durable bandit over a fixed action set. suggest picks the next arm from
 * eval compares, forge usage, and capability gaps. show reads the policy file.
 * This module never applies proposals, writes the catalog, or bypasses eval gates.
 */

import { createHash } from 'node:crypto'

export const OPT_CONTROL_ACTIONS = ['suggest', 'show'] as const
export type OptControlAction = (typeof OPT_CONTROL_ACTIONS)[number]

export const OPT_ARMS = [
  'prepare_promote',
  'prepare_forge',
  'prepare_unload',
  'prepare_save',
  'noop',
] as const
export type OptArm = (typeof OPT_ARMS)[number]

export const OPT_STORE_DIR = 'omd/opt'
export const OPT_POLICY_FILE = 'policy.json'

export const OPT_CONTROL_DESCRIPTION =
  'Choose the next harness mutation from a fixed action set using a durable policy. ' +
  'suggest reads eval compares, forged-plugin usage, and capability gaps, then returns one arm ' +
  'and a next tool call. show reads the policy file under $DSH_HOME/omd/opt. ' +
  'opt_control never applies proposals, writes presets/plugins.json, or bypasses eval gates. ' +
  'Two actions only: suggest, show.'

const FORBIDDEN_ACTIONS = [
  'apply',
  'judge',
  'promote',
  'export',
  'train',
  'optimize',
  'run',
  'compare',
] as const

const REQUEST_FIELDS = ['action'] as const

export interface ArmStats {
  wins: number
  losses: number
}

export interface OptLastSuggestion {
  arm: OptArm
  target?: string
  query?: string
  at: string
}

export interface OptPolicy {
  version: 1
  arms: Record<OptArm, ArmStats>
  last?: OptLastSuggestion
  credited: string[]
}

export interface OptSuggestion {
  arm: OptArm
  target?: string
  query?: string
  scope?: 'user' | 'project'
  next: OptNextAction[]
}

export interface OptCandidate {
  arm: OptArm
  target?: string
  query?: string
  scope?: 'user' | 'project'
  usage?: number
}

export interface OptNextAction {
  tool: string
  action: string
  args?: Record<string, unknown>
  instruction: string
}

export interface OptFilePointer {
  kind: 'policy'
  ref: string
  path: string
}

export interface OptControlEnvelope<T> {
  action: OptControlAction
  refs: string[]
  files: OptFilePointer[]
  next: OptNextAction[]
  data: T
}

export const OPT_CONTROL_PARAMETERS = {
  action: {
    type: 'string',
    required: true,
    enum: [...OPT_CONTROL_ACTIONS],
    description: 'suggest picks one arm and a next tool call; show reads the durable policy file.',
  },
} as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function optSha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export function emptyArmStats(): ArmStats {
  return { wins: 0, losses: 0 }
}

export function emptyPolicy(): OptPolicy {
  const arms = {} as Record<OptArm, ArmStats>
  for (const arm of OPT_ARMS) arms[arm] = emptyArmStats()
  return { version: 1, arms, credited: [] }
}

export function parseOptPolicy(value: unknown): OptPolicy {
  if (!isRecord(value)) throw new Error('opt policy must be an object')
  if (value.version !== 1) throw new Error('opt policy version must be 1')
  if (!isRecord(value.arms)) throw new Error('opt policy arms must be an object')
  const arms = {} as Record<OptArm, ArmStats>
  for (const arm of OPT_ARMS) {
    const raw = value.arms[arm]
    if (!isRecord(raw)) {
      arms[arm] = emptyArmStats()
      continue
    }
    const wins = raw.wins
    const losses = raw.losses
    if (typeof wins !== 'number' || !Number.isInteger(wins) || wins < 0) {
      throw new Error(`opt policy arms.${arm}.wins must be an integer ≥ 0`)
    }
    if (typeof losses !== 'number' || !Number.isInteger(losses) || losses < 0) {
      throw new Error(`opt policy arms.${arm}.losses must be an integer ≥ 0`)
    }
    arms[arm] = { wins, losses }
  }
  const credited = Array.isArray(value.credited)
    ? value.credited.filter((item): item is string => typeof item === 'string' && item.length > 0)
    : []
  const policy: OptPolicy = { version: 1, arms, credited }
  if (value.last !== undefined) {
    if (!isRecord(value.last)) throw new Error('opt policy last must be an object')
    const arm = value.last.arm
    if (!(OPT_ARMS as readonly string[]).includes(arm as string)) {
      throw new Error('opt policy last.arm is not a known arm')
    }
    const last: OptLastSuggestion = {
      arm: arm as OptArm,
      at: typeof value.last.at === 'string' ? value.last.at : new Date(0).toISOString(),
    }
    if (typeof value.last.target === 'string' && value.last.target.trim()) {
      last.target = value.last.target.trim()
    }
    if (typeof value.last.query === 'string' && value.last.query.trim()) {
      last.query = value.last.query.trim()
    }
    policy.last = last
  }
  return policy
}

export function envelope<T>(
  action: OptControlAction,
  data: T,
  parts: { refs?: string[]; files?: OptFilePointer[]; next?: OptNextAction[] } = {},
): OptControlEnvelope<T> {
  if (isRecord(data) && Object.hasOwn(data, 'summary')) {
    throw new Error('opt_control envelope data must not include a narrative summary')
  }
  return {
    action,
    refs: parts.refs ?? [],
    files: parts.files ?? [],
    next: parts.next ?? [],
    data,
  }
}

export function parseOptControlRequest(args: unknown): { action: OptControlAction } {
  if (!isRecord(args)) throw new Error('opt_control arguments must be an object')
  const unknown = Object.keys(args).filter(
    (key) => !(REQUEST_FIELDS as readonly string[]).includes(key),
  )
  if (unknown.length) {
    throw new Error(`opt_control has unknown fields: ${unknown.join(', ')}`)
  }
  const action = args.action
  if (typeof action !== 'string' || !action.trim()) {
    throw new Error('opt_control action is required')
  }
  if ((FORBIDDEN_ACTIONS as readonly string[]).includes(action)) {
    throw new Error(
      `opt_control cannot ${action}; it only suggests the next arm and never applies, judges, or trains`,
    )
  }
  if (!(OPT_CONTROL_ACTIONS as readonly string[]).includes(action)) {
    throw new Error(`opt_control action must be one of ${OPT_CONTROL_ACTIONS.join(', ')}`)
  }
  return { action: action as OptControlAction }
}

export function nextForSuggestion(suggestion: OptSuggestion): OptNextAction[] {
  if (suggestion.arm === 'noop') {
    return [
      {
        tool: 'opt_control',
        action: 'show',
        instruction: 'No legal mutation. Read the policy; do not invent a promote or distill.',
      },
    ]
  }
  if (suggestion.arm === 'prepare_promote' && suggestion.target) {
    const parsed = splitForgedRef(suggestion.target)
    return [
      {
        tool: 'plugin_forge',
        action: 'prepare_promote',
        args: parsed ? { scope: parsed.scope, name: parsed.slug } : { name: suggestion.target },
        instruction:
          'Eval gates still apply: compare mode=diff must not regress and mode=ablate must be faithful. Then proposal_control apply.',
      },
    ]
  }
  if (suggestion.arm === 'prepare_unload' && suggestion.target) {
    const parsed = splitForgedRef(suggestion.target)
    return [
      {
        tool: 'plugin_forge',
        action: 'prepare_unload',
        args: parsed ? { name: parsed.slug } : { name: suggestion.target },
        instruction:
          'Ablation showed this plugin was ignored. Unload is still a proposal: proposal_control apply.',
      },
    ]
  }
  if (suggestion.arm === 'prepare_forge') {
    return [
      {
        tool: 'plugin_forge',
        action: 'gaps',
        instruction: suggestion.query
          ? `Capability gap ${JSON.stringify(suggestion.query)}. Draft minimal source and call plugin_forge prepare_forge. opt_control does not write source.`
          : 'Read capability gaps, then draft source and call plugin_forge prepare_forge.',
      },
    ]
  }
  if (suggestion.arm === 'prepare_save' && suggestion.target) {
    const slug = suggestion.target.startsWith('skill:')
      ? decodeURIComponent(suggestion.target.slice('skill:'.length))
      : suggestion.target
    return [
      {
        tool: 'skill_control',
        action: 'prepare_save',
        args: { scope: suggestion.scope ?? 'user', name: slug },
        instruction:
          'This skill was causally used. Draft the updated body and call prepare_save. A faithful ablate is still required.',
      },
    ]
  }
  return [
    {
      tool: 'opt_control',
      action: 'show',
      instruction: 'Inspect the policy before acting.',
    },
  ]
}

export function splitForgedRef(
  ref: string,
): { scope: 'user' | 'project'; slug: string } | undefined {
  const raw = ref.startsWith('plugin:') ? decodeURIComponent(ref.slice('plugin:'.length)) : ref
  const match = /^forged\/(user|project)\/([a-z0-9][a-z0-9-]{0,40})$/.exec(raw)
  if (!match) return undefined
  return { scope: match[1] as 'user' | 'project', slug: match[2]! }
}
