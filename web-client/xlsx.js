/* قراءة/كتابة ملفات Excel وCSV للاستيراد والتصدير (بلا اعتماد على حالة التطبيق).
   يعتمد على مكتبة fflate المحلية (assets/vendor/fflate.js).
   المبالغ في التصدير بالريال بمنزلتين عشريتين. */
(function(){
function arabicDigits(t){return String(t).replace(/[٠-٩]/g,d=>'٠١٢٣٤٥٦٧٨٩'.indexOf(d));}
function xlsxColumn(index){let n=index+1,out='';while(n){const r=(n-1)%26;out=String.fromCharCode(65+r)+out;n=Math.floor((n-1)/26);}return out;}

function xlsxEscape(value){return String(value??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');}

function xlsxSpec(kind,rows){
  if(kind==='invoices')return {name:'فواتير',heads:['رقم الفاتورة','المجموع قبل الخصم (ريال)','الخصم (ريال)','الإجمالي بعد الخصم (ريال)','الدين (ريال)','التاريخ'],data:rows.map(x=>[x.number,(Number(x.subtotal_cents||x.total_cents||0)/100).toFixed(2),(Number(x.discount_cents||0)/100).toFixed(2),(Number(x.total_cents||0)/100).toFixed(2),(Number(x.due_cents||0)/100).toFixed(2),x.created_at||''])};
  if(kind==='customers')return {name:'زبائن',heads:['اسم الزبون','الهاتف','تاريخ الإضافة'],data:rows.map(x=>[x.name||'',x.phone||'',x.created_at||''])};
  return {name:'ديون',heads:['معرف الزبون','معرف الفاتورة','نوع الحركة','المبلغ (ريال)','التاريخ'],data:rows.map(x=>[x.customer_id||'',x.invoice_id||'',x.kind||'',(Number(x.amount_cents||0)/100).toFixed(2),x.created_at||''])};
}

function xlsxRows(bytes){
  const z=window.fflate;if(!z?.unzipSync)throw Error('مكوّن قراءة Excel غير متاح');
  verifyXlsxZip(bytes);const files=z.unzipSync(new Uint8Array(bytes));const dec=new TextDecoder();
  const xml=(path)=>files[path]?new DOMParser().parseFromString(dec.decode(files[path]),'application/xml'):null;
  const strings=[];const ss=xml('xl/sharedStrings.xml');
  if(ss)for(const item of ss.getElementsByTagNameNS('*','si'))strings.push([...item.getElementsByTagNameNS('*','t')].map(t=>t.textContent||'').join(''));
  const wb=xml('xl/workbook.xml'),rels=xml('xl/_rels/workbook.xml.rels');let sheetPath='xl/worksheets/sheet1.xml';
  if(wb&&rels){const sheet=wb.getElementsByTagNameNS('*','sheet')[0],rid=sheet?.getAttribute('r:id');
    const rel=[...rels.getElementsByTagNameNS('*','Relationship')].find(r=>r.getAttribute('Id')===rid);
    if(rel?.getAttribute('Target'))sheetPath='xl/'+rel.getAttribute('Target').replace(/^\//,'').replace(/^xl\//,'');}
  const doc=xml(sheetPath);if(!doc)throw Error('ملف Excel لا يحتوي ورقة عمل قابلة للقراءة');
  const out=[];for(const row of doc.getElementsByTagNameNS('*','row')){const vals=[];for(const c of row.getElementsByTagNameNS('*','c')){
    const ref=c.getAttribute('r')||'A1',letters=(ref.match(/^[A-Z]+/i)||['A'])[0].toUpperCase();let col=0;for(const ch of letters)col=col*26+ch.charCodeAt(0)-64;col--;
    const t=c.getAttribute('t'),v=c.getElementsByTagNameNS('*','v')[0]?.textContent||'';
    vals[col]=t==='s'?(strings[Number(v)]||''):t==='inlineStr'?[...c.getElementsByTagNameNS('*','t')].map(x=>x.textContent||'').join(''):v;
  }out.push(vals.map(x=>x??''));}return out;
}

function makeXlsx(rows,sheetName='Rafiq'){
  const z=window.fflate;if(!z?.zipSync)throw Error('مكوّن Excel المحلي غير متاح');
  const xmlRows=rows.map((r,ri)=>`<row r="${ri+1}">${r.map((v,ci)=>{const ref=xlsxColumn(ci)+(ri+1);const n=typeof v==='number'&&Number.isFinite(v);return n?`<c r="${ref}" t="n"><v>${v}</v></c>`:`<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xlsxEscape(v)}</t></is></c>`;}).join('')}</row>`).join('');
  const files={
    '[Content_Types].xml':'<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels':'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml':`<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xlsxEscape(sheetName).slice(0,31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels':'<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml':`<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${xmlRows}</sheetData></worksheet>`
  };
  return z.zipSync(Object.fromEntries(Object.entries(files).map(([k,v])=>[k,new TextEncoder().encode(v)])),{level:6});
}

function verifyXlsxZip(bytes){
  const u=new Uint8Array(bytes),dv=new DataView(u.buffer,u.byteOffset,u.byteLength);let eocd=-1;
  for(let i=Math.max(0,u.length-65557);i<=u.length-22;i++)if(dv.getUint32(i,true)===0x06054b50)eocd=i;
  if(eocd<0)throw Error('ملف XLSX غير صالح أو مضغوط بطريقة غير مدعومة');
  const count=dv.getUint16(eocd+10,true),start=dv.getUint32(eocd+16,true);if(!count||count>100)throw Error('ملف Excel يجب أن يحتوي على 100 ملف داخلي كحد أقصى');
  let pos=start,total=0;
  for(let i=0;i<count;i++){
    if(pos+46>u.length||dv.getUint32(pos,true)!==0x02014b50)throw Error('فهرس ZIP غير صالح');
    const flags=dv.getUint16(pos+8,true),method=dv.getUint16(pos+10,true),size=dv.getUint32(pos+24,true),nameLen=dv.getUint16(pos+28,true),extra=dv.getUint16(pos+30,true),comment=dv.getUint16(pos+32,true);
    if((flags&1)||![0,8].includes(method)||size===0xffffffff)throw Error('ملف Excel مشفّر أو يستخدم ضغطًا غير مدعوم');
    if(pos+46+nameLen+extra+comment>u.length)throw Error('فهرس ZIP غير مكتمل');
    total+=size;if(total>30*1024*1024)throw Error('المحتوى غير المضغوط يتجاوز 30 ميغابايت');
    pos+=46+nameLen+extra+comment;
  }
}

async function exportXlsx(kind){
  const pack=await exportRows(kind),rows=pack.rows,spec=xlsxSpec(kind,rows);
  const note=`${rows.length} صف — ${pack.mode==='server'?'من الخادم':pack.mode==='server-id'?'من الخادم':'نسخة محلية'}${pack.warn?' • '+pack.warn:''}`;
  const msg=saveXlsx(`${kind}.xlsx`,[[...spec.heads],...spec.data]);return `${msg} • ${note}`;
}

function csvRows(text){
  text=String(text||'').replace(/^\uFEFF/,'');const first=text.split(/\r?\n/,1)[0]||'',sep=(first.match(/;/g)||[]).length>(first.match(/,/g)||[]).length?';':',';
  const rows=[];let row=[],cell='',quote=false;
  for(let i=0;i<text.length;i++){const c=text[i];if(quote){if(c==='"'&&text[i+1]==='"'){cell+='"';i++;}else if(c==='"')quote=false;else cell+=c;}
    else if(c==='"')quote=true;else if(c===sep){row.push(cell);cell='';}else if(c==='\n'){row.push(cell.replace(/\r$/,''));if(row.some(x=>String(x).trim()))rows.push(row);row=[];cell='';}else cell+=c;}
  row.push(cell.replace(/\r$/,''));if(row.some(x=>String(x).trim()))rows.push(row);return rows;
}

function normalizeImportDecimal(v){let s=arabicDigits(String(v??'').trim()).replace(/[٬\s]/g,'').replace(/٫/g,'.');if(s.includes(',')&&!s.includes('.'))s=/,\d{1,2}$/.test(s)?s.replace(',', '.'):s.replace(/,/g,'');return s;}
window.RafiqXlsx={read:xlsxRows,make:makeXlsx,verify:verifyXlsxZip,csv:csvRows,num:normalizeImportDecimal,spec:xlsxSpec};
})();
