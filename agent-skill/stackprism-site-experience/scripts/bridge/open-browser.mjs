import { spawn } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'

const DEFAULT_OPEN_TIMEOUT_MS = 5000
const MAX_OPEN_TIMEOUT_MS = 30000
const MAX_LAUNCH_PROBE_MS = 1000
const containsNul = value => (typeof value === 'string' ? value.includes('\0') : Array.isArray(value) && value.some(containsNul))
const hasPathSeparator = value => value.includes('/') || value.includes('\\')

const commandCandidates = (command, env, platform) => {
  const extensions = String(env.PATHEXT ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .filter(Boolean)
  const lowerCommand = command.toLowerCase()
  if (hasPathSeparator(command)) {
    if (platform !== 'win32' || extensions.some(extension => lowerCommand.endsWith(extension.toLowerCase()))) return [command]
    return extensions.map(extension => `${command}${extension}`)
  }
  const pathEntries = String(env.PATH ?? process.env.PATH ?? '').split(delimiter).filter(Boolean)
  if (platform !== 'win32') return pathEntries.map(entry => join(entry, command))
  return pathEntries.flatMap(entry =>
    extensions.map(extension => {
      const suffix = extension.toLowerCase()
      return join(entry, lowerCommand.endsWith(suffix) ? command : `${command}${extension}`)
    })
  )
}

const commandExists = (command, env, platform) => {
  const mode = platform === 'win32' ? constants.F_OK : constants.X_OK
  for (const candidate of commandCandidates(command, env, platform)) {
    try {
      accessSync(candidate, mode)
      if (!statSync(candidate).isFile()) continue
      return true
    } catch {}
  }
  return false
}

const validateOpenUrl = url => {
  const value = String(url)
  if (value.includes('\0') || value.includes('\n') || value.includes('\r')) return { ok: false, details: { reason: 'invalid_url' } }
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    return { ok: false, details: { reason: 'invalid_url' } }
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    return { ok: false, details: { reason: 'invalid_scheme', allowed: ['http', 'https'] } }
  }
  if (parsed.username || parsed.password) return { ok: false, details: { reason: 'invalid_url' } }
  return { ok: true }
}

export const parseOpenTimeoutMs = env => {
  const value = env.STACKPRISM_BROWSER_OPEN_TIMEOUT_MS
  if (value == null || value === '') return { ok: true, timeoutMs: DEFAULT_OPEN_TIMEOUT_MS }
  const parsed = Number(value)
  if (Number.isInteger(parsed) && parsed >= 100 && parsed <= MAX_OPEN_TIMEOUT_MS) return { ok: true, timeoutMs: parsed }
  return { ok: false, details: { reason: 'invalid_open_timeout' } }
}

export const parseOpenConfig = env => {
  for (const key of ['STACKPRISM_BROWSER_OPEN_COMMAND', 'STACKPRISM_BROWSER_OPEN_ARGS_JSON']) {
    if (String(env[key] || '').includes('\0')) {
      return { ok: false, code: 'BRIDGE_INVALID_ENV', message: 'Browser open environment contains NUL.' }
    }
  }
  if (env.STACKPRISM_BROWSER_OPEN_COMMAND && env.STACKPRISM_BROWSER_OPEN_ARGS_JSON) {
    try {
      if (containsNul(JSON.parse(env.STACKPRISM_BROWSER_OPEN_ARGS_JSON))) {
        return { ok: false, code: 'BRIDGE_INVALID_ENV', message: 'Browser open environment contains NUL.' }
      }
    } catch {}
  }
  return { ok: true }
}

export const resolveBrowserOpenCommand = (env = process.env, platform = process.platform) => {
  let command = env.STACKPRISM_BROWSER_OPEN_COMMAND
  let args = []
  if (command) {
    if (env.STACKPRISM_BROWSER_OPEN_ARGS_JSON) {
      try {
        args = JSON.parse(env.STACKPRISM_BROWSER_OPEN_ARGS_JSON)
      } catch {
        return { ok: false, details: { reason: 'invalid_open_args' } }
      }
      if (!Array.isArray(args) || args.some(arg => typeof arg !== 'string')) {
        return { ok: false, details: { reason: 'invalid_open_args' } }
      }
    }
  } else if (platform === 'darwin') {
    command = 'open'
  } else if (platform === 'win32') {
    command = 'rundll32.exe'
    args = ['url.dll,FileProtocolHandler']
  } else {
    command = 'xdg-open'
  }
  return { ok: true, command, args }
}

const waitForLaunchProbe = (child, timeoutMs) =>
  new Promise(resolve => {
    let settled = false
    const finish = result => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.off('error', onError)
      child.off('exit', onExit)
      resolve(result)
    }
    const onError = error => {
      finish({ ok: false, details: { reason: error?.code === 'ENOENT' ? 'command_not_found' : 'spawn_failed' } })
    }
    const onExit = code => {
      finish(code === 0 ? { ok: true } : { ok: false, details: { reason: 'open_failed', exitCode: code } })
    }
    const timer = setTimeout(() => finish({ ok: true }), Math.min(timeoutMs, MAX_LAUNCH_PROBE_MS))
    timer.unref?.()
    child.once('error', onError)
    child.once('exit', onExit)
  })

export const openBrowser = async (url, env = process.env, platform = process.platform) => {
  const openConfig = parseOpenConfig(env)
  if (!openConfig.ok) return { ok: false, details: { reason: openConfig.code, message: openConfig.message } }
  const openUrl = validateOpenUrl(url)
  if (!openUrl.ok) return openUrl

  if (env.STACKPRISM_BRIDGE_NO_OPEN === '1') return { ok: true, skipped: true }

  const resolved = resolveBrowserOpenCommand(env, platform)
  if (!resolved.ok) return resolved
  const timeout = parseOpenTimeoutMs(env)
  if (!timeout.ok) return { ok: false, details: timeout.details }
  const { command, args } = resolved
  if (!commandExists(command, env, platform)) return { ok: false, details: { reason: 'command_not_found' } }

  try {
    const child = spawn(command, [...args, url], { detached: true, stdio: 'ignore', shell: false })
    const launched = await waitForLaunchProbe(child, timeout.timeoutMs)
    child.unref()
    return launched
  } catch {
    return { ok: false, details: { reason: 'spawn_failed' } }
  }
}
