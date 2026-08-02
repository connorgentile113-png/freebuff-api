#!/usr/bin/env node

import { runSetup } from '../src/setup.js';

try {
  await runSetup();
} catch (error) {
  console.error(`Freebuff API setup failed: ${error.message}`);
  process.exitCode = 1;
}
