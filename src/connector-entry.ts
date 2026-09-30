#!/usr/bin/env node
import { runConnector } from './connector-cli.js';

const index = process.argv.indexOf('--config');
const config = index >= 0 ? process.argv[index + 1] : undefined;
if (!config) {
  process.stderr.write('Use --config with a connector configuration file.\n');
  process.exitCode = 1;
} else {
  runConnector(config).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'Connector failed'}\n`);
    process.exitCode = 1;
  });
}
