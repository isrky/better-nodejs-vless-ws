// Put text on the operator's clipboard from a terminal.
//
// Two mechanisms, chosen at call time. A local clipboard binary
// (wl-copy/xclip/xsel/pbcopy) is used only when a display is present, so a
// headless VPS reached over SSH does not pipe into a useless server-side
// clipboard. Otherwise — and whenever the binary is missing or fails — the
// OSC 52 terminal escape carries the text to the emulator, which lands it on
// the operator's *local* clipboard even across an SSH hop.
//
// All environment access is injected so tests never spawn a process, touch a
// real clipboard, or emit escapes into their own output.
import { spawnSync as nodeSpawnSync } from 'node:child_process';

// A local clipboard command for the current platform, or null when none fits.
// Linux gates on a display so SSH sessions skip straight to OSC 52.
function localCommand(env, platform) {
  if (platform === 'darwin') return { name: 'pbcopy', argv: ['pbcopy'] };
  if (env.WAYLAND_DISPLAY) return { name: 'wl-copy', argv: ['wl-copy'] };
  if (env.DISPLAY) return { name: 'xclip', argv: ['xclip', '-selection', 'clipboard'] };
  return null;
}

function osc52(text, stdout) {
  const payload = Buffer.from(text, 'utf8').toString('base64');
  stdout.write(`\x1b]52;c;${payload}\x07`);
  return 'osc52';
}

/**
 * Copy `text` to the clipboard. Returns the method used
 * ('wl-copy' | 'xclip' | 'pbcopy' | 'osc52') so the caller can report it.
 */
export function writeClipboard(text, {
  env = process.env,
  platform = process.platform,
  stdout = process.stdout,
  spawn = nodeSpawnSync
} = {}) {
  const command = localCommand(env, platform);
  if (command) {
    try {
      const result = spawn(command.argv[0], command.argv.slice(1), { input: text });
      // A missing binary surfaces as an ENOENT error; a non-zero exit as status.
      if (result && !result.error && (result.status === 0 || result.status === null)) {
        return command.name;
      }
    } catch {
      // fall through to OSC 52
    }
  }
  return osc52(text, stdout);
}
