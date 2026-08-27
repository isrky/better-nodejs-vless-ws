// Presentational only. Every component renders visibleState() and nothing
// else — the reducer's selector is the sole bridge from the store to the
// screen, which is what keeps the no-secret-in-any-frame property in one
// place instead of in every component.
import { html } from './h.mjs';

const pad = (s, n) => String(s).padEnd(n);

function Header({ header, probe }) {
  return html`
    <Box>
      <Text bold>credentials  </Text>
      <Text dimColor wrap="truncate-start">${header.path}  v${header.version}</Text>
      ${header.problems ? html`<Text color="red">   ${header.problems} problem(s)</Text>` : null}
      ${probe === 'pending' ? html`<Text color="yellow">   probing…</Text>` : null}
    </Box>`;
}

function FieldRow({ row }) {
  // Fixed-width columns: a value longer than its column is truncated rather
  // than allowed to push `ok`/targets out of alignment (padEnd only pads, it
  // never trims). The full value is always visible by opening the field.
  return html`
    <Box>
      <Box width=${29} flexShrink=${0}>
        <Text bold=${row.selected} color=${row.selected ? 'cyan' : undefined} wrap="truncate-end">
          ${row.selected ? ' › ' : '   '}${row.key}
        </Text>
      </Box>
      <Box width=${26} flexShrink=${0} marginRight=${2}>
        <Text wrap="truncate-end">${row.display}</Text>
      </Box>
      ${row.error
        ? html`<Text color="red" wrap="truncate-end">${row.status}</Text>`
        : html`<Text dimColor wrap="truncate-end">${pad(row.status, 4)}${row.targets}</Text>`}
    </Box>`;
}

function Group({ group }) {
  return html`
    <Box flexDirection="column" marginTop=${1}>
      <Text dimColor>  ${group.label}</Text>
      ${group.rows.map((row) => html`<${FieldRow} key=${row.key} row=${row} />`)}
    </Box>`;
}

function SetupBanner() {
  return html`
    <Box marginTop=${1}>
      <Text color="yellow">S</Text>
      <Text>${'  '}quick setup — generate the missing values, then walk the required hosts</Text>
    </Box>`;
}

function Editor({ editor }) {
  return html`
    <Box flexDirection="column" borderStyle="round"
         borderColor=${editor.error ? 'red' : 'cyan'} paddingX=${1} marginTop=${1}>
      <Box>
        <Text bold>${editor.key}</Text>
        <Text dimColor>${'   '}${editor.help}</Text>
      </Box>
      <Text dimColor>current: ${editor.current}</Text>
      <Box>
        <Text color="cyan">${'> '}</Text>
        ${editor.empty
          ? html`<Text dimColor>${editor.setup
              ? 'type a value — enter skips this one, esc stops the setup'
              : 'type a value — enter keeps the current, esc cancels'}</Text>`
          : html`<Text>${editor.display}</Text>`}
        <Text color="cyan">▌</Text>
      </Box>
      ${editor.error ? html`<Text color="red">${editor.error}</Text>` : null}
    </Box>`;
}

function CaSelect({ ca }) {
  return html`
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX=${1} marginTop=${1}>
      <Box>
        <Text bold>INTERCEPT_CA_FILE</Text>
        <Text dimColor>${'   '}which CA goes into the client configs?</Text>
      </Box>
      ${ca.options.map((opt, i) => html`
        <Box key=${i}>
          <Text bold=${i === ca.cursor} color=${i === ca.cursor ? 'cyan' : undefined}>
            ${i === ca.cursor ? ' › ' : '   '}${i + 1}${'  '}${opt.label}
          </Text>
          ${opt.current ? html`<Text dimColor>${'   '}(current)</Text>` : null}
        </Box>`)}
    </Box>`;
}

function RevealConfirm({ reveal }) {
  return html`
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX=${1} marginTop=${1}>
      <Text bold>About to print ${reveal.count} secret value(s) to this terminal.</Text>
      <Text>${'  '}Fly · ${reveal.fly.name}${'   '}${reveal.fly.keys.join(' ') || '(nothing set)'}</Text>
      <Text>${'  '}Worker · ${reveal.worker.name}${'   '}${reveal.worker.keys.join(' ') || '(nothing set)'}</Text>
      <Text dimColor>${'  '}They will stay in your scrollback.</Text>
    </Box>`;
}

function SetupSecrets({ offer }) {
  return html`
    <Box borderStyle="round" borderColor="yellow" paddingX=${1} marginTop=${1}>
      <Text>also generate ${offer.keys.join(' + ')} for the server?${' '}</Text>
      <Text dimColor>(y/N)</Text>
    </Box>`;
}

const LEVEL_COLOR = { error: 'red', warn: 'yellow' };

function Messages({ messages }) {
  if (!messages.length) return null;
  return html`
    <Box flexDirection="column" marginTop=${1}>
      ${messages.map((m, i) => html`
        <Text key=${i} color=${LEVEL_COLOR[m.level]} dimColor=${m.level === 'dim'}>
          ${' '}${m.text}
        </Text>`)}
    </Box>`;
}

function Legend({ legend }) {
  return html`
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX=${1} marginTop=${1}>
      ${legend.map(([keys, what]) => html`
        <Box key=${keys}>
          <Text bold>${pad(keys, 12)}</Text>
          <Text dimColor>${what}</Text>
        </Box>`)}
    </Box>`;
}

export function Ui({ vs }) {
  return html`
    <Box flexDirection="column" paddingX=${1}>
      <${Header} header=${vs.header} probe=${vs.probe} />
      ${vs.groups.map((g) => html`<${Group} key=${g.label} group=${g} />`)}
      ${vs.warnings.map((w, i) => html`<Text key=${i} color="red">warning: ${w}</Text>`)}
      ${vs.setupAvailable && !vs.editor && !vs.caSelect && !vs.reveal && !vs.setupSecrets
        ? html`<${SetupBanner} />` : null}
      ${vs.editor ? html`<${Editor} editor=${vs.editor} />` : null}
      ${vs.caSelect ? html`<${CaSelect} ca=${vs.caSelect} />` : null}
      ${vs.reveal ? html`<${RevealConfirm} reveal=${vs.reveal} />` : null}
      ${vs.setupSecrets ? html`<${SetupSecrets} offer=${vs.setupSecrets} />` : null}
      <${Messages} messages=${vs.messages} />
      ${vs.legend ? html`<${Legend} legend=${vs.legend} />` : null}
      <Box marginTop=${1}>
        <Text dimColor>${vs.helpBar}</Text>
      </Box>
    </Box>`;
}
