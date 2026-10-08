/**
 * Run configurations: per-file arguments, environment variables and
 * working directory, used by Run (⌘R) and Debug (F5). Pure helpers, so
 * they're unit-tested.
 */

export interface RunConfig {
  /** Program arguments, shell-style (quotes group words). */
  args: string;
  /** One KEY=VALUE per line. */
  env: string;
  /** Empty: the project folder. */
  cwd: string;
}

export const EMPTY_RUN_CONFIG: RunConfig = { args: "", env: "", cwd: "" };

export function isEmptyConfig(config: RunConfig): boolean {
  return !config.args.trim() && !config.env.trim() && !config.cwd.trim();
}

/** Split arguments like a shell: whitespace separates, quotes group,
 *  backslash escapes (outside single quotes). */
export function parseArgs(text: string): string[] {
  const args: string[] = [];
  let current = "";
  let inArg = false;
  let quote: '"' | "'" | null = null;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && index + 1 < text.length) current += text[++index];
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      inArg = true;
    } else if (char === "\\" && index + 1 < text.length) {
      current += text[++index];
      inArg = true;
    } else if (/\s/.test(char)) {
      if (inArg) args.push(current);
      current = "";
      inArg = false;
    } else {
      current += char;
      inArg = true;
    }
  }
  if (inArg) args.push(current);
  return args;
}

/** KEY=VALUE lines → a map (blank lines and # comments ignored; values may
 *  be quoted). */
export function parseEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/^export\s+/, "");
    if (!line || line.startsWith("#")) continue;
    const equals = line.indexOf("=");
    if (equals <= 0) continue;
    const name = line.slice(0, equals).trim();
    let value = line.slice(equals + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    env[name] = value;
  }
  return env;
}

/** Quote a word for a POSIX shell. */
export function shellQuote(word: string): string {
  return /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** The terminal command line for running `base` (already quoted) with a
 *  configuration: `cd dir && NAME=value … base args…`. */
export function commandLineFor(base: string, config: RunConfig): string {
  const env = Object.entries(parseEnv(config.env)).map(([name, value]) => `${name}=${shellQuote(value)}`);
  const args = parseArgs(config.args).map(shellQuote);
  const command = [...env, base, ...args].join(" ");
  return config.cwd.trim() ? `cd ${shellQuote(config.cwd.trim())} && ${command}` : command;
}
