/**
 * Every test runs with git's location variables removed from its environment.
 *
 * The pre-push hook runs the suite with GIT_DIR naming the repository being pushed (for a
 * worktree, `.git/worktrees/<name>`). A git child that inherits it acts on that repository
 * whatever `-C` or a path argument says. On 2026-10-27 a test's `git init <fixture>` under the
 * hook re-initialised this repository instead and wrote `core.bare = true` into the config every
 * worktree shares (B-160): the main clone stopped working and the fixture test failed, so the
 * hook refused the push. A test that means to name a repository passes `-C` or `--git-dir`.
 *
 * Loaded as a vitest setup file, so it runs in each worker before any test file, and every
 * process a test starts inherits the cleaned environment.
 */

export const GIT_LOCATION = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_PREFIX',
] as const

export function dropGitLocation(env: Record<string, string | undefined>): void {
  for (const name of GIT_LOCATION) delete env[name]
}

dropGitLocation(process.env)
