#!/usr/bin/env node

import { installService, uninstallService } from '../src/service-manager.js';

const action = process.argv[2];
try {
  if (action === 'install') {
    const location = await installService();
    console.log(`Freebuff API service installed: ${location}`);
  } else if (action === 'uninstall') {
    await uninstallService();
    console.log('Freebuff API service removed.');
  } else {
    throw new Error('Usage: freebuff-api-service <install|uninstall>');
  }
} catch (error) {
  console.error(`Service ${action ?? 'operation'} failed: ${error.message}`);
  process.exitCode = 1;
}
