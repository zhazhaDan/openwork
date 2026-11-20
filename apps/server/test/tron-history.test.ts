import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClientV2 } from '../src/tron-compat/client.js';

test('a 300-message desktop page spans native pages and retains its continuation cursor', async () => {
  const messages = Array.from({ length: 350 }, (_, index) => ({ id: `msg_${String(index).padStart(5, '0')}`, type: 'user', time: { created: index }, text: `message ${index}` })).toReversed();
  const limits: number[] = [];
  const client = createClientV2('http://fixture', '/fixture', {}, async input => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const offset = Number(url.searchParams.get('cursor') ?? 0);
    const limit = Number(url.searchParams.get('limit') ?? 200); limits.push(limit);
    const data = messages.slice(offset, offset + limit);
    return Response.json({ data, cursor: { next: data.length ? String(offset + data.length) : null } });
  });
  const first = await client.session.messages({ sessionID: 'ses_fixture', limit: 300 });
  assert.equal(first.response.status, 200); assert.ok(Array.isArray(first.data));
  assert.equal(first.data.length, 300);
  assert.deepEqual(limits, [200, 100]);
  const pagination = first.pagination;
  assert.ok(pagination && typeof pagination === 'object' && 'nextCursor' in pagination);
  assert.equal(pagination.nextCursor, '300');
  const next = await client.session.messages({ sessionID: 'ses_fixture', limit: 300, before: pagination.nextCursor });
  assert.ok(Array.isArray(next.data)); assert.equal(next.data.length, 50);
  const combined = [...next.data, ...first.data].map(message => {
    assert.ok(message && typeof message === 'object' && 'info' in message);
    const info = message.info;
    assert.ok(info && typeof info === 'object' && 'id' in info); return info.id;
  });
  assert.equal(new Set(combined).size, 350);
  assert.equal(combined[0], 'msg_00000'); assert.equal(combined.at(-1), 'msg_00349');
});
