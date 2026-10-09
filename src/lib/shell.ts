/** Arguments that run `command` in a login shell (so tools installed via
 *  Homebrew, nvm, rustup, … are on PATH, as in the user's terminal). */
export function loginShellArgs(command: string): string[] {
  if (/windows/i.test(navigator.userAgent)) return ["cmd.exe", "/d", "/c", command];
  return [/mac/i.test(navigator.userAgent) ? "/bin/zsh" : "/bin/bash", "-l", "-c", command];
}
