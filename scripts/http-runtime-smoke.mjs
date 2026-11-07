#!/usr/bin/env node
// Real Docker isolation with production server/runtime modules and disposable
// loopback fixtures. No live API, production data or production secret is used.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let serverImage = 'owngate/server:http-runtime-smoke';
let runtimeImage = 'owngate/http-runtime:smoke';
let build = false;
for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--build') build = true;
  else if (arg === '--server-image' && process.argv[i + 1]) serverImage = process.argv[++i];
  else if (arg === '--runtime-image' && process.argv[i + 1]) runtimeImage = process.argv[++i];
  else if (arg === '--help') {
    console.log('Usage: node scripts/http-runtime-smoke.mjs [--build] [--server-image IMAGE] [--runtime-image IMAGE]');
    process.exit(0);
  } else throw new Error(`Unknown argument: ${arg}`);
}
function docker(args, options = {}) {
  return execFileSync('docker', args, { cwd: root, encoding: 'utf8', timeout: 30_000, stdio: ['pipe', 'pipe', 'pipe'], ...options });
}
function inside(container, source, user) {
  return docker(['exec', ...(user ? ['--user', user] : []), '--interactive', container, 'node', '--input-type=module'], { input: source });
}
if (build) {
  docker(['build', '--file', 'packages/runtime-http/Dockerfile', '--tag', runtimeImage, '.'], { stdio: 'inherit', timeout: 15 * 60_000 });
  docker(['build', '--file', 'apps/server/Dockerfile', '--tag', serverImage, '.'], { stdio: 'inherit', timeout: 15 * 60_000 });
}

const id = randomBytes(8).toString('hex');
const runtime = `owngate-http-smoke-runtime-${id}`;
const server = `owngate-http-smoke-server-${id}`;
const upstream = `owngate-http-smoke-upstream-${id}`;
const internal = `owngate-http-smoke-internal-${id}`;
const external = `owngate-http-smoke-fixtures-${id}`;
const fixtures = mkdtempSync(join(tmpdir(), 'owngate-http-runtime-smoke-'));
const controlFile = join(fixtures, 'http_runtime_secret');
const credentialFile = join(fixtures, 'upstream_credential');
const unsafeFile = join(fixtures, 'unsafe_runtime_secret');
writeFileSync(controlFile, randomBytes(32).toString('hex'), { mode: 0o400 });
writeFileSync(credentialFile, `fixture-upstream-${randomBytes(24).toString('hex')}`, { mode: 0o400 });
writeFileSync(unsafeFile, randomBytes(32).toString('hex'), { mode: 0o444 });
const networks = [], containers = [];
const runtimeCaps = ['--cap-drop', 'ALL', '--cap-add', 'SETUID', '--cap-add', 'SETGID', '--cap-add', 'DAC_OVERRIDE', '--security-opt', 'no-new-privileges:true'];

async function healthy(container, url) {
  const deadline = Date.now() + 20_000;
  do {
    try { inside(container, `const r=await fetch(${JSON.stringify(url)},{signal:AbortSignal.timeout(1000)});if(!r.ok)process.exit(1);`); return; }
    catch {
      if (docker(['inspect', '--format', '{{.State.Running}}', container]).trim() !== 'true') throw new Error(`${container} exited before health check`);
      await delay(150);
    }
  } while (Date.now() < deadline);
  throw new Error(`${container} did not become healthy`);
}

const upstreamSource = `
  import {createServer} from 'node:http';
  import {readFileSync} from 'node:fs';
  const credential=readFileSync('/run/secrets/upstream_credential','utf8').trim();
  let hold=false,dataRequests=0,privateRequests=0,moreRecords=false;const waiting=[],recordPages=[];
  const finish=(response)=>{response.setHeader('content-type','application/json');response.end(JSON.stringify({value:42,echoed_auth:credential}));};
  createServer((request,response)=>{
    if(request.url==='/health'){response.end('ok');return;}
    if(request.url==='/control/hold'){hold=true;response.end('ok');return;}
    if(request.url==='/control/release'){hold=false;for(const response of waiting.splice(0))finish(response);response.end('ok');return;}
    if(request.url==='/control/records-complete'){moreRecords=false;recordPages.length=0;response.end('ok');return;}
    if(request.url==='/control/records-more'){moreRecords=true;recordPages.length=0;response.end('ok');return;}
    if(request.url==='/stats'){response.setHeader('content-type','application/json');response.end(JSON.stringify({dataRequests,privateRequests,recordPages}));return;}
    if(request.url==='/private')privateRequests++;
    if(request.headers.authorization!=='Bearer '+credential){response.writeHead(401);response.end();return;}
    const pageUrl=new URL(request.url,'http://upstream:8080');
    if(pageUrl.pathname==='/api/records'&&request.method==='GET'){
      const page=Number(pageUrl.searchParams.get('page'));recordPages.push(page);
      response.setHeader('content-type','application/json');response.end(JSON.stringify({items:[{id:'fixture-page-'+page,title:'Page '+page}],has_more:moreRecords||page<3}));return;
    }
    if(request.url!=='/data'){response.writeHead(404);response.end();return;}
    dataRequests++;if(hold)waiting.push(response);else finish(response);
  }).listen(8080,'0.0.0.0');
`;
const serverSource = `
  import assert from 'node:assert/strict';
  import {createRequire} from 'node:module';
  import {readFileSync} from 'node:fs';
  import {setTimeout as delay} from 'node:timers/promises';
  import {IsolatedHttpRuntime} from './apps/server/dist/http-runtime.js';
  import {signRuntime} from './packages/runtime-http/dist/index.js';
  const Fastify=createRequire(new URL('./apps/server/package.json',import.meta.url))('fastify');
  const secret=readFileSync('/run/secrets/http_runtime_secret','utf8').trim();
  const credential=readFileSync('/run/secrets/upstream_credential','utf8').trim();
  const connection={id:'http-smoke',connector_id:'fixture',label:'Fixture',config:{},capability_states:{'fixture.read':{status:'supported'}},created_at:'2026-11-03T00:00:00Z',updated_at:'2026-11-03T00:00:00Z'};
  const capability={id:'fixture.read',title:'Read',description:'Local fixture',kind:'query',effect:'read',approval:'never',input:{type:'object'},output:{type:'object',properties:{value:{type:'number'},echoed_auth:{type:'string'}}},cache:null,long_running:false,cancel:'none',idempotency:'native',verify:null,transport:'http',support:{status:'supported'}};
  const manifest={http:{base:'http://upstream:8080',headers:{Authorization:'Bearer {{secret.token}}'},timeout_ms:10000},capabilityDefs:{'fixture.read':{request:{method:'GET',path:'/data'},output:{value:{from:'value'},echoed_auth:{from:'echoed_auth'}}}},compiled:{}};
  const adapterConnection={...connection,id:'adapter-smoke',connector_id:'paged-json-example',label:'Trusted paginated fixture',capability_states:{'records.list':{status:'supported'}}};
  const adapterCapability={...capability,id:'records.list',output:{type:'object',properties:{items:{type:'array','x-sensitivity':'content',items:{type:'object',required:['id','title'],properties:{id:{type:'string'},title:{type:['string','null']}}}},truncated:{type:'boolean'}}}};
  const adapterRequest={method:'ADAPTER',path:'/api/records?page=1',readonly_paths:['/api/records?page=2','/api/records?page=3']};
  const adapterManifest={http:manifest.http,capabilityDefs:{'records.list':{request:adapterRequest}},compiled:{}};
  const registry={getManifest:(id)=>id==='paged-json-example'?adapterManifest:manifest,getCredentials:()=>({token:credential})};
  const sanitize=(value)=>JSON.parse(JSON.stringify(value).replaceAll(credential,'[REDACTED]'));
  const app=Fastify({logger:false});let latestHandle='';
  app.addHook('onRequest',async(request)=>{if(request.url.startsWith('/internal/http-runtime/'))latestHandle=request.url;});
  const runtime=new IsolatedHttpRuntime({registry,getConnection:(id)=>id===adapterConnection.id?adapterConnection:connection,runtimeUrl:'http://runtime:5000',secret,brokerOrigin:'http://server:3000',sanitize});
  await runtime.init(app);
  app.get('/health',async()=>({ok:true}));
  app.post('/smoke/query',async()=>runtime.dispatch(connection,capability,{}));
  app.post('/smoke/auth',async()=>{
    const url='http://runtime:5000/v1/execute',body='{}';
    const send=(headers,value=body)=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...headers},body:value});
    const unsigned=(await send({})).status;
    const headers=signRuntime(secret,'POST','/v1/execute',body);
    const signedMalformed=(await send(headers)).status;
    const replay=(await send(headers)).status;
    const tampered=(await send(signRuntime(secret,'POST','/v1/execute',body),'{"tampered":true}')).status;
    const wrongMethod=(await send(signRuntime(secret,'GET','/v1/execute',body))).status;
    const wrongPath=(await send(signRuntime(secret,'POST','/v1/other',body))).status;
    const validJob={connection,capability,input:{},definition:{http:{base:'http://upstream:8080',headers:{}},request:{method:'GET',path:'/data'}},timeout_ms:1000,broker_url:'http://server:3000/internal/http-runtime/'+'0'.repeat(64)};
    const invalidCallbackBody=JSON.stringify({...validJob,broker_url:'http://outside.invalid/internal/http-runtime/'+'0'.repeat(64)});
    const invalidCallback=(await send(signRuntime(secret,'POST','/v1/execute',invalidCallbackBody),invalidCallbackBody)).status;
    const secretHeadersBody=JSON.stringify({...validJob,definition:{...validJob.definition,http:{...validJob.definition.http,headers:{Authorization:'must-not-reach-worker'}}}});
    const secretHeaders=(await send(signRuntime(secret,'POST','/v1/execute',secretHeadersBody),secretHeadersBody)).status;
    return {unsigned,signedMalformed,replay,tampered,wrongMethod,wrongPath,invalidCallback,secretHeaders};
  });
  app.post('/smoke/scope',async()=>{
    await fetch('http://upstream:8080/control/hold');
    const oldHandle=latestHandle;const running=runtime.dispatch(connection,capability,{});
    try{
      const deadline=Date.now()+3000;while(latestHandle===oldHandle){if(Date.now()>deadline)throw new Error('Broker was not called');await delay(10);}
      const activeHandle=latestHandle;
      const attempt=async(url,method='GET',handle=activeHandle)=>(await app.inject({method:'POST',url:handle,payload:{url,method}})).statusCode;
      const sameOriginOtherPath=await attempt('http://upstream:8080/private');
      const otherMethod=await attempt('http://upstream:8080/data','HEAD');
      const otherOrigin=await attempt('http://1.1.1.1/data');
      const unknownHandle=await attempt('http://upstream:8080/data','GET','/internal/http-runtime/'+'0'.repeat(64));
      connection.paused=true;const paused=await attempt('http://upstream:8080/data');connection.paused=false;
      const revision=connection.updated_at;connection.updated_at='2099-01-01T00:00:00Z';const changedRevision=await attempt('http://upstream:8080/data');connection.updated_at=revision;
      await fetch('http://upstream:8080/control/release');
      const result=await running;
      const completedHandle=await attempt('http://upstream:8080/data');
      const stats=await (await fetch('http://upstream:8080/stats')).json();
      return {sameOriginOtherPath,otherMethod,otherOrigin,unknownHandle,paused,changedRevision,completedHandle,outcome:result.outcome,privateRequests:stats.privateRequests};
    }finally{connection.paused=false;await fetch('http://upstream:8080/control/release');await running;}
  });
  app.post('/smoke/assert',async()=>{const result=await runtime.dispatch(connection,capability,{});assert.equal(result.outcome,'success');assert.equal(result.data.value,42);assert.equal(result.data.echoed_auth,'[REDACTED]');assert(!JSON.stringify(result).includes(credential));return{ok:true};});
  app.post('/smoke/adapter',async()=>{
    const expectedItems=[1,2,3].map(page=>({id:'fixture-page-'+page,title:'Page '+page}));
    await fetch('http://upstream:8080/control/records-complete');
    const complete=await runtime.dispatch(adapterConnection,adapterCapability,{});
    assert.equal(complete.outcome,'success');assert.deepEqual(complete.data,{items:expectedItems,truncated:false});
    assert.equal(complete.fields.items.untrusted,true);assert.equal(complete.fields.items.sensitivity,'content');
    assert.deepEqual((await (await fetch('http://upstream:8080/stats')).json()).recordPages,[1,2,3]);
    await fetch('http://upstream:8080/control/records-more');
    const bounded=await runtime.dispatch(adapterConnection,adapterCapability,{});
    assert.equal(bounded.outcome,'success');assert.deepEqual(bounded.data,{items:expectedItems,truncated:true});
    assert.equal(bounded.warnings.length,1);assert.match(bounded.warnings[0],/三页/);
    assert.deepEqual((await (await fetch('http://upstream:8080/stats')).json()).recordPages,[1,2,3]);
    await fetch('http://upstream:8080/control/records-complete');
    adapterRequest.readonly_paths=['/api/records?page=2'];
    try{
      const restricted=await runtime.dispatch(adapterConnection,adapterCapability,{});
      assert.equal(restricted.outcome,'error');assert.equal(restricted.error.code,'CAPABILITY_DISABLED');
      assert.deepEqual((await (await fetch('http://upstream:8080/stats')).json()).recordPages,[1,2]);
    }finally{adapterRequest.readonly_paths=['/api/records?page=2','/api/records?page=3'];}
    return{ok:true};
  });
  await app.listen({port:3000,host:'0.0.0.0'});
`;

try {
  docker(['network', 'create', '--internal', internal]); networks.push(internal);
  docker(['network', 'create', external]); networks.push(external);
  docker(['run', '--detach', '--name', upstream, '--network', external, '--network-alias', 'upstream', '--read-only', '--user', '1000:1000',
    '--mount', `type=bind,source=${credentialFile},target=/run/secrets/upstream_credential,readonly`, '--entrypoint', 'node', runtimeImage, '--input-type=module', '--eval', upstreamSource]);
  containers.push(upstream);
  await healthy(upstream, 'http://127.0.0.1:8080/health');
  docker(['run', '--detach', '--name', runtime, '--network', internal, '--network-alias', 'runtime', '--read-only', ...runtimeCaps,
    '--mount', `type=bind,source=${controlFile},target=/run/secrets/http_runtime_secret,readonly`,
    '--env', 'HTTP_RUNTIME_SECRET_FILE=/run/secrets/http_runtime_secret', '--env', 'HTTP_BROKER_ORIGIN=http://server:3000', runtimeImage]);
  containers.push(runtime);
  await healthy(runtime, 'http://127.0.0.1:5000/health');
  docker(['create', '--name', server, '--network', internal, '--network-alias', 'server', '--read-only', '--user', '1000:1000', '--security-opt', 'no-new-privileges:true', '--cap-drop', 'ALL',
    '--mount', `type=bind,source=${controlFile},target=/run/secrets/http_runtime_secret,readonly`,
    '--mount', `type=bind,source=${credentialFile},target=/run/secrets/upstream_credential,readonly`, '--entrypoint', 'node', serverImage, '--input-type=module', '--eval', serverSource]);
  containers.push(server);
  docker(['network', 'connect', external, server]);
  docker(['start', server]);
  await healthy(server, 'http://127.0.0.1:3000/health');
  inside(server, `
    import assert from 'node:assert/strict';
    const call=async(path)=>{const r=await fetch('http://127.0.0.1:3000'+path,{method:'POST'});assert(r.ok);return r.json();};
    const auth=await call('/smoke/auth');
    assert.deepEqual(auth,{unsigned:401,signedMalformed:400,replay:401,tampered:401,wrongMethod:401,wrongPath:401,invalidCallback:400,secretHeaders:400});
    assert.deepEqual(await call('/smoke/assert'),{ok:true});
    assert.deepEqual(await call('/smoke/adapter'),{ok:true});
    const scope=await call('/smoke/scope');
    assert.deepEqual(scope,{sameOriginOtherPath:403,otherMethod:403,otherOrigin:403,unknownHandle:403,paused:403,changedRevision:403,completedHandle:403,outcome:'success',privateRequests:0});
  `);
  // Inspect the actual production fork, then run permission/network probes as
  // that same unprivileged uid. The fork's environment comes from /proc.
  inside(runtime, String.raw`
    import assert from 'node:assert/strict';import {readFileSync,readdirSync} from 'node:fs';
    assert.equal(process.getuid(),65534);
    const pids=readdirSync('/proc').filter(pid=>{try{return pid!==String(process.pid)&&readFileSync('/proc/'+pid+'/cmdline','utf8').split('\0').some(arg=>arg.endsWith('/worker.js'));}catch{return false;}});
    assert.equal(pids.length,2,'each connector must have its own production worker');
    for(const pid of pids){
      const status=readFileSync('/proc/'+pid+'/status','utf8');
      assert.match(status,/Uid:\s+65534\s+65534\s+65534\s+65534/);assert.match(status,/Gid:\s+65534\s+65534\s+65534\s+65534/);assert.match(status,/CapEff:\s+0000000000000000/);assert.match(status,/NoNewPrivs:\s+1/);assert.match(status,/Groups:[ \t]*\n/);
      const env=readFileSync('/proc/'+pid+'/environ','utf8');assert(!/HTTP_RUNTIME|MASTER_KEY|BROWSER_RPC|upstream_credential/.test(env),'worker must not inherit parent secret config');
    }
    for(const path of ['/run/secrets/http_runtime_secret','/proc/1/environ']){let denied=false;try{readFileSync(path);}catch(error){denied=['EACCES','EPERM'].includes(error.code);}assert(denied,'worker uid read forbidden file: '+path);}
    for(const path of ['/run/secrets/upstream_credential','/run/secrets/master_key','/data/owngate.db']){let absent=false;try{readFileSync(path);}catch(error){absent=error.code==='ENOENT';}assert(absent,'server-only file mounted in runtime: '+path);}
    for(const url of ['http://1.1.1.1','http://upstream:8080/private']){let blocked=false;try{await fetch(url,{signal:AbortSignal.timeout(1000)});}catch{blocked=true;}assert(blocked,'runtime has direct egress: '+url);}
    const unauth=await fetch('http://127.0.0.1:5000/v1/execute',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(unauth.status,401);
  `, '65534:65534');
  const rootCheck = inside(runtime, "if(process.getuid()!==0)throw new Error('Runtime control process must run as root');console.log('ok');");
  assert.equal(rootCheck.trim(), 'ok');

  for (const [name, user, secret] of [['unsafe-secret', undefined, unsafeFile], ['unsafe-user', '1000:1000', controlFile]]) {
    let refused = false;
    const invalidContainer = `${runtime}-${name}`;
    containers.push(invalidContainer);
    try {
      docker(['run', '--rm', '--name', invalidContainer, '--network', 'none', '--read-only', ...(user ? ['--user', user] : []), ...runtimeCaps,
        '--mount', `type=bind,source=${secret},target=/run/secrets/http_runtime_secret,readonly`, '--env', 'HTTP_RUNTIME_SECRET_FILE=/run/secrets/http_runtime_secret', runtimeImage], { timeout: 5000 });
    } catch (error) { refused = error.status === 1; }
    assert(refused, `${name} must refuse startup instead of weakening isolation`);
  }
  docker(['stop', '--time', '2', runtime]);
  inside(server, `
    import assert from 'node:assert/strict';const response=await fetch('http://127.0.0.1:3000/smoke/query',{method:'POST'});const result=await response.json();
    assert.equal(result.outcome,'error');assert.equal(result.error.code,'CONNECTOR_CRASHED');
  `);
  console.log('HTTP runtime Docker smoke passed: production signed RPC and replay protection, exact opaque broker scope, credential sanitization, compiled TypeScript adapter with bounded pagination and readonly_paths, separate nobody workers with no capabilities or inherited secrets, private-secret/non-root startup guards, internal network isolation and remote-runtime fail closed.');
} catch (error) {
  console.error(error instanceof Error ? error.stack : String(error));
  for (const container of containers) { try { docker(['logs', '--tail', '35', container], { stdio: 'inherit' }); } catch {} }
  process.exitCode = 1;
} finally {
  for (const container of containers.reverse()) { try { docker(['rm', '--force', container]); } catch {} }
  for (const network of networks.reverse()) { try { docker(['network', 'rm', network]); } catch {} }
  rmSync(fixtures, { recursive: true, force: true });
}
