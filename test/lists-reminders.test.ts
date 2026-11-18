import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import './support/no-network.js';
import { createHttpServer } from '../src/http-server.js';
import { summarizeListItems, summarizeLists, summarizeReminders } from '../src/lists-reminders.js';
import { FakeAlexa } from './support/fake-alexa.js';

test('mappers keep only safe fields and drop malformed entries', () => {
  assert.deepEqual(summarizeLists([
    { listId: 'L1', listName: 'Shopping', totalActiveItemsCount: '{"count":3}', customerId: 'secret-customer' },
    { nothing: true }, 'x',
  ]), [{ id: 'L1', name: 'Shopping', activeItems: 3 }]);
  assert.deepEqual(summarizeListItems([
    { itemId: 'i1', itemName: 'Milk', itemStatus: 'COMPLETE', customerId: 'secret-customer' },
    { itemId: 'i2' },
  ]), [{ id: 'i1', text: 'Milk', completed: true }]);
  assert.deepEqual(summarizeReminders({ notifications: [
    { id: 'r1', type: 'Reminder', reminderLabel: 'Call mum', status: 'ON', originalDate: '2026-01-02', originalTime: '09:00:00.000', deviceSerialNumber: 'SER-1' },
    { id: 'r2' },
  ] }), [{ id: 'r1', type: 'Reminder', label: 'Call mum', status: 'ON', when: '2026-01-02T09:00:00.000' }]);
  assert.deepEqual(summarizeLists('nope'), []);
});

async function serve(personalReads: boolean) {
  const adapter = new FakeAlexa({
    lists: [{ listId: 'L1', listName: 'Shopping' }],
    listItems: { L1: [{ itemId: 'i1', itemName: 'Milk' }] },
    reminders: { notifications: [{ id: 'r1', type: 'Timer', status: 'ON' }] },
  });
  const server = createHttpServer({
    adapter,
    sessionHealth: () => 'usable',
    authenticate: async (request) => {
      const token = request.headers.authorization?.replace('Bearer ', '');
      return token ? { token, clientId: 'c', scopes: token === 'noread' ? [] : ['read'], extra: { principal: 'owner' } } : undefined;
    },
    allowedOrigins: [],
    resourceMetadataUrl: 'https://mcp.example/.well-known/oauth-protected-resource',
    ...(personalReads ? { personalReads } : {}),
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const rpc = async (token: string, method: string, params: Record<string, unknown>) => {
    const response = await fetch(url, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
    return await response.json() as { result?: { isError?: boolean; tools?: Array<{ name: string }>; content?: Array<{ text: string }> } };
  };
  return { rpc, stop: () => new Promise<void>((r) => server.close(() => r())) };
}

test('list and reminder tools exist only when enabled and need the read scope', async () => {
  const off = await serve(false);
  try {
    const names = (await off.rpc('owner', 'tools/list', {})).result?.tools?.map((t) => t.name) ?? [];
    assert.ok(!names.includes('list_lists') && !names.includes('list_reminders'));
  } finally { await off.stop(); }

  const on = await serve(true);
  try {
    const names = (await on.rpc('owner', 'tools/list', {})).result?.tools?.map((t) => t.name) ?? [];
    assert.ok(['list_lists', 'get_list_items', 'list_reminders'].every((n) => names.includes(n)));
    const items = await on.rpc('owner', 'tools/call', { name: 'get_list_items', arguments: { listId: 'L1' } });
    assert.deepEqual(JSON.parse(items.result?.content?.[0]?.text ?? '{}'), { items: [{ id: 'i1', text: 'Milk', completed: false }] });
    const reminders = await on.rpc('owner', 'tools/call', { name: 'list_reminders', arguments: {} });
    assert.match(reminders.result?.content?.[0]?.text ?? '', /Timer/);
    assert.equal((await on.rpc('noread', 'tools/call', { name: 'list_lists', arguments: {} })).result?.isError, true);
  } finally { await on.stop(); }
});
