import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sameOrigin } from '../src/auth';

test('hosted writes accept only the configured public origin through a reverse proxy', () => {
  const verified = 'https://scheduler.execute-api.us-east-1.amazonaws.com';
  const previous = process.env.PUBLIC_ORIGIN;
  process.env.PUBLIC_ORIGIN = verified;
  const request = (origin: string, site = 'same-origin') => new Request('http://10.53.1.81:3000/api/session', {
    method: 'POST', headers: { Host: '10.53.1.81:3000', Origin: origin, 'Sec-Fetch-Site': site, 'X-Forwarded-Host': 'untrusted.invalid' },
  });
  try {
    assert.doesNotThrow(() => sameOrigin(request(verified)));
    assert.throws(() => sameOrigin(request('https://untrusted.invalid')), { status: 403 });
    assert.throws(() => sameOrigin(request(verified.replace('https:', 'http:'))), { status: 403 });
    assert.throws(() => sameOrigin(request(verified, 'cross-site')), { status: 403 });
  } finally {
    if (previous === undefined) delete process.env.PUBLIC_ORIGIN;
    else process.env.PUBLIC_ORIGIN = previous;
  }
});
