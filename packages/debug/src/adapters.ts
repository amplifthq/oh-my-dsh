/**
 * Debug adapter catalog: built-in probes for `debugpy` and `lldb-dap`, plus
 * user-configured stdio adapters. Discovery is injected so the catalog logic
 * is testable without spawning real processes.
 * @module oh-my-dsh/debug/adapters
 */

export interface DebugAdapter {
  id: string
  description: string
  /** Adapter process command line; speaks DAP on stdio. */
  argv: string[]
  languages: string[]
  /** Adapter-specific defaults merged under every launch configuration. */
  launchDefaults: Record<string, unknown>
  /** Whether the adapter meaningfully supports the DAP attach request. */
  supportsAttach: boolean
}

export interface CustomAdapterConfig {
  command: string
  args?: string[]
  description?: string
  languages?: string[]
  launchDefaults?: Record<string, unknown>
  supportsAttach?: boolean
}

export interface AdapterProbeHost {
  /** Resolve a bare executable name to a canonical path; reject when absent. */
  resolveExecutable(command: string): Promise<string>
  /** Run a short probe command; resolve true on exit code 0. */
  probeCommand(argv: string[]): Promise<boolean>
}

async function resolveOrUndefined(
  host: AdapterProbeHost,
  command: string,
): Promise<string | undefined> {
  try {
    return await host.resolveExecutable(command)
  } catch {
    return undefined
  }
}

async function discoverDebugpy(host: AdapterProbeHost): Promise<DebugAdapter | undefined> {
  for (const candidate of ['python3', 'python']) {
    const python = await resolveOrUndefined(host, candidate)
    if (!python) continue
    if (!(await host.probeCommand([python, '-c', 'import debugpy']))) continue
    return {
      id: 'debugpy',
      description: 'Python via debugpy (python -m debugpy.adapter)',
      argv: [python, '-m', 'debugpy.adapter'],
      languages: ['python'],
      launchDefaults: {
        type: 'python',
        console: 'internalConsole',
        justMyCode: true,
        redirectOutput: true,
      },
      supportsAttach: true,
    }
  }
  return undefined
}

async function discoverLldb(host: AdapterProbeHost): Promise<DebugAdapter | undefined> {
  const command = await resolveOrUndefined(host, 'lldb-dap')
  if (!command) return undefined
  return {
    id: 'lldb',
    description: 'Native binaries via lldb-dap (C, C++, Rust, Swift)',
    argv: [command],
    languages: ['c', 'cpp', 'rust', 'swift'],
    launchDefaults: {},
    supportsAttach: true,
  }
}

export async function discoverAdapters(
  custom: Record<string, CustomAdapterConfig>,
  host: AdapterProbeHost,
): Promise<Record<string, DebugAdapter>> {
  const adapters: Record<string, DebugAdapter> = {}
  const debugpy = await discoverDebugpy(host)
  if (debugpy) adapters[debugpy.id] = debugpy
  const lldb = await discoverLldb(host)
  if (lldb) adapters[lldb.id] = lldb

  for (const [id, config] of Object.entries(custom)) {
    const command = await resolveOrUndefined(host, config.command)
    if (!command) continue
    adapters[id] = {
      id,
      description: config.description ?? `custom adapter (${config.command})`,
      argv: [command, ...(config.args ?? [])],
      languages: config.languages ?? [],
      launchDefaults: config.launchDefaults ?? {},
      supportsAttach: config.supportsAttach ?? false,
    }
  }
  return adapters
}

/**
 * Merge launch arguments so adapter defaults sit under user configuration,
 * while the validated program, cwd, and argv always win over both.
 */
export function mergeLaunchArguments(
  adapter: DebugAdapter,
  userConfig: Record<string, unknown>,
  validated: {
    program: string
    args: string[]
    cwd: string
    stopOnEntry: boolean
    env?: Record<string, string>
  },
): Record<string, unknown> {
  return {
    ...adapter.launchDefaults,
    ...userConfig,
    program: validated.program,
    args: validated.args,
    cwd: validated.cwd,
    stopOnEntry: validated.stopOnEntry,
    ...(validated.env ? { env: validated.env } : {}),
  }
}
