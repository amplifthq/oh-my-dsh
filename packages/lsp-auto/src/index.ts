/**
 * Mounts bundled language servers plus compatible servers already on PATH.
 * The upstream LSP seam remains the protocol owner; this plugin supplies the
 * catalog and installation policy that the neutral framework intentionally
 * leaves to distributions.
 * @module oh-my-dsh/lsp-auto
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import * as LspStdio from '@deepseek-ai/dsh-lsp-stdio'

export const name = 'omd-lsp-auto'
export const inject = ['lsp', 'fs', 'subprocess']

const require = createRequire(import.meta.url)

interface ServerConfig {
  command: string
  args?: string[]
  extensionToLanguage: Record<string, string>
}

function packageBin(packageName: string, binName: string): string | undefined {
  try {
    const path = require.resolve(`${packageName}/package.json`)
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as {
      bin?: string | Record<string, string>
    }
    const relative = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[binName]
    return relative ? join(dirname(path), relative) : undefined
  } catch {
    return undefined
  }
}

function executable(command: string): boolean {
  const probe = process.platform === 'win32' ? 'where' : 'which'
  return spawnSync(probe, [command], { stdio: 'ignore' }).status === 0
}

function bundled(
  servers: Record<string, ServerConfig>,
  id: string,
  packageName: string,
  binName: string,
  args: string[],
  extensionToLanguage: Record<string, string>,
): void {
  const script = packageBin(packageName, binName)
  if (!script) return
  servers[id] = {
    command: process.execPath,
    args: [script, ...args],
    extensionToLanguage,
  }
}

export function discoverServers(): Record<string, ServerConfig> {
  const servers: Record<string, ServerConfig> = {}

  bundled(
    servers,
    'typescript',
    'typescript-language-server',
    'typescript-language-server',
    ['--stdio'],
    {
      '.ts': 'typescript',
      '.tsx': 'typescriptreact',
      '.mts': 'typescript',
      '.cts': 'typescript',
      '.js': 'javascript',
      '.jsx': 'javascriptreact',
      '.mjs': 'javascript',
      '.cjs': 'javascript',
    },
  )
  bundled(servers, 'python', 'pyright', 'pyright-langserver', ['--stdio'], { '.py': 'python' })
  bundled(
    servers,
    'json',
    'vscode-langservers-extracted',
    'vscode-json-language-server',
    ['--stdio'],
    { '.json': 'json', '.jsonc': 'jsonc' },
  )
  bundled(
    servers,
    'web-markup',
    'vscode-langservers-extracted',
    'vscode-html-language-server',
    ['--stdio'],
    { '.html': 'html', '.htm': 'html' },
  )
  bundled(
    servers,
    'styles',
    'vscode-langservers-extracted',
    'vscode-css-language-server',
    ['--stdio'],
    { '.css': 'css', '.scss': 'scss', '.less': 'less' },
  )
  bundled(
    servers,
    'yaml',
    'yaml-language-server',
    'yaml-language-server',
    ['--stdio'],
    { '.yaml': 'yaml', '.yml': 'yaml' },
  )

  const external: Array<[string, string, string[], Record<string, string>]> = [
    ['rust', 'rust-analyzer', [], { '.rs': 'rust' }],
    ['go', 'gopls', [], { '.go': 'go' }],
    ['clang', 'clangd', [], { '.c': 'c', '.h': 'c', '.cc': 'cpp', '.cpp': 'cpp', '.cxx': 'cpp', '.hpp': 'cpp' }],
    ['swift', 'sourcekit-lsp', [], { '.swift': 'swift' }],
  ]
  for (const [id, command, args, extensionToLanguage] of external) {
    if (executable(command)) servers[id] = { command, args, extensionToLanguage }
  }
  return servers
}

export function apply(ctx: Context): void {
  const servers = discoverServers()
  if (!Object.keys(servers).length) return
  ctx.plugin(LspStdio, { servers })
}
