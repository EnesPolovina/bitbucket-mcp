import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildPrQuery, quote } from '../dist/query.js';

test('a quote in a filter cannot break out of the BBQL string', () => {
  assert.equal(quote('a"b'), 'a\\"b');
  assert.equal(quote('a\\b'), 'a\\\\b');
  const q = buildPrQuery({ state: 'OPEN', author: 'a" OR state = "MERGED' });
  assert.ok(!/[^\\]"\s+OR/.test(q), `unescaped quote survived: ${q}`);
});

test('only the filters that were supplied appear in the query', () => {
  assert.equal(buildPrQuery({ state: 'OPEN' }), 'state = "OPEN"');
  const q = buildPrQuery({ state: 'MERGED', destination_branch: 'main', source_branch: 'CMS' });
  assert.equal(
    q,
    'state = "MERGED" AND destination.branch.name = "main" AND source.branch.name ~ "CMS"'
  );
  assert.ok(!q.includes('author'));
});

// Drive the real server over stdio. No network: every assertion here is about
// what the server exposes, not about Bitbucket.
function talk(env, requests) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['dist/index.js'], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.on('error', reject);
    child.on('close', () =>
      resolve(
        out
          .split('\n')
          .filter((l) => l.trim())
          .map((l) => JSON.parse(l))
      )
    );
    for (const r of requests) child.stdin.write(JSON.stringify(r) + '\n');
    setTimeout(() => child.kill(), 2500);
  });
}

const CREDS = { ATLASSIAN_EMAIL: 'x@y.z', BITBUCKET_API_TOKEN: 't' };
const HANDSHAKE = [
  {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' },
    },
  },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
];

test('the Jira tool appears only when Jira is configured', async () => {
  const list = { jsonrpc: '2.0', id: 2, method: 'tools/list' };

  const without = await talk(CREDS, [...HANDSHAKE, list]);
  const a = without.find((m) => m.id === 2).result.tools.map((t) => t.name);
  assert.ok(!a.includes('get_jira_issue'), 'registered without Jira configured');
  assert.ok(a.includes('get_diff'));

  const withJira = await talk(
    { ...CREDS, JIRA_BASE_URL: 'https://example.atlassian.net', JIRA_API_TOKEN: 't' },
    [...HANDSHAKE, list]
  );
  const b = withJira.find((m) => m.id === 2).result.tools.map((t) => t.name);
  assert.ok(b.includes('get_jira_issue'));
});

test('no tool can write to a repository', async () => {
  const res = await talk(CREDS, [...HANDSHAKE, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
  const names = res.find((m) => m.id === 2).result.tools.map((t) => t.name);
  for (const forbidden of ['merge', 'approve', 'decline', 'delete', 'push', 'pipeline']) {
    assert.ok(
      !names.some((n) => n.includes(forbidden)),
      `a tool matching "${forbidden}" exists: ${names.join(', ')}`
    );
  }
});

test('the review prompt uses the checklist file, and survives a bad path', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bbmcp-'));
  const file = join(dir, 'checklist.md');
  writeFileSync(file, 'ONLY-ITEM: does it hold under retry?');

  const get = {
    jsonrpc: '2.0',
    id: 2,
    method: 'prompts/get',
    params: { name: 'review_pull_request', arguments: { pull_request_id: '1' } },
  };

  const used = await talk({ ...CREDS, REVIEW_CHECKLIST_PATH: file }, [...HANDSHAKE, get]);
  const text = used.find((m) => m.id === 2).result.messages[0].content.text;
  assert.match(text, /ONLY-ITEM/);
  assert.ok(!text.includes('Edge cases'), 'default checklist leaked in alongside the file');

  const broken = await talk({ ...CREDS, REVIEW_CHECKLIST_PATH: '/nope/missing.md' }, [
    ...HANDSHAKE,
    get,
  ]);
  const fallback = broken.find((m) => m.id === 2).result.messages[0].content.text;
  assert.match(fallback, /Edge cases/, 'a missing checklist should fall back, not break');
});
