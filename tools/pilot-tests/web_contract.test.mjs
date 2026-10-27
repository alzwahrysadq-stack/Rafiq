import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {projectUrl,publicKey,moneyCents,qtyMilli,cartTotal,PilotApi} from '../../web-client/lib.mjs';
let count=0;
const expect=fn=>{assert.throws(fn);count++;};
assert.equal(projectUrl(' https://syntheticprojectref.supabase.co/ '),'https://syntheticprojectref.supabase.co');count++;
for(const bad of ['https://example.org','http://syntheticprojectref.supabase.co',
  'https://user@syntheticprojectref.supabase.co','https://syntheticprojectref.supabase.co:443',
  'https://syntheticprojectref.supabase.co/path','https://syntheticprojectref.supabase.co?ref=x',
  'https://syntheticprojectref.supabase.co.evil.test'])expect(()=>projectUrl(bad));
const key=`sb_publishable_${'A'.repeat(30)}`;
assert.equal(publicKey(key),key);count++;
expect(()=>publicKey(`sb_secret_${'A'.repeat(30)}`));
const enc=obj=>Buffer.from(JSON.stringify(obj)).toString('base64url');
const anon=`${enc({alg:'HS256'})}.${enc({role:'anon',exp:Math.floor(Date.now()/1000)+3600})}.signature`;
assert.equal(publicKey(anon),anon);count++;
expect(()=>publicKey(`${enc({alg:'HS256'})}.${enc({role:'service_role'})}.signature`));
expect(()=>publicKey(`${enc({alg:'HS256'})}.${enc({role:'anon',exp:1})}.signature`));
assert.equal(moneyCents('325.40'),32540);assert.equal(moneyCents('0'),0);count+=2;
for(const bad of ['-1','12.345','1,000','Infinity',''])expect(()=>moneyCents(bad));
assert.equal(qtyMilli('1.250'),1250);assert.equal(qtyMilli('0.001'),1);count+=2;
for(const bad of ['0','1000.001','-2','1.1234'])expect(()=>qtyMilli(bad));
assert.equal(cartTotal([{price_cents:1200,qty_milli:250},{price_cents:999,qty_milli:1000}]),1299);count++;
let requests=[];
const mock=async (url,opts)=>{
  requests.push({url,opts});
  if(url.includes('grant_type=password'))return {ok:true,text:async()=>JSON.stringify({
    access_token:'access-1',refresh_token:'refresh-1',expires_in:3600,user:{id:'usr-test',email:'worker@invalid.test'}})};
  if(url.includes('grant_type=refresh_token'))return {ok:true,text:async()=>JSON.stringify({
    access_token:'access-2',refresh_token:'refresh-2',expires_in:3600})};
  if(url.includes('logout'))return {ok:true,text:async()=>'{}'};
  return {ok:true,text:async()=>JSON.stringify([{id:'row-1'}])};
};
const api=new PilotApi('https://syntheticprojectref.supabase.co',key,mock);
assert.equal(api.signedIn,false);count++;
const user=await api.signIn(' worker@invalid.test ','private-password');
assert.equal(user.id,'usr-test');count++;
await api.table('rfq_pilot_products',{store_id:'eq.store-test',select:'id,name'});
assert.match(requests[1].url,/\/rest\/v1\/rfq_pilot_products\?/);count++;
assert.equal(requests[1].opts.headers.Authorization,'Bearer access-1');count++;
assert.equal(requests[1].opts.redirect,'error');count++;
assert.equal(requests[1].opts.credentials,'omit');count++;
api.expiresAt=0;await api.rpc('rfq_pilot_customer_balance',{p_store:'store-test'});
assert.equal(requests[2].opts.body,JSON.stringify({refresh_token:'refresh-1'}));count++;
assert.equal(requests[3].opts.headers.Authorization,'Bearer access-2');count++;
assert.equal(requests[3].opts.method,'POST');count++;
await assert.rejects(()=>api.rpc('not_pilot_customers'));count++;
await api.signOut();assert.equal(api.signedIn,false);count++;
// A real Window.fetch is brand-checked. A Node arrow mock lets the old
// constructor pass even when PilotApi accidentally calls an unbound fetch.
const originalFetch=globalThis.fetch;
let browserRequests=0;
globalThis.fetch=function browserFetch(url,options){
  assert.equal(this,globalThis,'Window.fetch must be invoked with its Window receiver');
  browserRequests++;
  return mock(url,options);
};
try{
  const browserApi=new PilotApi('https://syntheticprojectref.supabase.co',key);
  assert.equal((await browserApi.signIn('worker@invalid.test','synthetic-only')).id,'usr-test');count++;
  assert.equal((await browserApi.table('rfq_pilot_products',{select:'id'}))[0].id,'row-1');count++;
  assert.equal(browserRequests,2);count++;
}finally{globalThis.fetch=originalFetch;}
const html=readFileSync(new URL('../../web-client/index.html',import.meta.url),'utf8');
assert.match(html,/script type="module"/);assert.match(html,/form-action 'self'/);count+=2;
const script=readFileSync(new URL('../../web-client/web.js',import.meta.url),'utf8');
const runtimeIds=new Set([...script.matchAll(/\.id='([A-Za-z][A-Za-z0-9]*)'/g)].map(m=>m[1]));
for(const match of script.matchAll(/\$\('([A-Za-z][A-Za-z0-9]*)'\)/g)){
  if(runtimeIds.has(match[1]))continue; // created at runtime by web.js itself
  assert.ok(html.includes(`id="${match[1]}"`),`missing DOM element ${match[1]}`);count++;
}
const innerUses=[...script.matchAll(/innerHTML\s*=\s*([^;]+)/g)].map(m=>m[1].trim());
assert.ok(innerUses.every(u=>u.startsWith('barcodeSvg(')),
  'innerHTML only for barcodeSvg(): its input is Code39-whitelist-filtered and output is rects only');count++;
console.log(`PASS ${count} web contract assertions (synthetic endpoint only; no network).`);
