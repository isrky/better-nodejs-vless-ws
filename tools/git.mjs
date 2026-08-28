// Commit and push the committed encrypted-secrets file from the dashboard.
//
// The only git integration in the tooling. Push is a network op, so the runner
// is async (promisified execFile) rather than a blocking spawnSync — the Ink
// render loop must not freeze while the push is in flight. The command runner
// is injected (default: real git in the repo root) so tests never shell out.
//
// Only `src/node/secrets.enc.json` is ever staged/committed: a pathspec commit
// never sweeps in unrelated working-tree changes the way `git add -A` would.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const execFileP = promisify(execFile);

export const SECRETS_PATHSPEC = 'src/node/secrets.enc.json';

/** Run `git <args>` in the repo root, returning stdout. Throws the git stderr on failure. */
async function defaultRun(args) {
  try {
    const { stdout } = await execFileP('git', args, { cwd: ROOT });
    return stdout;
  } catch (e) {
    const detail = (e.stderr || e.message || '').toString().trim();
    throw new Error(detail || `git ${args[0]} failed`);
  }
}

/**
 * The git state of the secrets file, for the push tab. Returns enums, counts,
 * and branch names only — never file contents (which are ciphertext anyway).
 */
export async function secretsGitStatus({ run = defaultRun } = {}) {
  const file = (await run(['status', '--porcelain', '--', SECRETS_PATHSPEC])).trim() ? 'modified' : 'clean';
  const branch = (await run(['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  let upstream = null;
  let ahead = 0;
  let behind = 0;
  try {
    upstream = (await run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])).trim();
    const [b, a] = (await run(['rev-list', '--left-right', '--count', '@{u}...HEAD'])).trim().split(/\s+/);
    behind = Number(b) || 0;
    ahead = Number(a) || 0;
  } catch {
    // No upstream configured for this branch.
  }
  return { file, branch, upstream, ahead, behind };
}

/**
 * Commit the secrets file (only if it has uncommitted changes), then push.
 * `out` is the message sink; it receives filenames and outcomes, never values.
 */
export async function gitCommitPush(out, { run = defaultRun } = {}) {
  if ((await run(['status', '--porcelain', '--', SECRETS_PATHSPEC])).trim()) {
    await run(['commit', '-m', 'Update encrypted secrets', '--', SECRETS_PATHSPEC]);
    out('committed src/node/secrets.enc.json');
  }
  await run(['push']);
  out('pushed to the remote');
  return true;
}
