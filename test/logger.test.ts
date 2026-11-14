import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLogger, type LogEvent } from '../src/logger.js';

test('redacts untrusted details, including nested secrets and identifiers', () => {
  const lines: string[] = [];
  const logger = createLogger((line) => lines.push(line));
  const privateValues = [
    'session-cookie-synthetic',
    'refresh-token-synthetic',
    'account-id-synthetic',
    'private-device-name-synthetic',
  ];

  logger.log('session.refreshed', {
    cookie: privateValues[0],
    nested: { token: privateValues[1], accountId: privateValues[2] },
    [privateValues[3]!]: new Error(privateValues.join(' ')),
  });

  assert.deepEqual(JSON.parse(lines[0]!), {
    event: 'session.refreshed',
    details: '[REDACTED]',
  });
  for (const value of privateValues) assert.ok(!lines[0]!.includes(value));
});

test('never emits an unrecognized event or arbitrary error text', () => {
  const lines: string[] = [];
  const logger = createLogger((line) => lines.push(line));
  logger.log('private-event-identifier' as LogEvent, new Error('private-error-token'));
  assert.deepEqual(JSON.parse(lines[0]!), {
    event: 'unrecognized_event',
    details: '[REDACTED]',
  });
  assert.ok(!lines[0]!.includes('private'));
});
