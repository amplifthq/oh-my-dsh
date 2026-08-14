/**
 * Shell fetch-degradation detection — the pure half of the guard. When the
 * web_fetch tool is disabled, models degrade to `curl`/`wget` in the shell
 * (often with a spoofed browser User-Agent), silently bypassing the fetch
 * tool's safety and visibility. This module classifies a bash command; the
 * plugin turns a positive into an approval prompt rather than a hard block.
 * @module @oh-my-dsh/web-guard/guard
 */

import { isPrivateHost } from './address.js'

/** Command words that fetch over HTTP: curl, wget, and the common HTTPie family. */
const FETCHER_WORDS = new Set(['curl', 'wget', 'http', 'https', 'xh', 'httpie', 'aria2c'])

/**
 * Words in command position: the first word plus any word following a shell
 * connector. A rough lexer is enough — the guard asks rather than blocks, so
 * a miss costs one un-prompted command, not a security boundary.
 */
export function commandWords(command: string): string[] {
  const words: string[] = []
  const tokens = command.split(/(\s+|;|&&|\|\||\||&|\$\(|`|\n)/).filter((token) => token.length > 0)
  let atCommandPosition = true
  for (const token of tokens) {
    if (/^(\s+)$/.test(token)) continue
    if (token === ';' || token === '&&' || token === '||' || token === '|' || token === '&'
      || token === '$(' || token === '`' || token === '\n') {
      atCommandPosition = true
      continue
    }
    if (atCommandPosition) {
      // Skip leading env assignments (FOO=bar curl …) and sudo-style wrappers.
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) continue
      if (token === 'sudo' || token === 'env' || token === 'command' || token === 'nohup' || token === 'time') continue
      words.push(token.replace(/^.*\//, ''))
      atCommandPosition = false
    }
  }
  return words
}

/** All http(s) URLs appearing in a command string. */
export function extractUrls(command: string): URL[] {
  const urls: URL[] = []
  for (const match of command.matchAll(/https?:\/\/[^\s"'<>()\[\]`]+/gi)) {
    try {
      urls.push(new URL(match[0]))
    } catch {
      // Malformed candidate; not a fetch target.
    }
  }
  return urls
}

/** The guard's verdict on one bash command. */
export interface FetchCommandAssessment {
  /** A fetcher word (curl, wget, …) sits in command position. */
  usesFetcher: boolean
  /** Public http(s) URLs the command references (private/local hosts excluded). */
  publicUrls: string[]
}

/**
 * Assess whether a bash command shell-fetches a public URL. Private and
 * conventionally-local hosts stay unflagged: `curl localhost:3000` against a
 * dev server is a core workflow, not a degradation.
 */
export function assessFetchCommand(command: string): FetchCommandAssessment {
  const usesFetcher = commandWords(command).some((word) => FETCHER_WORDS.has(word))
  if (!usesFetcher) return { usesFetcher: false, publicUrls: [] }
  const publicUrls = extractUrls(command)
    .filter((url) => !isPrivateHost(url.hostname))
    .map((url) => url.toString())
  return { usesFetcher, publicUrls }
}
