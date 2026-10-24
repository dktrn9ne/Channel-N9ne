import test from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/studio.js';

test('producer session endpoint preserves authentication and never returns stream secrets', async () => {
  const saved = { ...process.env };
  const originalFetch = globalThis.fetch;
  process.env.STUDIO_ADMIN_PASSWORD = 'synthetic-test-password';
  process.env.STUDIO_SESSION_SECRET = 'synthetic-session-secret-for-local-tests-only';
  process.env.STREAM_PUBLISH_PASSWORD = 'synthetic-stream-secret';
  delete process.env.SUPABASE_URL;
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new Error('Unexpected network request'); };
  const call = async (req) => {
    const res = { headers:{}, statusCode:0, payload:null, setHeader(k,v){this.headers[k]=v;}, status(code){this.statusCode=code;return this;}, json(value){this.payload=value;return this;} };
    await handler({ method:'GET', headers:{}, query:{session:'1'}, ...req }, res);
    return res;
  };
  try {
    assert.equal((await call({})).statusCode,401);
    const bad = await call({method:'POST',body:{action:'login',password:'wrong'}});
    assert.equal(bad.statusCode,401);
    const login = await call({method:'POST',body:{action:'login',password:'synthetic-test-password'}});
    assert.equal(login.statusCode,200);
    assert.match(login.headers['Set-Cookie'],/HttpOnly; Secure; SameSite=Strict/);
    const cookie = login.headers['Set-Cookie'].split(';')[0];
    const status = await call({headers:{cookie}});
    assert.equal(status.statusCode,200);
    assert.deepEqual(status.payload,{authenticated:true});
    assert.equal(status.headers['Cache-Control'],'no-store');
    assert.equal(networkCalls,0,'Session check must not access analytics or MediaMTX');
    assert.equal((await call({headers:{cookie:cookie+'tampered'}})).statusCode,401);
    const dashboard = await call({headers:{cookie},query:{range:'24h'}});
    assert.equal(dashboard.statusCode,503,'Existing dashboard still requires analytics configuration');
    const logout = await call({method:'DELETE',headers:{cookie}});
    assert.equal(logout.statusCode,200);
    assert.match(logout.headers['Set-Cookie'],/Max-Age=0/);
    delete process.env.STUDIO_SESSION_SECRET;
    assert.equal((await call({headers:{cookie}})).statusCode,503);
  } finally { globalThis.fetch=originalFetch; process.env=saved; }
});
