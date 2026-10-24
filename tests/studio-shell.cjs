const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const path = require('node:path');
const server = spawn('python3',['-m','http.server','8878','--bind','127.0.0.1'],{cwd:path.resolve(__dirname,'..'),stdio:'ignore'});
let browser;
(async()=>{
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||'/usr/bin/chromium',headless:true,args:['--no-sandbox']});
  const page=await browser.newPage();let authorized=false;let analyticsAvailable=true;const errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.route('**/api/studio*',async route=>{
    const request=route.request();const url=new URL(request.url());let status=200;let body;
    if(request.method()==='POST'){authorized=true;body={authenticated:true};}
    else if(request.method()==='DELETE'){authorized=false;body={authenticated:false};}
    else if(!authorized){status=401;body={error:'Authentication required'};}
    else if(url.searchParams.get('session')==='1'){body={authenticated:true};}
    else if(!analyticsAvailable){status=503;body={error:'Analytics unavailable'};}
    else body={generated_at:new Date().toISOString(),stream:{online:false,rtmp_server:'rtmp://example.invalid',hls_url:'https://example.invalid/live',stream_key:'synthetic-obs-key'},analytics:{active_viewers:0,peak_viewers:0,unique_sessions:0,watch_minutes:0,playback_health:null,playback_errors:0,timeline:[],recent_sessions:[]}};
    await route.fulfill({status,contentType:'application/json',body:JSON.stringify(body)});
  });
  await page.goto('http://127.0.0.1:8878/studio.html');
  assert(await page.locator('#login').isVisible());
  assert(await page.locator('#workspace-tabs').isHidden());
  assert.equal(await page.locator('#producer-frame').getAttribute('src'),'about:blank');
  await page.locator('#password').fill('synthetic-test-only');
  await page.locator('#login-form button').click();
  await page.waitForFunction(()=>!document.querySelector('#dashboard').hidden);
  assert.equal(await page.locator('#stream-key').getAttribute('data-secret'),'synthetic-obs-key');
  await page.locator('#producer-tab').click();
  const frame=page.frameLocator('#producer-frame');
  await frame.locator('#producer-app').waitFor({state:'visible'});
  assert(await page.locator('#dashboard').isHidden());
  await page.locator('#operations-tab').click();
  assert(await page.locator('#dashboard').isVisible());
  await page.locator('#producer-tab').click();
  await frame.locator('#producer-app').waitFor({state:'visible'});
  await page.locator('#logout').click();
  await page.locator('#login').waitFor({state:'visible'});
  assert.equal(await page.locator('#producer-frame').getAttribute('src'),'about:blank');
  assert.equal(await page.locator('#stream-key').getAttribute('data-secret'),'');
  await page.goto('http://127.0.0.1:8878/producer.html');
  await page.waitForFunction(()=>document.querySelector('#producer-auth-message').textContent.includes('expired'));
  assert(await page.locator('#producer-app').isHidden(),'Direct producer URL cannot expose workspace without session');
  analyticsAvailable=false;
  await page.goto('http://127.0.0.1:8878/studio.html');
  await page.locator('#password').fill('synthetic-test-only');
  await page.locator('#login-form button').click();
  await page.locator('#workspace-tabs').waitFor({state:'visible'});
  await page.locator('#producer-tab').click();
  await page.frameLocator('#producer-frame').locator('#producer-app').waitFor({state:'visible'});
  assert.deepEqual(errors,[]);
  console.log('PASS authenticated Studio shell: login, existing OBS dashboard, lazy producer tab, workspace switching, logout clears frame/secrets, direct URL locked, producer works without analytics.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await browser?.close();server.kill();});
