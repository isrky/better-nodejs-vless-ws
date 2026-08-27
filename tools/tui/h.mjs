// htm bound to React.createElement, with the bare <Box>/<Text> tag names
// resolved to the Ink components — so the components read like JSX without
// adding a build step to a plain-.mjs project.
import { createElement } from 'react';
import { Box, Text } from 'ink';
import htm from 'htm';

const TAGS = { Box, Text };

export const html = htm.bind((type, props, ...children) =>
  createElement(typeof type === 'string' ? (TAGS[type] ?? type) : type, props, ...children));

export { createElement as h };
