// Test-only browser transport and arithmetic. No service_role or invoice SMS endpoint.
export function projectUrl(raw) {
  const s=String(raw||'').trim();
  const m=/^https:\/\/([a-z0-9](?:[a-z0-9-]{4,61}[a-z0-9])\.supabase\.co)\/?$/i.exec(s);
  if (!m || s.length>160) throw Error('رابط المشروع غير صالح: يلزم عنوان مشروع HTTPS بلا مسار أو منفذ');
  return `https://${m[1].toLowerCase()}`;
}
export function publicKey(raw,now=Date.now()) {
  const s=String(raw||'').trim();
  if (/^sb_publishable_[A-Za-z0-9_-]{20,512}$/.test(s)) return s;
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s) || s.length>4096) {
    throw Error('مفتاح المشروع العام غير صالح؛ لا تستخدم مفاتيح الخدمة');
  }
  try {
    const data=JSON.parse(atob(s.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
    if (data.role!=='anon' || (data.exp && data.exp <= Math.floor(now/1000))) throw Error('role/expiry');
  } catch { throw Error('يلزم Publishable أو Anon العام فقط، لا service_role'); }
  return s;
}
export function moneyCents(value) {
  const s=String(value??'').trim();
  if (!/^\d{1,9}(?:\.\d{1,2})?$/.test(s)) throw Error('اكتب مبلغاً صحيحاً بالريال (حتى منزلتين عشريتين)');
  const [whole,part='']=s.split('.');
  return Number(whole)*100 + Number(part.padEnd(2,'0'));
}
export function qtyMilli(value) {
  const s=String(value??'').trim();
  if (!/^\d{1,4}(?:\.\d{1,3})?$/.test(s)) throw Error('الكمية يجب أن تكون موجبة وبحد ثلاثة كسور');
  const [whole,part='']=s.split('.');
  const n=Number(whole)*1000+Number(part.padEnd(3,'0'));
  if (n<1 || n>1000000) throw Error('الكمية القصوى ١٠٠٠');
  return n;
}
export function cartTotal(lines) {
  return lines.reduce((sum,l)=>sum+Math.round(l.price_cents*l.qty_milli/1000),0);
}

export class PilotApi {
  // Window.fetch needs Window as its receiver in Android WebView and browsers.
  // A bare reference called as this.fetcher(...) instead uses PilotApi as `this`.
  constructor(url,key,fetcher=(...args)=>globalThis.fetch(...args)) {
    this.url=projectUrl(url); this.key=publicKey(key); this.fetcher=fetcher;
    this.access=''; this.refreshToken=''; this.expiresAt=0; this.refreshing=null;
  }
  get signedIn() {return !!this.access;}
  clear(){this.access='';this.refreshToken='';this.expiresAt=0;this.sessionUser=null;
    try{localStorage.removeItem('rafiq-cloud-session-v1');}catch{}}
  /** 6أ: إبقاء الجلسة عبر إغلاق التطبيق — دخول واحد فقط. رموز جلسة ومفاتيح عامة، لا أسرار خادم. */
  persistSession(){try{localStorage.setItem('rafiq-cloud-session-v1',JSON.stringify({
    url:this.url,key:this.key,access:this.access,refreshToken:this.refreshToken,
    expiresAt:this.expiresAt,user:this.sessionUser||null}));}catch{}}
  async send(path,{method='GET',body=null,token=''}={}) {
    const headers={'apikey':this.key,'Accept':'application/json'};
    if (body!==null) headers['Content-Type']='application/json';
    if (token) headers['Authorization']=`Bearer ${token}`;
    const controller=new AbortController();
    const timer=setTimeout(()=>controller.abort(),12000);
    try {
      const response=await this.fetcher(`${this.url}${path}`,{
        method,headers,body:body===null?undefined:JSON.stringify(body),
        credentials:'omit',redirect:'error',referrerPolicy:'no-referrer',cache:'no-store',signal:controller.signal,
      });
      try{const d=response.headers.get('Date');if(d)this.lastServerDate=d;}catch{}
      const raw=await response.text();
      let payload=null;
      try {payload=raw?JSON.parse(raw):null;} catch {payload=null;}
      if (!response.ok) {
        const msg=payload?.message||payload?.error_description||payload?.error||`HTTP ${response.status}`;
        // أمر المالك (الجولة 8): رمز الاستجابة ورمز الخطأ يسافران مع الخطأ نفسه —
        // التصنيف بالرمز الموثوق لا بنص الرسالة وحدها (500 بجسم نصي ≠ جلسة ميتة).
        const err=Error(String(msg).slice(0,160));
        err.status=response.status;
        err.code=String(payload?.code||payload?.error||'');
        throw err;
      }
      return payload;
    } finally {clearTimeout(timer);}
  }
  async signIn(email,password) {
    const data=await this.send('/auth/v1/token?grant_type=password',{
      method:'POST',body:{email:String(email).trim(),password:String(password)},
    });
    if (!data?.access_token || !data?.refresh_token || !data?.user?.id) throw Error('دخول غير مكتمل');
    this.access=data.access_token;this.refreshToken=data.refresh_token;
    this.expiresAt=Date.now()+(Number(data.expires_in)||3600)*1000;
    this.sessionUser=data.user||null;this.persistSession();
    return data.user;
  }
  async renew(){
    if (!this.refreshToken) throw Error('انتهت الجلسة؛ سجّل الدخول مجدداً');
    if (this.refreshing) return this.refreshing;
    this.refreshing=(async()=>{
      const data=await this.send('/auth/v1/token?grant_type=refresh_token',{
        method:'POST',body:{refresh_token:this.refreshToken},
      });
      if (!data?.access_token || !data?.refresh_token) throw Error('تعذر تجديد الجلسة');
      this.access=data.access_token;this.refreshToken=data.refresh_token;
      this.expiresAt=Date.now()+(Number(data.expires_in)||3600)*1000;
      this.persistSession();
    })();
    try {await this.refreshing;} catch (e) {
      // أمر المالك (الجولة 8+9): التصنيف يبدأ من رمز الاستجابة — كل 5xx و429 (حد المعدل) عابر،
      // وعطل الشبكة/الإجهاض بلا رمز استجابة عابر؛ ولا تُمسح الجلسة المحفوظة إلا بإبطال خادمي
      // مؤكد (invalid_grant صريحًا في رمز الخطأ أو الرسالة). رد أعمال 400 (ولو حمل نص
      // «unavailable») لا يمحو الجلسة — ليس إبطالًا مؤكدًا ولا عطلًا عابرًا.
      const m=String((e&&e.message)||e);
      const st=(e&&Number(e.status))||0;
      const transient=st>=500||st===429||(!st&&/Failed to fetch|fetch failed|network|timeout|aborted/i.test(m));
      const confirmedInvalidation=!transient&&/invalid_grant/i.test(`${(e&&e.code)||''} ${m}`);
      if(confirmedInvalidation)this.clear();
      throw e;
    }
    finally {this.refreshing=null;}
  }
  async rest(path,{method='GET',body=null}={}){
    if (!this.access) throw Error('سجّل الدخول أولاً');
    if (Date.now()+30000>=this.expiresAt) await this.renew();
    return this.send(`/rest/v1/${path}`,{method,body,token:this.access});
  }
  async rpc(name,args={}) {
    if (!/^rfq_pilot_[a-z0-9_]+$/.test(name)) throw Error('عملية غير مسموحة');
    return this.rest(`rpc/${name}`,{method:'POST',body:args});
  }
  async table(name,params){
    if (!/^rfq_pilot_[a-z0-9_]+$/.test(name)) throw Error('جدول غير مسموح');
    const query=new URLSearchParams(params).toString();
    return this.rest(`${name}?${query}`);
  }
  async signOut(){
    try{if(this.access) await this.send('/auth/v1/logout',{method:'POST',body:{},token:this.access});}
    finally{this.clear();}
  }
}

// ===== حزمة الإطلاق (130c): أكواد التفعيل + مخزن الجهاز المحلي (وضع بدون إنترنت) =====
// التصميم: السر مشترك بين «مفتاح الأكواد» (تطبيق الموزع) والتطبيق المبيع.
// الكود مرتبط بجهاز المشتري (رمز الجهاز) وبمدة صلاحية تُتحقق محليًا بلا إنترنت.

function _u8concat(a,b){const out=new Uint8Array(a.length+b.length);out.set(a,0);out.set(b,a.length);return out;}
function _rotr(x,n){return (x>>>n)|(x<<(32-n));}
const _K256=new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
export function sha256Bytes(msg){
  const bytes=typeof msg==='string'?new TextEncoder().encode(msg):msg;
  const l=bytes.length,bitLen=l*8;
  const padded=new Uint8Array((((l+9+63)>>6)<<6));padded.set(bytes);padded[l]=0x80;
  const dv=new DataView(padded.buffer);
  dv.setUint32(padded.length-8,Math.floor(bitLen/4294967296));
  dv.setUint32(padded.length-4,bitLen>>>0);
  const h=new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  const w=new Uint32Array(64);
  for(let i=0;i<padded.length;i+=64){
    for(let t=0;t<16;t++)w[t]=dv.getUint32(i+t*4);
    for(let t=16;t<64;t++){
      const s0=_rotr(w[t-15],7)^_rotr(w[t-15],18)^(w[t-15]>>>3);
      const s1=_rotr(w[t-2],17)^_rotr(w[t-2],19)^(w[t-2]>>>10);
      w[t]=(w[t-16]+s0+w[t-7]+s1)>>>0;
    }
    let a=h[0],b=h[1],c=h[2],d=h[3],e=h[4],f=h[5],g=h[6],hh=h[7];
    for(let t=0;t<64;t++){
      const S1=_rotr(e,6)^_rotr(e,11)^_rotr(e,25);
      const ch=(e&f)^(~e&g);
      const t1=(hh+S1+ch+_K256[t]+w[t])>>>0;
      const S0=_rotr(a,2)^_rotr(a,13)^_rotr(a,22);
      const maj=(a&b)^(a&c)^(b&c);
      const t2=(S0+maj)>>>0;
      hh=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0;
    }
    h[0]=(h[0]+a)>>>0;h[1]=(h[1]+b)>>>0;h[2]=(h[2]+c)>>>0;h[3]=(h[3]+d)>>>0;
    h[4]=(h[4]+e)>>>0;h[5]=(h[5]+f)>>>0;h[6]=(h[6]+g)>>>0;h[7]=(h[7]+hh)>>>0;
  }
  const out=new Uint8Array(32);const odv=new DataView(out.buffer);
  for(let i=0;i<8;i++)odv.setUint32(i*4,h[i]);
  return out;
}
export function hmacSha256(key,msg){
  let k=key instanceof Uint8Array?key:new TextEncoder().encode(String(key));
  if(k.length>64)k=sha256Bytes(k);
  const pad=new Uint8Array(64);pad.set(k);
  const outer=new Uint8Array(64),inner=new Uint8Array(64);
  for(let x=0;x<64;x++){outer[x]=pad[x]^0x5c;inner[x]=pad[x]^0x36;}
  return sha256Bytes(_u8concat(outer,sha256Bytes(_u8concat(inner,msg instanceof Uint8Array?msg:new TextEncoder().encode(String(msg))))));
}
export function bytesHex(u8){return Array.from(u8).map(b=>b.toString(16).padStart(2,'0')).join('');}
const B32='ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function b32encode(bytes){let bits=0,val=0,out='';for(const b of bytes){val=(val<<8)|b;bits+=8;while(bits>=5){out+=B32[(val>>>(bits-5))&31];bits-=5;}}if(bits>0)out+=B32[(val<<(5-bits))&31];return out;}
export function b32decode(str){const s=String(str||'').toUpperCase().replace(/[^A-Z2-7]/g,'');let bits=0,val=0;const out=[];for(const c of s){const idx=B32.indexOf(c);if(idx<0)continue;val=(val<<5)|idx;bits+=5;if(bits>=8){out.push((val>>>(bits-8))&255);bits-=8;}}return new Uint8Array(out);}
function _b64XorDecode(b64,xk){const raw=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));const out=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)out[i]=raw[i]^xk;return out;}
let _launchKeyCache=null;
export function launchSecret(){if(!_launchKeyCache)_launchKeyCache=_b64XorDecode('4AIruaYTE1tEPq61oZR6aw==',0x5a);return _launchKeyCache;}
function _eqBytes(a,b){if(!a||!b||a.length!==b.length)return false;let d=0;for(let i=0;i<a.length;i++)d|=a[i]^b[i];return d===0;}

// ---- أكواد التفعيل ----
// صيغة الكود: RFQ-XXXX-XXXX — 5 بايت: [نوع:2بت | أشهر:6بت] + وسم HMAC 4 بايت (مرتبط بجهاز المشتري).
// النوع: 0=بدون إنترنت، 1=بالإنترنت، 2=الاثنان. الأشهر: 1..62، و63=مدى الحياة.
export const ACT_TYPES={0:'offline',1:'online',2:'both'};
export function deviceCodeFrom(deviceId){
  return b32encode(sha256Bytes('rafiq-launch-device|'+String(deviceId||'')).slice(0,5)); // 8 خانات
}
function _actTag(deviceCode,b0){
  const msg=_u8concat(new TextEncoder().encode('RFQ1|'+b0+'|'),new TextEncoder().encode(String(deviceCode||'').toUpperCase().replace(/[^A-Z2-7]/g,'')));
  return hmacSha256(launchSecret(),msg).slice(0,4);
}
export function buildActivationCode(deviceCode,opts){
  const type=Number(opts?.type)||0,months=Number(opts?.months)||0;
  if(!(type>=0&&type<=2))throw Error('نوع التفعيل غير صالح');
  if(!((months>=1&&months<=62)||months===63))throw Error('مدة التفعيل غير صالحة');
  const b0=((type&3)<<6)|(months&63);
  const payload=_u8concat(Uint8Array.from([b0]),_actTag(deviceCode,b0));
  const enc=b32encode(payload);
  return 'RFQ-'+enc.slice(0,4)+'-'+enc.slice(4,8);
}
export function parseActivationCode(code){
  const s=String(code||'').trim().toUpperCase().replace(/\s+/g,'');
  const m=/^RFQ-?([A-Z2-7]{4})-?([A-Z2-7]{4})$/.exec(s);
  if(!m)return null;
  const bytes=b32decode(m[1]+m[2]);
  if(bytes.length!==5)return null;
  return bytes;
}
export function verifyActivationCode(deviceCode,code){
  const bytes=parseActivationCode(code);
  if(!bytes)return {ok:false,reason:'format'};
  const b0=bytes[0],type=(b0>>6)&3,months=b0&63;
  if(type>2)return {ok:false,reason:'type'};
  if(!((months>=1&&months<=62)||months===63))return {ok:false,reason:'months'};
  if(!_eqBytes(bytes.slice(1),_actTag(deviceCode,b0)))return {ok:false,reason:'code'};
  return {ok:true,type,months,mode:ACT_TYPES[type]};
}
export function activationUntil(months,from){
  const base=from?new Date(from):new Date();
  if(months===63)return new Date(base.getTime()+20*365*864e5).toISOString();
  const d=new Date(base.getTime());const day=d.getDate();
  d.setDate(1);d.setMonth(d.getMonth()+Number(months||0));
  const last=new Date(d.getFullYear(),d.getMonth()+1,0).getDate();
  d.setDate(Math.min(day,last)); // تثبيت نهاية الشهر: 31 يناير + شهر = 28/29 فبراير
  return d.toISOString();
}

// ---- المخزن المحلي (وضع بدون إنترنت): محاكاة دوال الخادم على الجهاز ----
export class LocalStore{
  constructor(kv){this.kv=kv;this.db=this._load();}
  _blank(){
    return {v:1,counter:{invoice:0,customer:0,product:0,supplier:0,purchase:0,shift:0},
      products:[],customers:[],invoices:[],invoice_lines:[],debt_entries:[],collections:[],cash_entries:[],
      shifts:[],shift_open:null,suppliers:[],purchases:[],supplier_ledger:[],returns:[],profile:{store:{},my:{}},extra:{}};
  }
  _load(){try{const raw=this.kv.get('rafiq-test-device:v2:android:local-db');if(raw){const d=JSON.parse(raw);if(d&&d.v===1)return d;}}catch{}return this._blank();}
  _save(){try{this.kv.set('rafiq-test-device:v2:android:local-db',JSON.stringify(this.db));}catch(e){throw Error('تعذر حفظ البيانات على الجهاز: '+e.message);}}
  _uuid(){return (this.db.extra.nonce||'')&&false||globalThis.crypto?.randomUUID?.()||('local-'+Date.now()+'-'+Math.random().toString(16).slice(2));}
  _now(){return new Date().toISOString();}
  _next(kind){this.db.counter[kind]=(this.db.counter[kind]||0)+1;return this.db.counter[kind];}
  _balance(customerId){let s=0;for(const d of this.db.debt_entries)if(d.customer_id===customerId)s+=Number(d.amount_cents||0);return s;}
  _openShift(){return this.db.shift_open?this.db.shifts.find(s=>s.id===this.db.shift_open)||null:null;}
  _entry(id){return this.db.debt_entries.find(e=>e.id===id);}

  // ===== الجداول (لمطالبات state.api.table) =====
  table(name,q){
    const map={rfq_pilot_customers:'customers',rfq_pilot_products:'products',rfq_pilot_invoices:'invoices',
      rfq_pilot_invoice_lines:'invoice_lines',rfq_pilot_debt_entries:'debt_entries',rfq_pilot_shifts:'shifts',
      rfq_pilot_suppliers:'suppliers',rfq_pilot_purchases:'purchases'};
    if(name==='rfq_pilot_devices'){return [{id:String((q&&q.id&&q.id.replace(/^eq\./,''))||'local-device'),status:'approved',kind:'owner_phone',user_id:'local-owner',created_at:this._now()}];}
    if(name==='rfq_pilot_members')return [{user_id:'local-owner',role:'owner',active:true}];
    if(name==='rfq_pilot_shift_requests')return [];
    if(name==='rfq_pilot_stores')return [{id:'local-store',name:this.db.profile.store?.name||'متجري',enabled:true,seat_limit:3,license_until:activationUntil(63)}];
    const key=map[name];if(!key)return [];
    let rows=(this.db[key]||[]).slice();
    if(q&&q.status==='eq.open')rows=rows.filter(r=>r.status==='open');
    if(q&&q.active==='eq.true')rows=rows.filter(r=>r.active!==false);
    if(q&&q.active==='eq.false')rows=rows.filter(r=>r.active===false);
    if(q&&typeof q.id==='string'&&q.id.startsWith('eq.'))rows=rows.filter(r=>String(r.id)===q.id.slice(3));
    if(q&&typeof q.customer_id==='string'&&q.customer_id.startsWith('eq.'))rows=rows.filter(r=>String(r.customer_id)===q.customer_id.slice(3));
    if(q&&typeof q.invoice_id==='string'&&q.invoice_id.startsWith('eq.'))rows=rows.filter(r=>String(r.invoice_id)===q.invoice_id.slice(3));
    if(q&&typeof q.store_id==='string'&&q.store_id.startsWith('eq.')){/* متجر واحد محلي */}
    if(q&&typeof q.order==='string'){
      const [col,dir]=q.order.split('.');rows.sort((a,b)=>String(a[col]??'').localeCompare(String(b[col]??''))*(dir==='desc'?-1:1));
    }
    if(q&&q.limit)rows=rows.slice(0,Number(q.limit));
    return rows.map(r=>({...r}));
  }

  // ===== دوال الخادم (لمطالبات state.api.rpc) =====
  rpc(name,args){
    const a=args||{};
    const R={
      rfq_pilot_license_current:()=>true,
      rfq_pilot_request_device:()=>'approved',
      rfq_pilot_approve_device:()=>true,
      rfq_pilot_heartbeat:()=>true,
      rfq_pilot_claim_worker:()=>true,
      rfq_pilot_claim_owner_seller:()=>true,
      rfq_pilot_replace_own_device:()=>true,
      rfq_pilot_revoke_worker:()=>true,
      rfq_pilot_my_open_shift:()=>{const s=this._openShift();return s?{id:s.id}:null;},
      rfq_pilot_request_shift:()=>{const s=this._openShift();if(s)return {id:s.id,status:'approved'};
        const id=this._uuid();const rec={id,opened_at:this._now(),closed_at:null,status:'open',worker_id:'local-owner',
          cashier_device_id:a.p_device||'local-device',opening_cents:Number(a.p_opening_cents||0),expected_cents:0};
        this.db.shifts.push(rec);this.db.shift_open=id;this._save();return {id,status:'approved'};},
      rfq_pilot_open_owner_shift:()=>{const s=this._openShift();if(s)return s.id;
        const id=this._uuid();const rec={id,opened_at:this._now(),closed_at:null,status:'open',worker_id:'local-owner',owner_shift:true,
          cashier_device_id:a.p_device||'local-device',opening_cents:Number(a.p_opening_cents||0),expected_cents:0};
        this.db.shifts.push(rec);this.db.shift_open=id;this._save();return id;},
      rfq_pilot_close_shift:()=>{const s=this._openShift();if(s){s.status='closed';s.closed_at=this._now();this.db.shift_open=null;this._save();}return true;},
      rfq_pilot_approve_shift:()=>true,
      rfq_pilot_post_invoice_guarded:(x)=>this._postInvoice(x),
      rfq_pilot_post_invoice_v3:(x)=>this._postInvoice(x),
      rfq_pilot_collect_debt_v2:(x)=>this._collect(x),
      rfq_pilot_owner_add_debt:(x)=>this._ownerDebt(x),
      rfq_pilot_owner_cash_adjust:(x)=>this._cashAdjust(x),
      rfq_pilot_save_product:(x)=>this._saveProduct(x),
      rfq_pilot_set_product_expiry:()=>true,
      rfq_pilot_adjust_stock:(x)=>this._adjustStock(x),
      rfq_pilot_create_customer:(x)=>this._createCustomer(x),
      rfq_pilot_set_customer_photo:(x)=>{const c=this.db.customers.find(z=>z.id===a.p_customer);if(c){c.photo=a.p_photo||null;this._save();}return true;},
      rfq_pilot_set_customer_message_pref:()=>true,
      rfq_pilot_get_customer_message_prefs:()=>({}),
      rfq_pilot_sales_return:(x)=>this._salesReturn(x),
      rfq_pilot_void_invoice:(x)=>this._voidInvoice(x),
      rfq_pilot_void_collection:(x)=>this._voidCollection(x),
      rfq_pilot_customer_statement:(x)=>this._statement(a.p_customer),
      rfq_pilot_customer_balance:(x)=>this._balance(a.p_customer),
      rfq_pilot_recent_collections:()=>this.db.collections.slice().sort((x,y)=>String(y.created_at).localeCompare(String(x.created_at))).slice(0,20).map(c=>({...c,customer_name:this.db.customers.find(z=>z.id===c.customer_id)?.name||'—'})),
      rfq_pilot_invoice_detail:(x)=>this._invoiceDetail(a.p_invoice),
      rfq_pilot_invoice_by_number:(x)=>{const inv=this.db.invoices.find(i=>Number(i.number)===Number(a.p_number));return inv?this._invoiceDetail(inv.id):null;},
      rfq_pilot_daily_report:(x)=>this._daily(a.p_date),
      rfq_pilot_profit_report:(x)=>this._profit(a.p_from,a.p_to),
      rfq_pilot_customers_report:()=>this.db.customers.map(c=>({id:c.id,name:c.name,phone:c.phone,active:c.active!==false,
        balance_cents:this._balance(c.id),last_activity:(this.db.debt_entries.filter(d=>d.customer_id===c.id).slice(-1)[0]||{}).created_at||c.created_at})),
      rfq_pilot_owner_summary:()=>{let sales=0,cash=0,out=0;
        for(const i of this.db.invoices){if(!i.voided_at){sales+=Number(i.total_cents);cash+=Number(i.cash_paid_cents||0);}}
        for(const d of this.db.debt_entries)out+=Number(d.amount_cents||0);
        return {sales_cents:sales,outstanding_debt_cents:Math.max(out,0),cash_received_on_sales_cents:cash};},
      rfq_pilot_owner_monitor:()=>this._monitor(),
      rfq_pilot_owner_product_costs:()=>this.db.products.map(p=>({id:p.id,name:p.name,cost_cents:p.cost_cents})),
      rfq_pilot_get_store_profile:()=>this.db.profile.store||{},
      rfq_pilot_save_store_profile:()=>{this.db.profile.store={...(this.db.profile.store||{}),...(a.p_profile||a)};this._save();return true;},
      rfq_pilot_store_profiles:()=>[this.db.profile.store||{}],
      rfq_pilot_save_my_profile:()=>{this.db.profile.my={...(this.db.profile.my||{}),...(a.p_profile||a)};this._save();return true;},
      rfq_pilot_get_message_settings:()=>({master_enabled:false,events:{}}),
      rfq_pilot_save_message_settings:()=>true,
      rfq_pilot_message_log:()=>[],
      rfq_pilot_sms_ack:()=>true,
      rfq_pilot_sms_claim:()=>'',
      rfq_pilot_sms_claim_v2:()=>'',
      rfq_pilot_enqueue_reminders:()=>true,
      rfq_pilot_voice_my:()=>true,
      rfq_pilot_voice_list:()=>[],
      rfq_pilot_voice_set:()=>true,
      rfq_pilot_member_perms_list:()=>[],
      rfq_pilot_set_member_perm:()=>true,
      rfq_pilot_demand_list:()=>[],
      rfq_pilot_add_demand:()=>({id:this._uuid()}),
      rfq_pilot_set_demand_status:()=>true,
      rfq_pilot_create_supplier:()=>{const id=a.p_id||this._uuid();
        if(!this.db.suppliers.find(s=>s.id===id))this.db.suppliers.push({id,name:a.p_name||'مورّد',phone:a.p_phone||'',kind:a.p_kind||'supplier',
        photo:a.p_photo||null,active:true,created_at:this._now()});this._save();return {id};},
      rfq_pilot_update_supplier:()=>{const s=this.db.suppliers.find(z=>z.id===a.p_supplier||z.id===a.p_id);if(s){Object.assign(s,{name:a.p_name??s.name,phone:a.p_phone??s.phone,kind:a.p_kind??s.kind});this._save();}return true;},
      rfq_pilot_suppliers_overview:()=>this.db.suppliers.map(s=>({...s,balance_cents:this._supBalance(s.id)})),
      rfq_pilot_save_purchase_v2:()=>this._purchase(a),
      rfq_pilot_save_purchase_v3:()=>this._purchase(a),
      rfq_pilot_product_batches:()=>productBatches(this,a.p_product),
      rfq_pilot_expiring_batches:()=>expiringBatches(this,a.p_days),
      rfq_pilot_supplier_payment_v2:()=>{const amt=Number(a.p_amount_cents||0);if(!(amt>0))throw Error('مبلغ الدفعة غير صالح');
        this.db.supplier_ledger.push({id:this._uuid(),supplier_id:a.p_supplier,kind:'payment',amount_cents:-amt,created_at:this._now(),note:a.p_note||''});this._save();return {total_cents:amt};},
      rfq_pilot_supplier_return:()=>this._supplierReturn(a),
      rfq_pilot_supplier_statement:(x)=>this._supStatement(a.p_supplier),
      rfq_pilot_void_purchase:()=>this._voidPurchase(a.p_purchase),
      rfq_pilot_request_supplier:()=>({id:this._uuid()}),
      rfq_pilot_decide_supplier_request:()=>true,
      rfq_pilot_supplier_requests_list:()=>[],
      rfq_pilot_open_stocktake:()=>({id:this._uuid()}),
      rfq_pilot_set_stocktake_count:()=>true,
      rfq_pilot_close_stocktake:()=>({id:this._uuid()}),
      rfq_pilot_stocktake_get:()=>null,
    };
    const fn=R[name];
    if(!fn)throw Error('هذه الميزة تحتاج اتصالاً بالإنترنت — متاحة في وضع «الدخول بالإنترنت»');
    const out=fn(a);
    return out;
  }

  // ---- عمليات مالية ----
  _postInvoice(a){
    const id=a.p_invoice||this._uuid();
    const prev=this.db.invoices.find(i=>i.id===id);
    if(prev)return {invoice_id:prev.id,number:prev.number,total_cents:prev.total_cents,due_cents:prev.due_cents,
      other_paid_cents:Number(prev.other_paid_cents||0),lines:this.db.invoice_lines.filter(l=>l.invoice_id===prev.id)
        .map(l=>({invoice_id:l.invoice_id,product_id:l.product_id,name_snapshot:l.name_snapshot,price_cents:l.price_cents,qty_milli:l.qty_milli})),already_committed:true};
    const shift=this._openShift();
    if(!shift||shift.status!=='open')throw Error('يلزم وردية مفتوحة لحفظ البيع');
    const lines=Array.isArray(a.p_lines)?a.p_lines:[];
    if(!lines.length||lines.length>100)throw Error('أسطر الفاتورة غير صالحة');
    let subtotal=0;const seen=new Set();const resolved=[];
    for(const l of lines){
      const p=this.db.products.find(z=>z.id===l.product_id&&z.active!==false);
      if(!p)throw Error('صنف غير موجود أو معطّل: '+(l.product_id||''));
      if(seen.has(l.product_id))throw Error('صنف مكرر في الفاتورة');
      seen.add(l.product_id);
      const qty=Number(l.qty_milli);
      if(!(Number.isSafeInteger(qty)&&qty>=1&&qty<=1000000))throw Error('كمية غير صالحة');
      assertSellable(this,p,qty);
      if(l.expected_price_cents!=null&&Number(l.expected_price_cents)!==Number(p.price_cents))throw Error('تغيّر سعر الصنف أثناء البيع: '+p.name);
      if(l.expected_name!=null&&String(l.expected_name)!==String(p.name))throw Error('تغيّر اسم الصنف أثناء البيع: '+p.name);
      const lineTotal=Math.round(Number(p.price_cents)*qty/1000);
      subtotal+=lineTotal;resolved.push({product:p,qty,lineTotal});
    }
    const cash=Number(a.p_cash_cents||0),other=Number(a.p_other_cents||0);
    if(!Number.isSafeInteger(cash)||cash<0||!Number.isSafeInteger(other)||other<0)throw Error('مبلغ الدفع غير صالح');
    if(cash+other>subtotal)throw Error('المدفوع أكبر من إجمالي الفاتورة');
    const due=subtotal-cash-other;
    if((due>0&&!a.p_customer)||(due===0&&a.p_customer))throw Error('فاتورة الدين تحتاج زبونًا — والفاتورة المدفوعة بالكامل لا تحتاج');
    if(due>0&&!this.db.customers.find(c=>c.id===a.p_customer&&c.active!==false))throw Error('الزبون غير موجود');
    const number=this._next('invoice');
    const inv={id,store_id:'local-store',number,shift_id:shift.id,worker_id:'local-owner',cashier_device_id:a.p_device||'local-device',
      customer_id:due>0?a.p_customer:null,subtotal_cents:subtotal,discount_cents:0,total_cents:subtotal,cash_paid_cents:cash,
      other_paid_cents:other,other_method:other>0?(a.p_other_method||'wallet'):null,other_reference:a.p_other_reference||null,
      due_cents:due,created_at:this._now(),voided_at:null,void_reason:null};
    this.db.invoices.push(inv);
    for(const r of resolved){
      this.db.invoice_lines.push({id:this._uuid(),invoice_id:id,product_id:r.product.id,name_snapshot:r.product.name,
        barcode_snapshot:r.product.barcode||'',unit_snapshot:r.product.unit||'',price_cents:Number(r.product.price_cents),
        cost_cents:Number(r.product.cost_cents||0),qty_milli:r.qty,line_total_cents:r.lineTotal,returned_qty_milli:0});
      batchConsume(this,r.product,r.qty,id);
    }
    if(cash>0)this.db.cash_entries.push({id:this._uuid(),shift_id:shift.id,kind:'sale',amount_cents:cash,method:'cash',reference_id:id,created_at:this._now()});
    if(other>0)this.db.cash_entries.push({id:this._uuid(),shift_id:shift.id,kind:'sale',amount_cents:other,method:inv.other_method,reference_id:id,created_at:this._now()});
    if(due>0)this.db.debt_entries.push({id:this._uuid(),customer_id:a.p_customer,invoice_id:id,kind:'invoice_due',amount_cents:due,created_at:this._now(),note:'',method:null});
    this._save();
    return {invoice_id:id,number,total_cents:subtotal,due_cents:due,other_paid_cents:other,
      lines:resolved.map(r=>({invoice_id:id,product_id:r.product.id,name_snapshot:r.product.name,price_cents:Number(r.product.price_cents),qty_milli:r.qty})),already_committed:false};
  }
  _collect(a){
    const ev=a.p_event||this._uuid();
    const prev=this._entry(ev);
    if(prev)return this._balance(prev.customer_id);
    const amt=Number(a.p_amount_cents||0);
    if(!(Number.isSafeInteger(amt)&&amt>=1&&amt<=100000000000))throw Error('مبلغ التحصيل غير صالح');
    const method=['cash','wallet','transfer'].includes(a.p_method)?a.p_method:'cash';
    const c=this.db.customers.find(z=>z.id===a.p_customer&&z.active!==false);
    if(!c)throw Error('الزبون غير موجود');
    if(this._balance(a.p_customer)<amt)throw Error('مبلغ التحصيل أكبر من دين الزبون');
    const shift=this._openShift();
    if(!shift)throw Error('يلزم وردية مفتوحة لتسجيل التحصيل');
    this.db.debt_entries.push({id:ev,customer_id:a.p_customer,invoice_id:null,kind:'collection',amount_cents:-amt,
      created_at:this._now(),note:String(shift.id),method,pay_reference:a.p_reference||null});
    this.db.collections.push({id:ev,customer_id:a.p_customer,amount_cents:amt,method,reference:a.p_reference||null,created_at:this._now(),voided_at:null,shift_id:shift.id});
    this.db.cash_entries.push({id:this._uuid(),shift_id:shift.id,kind:'collection',amount_cents:amt,method,reference_id:ev,created_at:this._now()});
    this._save();return this._balance(a.p_customer);
  }
  _ownerDebt(a){
    const ev=a.p_event||this._uuid();
    if(this._entry(ev))return {balance_cents:this._balance(a.p_customer)};
    const amt=Number(a.p_amount_cents||0);
    if(!(amt>0))throw Error('مبلغ الدين غير صالح');
    if(!this.db.customers.find(c=>c.id===a.p_customer&&c.active!==false))throw Error('الزبون غير موجود');
    this.db.debt_entries.push({id:ev,customer_id:a.p_customer,invoice_id:null,kind:'owner_debit',amount_cents:amt,
      created_at:this._now(),note:a.p_reason||'',method:null});
    this._save();return {balance_cents:this._balance(a.p_customer)};
  }
  _cashAdjust(a){
    const ev=a.p_event||this._uuid();
    if(this.db.cash_entries.find(x=>x.id===ev))return true;
    const amt=Number(a.p_amount_cents||0);
    if(!(amt>=0))throw Error('مبلغ الحركة غير صالح');
    const shift=this._openShift();if(!shift)throw Error('يلزم وردية مفتوحة لحركة الصندوق');
    const kind=a.p_kind==='out'||a.p_kind==='payout'?'payout':'adjust_in';
    this.db.cash_entries.push({id:ev,shift_id:shift.id,kind,amount_cents:kind==='payout'?-amt:amt,method:'cash',reference_id:null,created_at:this._now(),note:a.p_reason||''});
    this._save();return true;
  }
  _saveProduct(a){
    const id=a.p_id||this._uuid();
    let p=this.db.products.find(z=>z.id===id);
    if(!p){p={id,store_id:'local-store',created_at:this._now()};this.db.products.push(p);}
    Object.assign(p,{name:a.p_name,barcode:a.p_barcode||'',unit:a.p_unit||'حبة',category:a.p_category||'',
      price_cents:Number(a.p_price_cents||0),cost_cents:Number(a.p_cost_cents||0),active:true,updated_at:this._now()});
    if(!p.stock_milli)p.stock_milli=Number(a.p_initial_stock_milli||0);
    this._save();return {id:p.id,name:p.name,price_cents:p.price_cents};
  }
  _adjustStock(a){
    const p=this.db.products.find(z=>z.id===a.p_product);
    if(!p)throw Error('الصنف غير موجود');
    const qty=Number(a.p_qty_milli||0);if(!(qty>0))throw Error('كمية غير صالحة');
    if(a.p_action==='loss'){if(Number(p.stock_milli||0)<qty)throw Error('الكمية أكبر من المتوفر');p.stock_milli=Number(p.stock_milli||0)-qty;}
    else p.stock_milli=Number(p.stock_milli||0)+qty;
    p.updated_at=this._now();this._save();return true;
  }
  _createCustomer(a){
    const id=a.p_id||this._uuid();
    if(!this.db.customers.find(c=>c.id===id))this.db.customers.push({id,store_id:'local-store',name:a.p_name,phone:a.p_phone||'',
      active:true,photo:null,created_at:this._now(),updated_at:this._now()});
    this._save();return {id};
  }
  _salesReturn(a){
    const inv=this.db.invoices.find(i=>i.id===a.p_invoice);
    if(!inv)throw Error('الفاتورة غير موجودة');
    if(inv.voided_at)throw Error('الفاتورة ملغاة — لا مرتجع عليها');
    const lines=Array.isArray(a.p_lines)?a.p_lines:[];
    if(!lines.length)throw Error('اختر كمية إرجاع واحدة على الأقل');
    const reason=String(a.p_reason||'').trim();
    if(reason.length<3)throw Error('اكتب سبب المرتجع');
    const method=['debt','cash','wallet','transfer'].includes(a.p_refund_method)?a.p_refund_method:'debt';
    let total=0;const done=[];
    for(const l of lines){
      const line=this.db.invoice_lines.find(z=>z.id===l.invoice_line_id&&z.invoice_id===inv.id);
      if(!line)throw Error('سطر غير موجود في الفاتورة');
      const qty=Number(l.qty_milli||0);
      if(!(qty>0))throw Error('كمية الإرجاع غير صالحة');
      if(qty>Number(line.qty_milli)-Number(line.returned_qty_milli||0))throw Error('كمية الإرجاع أكبر من المباع');
      line.returned_qty_milli=Number(line.returned_qty_milli||0)+qty;
      const amt=Math.round(Number(line.price_cents)*qty/1000);
      total+=amt;
      const p=this.db.products.find(z=>z.id===line.product_id);
      if(p)batchRestock(this,p,qty,a.p_invoice||a.p_id||'return','return');
      done.push({line_id:line.id,qty_milli:qty,amount_cents:amt});
    }
    const rid=a.p_id||this._uuid();
    this.db.returns.push({id:rid,invoice_id:inv.id,kind:'sales_return',total_cents:total,refund_method:method,
      reason,refund_reference:a.p_refund_reference||null,created_at:this._now(),lines:done});
    // المرتجع يُقيد دائمًا كسداد/إلغاء للدين (سالب) — وكخرج نقدي عند الردّ بغير «الخصم من الدين»
    this.db.debt_entries.push({id:rid,customer_id:inv.customer_id,invoice_id:inv.id,kind:'sales_return',amount_cents:-total,
      created_at:this._now(),note:reason,method:method==='debt'?null:method});
    if(method!=='debt'&&inv.customer_id){
      const shift=this._openShift();
      this.db.cash_entries.push({id:this._uuid(),shift_id:shift?shift.id:null,kind:'refund',amount_cents:-total,method,reference_id:rid,created_at:this._now()});
    }
    this._save();return {total_cents:total};
  }
  _voidInvoice(a){
    const inv=this.db.invoices.find(i=>i.id===a.p_invoice);
    if(!inv)throw Error('الفاتورة غير موجودة');
    if(inv.voided_at)return true;
    const reason=String(a.p_reason||'').trim();
    if(reason.length<3)throw Error('اكتب سبب الإلغاء');
    inv.voided_at=this._now();inv.void_reason=reason;
    if(Number(inv.due_cents)>0&&inv.customer_id)
      this.db.debt_entries.push({id:this._uuid(),customer_id:inv.customer_id,invoice_id:inv.id,kind:'invoice_void',amount_cents:-Number(inv.due_cents),
        created_at:this._now(),note:reason,method:null});
    for(const l of this.db.invoice_lines.filter(z=>z.invoice_id===inv.id)){
      const p=this.db.products.find(z=>z.id===l.product_id);
      if(p)batchRestock(this,p,Number(l.qty_milli)-Number(l.returned_qty_milli||0),a.p_invoice,'void');
    }
    this._save();return true;
  }
  _voidCollection(a){
    const c=this.db.collections.find(z=>z.id===(a.p_collection||a.p_event));
    if(!c)throw Error('التحصيل غير موجود');
    if(c.voided_at)return true;
    c.voided_at=this._now();
    if(!this.db.debt_entries.find(e=>e.id===c.id+'-void'))
      this.db.debt_entries.push({id:c.id+'-void',customer_id:c.customer_id,invoice_id:null,kind:'collection_void',
        amount_cents:Number(c.amount_cents),created_at:this._now(),note:'عكس تحصيل',method:c.method});
    this._save();return true;
  }
  _statement(customerId){
    const c=this.db.customers.find(z=>z.id===customerId);
    if(!c)throw Error('الزبون غير موجود');
    const rows=this.db.debt_entries.filter(d=>d.customer_id===customerId)
      .slice().sort((x,y)=>String(x.created_at).localeCompare(String(y.created_at))||String(x.id).localeCompare(String(y.id)));
    const labels={invoice_due:'فاتورة',owner_debit:'دين يدوي',collection:'تحصيل',invoice_void:'إلغاء فاتورة',collection_void:'عكس تحصيل',sales_return:'مرتجع بيع',sales_return_void:'إلغاء مرتجع'};
    let running=0,debit=0,credit=0;
    const entries=rows.map(d=>{
      running+=Number(d.amount_cents||0);
      const k=d.kind;
      if(['invoice_due','owner_debit','collection_void','sales_return_void'].includes(k))debit+=Number(d.amount_cents||0);
      if(['collection','invoice_void','sales_return'].includes(k))credit+=-Number(d.amount_cents||0);
      const inv=this.db.invoices.find(i=>i.id===d.invoice_id);
      return {id:d.id,kind:k,at:d.created_at,ref:inv?('#'+inv.number):'',amount_cents:Number(d.amount_cents||0),
        note:d.note||'',balance_after_cents:running};
    });
    const invoices=this.db.invoices.filter(i=>i.customer_id===customerId).slice()
      .sort((x,y)=>Number(x.number)-Number(y.number))
      .map(i=>({number:i.number,at:i.created_at,total_cents:i.total_cents,cash_cents:i.cash_paid_cents,due_cents:i.due_cents,
        voided:!!i.voided_at,void_reason:i.void_reason||'',
        lines:this.db.invoice_lines.filter(l=>l.invoice_id===i.id).map(l=>({name:l.name_snapshot,qty_milli:l.qty_milli,price_cents:l.price_cents,total_cents:l.line_total_cents}))}));
    return {customer_name:c.name,customer_phone:c.phone||'',entries,invoices,
      debit_cents:debit,credit_cents:credit,balance_cents:debit-credit,generated_at:this._now()};
  }
  _invoiceDetail(invoiceId){
    const inv=this.db.invoices.find(i=>i.id===invoiceId);
    if(!inv)throw Error('الفاتورة غير موجودة');
    return {...inv,lines:this.db.invoice_lines.filter(l=>l.invoice_id===invoiceId).map(l=>({
      line_id:l.id,product_id:l.product_id,name:l.name_snapshot,qty_milli:l.qty_milli,price_cents:l.price_cents,
      total_cents:l.line_total_cents,returned_qty_milli:Number(l.returned_qty_milli||0)}))};
  }
  _daily(date){
    const day=String(date||new Date().toISOString().slice(0,10));
    const sameDay=(iso)=>String(iso||'').slice(0,10)===day;
    const sales=this.db.invoices.filter(i=>sameDay(i.created_at)).map(i=>({
      number:i.number,created_at:i.created_at,total_cents:i.total_cents,cash_paid_cents:i.cash_paid_cents,
      other_paid_cents:Number(i.other_paid_cents||0),other_method:i.other_method,due_cents:i.due_cents,worker_id:i.worker_id,voided_at:i.voided_at}));
    const sales_totals={total_cents:0,cash_cents:0,other_cents:0,due_cents:0,count:sales.length};
    for(const s of sales){if(!s.voided_at){sales_totals.total_cents+=Number(s.total_cents);sales_totals.cash_cents+=Number(s.cash_paid_cents||0);
      sales_totals.other_cents+=Number(s.other_paid_cents||0);sales_totals.due_cents+=Number(s.due_cents||0);}}
    const sales_returns=this.db.returns.filter(r=>sameDay(r.created_at)).map(r=>({
      invoice_number:(this.db.invoices.find(i=>i.id===r.invoice_id)||{}).number??'—',total_cents:r.total_cents,refund_method:r.refund_method,reason:r.reason}));
    const collections=this.db.collections.filter(c=>sameDay(c.created_at)).map(c=>({
      customer_name:this.db.customers.find(z=>z.id===c.customer_id)?.name||'—',amount_cents:c.amount_cents,method:c.method}));
    const purchases=this.db.purchases.filter(p=>sameDay(p.created_at)).map(p=>({
      supplier_name:this.db.suppliers.find(s=>s.id===p.supplier_id)?.name||'—',total_cents:p.total_cents,paid_cents:p.paid_cents,
      due_cents:Number(p.total_cents)-Number(p.paid_cents),voided_at:p.voided_at}));
    const purchases_totals={total_cents:0,paid_cents:0,due_cents:0,count:purchases.length};
    for(const p of purchases){if(!p.voided_at){purchases_totals.total_cents+=Number(p.total_cents);purchases_totals.paid_cents+=Number(p.paid_cents||0);}}
    purchases_totals.due_cents=purchases_totals.total_cents-purchases_totals.paid_cents;
    const supplier_payments=this.db.supplier_ledger.filter(l=>l.kind==='payment'&&sameDay(l.created_at)).map(l=>({
      supplier_name:this.db.suppliers.find(s=>s.id===l.supplier_id)?.name||'—',amount_cents:l.amount_cents,note:l.note}));
    return {date:day,sales,sales_totals,sales_returns,collections,purchases,purchases_totals,supplier_payments};
  }
  _profit(from,to){
    const inRange=(iso)=>{const d=String(iso||'').slice(0,10);return (!from||d>=from)&&(!to||d<=to);};
    const invs=this.db.invoices.filter(i=>inRange(i.created_at)&&!i.voided_at);
    let revenue=0,cogs=0,ret=0,invCount=invs.length;
    const byProduct=new Map();
    for(const i of invs)for(const l of this.db.invoice_lines.filter(z=>z.invoice_id===i.id)){
      revenue+=Number(l.line_total_cents);cogs+=Math.round(Number(l.cost_cents||0)*Number(l.qty_milli)/1000);
      const e=byProduct.get(l.product_id)||{name:l.name_snapshot,revenue_cents:0,cogs_cents:0,qty_milli:0};
      e.revenue_cents+=Number(l.line_total_cents);e.cogs_cents+=Math.round(Number(l.cost_cents||0)*Number(l.qty_milli)/1000);
      e.qty_milli+=Number(l.qty_milli);byProduct.set(l.product_id,e);
    }
    for(const r of this.db.returns)if(inRange(r.created_at))ret+=Number(r.total_cents);
    const net=revenue-ret,gross=net-cogs;
    const byDayMap=new Map();
    for(const i of invs){const d=String(i.created_at).slice(0,10);const e=byDayMap.get(d)||{d,revenue_cents:0,invoices:0};
      e.revenue_cents+=Number(i.total_cents);e.invoices+=1;byDayMap.set(d,e);}
    return {net_revenue_cents:net,cogs_cents:cogs,gross_profit_cents:gross,
      margin_pct:net?Math.round(gross*1000/net)/10:0,from:from||'',to:to||'',invoices:invCount,returns_cents:ret,
      top_products:[...byProduct.values()].map(e=>({...e,profit_cents:e.revenue_cents-e.cogs_cents})).sort((x,y)=>y.profit_cents-x.profit_cents).slice(0,10),
      by_day:[...byDayMap.values()].sort((x,y)=>String(x.d).localeCompare(String(y.d)))};
  }
  _monitor(){
    const today=new Date().toISOString().slice(0,10);
    const t={sales_cents:0,invoices:0,collections_cents:0,cash_cents:0,credit_cents:0};
    for(const i of this.db.invoices)if(String(i.created_at).slice(0,10)===today&&!i.voided_at){
      t.sales_cents+=Number(i.total_cents);t.invoices+=1;t.cash_cents+=Number(i.cash_paid_cents||0)+Number(i.other_paid_cents||0);t.credit_cents+=Number(i.due_cents||0);}
    for(const c of this.db.collections)if(String(c.created_at).slice(0,10)===today)t.collections_cents+=Number(c.amount_cents);
    let out=0;for(const d of this.db.debt_entries)out+=Number(d.amount_cents||0);
    return {today:t,totals:{outstanding_cents:Math.max(out,0),sales_cents:this.db.invoices.reduce((s,i)=>s+(!i.voided_at?Number(i.total_cents):0),0),
      products:this.db.products.length,customers:this.db.customers.length},
      open_shifts:this._openShift()?[this._openShift()]:[],
      out_stock:this.db.products.filter(p=>p.active!==false&&Number(p.stock_milli||0)<=0).map(p=>({name:p.name})),
      low_stock:this.db.products.filter(p=>p.active!==false&&Number(p.stock_milli||0)>0&&Number(p.stock_milli||0)<=1000).map(p=>({name:p.name,stock_milli:p.stock_milli}))};
  }
  _supBalance(supplierId){let s=0;for(const l of this.db.supplier_ledger)if(l.supplier_id===supplierId)s+=Number(l.amount_cents||0);return s;}
  _purchase(a){
    const lines=Array.isArray(a.p_lines)?a.p_lines:[];
    if(!lines.length)throw Error('أضف بند شراء واحدًا على الأقل');
    const supplier=this.db.suppliers.find(z=>z.id===a.p_supplier);
    if(!supplier)throw Error('اختر مورّدًا');
    ensureBatches(this);
    const key=a.p_idempotency_key||null;
    if(key){const prev=this.db.purchases.find(z=>z.idempotency_key===key&&z.idempotency_key!=null);
      if(prev)return {id:prev.id,purchase_id:prev.id,total_cents:prev.total_cents,already_committed:true};}
    const pid=a.p_id||this._uuid();
    let total=0;
    for(const l of lines){
      const prod=this.db.products.find(z=>z.id===l.product_id);
      if(!prod)throw Error('صنف غير موجود');
      const qty=Number(l.qty_milli),cost=Number(l.cost_cents||0);
      if(!(qty>0))throw Error('كمية الشراء غير صالحة');
      const expRaw=l.expiry_date||l.expiry||null;
      const exp=isoDateValid(expRaw)?expRaw:null;
      if(expRaw&&expRaw!==''&&!exp)throw Error('تاريخ صلاحية بند غير صالح');
      prod.stock_milli=Number(prod.stock_milli||0)+qty;prod.cost_cents=cost;prod.updated_at=this._now();
      total+=Math.round(cost*qty/1000);
    }
    const declared=a.p_declared_total_cents==null?null:Number(a.p_declared_total_cents);
    if(declared!=null&&declared!==total)throw Error('مجموع البنود لا يطابق إجمالي فاتورة المورد المراجع؛ افصل الحسم أو الضريبة أو النقل ولا تضف الرصيد السابق');
    const paid=Number(a.p_paid_cents||0);
    if(!(paid>=0&&paid<=total))throw Error('المدفوع غير صالح');
    this.db.purchases.push({id:pid,supplier_id:a.p_supplier,total_cents:total,paid_cents:paid,created_at:this._now(),
      voided_at:null,note:a.p_note||'',invoice_ref:String(a.p_invoice_ref||'').slice(0,100),
      invoice_date:isoDateValid(a.p_invoice_date)?a.p_invoice_date:null,
      image_sha256:a.p_image_sha256||null,image_thumb:a.p_image_thumb||null,
      pay_kind:paid===total?'cash':'credit',idempotency_key:key,
      lines:lines.map(l=>{const er=l.expiry_date||l.expiry||null;return {product_id:l.product_id,qty_milli:Number(l.qty_milli),cost_cents:Number(l.cost_cents||0),
        expiry_date:isoDateValid(er)?er:null};})});
    for(const l of lines){ // دفعة مخزون لكل سطر شراء — بتاريخ صلاحيته أو «غير معلومة»
      this.db.batches.push({id:this._uuid(),product_id:l.product_id,purchase_id:pid,kind:'purchase',
        qty_milli:Number(l.qty_milli),expiry_date:isoDateValid(l.expiry_date||l.expiry)?(l.expiry_date||l.expiry):null,created_at:this._now()});
    }
    this.db.supplier_ledger.push({id:this._uuid(),supplier_id:a.p_supplier,kind:'purchase',amount_cents:total,purchase_id:pid,
      created_at:this._now(),note:a.p_note||''});
    if(paid>0)this.db.supplier_ledger.push({id:this._uuid(),supplier_id:a.p_supplier,kind:'payment',amount_cents:-paid,
      created_at:this._now(),note:'سداد مع فاتورة شراء'});
    this._save();return {id:pid,purchase_id:pid,total_cents:total};
  }
  _supplierReturn(a){
    const lines=Array.isArray(a.p_lines)?a.p_lines:[];
    if(!lines.length)throw Error('أضف بند مرتجع واحدًا على الأقل');
    let total=0;
    for(const l of lines){
      const p=this.db.products.find(z=>z.id===l.product_id);
      const qty=Number(l.qty_milli||0),cost=Number(l.cost_cents||0);
      if(!(qty>0))throw Error('كمية غير صالحة');
      if(p)p.stock_milli=Number(p.stock_milli||0)-qty;
      total+=Math.round(cost*qty/1000);
    }
    this.db.supplier_ledger.push({id:this._uuid(),supplier_id:a.p_supplier,kind:'return',amount_cents:-total,
      created_at:this._now(),note:a.p_note||''});
    this._save();return {total_cents:total};
  }
  _supStatement(supplierId){
    const rows=this.db.supplier_ledger.filter(l=>l.supplier_id===supplierId)
      .slice().sort((x,y)=>String(x.created_at).localeCompare(String(y.created_at))||String(x.id).localeCompare(String(y.id)));
    let running=0;
    return rows.map(l=>{
      running+=Number(l.amount_cents||0);
      const purchase=l.purchase_id?this.db.purchases.find(p=>p.id===l.purchase_id):null;
      return {kind:l.kind,amount_cents:Number(l.amount_cents||0),balance_cents:running,created_at:l.created_at,note:l.note||'',
        purchase_id:l.purchase_id||null,invoice_ref:purchase?.invoice_ref||null,invoice_date:purchase?.invoice_date||null,pay_kind:purchase?.pay_kind||null,
        lines:purchase?purchase.lines.map(pl=>{const p=this.db.products.find(z=>z.id===pl.product_id);
          return {name:p?.name||'صنف',qty_milli:pl.qty_milli,cost_cents:pl.cost_cents,expiry_date:pl.expiry_date||null,line_total_cents:Math.round(Number(pl.cost_cents)*Number(pl.qty_milli)/1000)};}):[]};
    });
  }
  _voidPurchase(purchaseId){
    const p=this.db.purchases.find(z=>z.id===purchaseId);
    if(!p)throw Error('فاتورة الشراء غير موجودة');
    if(p.voided_at)return true;
    p.voided_at=this._now();
    for(const l of p.lines){const pr=this.db.products.find(z=>z.id===l.product_id);
      if(pr)pr.stock_milli=Number(pr.stock_milli||0)-Number(l.qty_milli||0);}
    this.db.supplier_ledger.push({id:this._uuid(),supplier_id:p.supplier_id,kind:'purchase_void',amount_cents:-Number(p.total_cents),
      purchase_id:p.id,created_at:this._now(),note:'إلغاء فاتورة شراء'});
    this._save();return true;
  }
}

// ==== دفعات المخزون (حزمة قراءة الفواتير — المرحلة كاملة) ====
export function isoDateValid(x){
  if(typeof x!=='string'||!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(x))return false;
  const d=new Date(x+'T00:00:00Z');
  return !isNaN(d.getTime())&&d.toISOString().slice(0,10)===x;
}
function todayIso(){return new Date().toISOString().slice(0,10);}
export function ensureBatches(ls){
  const db=ls.db;if(!Array.isArray(db.batches))db.batches=[];
  if(!Array.isArray(db.batch_moves))db.batch_moves=[];
  // ذاتي الإصلاح: كل فرق بين مجموع الدفعات ورصيد الصنف يُسوّى بدفعة «تسوية»
  for(const p of db.products){
    const sum=db.batches.filter(b=>b.product_id===p.id).reduce((t,b)=>t+Number(b.qty_milli||0),0);
    const stock=Number(p.stock_milli||0);
    if(sum!==stock)db.batches.push({id:ls._uuid(),product_id:p.id,purchase_id:null,kind:'adjust',
      qty_milli:stock-sum,expiry_date:null,created_at:ls._now()});
  }
  return db;
}
export function sellableQty(ls,productId){ // غير المنتهي فقط
  ensureBatches(ls);const t=todayIso();
  return ls.db.batches.filter(b=>b.product_id===productId&&Number(b.qty_milli||0)>0&&(!b.expiry_date||b.expiry_date>=t))
    .reduce((s,b)=>s+Number(b.qty_milli),0);
}
export function assertSellable(ls,product,qtyM){
  ensureBatches(ls);
  if(Number(product.stock_milli||0)<qtyM)throw Error('الكمية المطلوبة غير متوفرة من: '+product.name);
  if(sellableQty(ls,product.id)<qtyM)throw Error('الكمية المتاحة من '+product.name+' منتهية الصلاحية — غير صالحة للبيع');
}
export function batchConsume(ls,product,qtyM,refId){ // صرف بالأقرب صلاحية أولًا (FEFO)
  ensureBatches(ls);const t=todayIso();
  const pool=ls.db.batches.filter(b=>b.product_id===product.id&&Number(b.qty_milli||0)>0&&(!b.expiry_date||b.expiry_date>=t))
    .sort((x,y)=>(x.expiry_date||'9999').localeCompare(y.expiry_date||'9999')||String(x.created_at).localeCompare(String(y.created_at)));
  let need=qtyM;
  for(const b of pool){
    if(need<=0)break;
    const take=Math.min(Number(b.qty_milli),need);
    b.qty_milli=Number(b.qty_milli)-take;need-=take;
    ls.db.batch_moves.push({id:ls._uuid(),batch_id:b.id,product_id:product.id,ref:refId,kind:'consume',
      qty_milli:take,released_qty_milli:0,created_at:ls._now()});
  }
  if(need>0)throw Error('الكمية غير متوفرة من: '+product.name);
  product.stock_milli=Number(product.stock_milli||0)-qtyM;
}
export function batchRestock(ls,product,qtyM,refId,kind){ // إرجاع على الدفعات الأصلية ثم دفعة مرتجعات
  ensureBatches(ls);
  if(!(qtyM>0))return;
  let need=qtyM;
  const moves=ls.db.batch_moves.filter(m=>m.product_id===product.id&&m.ref===refId&&m.kind==='consume');
  for(let i=moves.length-1;i>=0&&need>0;i--){ // آخر صرف أولًا
    const m=moves[i];const left=Number(m.qty_milli)-Number(m.released_qty_milli||0);
    if(left<=0)continue;
    const back=Math.min(left,need);
    const b=ls.db.batches.find(x=>x.id===m.batch_id);if(b)b.qty_milli=Number(b.qty_milli||0)+back;
    m.released_qty_milli=Number(m.released_qty_milli||0)+back;need-=back;
    ls.db.batch_moves.push({id:ls._uuid(),batch_id:m.batch_id,product_id:product.id,ref:refId,kind:'release',
      qty_milli:back,released_qty_milli:0,created_at:ls._now()});
  }
  if(need>0){
    let rb=ls.db.batches.find(b=>b.product_id===product.id&&b.kind==='returns'&&b.expiry_date==null);
    if(!rb){rb={id:ls._uuid(),product_id:product.id,purchase_id:null,kind:'returns',qty_milli:0,expiry_date:null,created_at:ls._now()};ls.db.batches.push(rb);}
    rb.qty_milli=Number(rb.qty_milli||0)+need;
    ls.db.batch_moves.push({id:ls._uuid(),batch_id:rb.id,product_id:product.id,ref:refId,kind:'release',
      qty_milli:need,released_qty_milli:0,created_at:ls._now()});
  }
  product.stock_milli=Number(product.stock_milli||0)+qtyM;
}
export function productBatches(ls,productId){
  ensureBatches(ls);const t=todayIso();
  return ls.db.batches.filter(b=>b.product_id===productId&&Number(b.qty_milli||0)!==0)
    .map(b=>({id:b.id,qty_milli:Number(b.qty_milli),expiry_date:b.expiry_date||null,
      expired:!!(b.expiry_date&&b.expiry_date<t),kind:b.kind,created_at:b.created_at}))
    .sort((x,y)=>(x.expiry_date||'9999').localeCompare(y.expiry_date||'9999'));
}
export function expiringBatches(ls,days){ // تقرير القريب انتهاءً + المنتهي
  ensureBatches(ls);const t=todayIso();const lim=new Date(Date.now()+Math.max(1,Number(days||30))*864e5).toISOString().slice(0,10);
  const out=[];
  for(const b of ls.db.batches){
    if(!(Number(b.qty_milli)>0))continue;
    const exp=b.expiry_date;if(!exp)continue;
    if(exp>lim)continue;
    const p=ls.db.products.find(z=>z.id===b.product_id);
    out.push({product_id:b.product_id,name:p?.name||'صنف',qty_milli:Number(b.qty_milli),
      expiry_date:exp,expired:exp<t,created_at:b.created_at,purchase_id:b.purchase_id||null});
  }
  return out.sort((x,y)=>x.expiry_date.localeCompare(y.expiry_date));
}

// ==== قواعد مسودة فاتورة الشراء (مرآة PurchaseDraftRules.kt — حرفية) ====
export function validatePurchaseDraft(draft){
  const rej=m=>({ok:false,reason:m});
  if(!draft||!draft.reviewedByOwner)return rej('راجع صورة الفاتورة وكل بند ثم أكّدها قبل الترحيل');
  if(!draft.imageSha256||!/^[a-f0-9]{64}$/.test(draft.imageSha256))return rej('أرفق صورة فاتورة الشراء الأصلية للتحقق منها');
  if(!draft.supplierId)return rej('اختر مورداً صحيحاً');
  if(!isoDateValid(draft.invoiceDateIso))return rej('تاريخ فاتورة الشراء غير صالح');
  const ref=String(draft.invoiceRef||'');
  if(ref.length>100||/[\u0000-\u001f\u007f]/.test(ref))return rej('رقم فاتورة المورد غير صالح');
  if(draft.paymentType!=='cash'&&draft.paymentType!=='credit')return rej('طريقة سداد المشتريات غير صحيحة');
  const lines=Array.isArray(draft.lines)?draft.lines:[];
  if(!lines.length||lines.length>500)return rej('أدخل بنود الفاتورة (حتى 500 سطر)');
  let total=0;
  for(let i=0;i<lines.length;i++){
    const l=lines[i],n=i+1;
    if(!l.reviewed)return rej('راجع السطر '+n+' من الفاتورة قبل الترحيل');
    if(!l.productId)return rej('اربط السطر '+n+' بصنف موجود');
    const qty=Number(l.quantity);
    if(!isFinite(qty)||!(qty>0)||qty>1000000)return rej('كمية السطر '+n+' غير صالحة');
    const unit=Number(l.unitCostCents);
    if(!Number.isSafeInteger(unit)||unit<0||unit>1000000000)return rej('تكلفة السطر '+n+' غير صالحة');
    if(l.expiryRequired&&!isoDateValid(l.expiryIso))return rej('أكّد تاريخ صلاحية السطر '+n);
    if(l.expiryIso!=null&&l.expiryIso!==''&&!isoDateValid(l.expiryIso))return rej('تاريخ صلاحية السطر '+n+' غير صالح');
    if(l.expiryIso&&draft.invoiceDateIso&&l.expiryIso<draft.invoiceDateIso)
      return rej('صلاحية السطر '+n+' أقدم من تاريخ الشراء؛ اعزله ولا تضفه للمخزون القابل للبيع');
    total+=Math.round(unit*qty); // تقريب إلى قرش (HALF_UP للموجب)
  }
  if(!(total>0))return rej('إجمالي فاتورة الشراء يجب أن يكون أكبر من صفر');
  const declared=Number(draft.declaredTotalCents);
  if(!(declared>0)||declared!==total)
    return rej('مجموع البنود لا يطابق إجمالي فاتورة المورد المراجع؛ افصل الحسم أو الضريبة أو النقل ولا تضف الرصيد السابق');
  const paid=draft.paidCents==null||draft.paidCents===''?null:Number(draft.paidCents);
  if(paid==null||isNaN(paid))return rej('حدد المبلغ المدفوع للمورد، ولو كان صفراً');
  if(!(paid>=0)||paid>total)return rej('المدفوع خارج إجمالي الفاتورة');
  if(draft.paymentType==='cash'&&paid!==total)return rej('فاتورة الشراء النقدية يجب أن تُدفع كاملة');
  if(draft.paymentType==='credit'&&paid===total)return rej('لا يوجد متبقٍ آجل؛ اختر النقدي');
  return {ok:true,total_cents:total,paid_cents:paid,debt_cents:total-paid};
}

// محلل أسطر OCR (المرجع ocrParse.mjs) — يُعاد تصديره هنا حتى يبقى استيراد web.js سطرًا واحدًا
export {normalizeDigits,parseOcrLine,parseOcrText} from './ocrParse.mjs';
