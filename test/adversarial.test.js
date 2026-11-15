const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { once } = require('node:events');
const { crc32, deflateRawSync } = require('node:zlib');
const { createServer } = require('../src/http');
const { defaultLimits } = require('../src/publisher');

function zip(entries) {
  const local = [], central = []; let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name), data = Buffer.from(e.data || '');
    const method = e.method ?? 8, packed = method === 8 ? deflateRawSync(data) : data;
    const crc = e.crc ?? crc32(data), flags = e.flags ?? 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20,4); header.writeUInt16LE(flags,6);
    header.writeUInt16LE(method,8); header.writeUInt32LE(crc,14); header.writeUInt32LE(packed.length,18);
    header.writeUInt32LE(e.size ?? data.length,22); header.writeUInt16LE(name.length,26);
    local.push(header,name,packed);
    const cd = Buffer.alloc(46); cd.writeUInt32LE(0x02014b50); cd.writeUInt16LE(0x0314,4);
    cd.writeUInt16LE(20,6); cd.writeUInt16LE(flags,8); cd.writeUInt16LE(method,10);
    cd.writeUInt32LE(crc,16); cd.writeUInt32LE(packed.length,20); cd.writeUInt32LE(e.size ?? data.length,24);
    cd.writeUInt16LE(name.length,28); cd.writeUInt32LE(e.attr ?? 0,38); cd.writeUInt32LE(offset,42);
    central.push(cd,name); offset += header.length + name.length + packed.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length,8); end.writeUInt16LE(entries.length,10);
  end.writeUInt32LE(cd.length,12); end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,cd,end]);
}
const good = () => zip([{name:'index.html',data:'TEST RELEASE'}]);
const sleep = ms => new Promise(resolve => setTimeout(resolve,ms));

async function setup(t, edit, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'tailnow-audit-'));
  const configPath = path.join(root,'config.json');
  const config = {baseUrl:'https://audit.invalid/',allowedHosts:['audit.invalid','mini'],
    siteOrigins:{victim:'https://victim.example'},serviceLabel:'com.example.audit',sitesDirectory:path.join(root,'sites'),dataDirectory:path.join(root,'private'),apps:[]};
  fs.mkdirSync(config.sitesDirectory);
  fs.mkdirSync(path.join(config.sitesDirectory,'victim'));
  fs.writeFileSync(path.join(config.sitesDirectory,'victim','index.html'),'ORIGINAL');
  fs.writeFileSync(path.join(root,'secret.txt'),'OUTSIDE_SENTINEL');
  if (edit) edit({root,config,configPath});
  const write = () => fs.writeFileSync(configPath,JSON.stringify(config)); write();
  const server = createServer({configPath,...options});
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const port = server.address().port;
  const key = fs.readFileSync(path.join(config.dataDirectory, 'admin-token'), 'utf8').trim();
  config.allowedHosts.push(`127.0.0.1:${port}`); write(); server.catalog.invalidate();
  const request = (url, {method='GET',headers={},body}={}) => new Promise((resolve,reject) => {
    const req = http.request({hostname:'127.0.0.1',port,path:url,method,agent:false,
      headers:{Host:url.startsWith('/victim/')?'victim.example':'audit.invalid',...(method==='POST'?{Authorization:`Bearer ${key}`} : {}),...(body ? {'Content-Length':body.length} : {}),...headers}},res=>{
        const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,body:Buffer.concat(chunks).toString()}));
      });
    req.setTimeout(5000,()=>req.destroy(new Error('Request timed out')));req.on('error',reject);req.end(body);
  });
  const upload = (slug, archive=good(), extraHeaders={}) => request(`/api/publish/${slug}`,{method:'POST',
    headers:{'Content-Type':'multipart/form-data; boundary=AUDIT',...extraHeaders},
    body:Buffer.concat([Buffer.from('--AUDIT\r\nContent-Disposition: form-data; name="file"; filename="x.zip"\r\nContent-Type: application/zip\r\n\r\n'),archive,Buffer.from('\r\n--AUDIT--\r\n')])});
  t.after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections()});fs.rmSync(root,{recursive:true,force:true})});
  return {root,config,configPath,server,request,upload,port,write,key};
}

test('35 archive attacks: traversal, aliases, special files, corruption, and expansion limits', async t=>{
  const a=await setup(t,null,{limits:{...defaultLimits,fileBytes:1024,expandedBytes:2048,entries:20}});
  const paths=['../p.txt','../../secret.txt','/tmp/p.txt','a/../../p.txt','a/../p.txt','a/./p.txt','a//p.txt','a\\..\\p.txt','C:/p.txt','x:y','a/.env','.hidden/index.html','a\u0000b','a\u001fb','a\u007fb'];
  let attempts=0;
  for(const name of paths){const r=await a.upload('victim',zip([{name:'index.html',data:'x'},{name,data:'BAD'}]));assert.equal(r.status,400,JSON.stringify({name,r}));attempts++;}
  const sets=[
    [{name:'INDEX.HTML',data:'x'},{name:'index.html',data:'y'}],
    [{name:'index.html',data:'x'},{name:'café',data:'1'},{name:'cafe\u0301',data:'2'}],
    [{name:'index.html',data:'x'},{name:'x',data:'1'},{name:'x',data:'2'}],
    [{name:'index.html',data:'x'},{name:'a',data:'1'},{name:'a/b',data:'2'}],
    [{name:'index.html',data:'x'},{name:'link',data:'../../secret.txt',attr:0xa1ff0000}],
    [{name:'index.html',data:'x'},{name:'fifo',attr:0x11ff0000}],
    [{name:'index.html',data:'x'},{name:'device',attr:0x21ff0000}],
    [{name:'index.html',data:'x',flags:1}],
    [{name:'index.html',data:'x',method:9}],
    [{name:'index.html',data:'x',crc:1}],
    [{name:'index.html',data:'x',size:2}],
    [{name:'index.html',data:'x'.repeat(1025)}],
    [{name:'index.html',data:'x'.repeat(100000),size:1}],
    [{name:'index.html',data:'x'.repeat(1024)},{name:'x',data:'x'.repeat(1024)},{name:'y',data:'1'}],
    [{name:'nested/index.html',data:'x'}],
    [{name:'index.html/'}],
    [{name:'index.html',data:'x'},...Array.from({length:20},(_,i)=>({name:`f${i}`,data:'x'}))],
  ];
  for(const entries of sets){const r=await a.upload('victim',zip(entries));assert.equal(r.status,400,JSON.stringify({names:entries.map(e=>e.name),r}));attempts++;}
  for(const b of [Buffer.from('not a zip'),good().subarray(0,20),Buffer.alloc(0)]){assert.equal((await a.upload('victim',b)).status,400);attempts++;}
  assert.equal((await a.request('/victim/')).body,'ORIGINAL');
  assert.deepEqual(fs.readdirSync(path.join(a.config.dataDirectory,'uploads')),[]);
  assert.equal(a.server.catalog.busy,false);
});
test('file dispatcher rejects encoded traversal, hidden files, symlinks, malformed paths',async t=>{
  const a=await setup(t);
  fs.symlinkSync(a.root,path.join(a.config.sitesDirectory,'victim','link'));
  fs.writeFileSync(path.join(a.config.sitesDirectory,'victim','.hidden'),'SENTINEL');
  const paths=['/victim/../secret.txt','/victim/%2e%2e/secret.txt','/victim/%2E%2e%2fsecret.txt','/victim/..%5csecret.txt','/victim/%252e%252e/secret.txt','/victim/link/secret.txt','/victim/.hidden','/victim/%2ehidden','/victim/%00','/victim/%ff','/victim/%','/victim/%5c','/api/../private/catalog.json','/private/catalog.json','/server.js','/.git/config','/victim/%2f../secret.txt','/victim/.%2f../secret.txt'];
  for(const p of paths){const r=await a.request(p);assert.equal(r.status,404,p);assert.ok(!r.body.includes('SENTINEL'),p);}
});
test('cross-origin, metadata, host, and HTTP method controls reject unrelated clients',async t=>{
  const a=await setup(t);
  for(const origin of ['null','https://evil.invalid','http://mini:81','https://mini.evil.invalid','file://mini/']) {
    assert.equal((await a.request('/api/apps',{headers:{Origin:origin}})).status,403);
    assert.equal((await a.upload('victim',good(),{Origin:origin,'X-Tailnow-Request':'1'})).status,403);
  }
  for(const headers of [{Host:'evil.invalid'},{Host:'mini.evil.invalid'},{Host:'mini:1234'},{'Sec-Fetch-Site':'cross-site','Sec-Fetch-Mode':'cors'}])assert.equal((await a.request('/api/apps',{headers})).status,403);
  assert.equal((await a.upload('victim',good(),{'Sec-Fetch-Site':'same-origin'})).status,403);
  for(const method of ['OPTIONS','PUT','PATCH','DELETE','TRACE'])assert.equal((await a.request('/api/apps',{method})).status,405);
  const r=await a.request('/api/apps',{headers:{'X-Forwarded-Host':'evil.invalid','X-Forwarded-For':'203.0.113.1'}});
  assert.equal(r.status,200);assert.equal(r.headers['access-control-allow-origin'],undefined);
});
test('multipart errors and disconnected uploads release the lock and remove temporary files',async t=>{
  const a=await setup(t);
  const bodies=[
    ['multipart/form-data','x'],
    ['multipart/form-data; boundary=AUDIT','--AUDIT\r\n'],
    ['multipart/form-data; boundary=AUDIT','--AUDIT\r\nContent-Disposition: form-data; name="unexpected"\r\n\r\nx\r\n--AUDIT--\r\n'],
    ['multipart/form-data; boundary=AUDIT','--AUDIT\r\nContent-Disposition: form-data; name="wrong"; filename="x.zip"\r\n\r\nx\r\n--AUDIT--\r\n'],
    ['application/json','{}'],
  ];
  for(const [type,body]of bodies){const r=await a.request('/api/publish/victim',{method:'POST',headers:{'Content-Type':type},body:Buffer.from(body)});assert.ok(r.status>=400);assert.equal(a.server.catalog.busy,false);assert.equal((await a.request('/api/health')).status,200);}
  for(const partial of ['', '--AUDIT\r\nContent-Disposition: form-data; name="file";', '--AUDIT\r\nContent-Disposition: form-data; name="file"; filename="x.zip"\r\n\r\nabc']){
    const socket=net.connect(a.port,'127.0.0.1');await once(socket,'connect');
    socket.write('POST /api/publish/victim HTTP/1.1\r\nHost: audit.invalid\r\nAuthorization: Bearer '+a.key+'\r\nContent-Type: multipart/form-data; boundary=AUDIT\r\nContent-Length: 100000\r\n\r\n'+partial);
    await sleep(50);socket.destroy();await sleep(100);
    assert.equal(a.server.catalog.busy,false);assert.deepEqual(fs.readdirSync(path.join(a.config.dataDirectory,'uploads')),[]);
  }
  assert.equal((await a.upload('victim')).status,200);
});
test('raw HTTP rejects ambiguous framing, duplicate Host, and malformed request targets',async t=>{
  const a=await setup(t);
  const cases=[
    'GET /api/apps HTTP/1.1\r\nHost: audit.invalid\r\nHost: evil.invalid\r\nConnection: close\r\n\r\n',
    'GET /api/apps HTTP/1.1\r\nConnection: close\r\n\r\n',
    'GET /api/apps HTTP/1.1\r\nHost: audit.invalid\r\nContent-Length: 1\r\nContent-Length: 0\r\nConnection: close\r\n\r\nx',
    'POST /api/apps/victim/minimize HTTP/1.1\r\nHost: audit.invalid\r\nX-Tailnow-Request: 1\r\nContent-Length: 0\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n0\r\n\r\n',
    'GET http://mini/api/apps HTTP/1.1\r\nHost: audit.invalid\r\nConnection: close\r\n\r\n',
    'GET //evil.invalid/api/apps HTTP/1.1\r\nHost: audit.invalid\r\nConnection: close\r\n\r\n',
    'GET /\\evil.invalid/api/apps HTTP/1.1\r\nHost: audit.invalid\r\nConnection: close\r\n\r\n',
    'GET /api/apps HTTP/1.1\r\nHost: audit.invalid\r\nX-Large: '+ 'x'.repeat(9000)+'\r\nConnection: close\r\n\r\n',
  ];
  for(const raw of cases){
    const r=await new Promise((resolve,reject)=>{const s=net.connect(a.port,'127.0.0.1',()=>s.write(raw));let out='';s.setTimeout(3000,()=>s.destroy(new Error('Timeout')));s.on('data',b=>out+=b);s.on('end',()=>resolve(out));s.on('error',reject)});
    assert.match(r,/^HTTP\/1\.1 (400|403|431)/);assert.doesNotMatch(r,/\"apps\"/);
  }
  assert.equal(a.server.catalog.busy,false);assert.equal((await a.request('/api/health')).status,200);
});
test('worker deadline rejects upload while retaining the active release and unlocking writes',async t=>{
  const a=await setup(t,null,{limits:{...defaultLimits,timeoutMs:1}});
  assert.equal((await a.upload('victim')).status,400);
  assert.equal(a.server.catalog.busy,false);assert.equal((await a.request('/victim/')).body,'ORIGINAL');
  assert.deepEqual(fs.readdirSync(path.join(a.config.dataDirectory,'uploads')),[]);
});
