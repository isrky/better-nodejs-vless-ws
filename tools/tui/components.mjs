// Presentational only. Every component renders visibleState() and nothing
// else — the reducer's selector is the sole bridge from the store to the
// screen, which keeps secrets out of every Ink frame.
import { html } from './h.mjs';

export const MIN_COLUMNS = 50;
export const MIN_ROWS = 16;

export const terminalTooSmall = ({ columns, rows }) =>
  columns < MIN_COLUMNS || rows < MIN_ROWS;

function windowAround(items, selectedIndex, size) {
  if (items.length <= size) return items;
  const half = Math.floor(size / 2);
  const start = Math.max(0, Math.min(items.length - size, selectedIndex - half));
  return items.slice(start, start + size);
}

function inputWindow(input, width) {
  const before = Array.from(input.before || '');
  const after = Array.from(input.after || '');
  const all = [...before, ...after];
  const room = Math.max(1, width - 1); // reserve one column for the caret
  const start = Math.max(0, Math.min(Math.max(0, all.length - room), before.length - Math.floor(room / 2)));
  const visible = all.slice(start, start + room);
  const caret = Math.max(0, Math.min(visible.length, before.length - start));
  return {
    before: visible.slice(0, caret).join(''),
    after: visible.slice(caret).join('')
  };
}

function EditableInput({ input, viewport, placeholder }) {
  const shown = inputWindow(input, Math.max(4, viewport.columns - 10));
  return html`
    <Box width="100%" overflow="hidden">
      <Text color="cyan">${'> '}</Text>
      <Text>${shown.before}</Text>
      <Text color="cyan">▌</Text>
      <Text>${shown.after}</Text>
      ${input.empty && placeholder ? html`
        <Box flexGrow=${1} minWidth=${0} overflow="hidden">
          <Text dimColor wrap="truncate-end">${'  '}${placeholder}</Text>
        </Box>` : null}
    </Box>`;
}

function Header({ header, probe }) {
  return html`
    <Box width="100%" overflow="hidden" flexShrink=${0}>
      <Text bold>credentials${'  '}</Text>
      <Box flexGrow=${1} minWidth=${0} overflow="hidden">
        <Text dimColor wrap="truncate-start">${header.path}  v${header.version}</Text>
      </Box>
      ${header.problems ? html`<Text color="red">${'  '}${header.problems}!</Text>` : null}
      ${probe === 'pending' ? html`<Text color="yellow">${'  '}probing…</Text>` : null}
    </Box>`;
}

function FieldRow({ row, compact }) {
  const status = row.error ? row.status : `${row.status}${row.targets ? `  ${row.targets}` : ''}`;
  if (compact) {
    return html`
      <Box flexDirection="column" width="100%" overflow="hidden">
        <Box width="100%" overflow="hidden">
          <Box width=${21} flexShrink=${0} overflow="hidden">
            <Text bold=${row.selected} color=${row.selected ? 'cyan' : undefined} wrap="truncate-end">
              ${row.selected ? ' › ' : '   '}${row.key}
            </Text>
          </Box>
          <Box flexGrow=${1} minWidth=${0} overflow="hidden">
            <Text wrap="truncate-end">${row.display}</Text>
          </Box>
        </Box>
        <Box width="100%" paddingLeft=${3} overflow="hidden">
          <Text color=${row.error ? 'red' : undefined} dimColor=${!row.error} wrap="truncate-end">
            ${status || ' '}
          </Text>
        </Box>
      </Box>`;
  }

  return html`
    <Box width="100%" overflow="hidden">
      <Box width=${29} minWidth=${14} flexShrink=${1} overflow="hidden">
        <Text bold=${row.selected} color=${row.selected ? 'cyan' : undefined} wrap="truncate-end">
          ${row.selected ? ' › ' : '   '}${row.key}
        </Text>
      </Box>
      <Box width=${26} minWidth=${10} flexShrink=${1} marginRight=${2} overflow="hidden">
        <Text wrap="truncate-end">${row.display}</Text>
      </Box>
      <Box flexGrow=${1} minWidth=${0} overflow="hidden">
        <Text color=${row.error ? 'red' : undefined} dimColor=${!row.error} wrap="truncate-end">
          ${status}
        </Text>
      </Box>
    </Box>`;
}

function TabBar({ tabs, compact }) {
  return html`
    <Box width="100%" flexWrap="wrap" overflow="hidden" flexShrink=${0} marginTop=${compact ? 0 : 1}>
      ${tabs.map((t) => html`
        <Box key=${t.name} marginRight=${1} flexShrink=${0}>
          <Text bold=${t.active} inverse=${t.active}
                color=${t.danger ? 'red' : t.active ? 'cyan' : undefined}
                dimColor=${!t.active && !t.danger}>
            ${' '}${t.name}${' '}
          </Text>
          ${t.problems ? html`<Text color="red">${t.problems}</Text>` : null}
        </Box>`)}
    </Box>`;
}

function Group({ group, viewport, compact }) {
  const lineHeight = compact ? 2 : 1;
  const capacity = Math.max(1, Math.floor((viewport.rows - 10) / lineHeight));
  const selected = Math.max(0, group.rows.findIndex((row) => row.selected));
  const rows = windowAround(group.rows, selected, capacity);
  const range = rows.length < group.rows.length
    ? `  (${group.rows.indexOf(rows[0]) + 1}–${group.rows.indexOf(rows[0]) + rows.length}/${group.rows.length})`
    : '';
  return html`
    <Box flexDirection="column" width="100%" overflow="hidden" marginTop=${1}>
      <Text dimColor wrap="truncate-end">${'  '}${group.label}${range}</Text>
      ${rows.map((row) => html`<${FieldRow} key=${row.key} row=${row} compact=${compact} />`)}
    </Box>`;
}

function NukeChoices({ nuke, compact }) {
  return html`
    <Box flexDirection="column" width="100%" overflow="hidden" marginTop=${1}>
      <Text color="red" wrap="truncate-end">${'  '}${nuke.label}</Text>
      <Text dimColor wrap="truncate-end">${'  '}Only active secrets rotate; deployment config and user labels are preserved.</Text>
      ${nuke.choices.map((choice) => html`
        <Box key=${choice.name} flexDirection=${compact ? 'column' : 'row'} width="100%" overflow="hidden" marginTop=${1}>
          <Text bold=${choice.selected} color=${choice.selected ? 'red' : undefined}
                dimColor=${choice.disabled} wrap="truncate-end">
            ${choice.selected ? ' › ' : '   '}${choice.name} nuke
          </Text>
          <Box flexGrow=${1} minWidth=${0} paddingLeft=${compact ? 3 : 2} overflow="hidden">
            <Text dimColor wrap="truncate-end">${choice.description}${choice.disabled ? ' (canonical store only)' : ''}</Text>
          </Box>
        </Box>`)}
    </Box>`;
}

function Frame({ color, children }) {
  return html`
    <Box flexDirection="column" width="100%" overflow="hidden"
         borderStyle="round" borderColor=${color} paddingX=${1} marginTop=${1}>
      ${children}
    </Box>`;
}

function NukeConfirm({ confirm }) {
  return html`<${Frame} color="red">
    <Text bold color="red" wrap="truncate-end">CONFIRM ${confirm.kind.toUpperCase()} NUKE</Text>
    <Text wrap="truncate-end">This replaces active credentials${confirm.kind === 'full' ? ' and every encryption-group key' : ''}.</Text>
    <Text dimColor wrap="truncate-end">${confirm.kind === 'full'
      ? 'Already-issued users are cut off — reissue every user after this.'
      : 'The current provisioning secret becomes the previous secret for the transition.'}</Text>
    <Box marginTop=${1} width="100%" overflow="hidden">
      <Text color="red">${'> '}</Text>
      ${confirm.input ? html`<Text wrap="truncate-end">${confirm.input}</Text>` : null}
      <Text color="red">▌</Text>
      ${!confirm.input ? html`<Text dimColor wrap="truncate-end">${'  '}type NUKE</Text>` : null}
    </Box>
    ${confirm.error ? html`<Text color="red" wrap="truncate-end">${confirm.error}</Text>` : null}
  <//>`;
}

function NukeDone({ done }) {
  return html`<${Frame} color="red">
    <Text bold color="red" wrap="truncate-end">${done.kind.toUpperCase()} NUKE COMPLETE</Text>
    <Text wrap="truncate-end">Rotated: ${done.rotatedFields.join(', ')}</Text>
    ${done.kind === 'full' ? html`<Text wrap="truncate-end">Replaced: common, server, edge group keys</Text>` : null}
    <Text dimColor wrap="truncate-end">Expect an outage during the deployment cutover.</Text>
    ${done.steps.map((step, index) => html`
      <Text key=${index} wrap="truncate-end">${index + 1}. ${step}</Text>`)}
  <//>`;
}

function Nuke({ nuke, compact }) {
  if (nuke.confirm) return html`<${NukeConfirm} confirm=${nuke.confirm} />`;
  if (nuke.running) return html`<${Frame} color="red"><Text color="red">rotating credentials …</Text><//>`;
  if (nuke.done) return html`<${NukeDone} done=${nuke.done} />`;
  return html`<${NukeChoices} nuke=${nuke} compact=${compact} />`;
}

function SetupBanner() {
  return html`
    <Box width="100%" overflow="hidden" marginTop=${1}>
      <Text color="yellow">S${'  '}</Text>
      <Text wrap="truncate-end">quick setup — generate the missing values, then walk the required hosts</Text>
    </Box>`;
}

function Editor({ editor, viewport }) {
  return html`<${Frame} color=${editor.error ? 'red' : 'cyan'}>
    <Box width="100%" overflow="hidden">
      <Text bold>${editor.key}${'   '}</Text>
      <Box flexGrow=${1} minWidth=${0} overflow="hidden"><Text dimColor wrap="truncate-end">${editor.help}</Text></Box>
    </Box>
    <Text dimColor wrap="truncate-end">current: ${editor.current}</Text>
    <${EditableInput} input=${{ ...editor.input, empty: editor.empty }} viewport=${viewport}
      placeholder=${editor.setup
        ? 'type a value — enter skips this one, esc stops the setup'
        : 'type a value — enter keeps the current, esc cancels'} />
    ${editor.error ? html`<Text color="red" wrap="truncate-end">${editor.error}</Text>` : null}
  <//>`;
}

function UserManager({ manager, viewport }) {
  const selected = Math.max(0, manager.rows.findIndex((row) => row.selected));
  const capacity = Math.max(1, viewport.rows - 11);
  const rows = windowAround(manager.rows, selected, capacity);
  const danger = manager.view === 'confirm';
  const title = manager.view === 'input'
    ? manager.kind === 'add' ? 'ADD USER' : 'RENAME USER'
    : 'USERS';

  return html`<${Frame} color=${danger ? 'red' : 'cyan'}>
    <Box width="100%" overflow="hidden">
      <Text bold color=${danger ? 'red' : undefined}>${title}</Text>
      <Text dimColor>${'  '}${manager.count}/${manager.limit}</Text>
    </Box>
    ${!manager.provisioning
      ? html`<Text color="yellow" wrap="truncate-end">Provisioning is disabled — set PROVISION_SECRET before deployment.</Text>`
      : null}
    <Text dimColor wrap="truncate-end">Changes take effect after committing the encrypted payload and redeploying.</Text>

    ${manager.view === 'list' ? html`<Box flexDirection="column" width="100%" overflow="hidden">
      ${rows.length ? rows.map((row) => html`
        <Text key=${row.label} bold=${row.selected} color=${row.selected ? 'cyan' : undefined} wrap="truncate-end">
          ${row.selected ? ' › ' : '   '}${row.label}
        </Text>`) : html`<Text dimColor>${'   '}(no users — press a to add one)</Text>`}
      ${manager.error ? html`<Text color="red" wrap="truncate-end">${manager.error}</Text>` : null}
    </Box>` : null}

    ${manager.view === 'input' ? html`<Box flexDirection="column" width="100%" overflow="hidden">
      <Text wrap="truncate-end">${manager.kind === 'add' ? 'Enter a new user label.' : 'Edit the selected label.'}</Text>
      <${EditableInput} input=${manager.input} viewport=${viewport} placeholder="letters, digits, _ or -" />
      ${manager.input.error ? html`<Text color="red" wrap="truncate-end">${manager.input.error}</Text>` : null}
    </Box>` : null}

    ${manager.view === 'confirm' && manager.confirm.kind === 'rename' ? html`<Box flexDirection="column" width="100%" overflow="hidden">
      <Text bold color="red" wrap="truncate-end">Rename ${manager.confirm.target} → ${manager.confirm.replacement}?</Text>
      <Text wrap="truncate-end">The old derived credential will stop working after redeployment.</Text>
    </Box>` : null}
    ${manager.view === 'confirm' && manager.confirm.kind === 'delete' ? html`<Box flexDirection="column" width="100%" overflow="hidden">
      <Text bold color="red" wrap="truncate-end">Delete ${manager.confirm.target}?</Text>
      <Text wrap="truncate-end">That user's derived credential will stop working after redeployment.</Text>
    </Box>` : null}
    ${manager.view === 'confirm' && manager.confirm.kind === 'clear' ? html`<Box flexDirection="column" width="100%" overflow="hidden">
      <Text bold color="red" wrap="truncate-end">Delete all ${manager.confirm.count} users?</Text>
      <Text wrap="truncate-end">Every provisioned user credential will be revoked after redeployment.</Text>
    </Box>` : null}
  <//>`;
}

function CaSelect({ ca }) {
  return html`<${Frame} color="cyan">
    <Box width="100%" overflow="hidden">
      <Text bold>INTERCEPT_CA_FILE${'   '}</Text>
      <Box flexGrow=${1} minWidth=${0} overflow="hidden"><Text dimColor wrap="truncate-end">which CA goes into the client configs?</Text></Box>
    </Box>
    ${ca.options.map((opt, i) => html`
      <Box key=${i} width="100%" overflow="hidden">
        <Text bold=${i === ca.cursor} color=${i === ca.cursor ? 'cyan' : undefined} wrap="truncate-end">
          ${i === ca.cursor ? ' › ' : '   '}${i + 1}${'  '}${opt.label}${opt.current ? '  (current)' : ''}
        </Text>
      </Box>`)}
  <//>`;
}

function RevealConfirm({ reveal }) {
  return html`<${Frame} color="yellow">
    <Text bold wrap="truncate-end">About to print ${reveal.count} secret value(s) to this terminal.</Text>
    <Text wrap="truncate-end">${'  '}Fly · ${reveal.fly.name}${'   '}${reveal.fly.keys.join(' ') || '(nothing set)'}</Text>
    <Text wrap="truncate-end">${'  '}Worker · ${reveal.worker.name}${'   '}${reveal.worker.keys.join(' ') || '(nothing set)'}</Text>
    <Text dimColor wrap="truncate-end">${'  '}They will stay in your scrollback.</Text>
  <//>`;
}

function KeysConfirm({ confirm }) {
  return html`<${Frame} color="yellow">
    <Text bold wrap="truncate-end">About to print all ${confirm.groups.length} group keys to this terminal.</Text>
    <Text wrap="truncate-end">${'  '}They will be grouped for: ${confirm.platforms.join(', ')}.</Text>
    <Text dimColor wrap="truncate-end">${'  '}They will stay in your scrollback.</Text>
  <//>`;
}

function SetupSecrets({ offer }) {
  return html`<${Frame} color="yellow">
    <Text wrap="truncate-end">also generate ${offer.keys.join(' + ')} for the server? (y/N)</Text>
  <//>`;
}

const LEVEL_COLOR = { error: 'red', warn: 'yellow' };

function Status({ warnings, messages, viewport }) {
  const limit = viewport.rows < 20 ? 1 : viewport.rows < 24 ? 2 : 4;
  const entries = [
    ...warnings.map((text) => ({ text: `warning: ${text}`, level: 'error' })),
    ...messages
  ].slice(-limit);
  if (!entries.length) return null;
  return html`
    <Box flexDirection="column" width="100%" overflow="hidden" flexShrink=${0}>
      ${entries.map((m, i) => html`
        <Text key=${i} color=${LEVEL_COLOR[m.level]} dimColor=${m.level === 'dim'} wrap="truncate-end">
          ${' '}${m.text}
        </Text>`)}
    </Box>`;
}

function Legend({ legend, viewport }) {
  // Header, wrapped tabs, border, margin and footer consume eight rows at the
  // minimum viewport. Keep the slice conservative so Yoga never has to
  // shrink (and selectively hide) an entry in the middle of the list.
  const capacity = Math.max(1, viewport.rows - 8);
  const selected = Math.max(0, legend.findIndex((entry) => entry.selected));
  const entries = windowAround(legend, selected, capacity);
  return html`<${Frame} color="gray">
    ${entries.map((entry) => html`
      <Box key=${entry.keys} width="100%" overflow="hidden">
        <Box width=${18} flexShrink=${0} overflow="hidden">
          <Text bold=${entry.selected} color=${entry.selected ? 'cyan' : undefined} wrap="truncate-end">
            ${entry.selected ? '› ' : '  '}${entry.keys}
          </Text>
        </Box>
        <Box flexGrow=${1} minWidth=${0} overflow="hidden">
          <Text dimColor wrap="truncate-end">${entry.what}</Text>
        </Box>
      </Box>`)}
  <//>`;
}

function PrimaryBody({ vs, viewport, compact }) {
  if (vs.legend) return html`<${Legend} legend=${vs.legend} viewport=${viewport} />`;
  if (vs.userManager) return html`<${UserManager} manager=${vs.userManager} viewport=${viewport} />`;
  if (vs.editor) return html`<${Editor} editor=${vs.editor} viewport=${viewport} />`;
  if (vs.caSelect) return html`<${CaSelect} ca=${vs.caSelect} />`;
  if (vs.reveal) return html`<${RevealConfirm} reveal=${vs.reveal} />`;
  if (vs.keysConfirm) return html`<${KeysConfirm} confirm=${vs.keysConfirm} />`;
  if (vs.setupSecrets) return html`<${SetupSecrets} offer=${vs.setupSecrets} />`;
  if (vs.nuke) return html`<${Nuke} nuke=${vs.nuke} compact=${compact} />`;
  return vs.activeGroup
    ? html`<${Group} group=${vs.activeGroup} viewport=${viewport} compact=${compact} />`
    : null;
}

function ResizeNotice({ viewport }) {
  return html`
    <Box flexDirection="column" width=${viewport.columns} height=${viewport.rows} overflow="hidden">
      <Text color="yellow" wrap="truncate-end">resize terminal — need ${MIN_COLUMNS}×${MIN_ROWS}</Text>
      <Text dimColor wrap="truncate-end">current ${viewport.columns}×${viewport.rows} · q quit</Text>
    </Box>`;
}

export function Ui({ vs, viewport = { columns: 80, rows: 24 } }) {
  if (terminalTooSmall(viewport)) return html`<${ResizeNotice} viewport=${viewport} />`;

  const compact = viewport.columns < 72;
  const modal = Boolean(vs.legend || vs.userManager || vs.editor || vs.caSelect || vs.reveal || vs.keysConfirm || vs.setupSecrets ||
    vs.nuke?.confirm || vs.nuke?.running || vs.nuke?.done);

  return html`
    <Box flexDirection="column" width=${viewport.columns} height=${viewport.rows}
         overflow="hidden" paddingX=${1}>
      <${Header} header=${vs.header} probe=${vs.probe} />
      <${TabBar} tabs=${vs.tabs} compact=${compact} />
      <Box flexDirection="column" width="100%" flexGrow=${1} minHeight=${0} overflow="hidden">
        <${PrimaryBody} vs=${vs} viewport=${viewport} compact=${compact} />
        ${!modal && vs.setupAvailable && !vs.nuke ? html`<${SetupBanner} />` : null}
      </Box>
      ${!vs.legend ? html`<${Status} warnings=${vs.warnings} messages=${vs.messages} viewport=${viewport} />` : null}
      <Box width="100%" overflow="hidden" flexShrink=${0} marginTop=${1}>
        <Text dimColor wrap="truncate-end">${vs.helpBar}</Text>
      </Box>
    </Box>`;
}
