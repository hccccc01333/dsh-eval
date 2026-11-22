/**
 * Small, dependency-free command-line splitter shared by the CLI `--dsh`
 * override and benchmark check commands.
 *
 * Whitespace-only splitting silently breaks paths with spaces and quoted
 * arguments: `node "my script.mjs" --flag "a b"` used to become five argv
 * entries. This parser supports single/double quotes, backslash escapes and
 * escaped whitespace, without pretending to be a full POSIX shell (redirection
 * and pipes stay the job of explicit opt-in `checkShell`).
 *
 * @module dsh-eval/argv
 */

/**
 * Split a command string into argv tokens.
 * @param value - the command line as written by the user.
 * @returns argv tokens with quotes and escapes removed.
 * @throws on an unterminated quote, which is a typo rather than an empty command.
 */
export function splitArgv(value: string): string[] {
  const tokens: string[] = []
  let token = ''
  let started = false
  let quote: '"' | "'" | undefined
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined
      } else if (char === '\\' && quote === '"' && index + 1 < value.length) {
        token += value[index + 1]!
        index += 1
      } else {
        token += char
      }
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (char === '\\' && index + 1 < value.length && /\s/u.test(value[index + 1]!)) {
      token += value[index + 1]!
      started = true
      index += 1
      continue
    }
    if (/\s/u.test(char)) {
      if (started) {
        tokens.push(token)
        token = ''
        started = false
      }
      continue
    }
    token += char
    started = true
  }
  if (quote !== undefined) throw new Error('unterminated quote in command')
  if (started) tokens.push(token)
  return tokens
}
