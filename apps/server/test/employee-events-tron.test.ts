import assert from 'node:assert/strict';
import { test } from 'node:test';
import { translateTronGlobalEvents } from '../src/tron-compat.js';

for (const outcome of ['succeeded', 'failed', 'interrupted']) {
  test(`employee events preserve ${outcome} without settling a failed task`, async () => {
    const native = [
      { type: 'session.execution.started', location: { directory: '/task' }, data: { sessionID: 'ses_fixture' } },
      { type: `session.execution.${outcome}`, location: { directory: '/task' }, data: {
        sessionID: 'ses_fixture', ...(outcome === 'failed' ? { error: { message: 'Fixture failure' } } : {}),
      } },
    ];
    const response = new Response(native.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
    const translated = await translateTronGlobalEvents(response, new AbortController().signal).text();
    const events = translated.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)));
    assert.ok(events.every(event => event.directory === '/task' && event.payload.properties.sessionID === 'ses_fixture'));
    assert.ok(events.some(event => event.payload.type === 'session.status' && event.payload.properties.status.type === 'busy'));
    assert.equal(events.some(event => event.payload.type === 'session.idle'), outcome === 'succeeded');
    assert.equal(events.some(event => event.payload.type === 'session.error'), outcome !== 'succeeded');
  });
}

test('events without a location resolve their session directory and reuse it', async () => {
  const native = ['started', 'succeeded'].map(outcome => ({
    type: `session.execution.${outcome}`, data: { sessionID: 'ses_fixture' },
  }));
  let reads = 0;
  const response = new Response(native.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''));
  const translated = await translateTronGlobalEvents(response, new AbortController().signal, async id => {
    assert.equal(id, 'ses_fixture'); reads++; return '/task';
  }).text();
  const events = translated.split('\n').filter(line => line.startsWith('data:')).map(line => JSON.parse(line.slice(5)));
  assert.equal(reads, 1);
  assert.ok(events.every(event => event.directory === '/task'));
  assert.ok(events.some(event => event.payload.type === 'session.idle'));
});
