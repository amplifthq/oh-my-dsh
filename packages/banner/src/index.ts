/**
 * Prints the oh-my-dsh banner once at boot so a composed profile is
 * visually distinguishable from a stock dsh profile.
 * @module @oh-my-dsh/banner
 */

import type { Context } from '@deepseek-ai/cordis'

export const name = 'omd-banner'

const BANNER = [
  '┌──────────────────────────────────────────────┐',
  '│  oh-my-dsh ⚡ overlay active                  │',
  '│  plugins + defaults for DeepSeek Harness     │',
  '│  https://github.com/amplifthq/oh-my-dsh      │',
  '└──────────────────────────────────────────────┘',
].join('\n')

export function apply(_ctx: Context) {
  // eslint-disable-next-line no-console
  console.log(BANNER)
}
