const SCRIPT_LOAD_ERROR_PATTERN = /\b(?:unable|could not|failed) to load script\b/i
const SCRIPT_FILE_ACCESS_ERROR_PATTERN =
  /\b(?:unable to load file|could not load file|failed to load file|no such file|file not found|can't access file|cannot access file)\b/i
const SCRIPT_FILE_HINT_PATTERN = /(?:\.m?js\b|(?:^|[/\\])(?:assets|injected|src[/\\](?:content|injected))[/\\]|\bcontent script\b|\bscript file\b)/i

export const isScriptFileLoadError = (error: unknown): boolean => {
  const message = String(error instanceof Error ? error.message : error)
  if (SCRIPT_LOAD_ERROR_PATTERN.test(message)) return true
  return SCRIPT_FILE_ACCESS_ERROR_PATTERN.test(message) && SCRIPT_FILE_HINT_PATTERN.test(message)
}
