/**
 * How to start a package-manager command (`pnpm`, `npx`) on this platform.
 *
 * On macOS and Linux `pnpm` and `npx` are executables, and they are spawned as
 * before: no shell. On Windows they are `pnpm.cmd` and `npx.cmd`, and since Node
 * 18.20.2 and 20.12.2 (CVE-2024-27980) a `.cmd` cannot be spawned without a shell:
 * the call fails with EINVAL, so `pnpm package` and the Firefox suite stopped before
 * their first step (B-163). There the command goes through `cmd.exe` (`shell: true`).
 *
 * A shell joins the arguments with spaces and reads its own metacharacters, so on
 * win32 an argument that a shell would reinterpret is refused rather than quoted:
 * every argument these tools pass is a fixed word, and one that is not is a change
 * that should have to say so.
 */

/** Characters `cmd.exe` would read as something other than part of an argument. */
const CMD_SPECIAL = /[\s"&|<>^%!()]/

/**
 * @param {string} name   e.g. `pnpm`, `npx`
 * @param {readonly string[]} args
 * @param {string} [platform]
 * @returns {{ command: string, args: string[], shell: boolean }}
 */
export function binInvocation(name, args, platform = process.platform) {
  if (platform !== 'win32') return { command: name, args: [...args], shell: false }
  const unsafe = [name, ...args].filter((arg) => arg === '' || CMD_SPECIAL.test(arg))
  if (unsafe.length > 0) {
    throw new Error(`refusing to pass ${unsafe.map((a) => JSON.stringify(a)).join(', ')} through cmd.exe`)
  }
  return { command: name, args: [...args], shell: true }
}
