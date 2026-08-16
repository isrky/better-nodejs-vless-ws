#!/usr/bin/env node
// Interactive credential manager for local/credentials.json.
//
//   npm run creds                 the menu
//   npm run creds:status          redacted report, never prompts
//   npm run creds:push            reveal the secrets, to paste into the dashboards
//
// Prompts and a reprinted menu — no raw mode, no cursor addressing, no
// clear-screen — so it works over SSH and on a dumb terminal, and cannot leave
// a terminal in a broken state on any exit path.
//
// Edits are written through immediately rather than saved on exit. The failure
// this defends against is credential loss, and a freshly generated UUID that
// exists only in memory is precisely what you cannot recover.

import { createInterface } from 'node:readline/promises';
import { existsSync, readFileSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FIELDS, DEFAULT_STORE_PATH, StoreError,
  emptyStore, readStore, writeStore, restoreBackup, storeMode, withField,
  redact, generate, validateField, validateStore, field,
  parseLegacyEnv, planImport, pushPlan, publicHostWarnings, platformNames
} from './credstore.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LEGACY_ENV = resolve(ROOT, 'local/.env');

const USAGE = `manage the credentials in local/credentials.json

  npm run creds                    interactive menu
  npm run creds:status             redacted report (never prompts)
  npm run creds:push               show the secrets, grouped by dashboard
  node tools/credentials.mjs --push --yes
                                   skip the confirmation (prints secrets)
  node tools/credentials.mjs --import PATH
                                   import a retired local/.env

Rendering the client configs is a separate step: npm run configs`;

class Cancelled extends Error {}

const colour = process.stdout.isTTY && !process.env.NO_COLOR;
const dim = (s) => (colour ? `\x1b[2m${s}\x1b[0m` : s);
const bold = (s) => (colour ? `\x1b[1m${s}\x1b[0m` : s);
const red = (s) => (colour ? `\x1b[31m${s}\x1b[0m` : s);

// ==========================================
// Reports — all pure, all redacted
// ==========================================

function problemsByKey(store) {
  const map = new Map();
  for (const p of validateStore(store)) map.set(p.key, p);
  return map;
}

export function renderMenu(store, storePath = DEFAULT_STORE_PATH) {
  const problems = problemsByKey(store);
  const lines = [];

  lines.push('');
  lines.push(`${bold('credentials')} ${dim(storePath.replace(ROOT + '/', ''))}` +
             `   ${dim(`v${store.version}  ${storeMode(storePath)}`)}`);

  let n = 0;
  for (const group of ['render', 'server']) {
    lines.push('');
    lines.push(dim(group === 'render'
      ? '  used to render the client configs'
      : '  server-side only — never written into a config'));

    for (const f of FIELDS) {
      if (f.group !== group) continue;
      n += 1;
      const problem = problems.get(f.key);
      const state = problem ? red(problem.reason) : (store.credentials[f.key] === undefined ? '' : 'ok');
      const target = f.pushTo.length ? dim('-> ' + f.pushTo.join(', ')) : '';
      lines.push(
        `  ${String(n).padStart(2)}  ${f.key.padEnd(26)}` +
        `${redact(f.key, store.credentials[f.key]).padEnd(24)}${state.padEnd(12)}${target}`
      );
    }
  }

  lines.push('');
  lines.push('   r  render the configs      p  reveal secrets to paste');
  lines.push('   u  undo last change        q  quit');
  lines.push('');
  return lines.join('\n');
}

export function statusReport(store, storePath = DEFAULT_STORE_PATH) {
  const problems = validateStore(store);
  const lines = [renderMenu(store, storePath).replace(/\n\s{3}[rupq] .*/g, '')];

  for (const warning of publicHostWarnings(store)) lines.push(`warning: ${warning}`);
  if (problems.length) {
    lines.push(`${problems.length} problem(s) — run: npm run creds`);
  }
  return lines.join('\n');
}

/**
 * What is about to be revealed — key names and destinations only.
 *
 * Safe to print anywhere, and it doubles as the checklist: there is no separate
 * no-values mode to keep in step with this one.
 */
export function formatRevealPrompt(plan, names) {
  const count = new Set([...plan.fly, ...plan.wrangler]).size;
  const out = ['', `About to print ${count} secret value(s) to this terminal.`, ''];

  out.push(`  Fly · ${names.fly}${' '.repeat(Math.max(1, 22 - names.fly.length))}` +
           `${plan.fly.join(' ') || '(nothing set)'}`);
  out.push(`  Worker · ${names.worker}${' '.repeat(Math.max(1, 19 - names.worker.length))}` +
           `${plan.wrangler.join(' ') || '(nothing set)'}`);

  out.push('');
  out.push(dim('  They will stay in your scrollback.'));
  out.push('');
  return out.join('\n');
}

/**
 * The secrets themselves, grouped by where they are pasted.
 *
 * This is the ONLY function in the tool that prints a credential — keeping that
 * true is what makes the leak surface auditable in one place.
 */
export function formatReveal(plan, store, names) {
  const out = [''];

  const section = (keys) => {
    for (const key of keys) {
      out.push(`  ${bold(key)}`);
      out.push(`    ${store.credentials[key]}`);
    }
  };

  if (plan.fly.length) {
    out.push(bold(`Fly — https://fly.io/apps/${names.fly}/secrets`));
    out.push(dim('  Secrets → New secret. Setting any of these restarts the machine, which'));
    out.push(dim('  briefly drops every tunnel and resets the stats counters — do them together.'));
    out.push('');
    section(plan.fly);
    out.push('');
  }

  if (plan.wrangler.length) {
    out.push(bold(`Cloudflare — Workers & Pages → ${names.worker} → Settings → Variables and Secrets`));
    out.push(dim('  Add each as a SECRET, not a plaintext Variable. A plaintext variable is'));
    out.push(dim('  overwritten from wrangler.toml on the next `wrangler deploy`; a secret survives.'));
    out.push('');
    section(plan.wrangler);
    out.push('');
  }

  if (plan.renderOnly.length) {
    out.push(`Not pushed anywhere: ${plan.renderOnly.join(' ')}   ${dim('(render inputs only)')}`);
    out.push('');
  }

  out.push('Then:  npm run configs   npm run qr   npm run configs:check');
  out.push(dim('Do this from a network you do NOT reach through the tunnel — every device'));
  out.push(dim('on the old credential drops the moment these land, including this one.'));
  for (const w of plan.warnings) out.push(red(`warning: ${w}`));
  out.push('');
  return out.join('\n');
}

// ==========================================
// Prompting
// ==========================================

function makeAsk(rl) {
  return async function ask(query) {
    const ac = new AbortController();
    const cancel = () => ac.abort();
    rl.once('SIGINT', cancel);
    rl.once('close', cancel);
    try {
      return (await rl.question(query, { signal: ac.signal })).trim();
    } catch (e) {
      // rl.question does not resolve on EOF, so Ctrl-D arrives here too.
      if (e.name === 'AbortError') throw new Cancelled();
      throw e;
    } finally {
      rl.off('SIGINT', cancel);
      rl.off('close', cancel);
    }
  };
}

function fieldHelp(f, current) {
  const lines = ['', `${bold(f.key)}   ${dim(f.help)}`, `  current: ${redact(f.key, current)}`];
  if (f.pushTo.length) lines.push(`  pushed to: ${f.pushTo.join(', ')}`);

  const options = ['[enter] keep'];
  if (f.generate) options.push('[g] generate');
  if (!f.required) options.push('[c] clear');
  options.push('[q] back');
  lines.push('  ' + options.join('    '), '');
  return lines.join('\n');
}

/** @returns the new value, null to delete, or undefined to leave unchanged. */
export async function editField(f, store, ask, out) {
  const current = store.credentials[f.key];

  for (;;) {
    out(fieldHelp(f, current));
    const answer = await ask(`${f.key}> `);

    if (answer === '' || answer === 'q') return undefined;
    if (answer === 'g') {
      if (!f.generate) { out(red(`  ${f.key} cannot be generated`)); continue; }
      return f.generate();
    }
    if (answer === 'c') {
      if (f.required) { out(red(`  ${f.key} is required${f.generate ? '; use g' : ''}`)); continue; }
      return null;
    }

    const why = validateField(f.key, answer);
    // Never echo the answer — for a secret field it is the credential.
    if (why) { out(red(`  ${f.key} ${why}`)); continue; }
    return answer;
  }
}

/**
 * The CA is the one field with three states rather than a value, and the empty
 * string is one of them. A submenu means "leave it blank" can never silently
 * become either "no pinned CA" or "bundled" — both of which render a config
 * that works everywhere except the network the CA exists for.
 */
export async function editCa(store, ask, out) {
  const current = store.credentials.INTERCEPT_CA_FILE;
  out([
    '',
    `${bold('INTERCEPT_CA_FILE')}   ${dim('which CA goes into the client configs?')}`,
    `   1  bundled   the root from src/node/interceptca.js` +
      (current === undefined ? dim('   (current)') : ''),
    `   2  none      omit the certificates block entirely` +
      (current === '' ? dim('   (current)') : ''),
    `   3  file      supply your own PEM` +
      (current ? dim(`   (current: ${current})`) : ''),
    '   q  back',
    ''
  ].join('\n'));

  for (;;) {
    const answer = await ask('CA> ');
    if (answer === 'q' || answer === '') return undefined;
    if (answer === '1') return null;          // delete the key => bundled
    if (answer === '2') return '';            // explicit "no pinned CA"
    if (answer === '3') {
      const path = await ask('path to a PEM file> ');
      if (path === '') return undefined;
      const why = validateField('INTERCEPT_CA_FILE', path);
      if (why) { out(red(`  ${path} ${why}`)); continue; }
      return path;
    }
    out(red('  choose 1, 2, 3 or q'));
  }
}

/**
 * Show what is about to be printed, get a yes, then print it.
 *
 * The confirmation is not ceremony: this is the one command that puts
 * credentials on screen and into scrollback, so a mistyped keystroke should not
 * be enough to paint them across a shared display.
 */
export async function revealWithConfirmation(store, ask, out) {
  const plan = pushPlan(store);
  const names = platformNames();

  if (!plan.fly.length && !plan.wrangler.length) {
    out('  nothing to push — no pushable value is set');
    return false;
  }

  out(formatRevealPrompt(plan, names));
  const answer = (await ask('  Continue? [y/N] ')).toLowerCase();
  if (answer !== 'y' && answer !== 'yes') {
    out('  (nothing printed)');
    return false;
  }

  out(formatReveal(plan, store, names));
  return true;
}

// ==========================================
// The menu loop
// ==========================================

export async function runMenu({ storePath, store, ask, out, render }) {
  const numbered = FIELDS.slice();

  for (;;) {
    out(renderMenu(store, storePath));
    for (const w of publicHostWarnings(store)) out(red(`warning: ${w}`));

    let choice;
    try {
      choice = await ask('> ');
    } catch (e) {
      if (e instanceof Cancelled) return 130;
      throw e;
    }

    if (choice === 'q') return 0;
    if (choice === 'p') {
      try {
        await revealWithConfirmation(store, ask, out);
      } catch (e) {
        if (e instanceof Cancelled) out('  (cancelled)');
        else throw e;
      }
      continue;
    }
    if (choice === 'r') {
      if (render) await render(store);
      continue;
    }
    if (choice === 'u') {
      try {
        store = restoreBackup(storePath);
        out('  restored the previous store');
      } catch (e) {
        out(red(`  ${e.message}`));
      }
      continue;
    }

    const f = numbered[Number(choice) - 1];
    if (!f) { out(red('  unknown choice')); continue; }

    try {
      const next = f.key === 'INTERCEPT_CA_FILE'
        ? await editCa(store, ask, out)
        : await editField(f, store, ask, out);

      if (next === undefined) continue;

      const updated = withField(store, f.key, next);
      // Write through: an edit that exists only in memory is the thing you
      // cannot recover.
      writeStore(storePath, updated);
      store = updated;
      out(`  ${f.key} ${next === null ? 'cleared' : 'set'} — ` +
          `${redact(f.key, updated.credentials[f.key])}`);
    } catch (e) {
      if (e instanceof Cancelled) { out('  (cancelled)'); continue; }
      out(red(`  ${e.message}`));
    }
  }
}

// ==========================================
// Import
// ==========================================

export function describeImport(plan) {
  const lines = [];
  if (plan.add.length) lines.push(`  new:        ${plan.add.join(' ')}`);
  if (plan.same.length) lines.push(`  identical:  ${plan.same.join(' ')}`);
  for (const d of plan.differ) {
    lines.push(`  differs:    ${d.key}  (store #${d.current}  incoming #${d.incoming})`);
  }
  if (plan.unknown.length) {
    lines.push(`  unmanaged:  ${plan.unknown.join(' ')}  ${dim('(kept verbatim)')}`);
  }
  return lines.join('\n');
}

function loadStoreOrEmpty(storePath) {
  return existsSync(storePath) ? readStore(storePath) : emptyStore();
}

// ==========================================
// CLI
// ==========================================

function argValue(argv, name) {
  const i = argv.indexOf(name);
  return i === -1 ? null : argv[i + 1] || null;
}

async function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE);
    return 0;
  }

  const storePath = argValue(argv, '--store')
    ? resolve(process.cwd(), argValue(argv, '--store'))
    : DEFAULT_STORE_PATH;

  if (argv.includes('--push')) {
    const store = loadStoreOrEmpty(storePath);
    const plan = pushPlan(store);
    const names = platformNames();

    if (argv.includes('--yes')) {
      console.log(formatReveal(plan, store, names));
      return 0;
    }

    // Without a terminal there is no way to confirm, so refuse rather than
    // write credentials into whatever is on the other end of the pipe.
    if (!process.stdin.isTTY) {
      console.log(formatRevealPrompt(plan, names));
      console.error('error: refusing to print secrets without a confirmation; ' +
                    'run it on a terminal, or pass --yes');
      return 1;
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const shown = await revealWithConfirmation(store, makeAsk(rl), (s) => console.log(s));
      return shown ? 0 : 0;
    } catch (e) {
      if (e instanceof Cancelled) { console.log('  (cancelled)'); return 130; }
      throw e;
    } finally {
      rl.close();
    }
  }

  if (argv.includes('--import')) {
    const path = argValue(argv, '--import');
    if (!path) { console.error('error: --import needs a path'); return 64; }
    const imported = parseLegacyEnv(readFileSync(resolve(process.cwd(), path), 'utf8'), path);
    const store = loadStoreOrEmpty(storePath);
    const plan = planImport(store, imported);

    console.log(describeImport(plan));
    if (plan.differ.length && !argv.includes('--force')) {
      console.error('\nerror: keys differ from the store; re-run with --force to overwrite');
      return 1;
    }

    let updated = store;
    for (const [key, value] of Object.entries(imported)) updated = withField(updated, key, value);
    writeStore(storePath, updated);
    console.log(`\nimported into ${storePath.replace(ROOT + '/', '')}`);
    console.log(dim(`${path} is unchanged; archive it once you are satisfied`));
    return 0;
  }

  const store = loadStoreOrEmpty(storePath);

  if (argv.includes('--status') || !process.stdin.isTTY) {
    // Off a TTY this is the whole behaviour: report and exit, never prompt.
    console.log(statusReport(store, storePath));
    if (!process.stdin.isTTY && !argv.includes('--status')) {
      console.error(dim('\nnot a terminal — run `npm run creds` to edit'));
    }
    return validateStore(store).length ? 1 : 0;
  }

  if (!existsSync(storePath) && existsSync(LEGACY_ENV)) {
    console.log(`\n${LEGACY_ENV.replace(ROOT + '/', '')} exists and there is no store yet.`);
    console.log(`Import it with:  node tools/credentials.mjs --import local/.env\n`);
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await runMenu({
      storePath,
      store,
      ask: makeAsk(rl),
      out: (s) => console.log(s),
      render: async () => {
        const mod = await import('./render-configs.mjs');
        void mod;
        console.log('  run `npm run configs` to render');
      }
    });
  } finally {
    rl.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(e instanceof StoreError ? `error: ${e.message}` : e);
      process.exit(1);
    }
  );
}

export { Cancelled, makeAsk };
