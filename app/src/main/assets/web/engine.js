/*
 * محرّك الواجهة: يعرض القوالب المعتمدة (nunjucks) بالبيانات التي يعيدها الكود الأصلي (Kotlin).
 * كل تنقّل = تحميل index.html من جديد بالمعامل ?p=<المسار>، فتبقى الحالة في Kotlin (الجلسة والرسائل).
 * الواجهة لا تتصل بأي خادم: window.RafiqNative.page / api تستدعي Kotlin مباشرة.
 */
(function () {
  var BASE = location.href.split('?')[0].split('#')[0];
  var T = window.RAFIQ_TEMPLATES;
  var R = window.RAFIQ_ROUTES;
  var CUR = new URLSearchParams(location.search).get('p') || '/';

  /* ---------- nunjucks + مرشّحات بايثون ---------- */

  var Loader = nunjucks.Loader.extend({
    getSource: function (name) {
      return T[name] ? { src: T[name], path: name, noCache: true } : null;
    }
  });
  var env = new nunjucks.Environment(new Loader(), { autoescape: true });
  // قوالب Jinja تعدّ tojson آمناً للإدراج في السكربتات؛ بدونه يُهرَب الناتج (&quot;) ويتعطل السكربت
  env.addFilter('tojson', function (v) {
    var j = JSON.stringify(v === undefined ? null : v) || 'null';
    return nunjucks.runtime.markSafe(j.replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/'/g, '\\u0027'));
  });

  function fmtMoney(cents) {               // مطابق لـ Money.format
    cents = Number(cents || 0);
    var sign = cents < 0 ? '-' : '';
    var rials = Math.floor(Math.abs(cents) / 100);
    return sign + String(rials).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  env.addFilter('money', fmtMoney);
  env.addFilter('abs', function (x) { return Math.abs(Number(x)); });
  env.addFilter('min', function (a) { return Math.min.apply(null, a); });
  env.addFilter('slice', function (s, a, b) {
    return Array.isArray(s) ? s.slice(a, b) : String(s == null ? '' : s).slice(a, b);
  });
  env.addFilter('format', function (fmt) {
    var args = Array.prototype.slice.call(arguments, 1);
    var i = 0;
    return String(fmt).replace(/%(\.\d+)?([dfsg])/g, function (m, prec, kind) {
      var v = args[i++];
      if (kind === 'g') return String(parseFloat(Number(v).toPrecision(6)));
      if (kind === 'f') return Number(v).toFixed(prec ? parseInt(prec.slice(1), 10) : 6);
      if (kind === 'd') return String(Math.trunc(Number(v)));
      return String(v);
    });
  });
  env.addFilter('ago', function (ts) {     // مطابق لـ days_ago
    if (!ts) return '';
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ts));
    if (!m) return '';
    var d = new Date(+m[1], +m[2] - 1, +m[3]);
    var today = new Date();
    today = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    var diff = Math.round((today - d) / 86400000);
    if (diff <= 0) return 'اليوم';
    if (diff === 1) return 'أمس';
    if (diff === 2) return 'مضى يومان';
    if (diff <= 10) return 'مضت ' + diff + ' أيام';
    return 'مضى ' + diff + ' يوماً';
  });

  // مطابق لـ loc_text في النسخة الأصلية: «ممر 3 • رف ب» أو فارغ
  env.addGlobal('loc_text', function (p) {
    var a = String((p && p.aisle) == null ? '' : p.aisle).trim();
    var s = String((p && p.shelf) == null ? '' : p.shelf).trim();
    if (a && s) return 'ممر ' + a + ' • رف ' + s;
    if (a) return 'ممر ' + a;
    if (s) return 'رف ' + s;
    return '';
  });

  env.addGlobal('url_for', function (endpoint, kw) {
    if (endpoint === 'static') return 'static/' + ((kw && kw.filename) || '');
    var rule = R[endpoint];
    if (!rule) return '#';
    return rule.replace(/<(?:int:|str:|)(\w+)>/g, function (_, k) {
      return kw && kw[k] != null ? encodeURIComponent(kw[k]) : '';
    });
  });

  /* ---------- الجسر إلى Kotlin ---------- */

  function callPage(method, p, body) {
    return JSON.parse(window.RafiqNative.page(method, p, body || ''));
  }

  /* التنقل بلا إعادة تحميل: الشاشة تُجلب من Kotlin وتُعرض مباشرة (كانت كل نقرة تعيد تحميل الصفحة كاملة) */
  function go(p) {
    // لا تبقَ جلسة المالك السحابية في ذاكرة الصفحة بعد تبديل حساب التطبيق المحلي.
    if ((p === '/logout' || p === '/login') && window.RafiqCloudShift) window.RafiqCloudShift.localLogout();
    show(callPage('GET', p, ''));
  }

  /* ---------- تبديل الشاشة داخل الصفحة نفسها ----------
     تُستبدل محتويات <body> فقط. سكربتات الشاشة تعمل في نطاق مستقل (فلا تتعارض let/const عند تكرار الزيارة)،
     وما تسجّله الشاشة من مستمعات ومؤقتات يُزال عند الانتقال إلى شاشة أخرى. */
  var booted = false, tracking = false, listening = false;
  var pageListeners = [], pageTimers = [];
  var nDocAdd = document.addEventListener, nDocRemove = document.removeEventListener;
  var nWinAdd = window.addEventListener, nWinRemove = window.removeEventListener;
  var nSetInterval = window.setInterval, nClearInterval = window.clearInterval;
  document.addEventListener = function (t, fn, o) {
    if (tracking) pageListeners.push([document, t, fn, o]);
    return nDocAdd.call(document, t, fn, o);
  };
  window.addEventListener = function (t, fn, o) {
    if (tracking) pageListeners.push([window, t, fn, o]);
    return nWinAdd.call(window, t, fn, o);
  };
  window.setInterval = function () {
    var id = nSetInterval.apply(window, arguments);
    if (tracking) pageTimers.push(id);
    return id;
  };
  function clearPage() {
    pageListeners.forEach(function (l) {
      if (l[0] === window) nWinRemove.call(window, l[1], l[2], l[3]);
      else nDocRemove.call(document, l[1], l[2], l[3]);
    });
    pageListeners = [];
    pageTimers.forEach(function (id) { nClearInterval.call(window, id); });
    pageTimers = [];
  }
  function runPageScript(code) {
    // أسماء المستوى الأعلى تُصدَّر إلى window، لأن أزرار onclick في القوالب تستدعيها باسمها
    var exp = [];
    code.replace(/^(?:async\s+)?function\s+(\w+)/gm, function (m, n) {
      exp.push('window[' + JSON.stringify(n) + ']=' + n + ';');
      return m;
    });
    code.replace(/^(?:const|let|var)\s+(\w+)/gm, function (m, n) {
      exp.push('Object.defineProperty(window,' + JSON.stringify(n) + ',{configurable:true,get:function(){return ' + n +
        ';},set:function(v){' + n + '=v;}});');
      return m;
    });
    try {
      new Function(code + '\n;' + exp.join('\n'))();
    } catch (e) {
      console.error('سكربت الشاشة:', e);
    }
  }
  function runPageScripts(list) {
    tracking = true;
    try { list.forEach(runPageScript); } finally { tracking = false; }
  }

  function show(res) {
    if (res.redirect) { go(res.redirect); return; }
    closeMenu();
    if (res.download) {   // ملف للتنزيل (نموذج الاستيراد): يفتح واجهة الحفظ في الجهاز
      if (window.RafiqDevice) window.RafiqDevice.saveText(res.download.name, res.download.text);
      return;
    }
    CUR = res.path || CUR;
    syncNav(CUR);
    var ctx = res.ctx || {};
    ctx.request = { endpoint: res.endpoint, args: {}, path: CUR };
    // قواميس بايثون: كل قيمة كائنية في السياق تحصل على get(k, افتراضي) غير مرئية (مثل PL.get و K.get)
    Object.keys(ctx).forEach(function (key) {
      var v = ctx[key];
      if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.get !== 'function') {
        Object.defineProperty(v, 'get', {
          enumerable: false,
          value: function (k, d) { return Object.prototype.hasOwnProperty.call(this, k) ? this[k] : (d === undefined ? null : d); }
        });
        // dict.items() في بايثون: أزواج [مفتاح، قيمة] تُقرأ في الحلقات for k, v in X.items()
        Object.defineProperty(v, 'items', {
          enumerable: false,
          value: function () { var self = this; return Object.keys(self).map(function (k) { return [k, self[k]]; }); }
        });
      }
    });
    ctx.get_flashed_messages = function () { return res.flashes || []; };
    var html = env.render(res.template, ctx);
    var doc = new DOMParser().parseFromString(html, 'text/html');
    var inline = [], srcs = [];
    Array.prototype.forEach.call(doc.querySelectorAll('script'), function (s) {
      if (s.getAttribute('src')) srcs.push(s.getAttribute('src'));
      else inline.push(s.textContent);
      s.parentNode.removeChild(s);
    });
    var wasBooted = booted;
    booted = true;
    // لا نستعمل document.open/write هنا: هذا الكود يعمل داخل سكربت يُحلَّل الآن، فيتأخر ما يُكتب
    // إلى ما بعد هذا السكربت، وتفقد سكربتات الشاشة عناصرها (هذا ما أوقف أزرار الدخول).
    clearPage();
    if (!wasBooted) {
      // ورقة التنسيق والأيقونة من القالب تُضاف إلى رأس الصفحة مرة واحدة
      Array.prototype.forEach.call(doc.querySelectorAll('link[rel="stylesheet"], link[rel="icon"]'), function (l) {
        var href = l.getAttribute('href');
        if (!document.querySelector('link[href="' + href + '"]')) {
          document.head.appendChild(l.cloneNode(true));
        }
      });
    }
    document.title = doc.title;
    document.body.className = doc.body.className;
    document.body.innerHTML = doc.body.innerHTML;
    if (ctx.cloud_shift_only && CUR !== '/cash' && CUR !== '/pos' &&
        CUR !== '/customers' && CUR !== '/' && CUR !== '/home' && CUR !== '/remote-eye' &&
        CUR !== '/login' && CUR !== '/license' && CUR !== '/cloud/setup') {
      var archiveBanner = document.createElement('div');
      archiveBanner.className = 'flash error no-print';
      archiveBanner.textContent = 'هذه الصفحة أرشيف هذا الهاتف فقط؛ لا تُزامن أرقامها مع الخادم أو الهاتف الآخر. قيود المال المحلية متوقفة، ودفتر المتجر الجديد في البيع والصندوق والزبائن المتصلة.';
      var content = document.querySelector('.wrap');
      if (content) content.insertBefore(archiveBanner, content.firstChild);
    }
    if (window.scrollTo) window.scrollTo(0, 0);
    attach();
    history.replaceState(null, '', BASE + '?p=' + encodeURIComponent(CUR));
    loadScripts(srcs, function () {
      // app.js عند تحميله أول مرة يعرّف openCameraScanner للمتصفح؛ نعيد ضبط جسر
      // ماسح أندرويد بعده حتى تعمل الكاميرا حتى عند بدء WebView من صفحة الصنف مباشرة.
      installDeviceHooks();
      runPageScripts(inline);
      // التفريغ الصوتي تعبئة نموذج فقط؛ لا يُرسل النموذج أو يضيف صنفاً إلى القاعدة.
      if (voiceNewProductDraft) {
        var draft = voiceNewProductDraft;
        voiceNewProductDraft = null;
        if (res.endpoint === 'product_new' && res.status === 200) {
          var name = document.getElementById('productName');
          var price = document.getElementById('productPrice');
          var barcode = document.getElementById('bc');
          var stock = document.getElementById('productStock');
          if (name && price && barcode && stock) {
            name.value = draft.name || '';
            if (draft.price) price.value = String(draft.price);
            if (draft.barcode) {
              barcode.value = draft.barcode;
              if (typeof window.fillStockRoots === 'function') {
                Promise.resolve(window.fillStockRoots()).catch(function () { /* يختار الباركود يدوياً عند فشل البحث */ });
              }
            }
            if (draft.stock) stock.value = draft.stock;
            var note = voiceNode('p', 'مسودة من كلامك: راجع الاسم والسعر والباركود والرصيد، ثم اضغط «حفظ» بنفسك.', 'hint');
            name.closest('.product-card').insertBefore(note, name.closest('form'));
          }
        }
      }
      // الشاشة الجديدة لا تُطلق حدث load من جديد: نطلقه يدوياً (الفاتورة تنتظره للطباعة التلقائية)
      if (wasBooted) window.dispatchEvent(new Event('load'));
    });
  }

  /* سكربتات المكتبة المشتركة (app.js) تُحمَّل مرة واحدة، ثم تُشغَّل سكربتات الشاشة بعدها بالترتيب */
  var loadedSrc = {};
  function loadScripts(list, done) {
    var todo = list.filter(function (src) { return !loadedSrc[src]; });
    (function next(i) {
      if (i >= todo.length) { done(); return; }
      var el = document.createElement('script');
      el.src = todo[i];
      el.onload = function () { loadedSrc[todo[i]] = true; next(i + 1); };
      el.onerror = function () { next(i + 1); };
      document.body.appendChild(el);
    })(0);
  }

  /* ---------- مكدّس الشاشات للرجوع ----------
   التنقل بـ location.replace لا يسجّل تاريخاً، لذلك نحفظ مسار الشاشات بأنفسنا في sessionStorage.
   الرئيسية تُعيد المكدّس إلى نفسها، والدخول يبدأ مكدّساً جديداً، فالرجوع من الرئيسية يُغلق التطبيق. */
  function navLoad() {
    try { return JSON.parse(sessionStorage.getItem('rafiqNav') || '[]'); } catch (e) { return []; }
  }
  function navSave(st) {
    try { sessionStorage.setItem('rafiqNav', JSON.stringify(st)); } catch (e) { /* لا شيء */ }
  }
  function syncNav(p) {
    var st = navLoad();
    if (st.length && st[st.length - 1] === p) return;
    if (p === '/login' || p === '/') {
      st = [p];
    } else {
      var i = st.lastIndexOf(p);
      if (i >= 0) st = st.slice(0, i + 1); else st.push(p);
    }
    navSave(st);
  }
  /* يُستدعى من Kotlin عند زر الرجوع: true إن عاد إلى شاشة سابقة، وfalse إن لم توجد */
  window.__rafiqBack = function () {
    if (document.getElementById('rafiqVoiceShade')) { closeVoice(); return true; }
    if (menuOpen()) { closeMenu(); return true; }   // الرجوع يغلق القائمة الجانبية أولاً
    var st = navLoad();
    if (st.length < 2) return false;
    st.pop();
    navSave(st);
    go(st[st.length - 1]);
    return true;
  };

  /* ---------- ميزات الجهاز (تعمل داخل التطبيق فقط) ---------- */

  /* الكلام يقترح مسودة/شاشة مراجعة فقط؛ كتابة البيع والدين تتطلب تأكيد اللمس في شاشة الدفع. */
  function voiceNormalize(raw) {
    return String(raw || '').normalize('NFKC')
      .replace(/[٠-٩۰-۹]/g, function (digit) {
        var n = '٠١٢٣٤٥٦٧٨٩'.indexOf(digit);
        return String(n >= 0 ? n : '۰۱۲۳۴۵۶۷۸۹'.indexOf(digit));
      })
      .replace(/[\u064b-\u065f\u0670\u0640]/g, '')
      .replace(/[إأآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
      .replace(/[^\p{L}\p{N}#]+/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  }
  var VOICE_PAGES = [
    {path: '/', label: 'الرئيسية', names: ['الرئيسية', 'الصفحة الرئيسية', 'الصفحة الأولى', 'البيت']},
    {path: '/pos', label: 'البيع', names: ['البيع', 'نقطة البيع', 'الكاشير', 'شاشة البيع', 'فاتورة جديدة']},
    {path: '/products', label: 'الأصناف', names: ['الأصناف', 'المنتجات', 'المخزون', 'قائمة الأصناف']},
    {path: '/products/new', label: 'إضافة صنف جديد', names: ['إضافة صنف', 'صنف جديد', 'إضافة منتج']},
    {path: '/customers', label: 'الزبائن', names: ['الزبائن', 'العملاء', 'دفتر الديون', 'ديون العملاء']},
    {path: '/suppliers', label: 'الموردين', names: ['الموردين', 'الموردون', 'المورد']},
    {path: '/cash/report', label: 'تقرير الصندوق', names: ['تقرير الصندوق', 'كشف الصندوق']},
    {path: '/cash', label: 'الصندوق', names: ['الصندوق', 'الدرج', 'درج النقد']},
    {path: '/reports', label: 'التقارير', names: ['التقارير', 'تقرير المبيعات']},
    {path: '/imports', label: 'الاستيراد', names: ['الاستيراد', 'استيراد البيانات']},
    {path: '/settings', label: 'الإعدادات', names: ['الإعدادات', 'اعدادات التطبيق']},
    {path: '/users', label: 'المستخدمين', names: ['المستخدمين', 'العمال']},
    {path: '/logout', label: 'تسجيل الخروج', names: ['تسجيل الخروج', 'خروج']}
  ];
  function voiceCommand(said) {
    var s = voiceNormalize(said);
    if (!s || s.length > 120) return null;
    var newProduct = s.match(/^(?:اضف|سجل|انشئ|افتح) (?:صنف|منتج) جديد(?: (.+))?$/);
    if (newProduct) {
      var rest = newProduct[1] || '';
      var spokenRest = String(said || '').trim().replace(/^[^\s]+\s+(?:صنف|منتج)\s+جديد\s*/u, '').trim();
      var priced = rest.match(/^(.+?) بسعر (\d{1,8})(?: باركود (\d{3,20}))?(?: رصيد (\d{1,5}))?$/);
      if (rest.indexOf('بسعر') >= 0 && !priced) return null;
      // احتفظ بإملاء اسم الصنف كما سمعه الهاتف؛ تطبيع «ة» إلى «ه» مخصص للمطابقة فقط.
      var rawName = priced ? ((spokenRest.match(/^(.*?)\s+بسعر\s+/u) || [])[1] || priced[1]).trim() : spokenRest;
      var draft = priced ? {name: rawName || priced[1], price: Number(priced[2]), barcode: priced[3] || '',
        stock: priced[4] || ''} : {name: rawName || rest};
      if (draft.name.length > 70 || (priced && (draft.price < 1 || draft.price > 999999))) return null;
      return {type: 'new_product', path: '/products/new', productDraft: draft,
        label: 'نموذج صنف جديد' + (draft.name ? ': ' + draft.name : '') +
          (priced ? '، سعر البيع ' + draft.price +
            (draft.barcode ? '، الباركود ' + draft.barcode : '، الباركود غير محدد') +
            (draft.stock ? '، الرصيد ' + draft.stock : '، الرصيد غير محدد') +
            '؛ راجع الحقول واحفظ بيدك' : '؛ أدخل السعر والباركود وراجعهما قبل الحفظ')};
    }
    var add = s.match(/^(?:اضف|ضيف|حط|زود|زد)(?: لي)?(?: صنف)? (.+)$/);
    if (add) {
      var name = add[1], qty = 1;
      var counted = name.match(/^(.*?) (?:عدد|كميه) (\d+)$/);
      var before = name.match(/^(\d+) (.+)$/);
      if (counted) { name = counted[1]; qty = Number(counted[2]); }
      else if (before) { name = before[2]; qty = Number(before[1]); }
      if (!name || name.length > 70 || !Number.isInteger(qty) || qty < 1 || qty > 100) return null;
      return {type: 'cart', query: name, qty: qty, label: 'إضافة ' + name + ' × ' + qty + ' إلى سلة البيع'};
    }
    var sale = s.match(/^(?:بع|بيع|سجل بيع|سجل فاتوره)(?: (نقدي|نقدا|كاش|اجل|اجله))?(?: (?:للزبون|للعميل|لزبون|لعميل) (.+))?$/);
    if (sale) {
      if (!sale[1]) return {type: 'manual', label: 'حدّد نقدي أو آجل ثم راجع بيانات البيع'};
      var kind = /^(?:اجل|اجله)$/.test(sale[1]) ? 'credit' : 'cash';
      if (kind === 'cash' && sale[2]) return {type: 'manual', label: 'لا تربط زبوناً ببيع نقدي من كلام قد يلتبس'};
      if (sale[2] && sale[2].length > 70) return null;
      return {type: 'checkout', kind: kind, customerQuery: sale[2] || '',
        label: kind === 'cash' ? 'تحضير بيع نقدي' : 'تحضير بيع آجل واختيار الزبون'};
    }
    var print = s.match(/^(?:اطبع|طبع|اطبع لي) (?:الفاتوره|فاتوره|اخر فاتوره)(?: (حراري|a4|اي فور|ايه فور))?$/);
    if (print) return {type: 'print', mode: /^(?:a4|اي فور|ايه فور)$/.test(print[1] || '') ? 'a4' : 'receipt',
      label: 'طباعة الفاتورة'};
    var share = s.match(/^(?:ارسل|ابعث|شارك)(?: لي)? (?:الفاتوره|فاتوره|اخر فاتوره)(?: (?:للزبون|للعميل) (.+?))?(?: (?:عبر )?واتساب)?$/);
    if (share) return {type: 'share', recipient: share[1] || '', label: 'مشاركة فاتورة PDF للزبون'};
    var m = s.match(/^(?:ابحث عن|ابحث|بحث عن|دور علي|دور على|وين|فين|اين) (.+)$/);
    if (m) {
      var q = m[1];
      var customer = q.match(/^(?:الزبون|زبون|العميل|عميل|العملاء|الزبائن) (.+)$/);
      if (customer) q = customer[1];
      q = q.trim();
      if (q.length < 2 || q.length > 70) return null;
      return {type: 'search', path: (customer ? '/customers?q=' : '/find?q=') +
        encodeURIComponent(q), label: (customer ? 'بحث عن زبون: ' : 'بحث عن صنف: ') + q};
    }
    var item = s.replace(/^(?:افتحلي|افتح لي|افتح|اعرض|اظهر|وريني|اذهب|روح|وديني|خذني)(?: (?:لي|الي|على))? /, '');
    if (item.indexOf('لل') === 0) item = 'ال' + item.slice(2); // «روح للبيع»
    for (var i = 0; i < VOICE_PAGES.length; i++) {
      for (var j = 0; j < VOICE_PAGES[i].names.length; j++) {
        if (item === voiceNormalize(VOICE_PAGES[i].names[j])) {
          return {type: 'page', path: VOICE_PAGES[i].path, label: VOICE_PAGES[i].label};
        }
      }
    }
    if (/^(?:بع|بيع|سدد|سدّد|سجل|سجّل|اضف|زود|احذف|امسح|الغ|حول|انقل|ادفع|اقبض|حصل) /.test(s)) {
      return {type: 'manual', label: 'هذه عملية مالية أو تعديل؛ راجعها يدوياً قبل الحفظ.'};
    }
    return null;
  }
  // تُبقي الاختبارات القديمة على اسم الدالة، لكن لا تنفّذ أي مسار من نص ملتبس.
  window.rafiqVoiceCommand = voiceCommand;
  window.rafiqVoiceRoute = function (said) {
    var c = voiceCommand(said);
    return c && c.path || null;
  };

  function say(msg) {
    var old = document.getElementById('rafiqSay');
    if (old) old.parentNode.removeChild(old);
    var d = document.createElement('div');
    d.id = 'rafiqSay';
    d.setAttribute('style', 'position:fixed;left:50%;top:14px;transform:translateX(-50%);z-index:9999;background:#002651;color:#fff;padding:10px 16px;border-radius:10px;font-size:15px;max-width:90%');
    d.textContent = msg;
    document.body.appendChild(d);
    setTimeout(function () { if (d.parentNode) d.parentNode.removeChild(d); }, 2500);
  }

  var voicePending = false;
  var voiceChoice = null;
  var voiceNewProductDraft = null;
  var voiceSeq = 0;
  var voiceExecuting = false;
  function voiceNode(tag, text, cls) {
    var el = document.createElement(tag);
    if (text) el.textContent = text; // لا نُدخل ما سمعه الهاتف إلى HTML.
    if (cls) el.className = cls;
    return el;
  }
  function voiceStatus(text) {
    var status = document.getElementById('rafiqVoiceStatus');
    if (status) status.textContent = text;
  }
  function closeVoice() {
    voiceSeq++; // تجاهل أي بحث أو نتيجة قديمة بعد إغلاق المراجعة.
    var panel = document.getElementById('rafiqVoiceShade');
    if (panel) panel.remove();
    voicePending = false;
    voiceChoice = null;
    var mic = document.getElementById('rafiqMic');
    if (mic && !document.querySelector('.modal.open')) mic.focus();
  }
  function voiceLive(seq) { return seq === voiceSeq && !!document.getElementById('rafiqVoiceShade'); }
  function voiceReady(heard, action, detail, label) {
    var preview = document.getElementById('rafiqVoicePreview');
    var goButton = document.getElementById('rafiqVoiceGo');
    if (!preview || !goButton) return;
    voiceChoice = action;
    preview.textContent = 'سمعت: «' + heard + '». ' + detail;
    goButton.textContent = label;
    goButton.disabled = false;
    goButton.style.display = '';
    voiceStatus('راجع الاسم والعدد والمبلغ أو الزبون، ثم اضغط إذا كانت المعلومات صحيحة.');
  }
  function moneyVoice(cents) {
    return fmtMoney(cents) + (window.CURRENCY ? ' ' + window.CURRENCY : '');
  }
  function currentVoiceInvoiceId() {
    var current = /^\/invoice\/(\d+)$/.exec(CUR);
    if (current) return Number(current[1]);
    if (CUR === '/pos' && window.rafiqVoicePos && window.rafiqVoicePos.lastInvoiceId) {
      return window.rafiqVoicePos.lastInvoiceId();
    }
    return null;
  }
  function readVoiceInvoice(id) {
    // GET فقط: الصلاحية والرخصة والفاتورة تُفحص مجدداً في NativeApi.
    var response = JSON.parse(window.RafiqNative.page('GET', '/invoice/' + id, ''));
    if (response.status !== 200 || response.endpoint !== 'invoice' || !response.ctx ||
        !response.ctx.inv || Number(response.ctx.inv.id) !== id) {
      throw new Error('لا يمكن فتح هذه الفاتورة في الجلسة الحالية.');
    }
    if (response.ctx.inv.status !== 'open') throw new Error('الفاتورة ملغاة؛ لا تطبعها أو تشاركها بالصوت.');
    return response.ctx;
  }
  function voicePreview(heard, action) {
    var seq = ++voiceSeq;
    voiceChoice = null;
    var preview = document.getElementById('rafiqVoicePreview');
    var choices = document.getElementById('rafiqVoiceChoices');
    var goButton = document.getElementById('rafiqVoiceGo');
    if (!preview || !choices || !goButton) return;
    preview.textContent = ''; choices.textContent = ''; goButton.style.display = 'none';
    if (action.path) {
      voiceReady(heard, action, 'المقترح: ' + action.label + '.',
        action.type === 'search' ? 'أظهر نتائج البحث' : action.path === '/logout' ? 'تأكيد الخروج' : 'افتح الصفحة');
      return;
    }
    if (action.type === 'cart') {
      if (CUR !== '/pos' || !window.rafiqVoicePos) {
        voiceStatus('افتح شاشة البيع أولاً، ثم أعد طلب إضافة الصنف.'); return;
      }
      voiceStatus('أبحث عن الصنف في المتجر…');
      Promise.resolve(window.rafiqVoicePos.findProducts(action.query)).then(function (rows) {
        if (!voiceLive(seq)) return;
        rows = Array.isArray(rows) ? rows.filter(function (p) {
          return p && (window.rafiqVoicePos.cloud ?
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(p.id)) : p.id > 0);
        }) : [];
        var q = voiceNormalize(action.query);
        var exact = rows.filter(function (p) {
          return voiceNormalize(p.name) === q || String(p.barcode || '') === q;
        });
        var options = exact.length ? exact : rows;
        if (!options.length) { voiceStatus('لم أجد هذا الصنف؛ لا أضيف صنفاً بالتخمين.'); return; }
        function choose(p) {
          if (!voiceLive(seq)) return;
          choices.textContent = '';
          voiceReady(heard, Object.assign({}, action, {product: p}),
            'الصنف: ' + p.name + '، العدد: ' + action.qty + '، سعر الواحد: ' + moneyVoice(p.price_cents) +
              '، رصيده المعروض: ' + p.stock + '. هذه إضافة إلى السلة فقط، وليست بيعاً.', 'أضف إلى السلة');
        }
        if (exact.length === 1) { choose(exact[0]); return; }
        voiceStatus(exact.length > 1 ? 'للاسم أكثر من صنف؛ اختر الوجه والسعر بيدك.' :
          'لم أجد اسماً مطابقاً تماماً؛ اختر الصنف المقصود بيدك أو أعد المحاولة.');
        options.slice(0, 8).forEach(function (p) {
          var b = voiceNode('button', p.name + ' — ' + moneyVoice(p.price_cents) +
            ' — رصيد ' + p.stock + ' — رقم ' + p.id, 'btn ghost sm wide');
          b.type = 'button'; b.addEventListener('click', function () { choose(p); });
          choices.appendChild(b);
        });
      }).catch(function (e) { if (voiceLive(seq)) voiceStatus(e.message || 'تعذّر البحث عن الصنف.'); });
      return;
    }
    if (action.type === 'checkout') {
      if (CUR !== '/pos' || !window.rafiqVoicePos) {
        voiceStatus('افتح شاشة البيع أولاً، ثم أعد طلب البيع.'); return;
      }
      try {
        var quote = window.rafiqVoicePos.quote();
        var summary = quote.lines.slice(0, 8).join('، ') + (quote.lines.length > 8 ? '، وأصناف أخرى' : '');
        var detail = 'سلة البيع: ' + summary + '. الإجمالي بعد الخصم: ' + moneyVoice(quote.totalCents) +
          (action.kind === 'credit' ? '. البيع آجل؛ اختر الزبون وراجع دينه قبل الحفظ' +
            (action.customerQuery ? '، البحث المقترح: ' + action.customerQuery : '') : '. البيع نقدي') +
          '. بعد هذا الزر ستظهر نافذة الدفع؛ لا يُحفظ البيع حتى تضغط تأكيدها بيدك.';
        voiceReady(heard, Object.assign({}, action, {quote: quote}), detail, 'راجع نافذة الدفع');
      } catch (e) { voiceStatus(e.message || 'تعذّر تجهيز البيع.'); }
      return;
    }
    if (action.type === 'print' || action.type === 'share') {
      var id = currentVoiceInvoiceId();
      if (!id) { voiceStatus('افتح فاتورة محفوظة أولاً أو احفظ البيع من شاشة الدفع.'); return; }
      try {
        var ctx = readVoiceInvoice(id);
        var inv = ctx.inv, customer = ctx.customer;
        if (action.type === 'share') {
          if (!window.RafiqDevice || !window.RafiqDevice.shareInvoicePdf || !customer || !customer.phone) {
            throw new Error('مشاركة PDF تحتاج فاتورة مرتبطة بزبون له رقم هاتف صالح.');
          }
          if (action.recipient && voiceNormalize(action.recipient) !== voiceNormalize(customer.name)) {
            throw new Error('الاسم المسموع لا يطابق الزبون في الفاتورة؛ لم أُرسل شيئاً.');
          }
        }
        var detailInvoice = 'فاتورة رقم ' + inv.number + '، الإجمالي ' + moneyVoice(inv.total_cents) +
          (customer ? '، الزبون ' + customer.name : '، بلا زبون مرتبط');
        if (action.type === 'share') detailInvoice += '، هاتفه ' + customer.phone +
          '، دينه الحالي ' + moneyVoice(customer.balance_cents) +
          '. بعد التأكيد سيفتح منتقي إرسال PDF؛ اختر المستلم الصحيح داخل التطبيق، ولن نعتبرها مرسلة تلقائياً.';
        else detailInvoice += '. بعد التأكيد تظهر نافذة الطباعة من الهاتف.';
        voiceReady(heard, Object.assign({}, action, {invoiceId: id, invoiceNumber: inv.number,
          totalCents: inv.total_cents, customerId: customer && customer.id,
          customerPhone: customer && customer.phone, customerBalance: customer && customer.balance_cents}),
          detailInvoice, action.type === 'share' ? 'افتح مشاركة PDF' : 'افتح الطباعة');
      } catch (e) { voiceStatus(e.message || 'تعذّر مراجعة الفاتورة.'); }
      return;
    }
    voiceStatus('لم أفهم الأمر؛ لا أنفّذ شيئاً غير معروف.');
  }
  function sameVoiceAction(a, b) {
    return a.type === b.type && a.path === b.path && a.query === b.query && a.qty === b.qty &&
      a.kind === b.kind && a.customerQuery === b.customerQuery && a.mode === b.mode && a.recipient === b.recipient &&
      JSON.stringify(a.productDraft || null) === JSON.stringify(b.productDraft || null);
  }
  function voiceCandidates(items) {
    voicePending = false;
    ++voiceSeq;
    var panel = document.getElementById('rafiqVoiceShade');
    if (!panel) return; // أُغلقت المراجعة أو تغيّرت الصفحة، فلا يُنفَّذ أمر متأخر.
    var start = document.getElementById('rafiqVoiceStart');
    if (start) start.disabled = false;
    var choices = document.getElementById('rafiqVoiceChoices');
    var preview = document.getElementById('rafiqVoicePreview');
    var goButton = document.getElementById('rafiqVoiceGo');
    choices.textContent = ''; preview.textContent = ''; goButton.style.display = 'none';
    voiceChoice = null;
    var heard = Array.isArray(items) ? items.slice(0, 3) : [items];
    var usable = [], manual = '';
    heard.forEach(function (raw) {
      var words = String(raw || '').trim().slice(0, 120);
      var command = voiceCommand(words);
      if (command && command.type === 'manual') manual = command.label;
      else if (command && !usable.some(function (row) { return sameVoiceAction(row.command, command); })) {
        usable.push({words: words, command: command});
      }
    });
    if (manual || !usable.length) {
      preview.textContent = heard.length ? 'سمعت: «' + String(heard[0]).slice(0, 120) + '».' : '';
      voiceStatus(manual || 'لم أفهم الأمر. جرّب: أضف حليب عدد 2، بيع نقدي، أو افتح البيع.');
      return;
    }
    if (usable.length === 1) { voicePreview(usable[0].words, usable[0].command); return; }
    voiceStatus('سمعت أكثر من احتمال؛ اختر المقصود أو أعد المحاولة.');
    usable.forEach(function (row) {
      var button = voiceNode('button', '«' + row.words + '» — ' + row.command.label, 'btn ghost sm wide');
      button.type = 'button';
      button.addEventListener('click', function () { voicePreview(row.words, row.command); });
      choices.appendChild(button);
    });
  }
  function openVoice() {
    if (document.getElementById('rafiqVoiceShade')) return;
    voicePending = false;
    voiceChoice = null;
    var shade = voiceNode('div');
    shade.id = 'rafiqVoiceShade';
    shade.setAttribute('role', 'presentation');
    var card = voiceNode('section');
    card.id = 'rafiqVoiceCard';
    card.setAttribute('role', 'dialog');
    card.setAttribute('aria-modal', 'true');
    card.setAttribute('aria-label', 'الأوامر الصوتية');
    card.appendChild(voiceNode('div', '🎤 الأوامر الصوتية', 'h2'));
    card.appendChild(voiceNode('p', 'قد تحتاج خدمة الهاتف إلى الإنترنت وقد ترسل الصوت لمزوّد التعرّف. لا يحفظ رفيق التسجيل. أمثلة: أضف حليب عدد 2، بيع نقدي، بيع آجل، اطبع الفاتورة، شارك الفاتورة. لا تحفظ كلمة مسموعة عملية مالية دون مراجعة ولمس زر الدفع.', 'small'));
    var status = voiceNode('p', 'اضغط «ابدأ الاستماع» ثم تكلّم بالعربية.', 'small');
    status.id = 'rafiqVoiceStatus'; status.setAttribute('role', 'status');
    card.appendChild(status);
    var preview = voiceNode('p', '', 'small'); preview.id = 'rafiqVoicePreview'; card.appendChild(preview);
    var choices = voiceNode('div'); choices.id = 'rafiqVoiceChoices'; card.appendChild(choices);
    var start = voiceNode('button', '🎤 ابدأ الاستماع', 'btn p');
    start.id = 'rafiqVoiceStart'; start.type = 'button';
    start.addEventListener('click', function () {
      if (voicePending || voiceExecuting) return;
      ++voiceSeq;
      voicePending = true; voiceChoice = null;
      preview.textContent = ''; choices.textContent = '';
      var goButton = document.getElementById('rafiqVoiceGo');
      if (goButton) goButton.style.display = 'none';
      start.disabled = true;
      voiceStatus('خدمة الهاتف تستمع الآن… يمكنك إلغاء الاستماع من نافذتها.');
      try { window.RafiqDevice.listen(); }
      catch (_) { window.__rafiqVoiceError('تعذّر تشغيل خدمة الصوت في الهاتف'); }
    });
    var execute = voiceNode('button', 'افتح', 'btn gold');
    execute.id = 'rafiqVoiceGo'; execute.type = 'button'; execute.style.display = 'none';
    execute.addEventListener('click', async function () {
      var action = voiceChoice;
      if (!action || voicePending || voiceExecuting) return;
      voiceExecuting = true;
      execute.disabled = true;
      try {
        if (action.path) {
          voiceNewProductDraft = action.type === 'new_product' ? action.productDraft : null;
          closeVoice(); go(action.path); return;
        }
        if (action.type === 'cart') {
          if (CUR !== '/pos' || !window.rafiqVoicePos || !action.product ||
              !(await window.rafiqVoicePos.addProduct(action.product, action.qty))) {
            throw new Error('لم أضف الصنف؛ افحص اسمه وسعره ورصيده وأعد المحاولة.');
          }
          closeVoice(); return;
        }
        if (action.type === 'checkout') {
          if (CUR !== '/pos' || !window.rafiqVoicePos) throw new Error('افتح شاشة البيع أولاً.');
          var fresh = window.rafiqVoicePos.quote();
          if (fresh.totalCents !== action.quote.totalCents ||
              JSON.stringify(fresh.lines) !== JSON.stringify(action.quote.lines)) {
            throw new Error('تغيّرت السلة أو المبلغ بعد المراجعة؛ أعد الأمر الصوتي.');
          }
          if (!window.rafiqVoicePos.checkout(action.kind, action.customerQuery)) {
            throw new Error('تعذّر فتح نافذة الدفع؛ لا بيع مسجّل.');
          }
          closeVoice(); return;
        }
        if (action.type === 'print' || action.type === 'share') {
          if (currentVoiceInvoiceId() !== action.invoiceId) throw new Error('تغيّرت الفاتورة؛ أعد الأمر.');
          var ctx = readVoiceInvoice(action.invoiceId);
          if (ctx.inv.number !== action.invoiceNumber || ctx.inv.total_cents !== action.totalCents ||
              (ctx.customer && ctx.customer.id) !== action.customerId ||
              (ctx.customer && ctx.customer.phone) !== action.customerPhone ||
              (ctx.customer && ctx.customer.balance_cents) !== action.customerBalance) {
            throw new Error('تغيّرت بيانات الفاتورة أو الزبون؛ راجعها من جديد.');
          }
          closeVoice();
          if (action.type === 'share') window.RafiqDevice.shareInvoicePdf(action.invoiceId);
          else if (/^\/invoice\/\d+$/.test(CUR) && typeof window.printInvoice === 'function') {
            window.printInvoice(action.mode);
          } else {
            go('/invoice/' + action.invoiceId + (action.mode === 'a4' ? '?a4=1&print=1' : '?print=1'));
          }
          return;
        }
      } catch (e) { voiceStatus(e.message || 'تعذّر التنفيذ؛ لا تغييرات مالية.'); }
      finally { voiceExecuting = false; if (document.getElementById('rafiqVoiceShade')) execute.disabled = false; }
    });
    var cancel = voiceNode('button', 'إغلاق', 'btn ghost');
    cancel.id = 'rafiqVoiceClose'; cancel.type = 'button'; cancel.addEventListener('click', closeVoice);
    var buttons = voiceNode('div'); buttons.id = 'rafiqVoiceButtons';
    buttons.appendChild(start); buttons.appendChild(execute); buttons.appendChild(cancel);
    card.appendChild(buttons);
    shade.appendChild(card);
    shade.addEventListener('click', function (e) { if (e.target === shade) closeVoice(); });
    shade.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeVoice(); });
    document.body.appendChild(shade);
    start.focus();
  }
  function setupVoiceButton() {
    if (!window.RafiqDevice || typeof window.RafiqDevice.listen !== 'function' ||
        !document.querySelector('nav.nav a[href]') ||
        CUR === '/login' || CUR === '/license' || CUR === '/setup' || CUR === '/rescue') return;
    if (document.getElementById('rafiqMic')) return;
    var mic = voiceNode('button', '🎤', 'btn');
    mic.id = 'rafiqMic'; mic.type = 'button';
    mic.setAttribute('aria-label', 'الأوامر الصوتية');
    mic.title = 'الأوامر الصوتية';
    // في شاشة البيع يبقى الزر فوق شريط الدفع، فلا يغطي تأكيد البيع النقدي/الآجل.
    var paybar = document.querySelector('.paybar');
    if (paybar) mic.style.bottom = 'calc(' +
      (Math.max(215, Math.ceil(paybar.getBoundingClientRect().height) + 16)) +
      'px + env(safe-area-inset-bottom))';
    mic.addEventListener('click', openVoice);
    document.body.appendChild(mic);
  }

  /* ---------- تخطيط الهاتف: الجداول تصبح بطاقات بعناوين واضحة ---------- */
  var MOBILE_CSS = '@media (max-width:640px){' +
    'table.tbl,table.tbl tbody{display:block;width:100%}' +
    'table.tbl tr{display:block}' +
    'table.tbl tr.tbl-head{display:none}' +
    'table.tbl tr:not(.tbl-head){border-bottom:1px solid #e2e8f0;padding:6px 0}' +
    'table.tbl tr:not(.tbl-head):last-child{border-bottom:0}' +
    'table.tbl td{display:flex;justify-content:space-between;align-items:center;gap:10px;border:0;padding:4px 0;text-align:start;font-size:.95rem}' +
    'table.tbl td[data-label]::before{content:attr(data-label);color:#6b7a90;font-size:.78rem;flex-shrink:0}' +
    'table.tbl td.tbl-wide{display:block;text-align:center}' +
    '.card{padding:14px}' +
    '}';
  function mobileLayout() {
    if (!document.getElementById('rafiqMobileCss')) {
      var st = document.createElement('style');
      st.id = 'rafiqMobileCss';
      st.textContent = MOBILE_CSS;
      document.head.appendChild(st);
    }
    document.querySelectorAll('table.tbl').forEach(function (t) {
      var heads = null;
      t.querySelectorAll('tr').forEach(function (tr) {
        var kids = Array.prototype.slice.call(tr.children);
        if (kids.length && kids[0].tagName === 'TH') {
          heads = kids.map(function (th) { return th.textContent.trim(); });
          tr.classList.add('tbl-head');
          return;
        }
        if (!heads) return;
        kids.forEach(function (td, i) {
          if (td.tagName !== 'TD') return;
          if (td.colSpan > 1) { td.classList.add('tbl-wide'); return; }
          if (heads[i]) td.setAttribute('data-label', heads[i]);
        });
      });
    });
  }

  /* ---------- أرقام الهاتف: زر 📇 يفتح جهات الاتصال ---------- */
  function normalizePhone(raw) {
    var d = String(raw || '').replace(/\D/g, '');
    if (d.indexOf('00967') === 0) d = d.slice(5);
    else if (d.indexOf('967') === 0 && d.length === 12) d = d.slice(3);
    if (d.length === 9 && d.charAt(0) === '7') d = '0' + d;   // محلي: 0771234567
    return d;
  }
  window.rafiqNormalizePhone = normalizePhone;
  window.rafiqLayoutHooks = { mobileLayout: mobileLayout, contactButtons: contactButtons };
  window.__rafiqContact = function (raw) {
    var el = window.__rafiqPhoneTarget;
    if (!el) return;
    el.value = normalizePhone(raw);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };
  function contactButtons() {
    if (!window.RafiqDevice) return;
    document.querySelectorAll('input[name="phone"], input[id="waPhone"], input[id="newCustPhone"], input[type="tel"], input[inputmode="tel"]')
      .forEach(function (input) {
        if (input.getAttribute('data-contact') === '1') return;
        input.setAttribute('data-contact', '1');
        var b = document.createElement('button');
        b.type = 'button';
        b.title = 'اختيار من جهات الاتصال';
        b.textContent = '📇';
        b.setAttribute('style', 'margin-inline-start:6px;padding:9px 11px;border-radius:10px;border:1px solid #d7dee8;background:#fff;font-size:18px;vertical-align:middle;cursor:pointer;flex-shrink:0');
        b.onclick = function () {
          window.__rafiqPhoneTarget = input;
          window.RafiqDevice.pickContact();
        };
        input.insertAdjacentElement('afterend', b);
      });
  }

  function installDeviceHooks() {
    if (!window.RafiqDevice) return;
    contactButtons();
    /* القراءة بالكاميرا: الصفحة تنادي openCameraScanner بالاسم، فنستبدلها بقارئ الجهاز */
    window.openCameraScanner = function (onCode) {
      window.__rafiqScanCb = onCode;
      window.RafiqDevice.scan();
    };
    window.__rafiqVoiceCandidates = voiceCandidates;
    window.__rafiqVoiceError = function (message) {
      ++voiceSeq;
      voicePending = false;
      voiceChoice = null;
      var start = document.getElementById('rafiqVoiceStart');
      var preview = document.getElementById('rafiqVoicePreview');
      var choices = document.getElementById('rafiqVoiceChoices');
      var goButton = document.getElementById('rafiqVoiceGo');
      if (start) start.disabled = false;
      if (preview) preview.textContent = '';
      if (choices) choices.textContent = '';
      if (goButton) goButton.style.display = 'none';
      voiceStatus(message || 'تعذّر التعرف على الكلام؛ حاول مجدداً.');
    };
  }

  /* ---------- القائمة الجانبية؛ تنسيق الدخول في style.css حتى لا يتنافس نوعان من CSS ---------- */
  var UI_CSS = '' +
    '.rafiq-has-menu nav.nav{display:none}' +
    '#rafiqMenuBtn{background:rgba(255,255,255,.14);color:#fff;border:0;border-radius:10px;width:40px;height:40px;font-size:20px;cursor:pointer;flex-shrink:0;padding:0}' +
    '#rafiqOverlay{position:fixed;inset:0;background:rgba(0,0,0,.45);opacity:0;pointer-events:none;transition:opacity .25s;z-index:199}' +
    '#rafiqDrawer{position:fixed;top:12px;bottom:12px;left:12px;width:min(78vw,300px);box-sizing:border-box;background:#002651;color:#fff;border-radius:24px;box-shadow:0 8px 30px rgba(0,0,0,.4);transform:translateX(calc(-100% - 24px));transition:transform .28s ease;z-index:200;overflow-y:auto;padding:14px 12px;display:flex;flex-direction:column;gap:2px}' +
    '.rafiq-menu-open #rafiqOverlay{opacity:1;pointer-events:auto}' +
    '.rafiq-menu-open #rafiqDrawer{transform:none}' +
    '.rafiq-menu-open #rafiqMic{display:none}' +
    '#rafiqDrawer .rd-head{display:flex;align-items:center;gap:10px;padding:6px 6px 12px;border-bottom:1px solid rgba(255,255,255,.15);margin-bottom:6px}' +
    '#rafiqDrawer .rd-av{width:42px;height:42px;border-radius:14px;background:#fcc43f;color:#002651;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:1.1rem;flex-shrink:0}' +
    '#rafiqDrawer .rd-name{font-weight:800;font-size:1rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '#rafiqDrawer .rd-sub{font-size:.78rem;opacity:.7}' +
    '#rafiqDrawer a{display:flex;align-items:center;gap:14px;padding:12px 8px;border-radius:12px;color:#fff;text-decoration:none;font-size:1rem;font-weight:600}' +
    '#rafiqDrawer a:active{background:rgba(255,255,255,.1)}' +
    '#rafiqDrawer a.on{background:rgba(252,196,63,.18);color:#fcc43f}' +
    '#rafiqDrawer .ic{width:26px;text-align:center;font-size:1.2rem;flex-shrink:0}' +
    '#rafiqDrawer .rd-build{margin-top:auto;padding:10px 8px 0;font-size:.72rem;opacity:.6;text-align:center}';

  var VOICE_CSS = '' +
    '#rafiqMic{position:fixed;left:16px;bottom:calc(88px + env(safe-area-inset-bottom));' +
      'width:54px;height:54px;min-height:54px;padding:0;border-radius:50%;z-index:160;' +
      'background:#002651;color:white;box-shadow:0 6px 18px rgba(0,38,81,.35);font-size:23px}' +
    '#rafiqVoiceShade{position:fixed;inset:0;background:rgba(2,19,38,.5);z-index:210;' +
      'display:flex;align-items:flex-end;justify-content:center;padding:12px}' +
    '#rafiqVoiceCard{background:white;color:#0e1b2c;width:100%;max-width:480px;border-radius:20px;' +
      'padding:18px;box-shadow:0 12px 34px rgba(0,0,0,.25);max-height:85vh;overflow:auto}' +
    '#rafiqVoiceCard p{margin:8px 0}' +
    '#rafiqVoicePreview{font-weight:700;overflow-wrap:anywhere}' +
    '#rafiqVoiceChoices{display:grid;gap:6px}' +
    '#rafiqVoiceButtons{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}' +
    '#rafiqVoiceButtons .btn{flex:1;min-width:100px}' +
    '@media print{#rafiqMic,#rafiqVoiceShade{display:none !important}}';

  var MENU_ICONS = [['/pos', '🛒'], ['/customers', '👥'], ['/find', '📍'], ['/cash', '💰'], ['/reports', '📈'],
    ['/products', '📦'], ['/imports', '⬆️'], ['/settings', '⚙️'], ['/users', '👤']];
  function ensureStyle(id, css) {
    if (document.getElementById(id)) return;
    var st = document.createElement('style');
    st.id = id;
    st.textContent = css;
    document.head.appendChild(st);
  }
  function iconFor(href, text) {
    var m = text.match(/^\s*(\p{Extended_Pictographic}\uFE0F?)/u);
    if (m) return m[1];
    if (href === '/') return '🏠';
    for (var i = 0; i < MENU_ICONS.length; i++) {
      if (href.indexOf(MENU_ICONS[i][0]) === 0) return MENU_ICONS[i][1];
    }
    return '•';
  }
  function labelOf(text) {
    return text.replace(/^\s*\p{Extended_Pictographic}\uFE0F?\s*/u, '').trim();
  }
  function buildLabel() {
    try {
      return window.RafiqDevice && window.RafiqDevice.version ? 'الإصدار ' + window.RafiqDevice.version() : '';
    } catch (e) { return ''; }
  }
  function menuOpen() { return document.body.classList.contains('rafiq-menu-open'); }
  function openMenu() { document.body.classList.add('rafiq-menu-open'); }
  function closeMenu() { document.body.classList.remove('rafiq-menu-open'); }
  function menuItem(href, icon, label, on) {
    var a = document.createElement('a');
    a.href = href;
    if (on) a.className = 'on';
    var ic = document.createElement('span');
    ic.className = 'ic';
    ic.textContent = icon;
    var lb = document.createElement('span');
    lb.textContent = label;
    a.appendChild(ic);
    a.appendChild(lb);
    return a;
  }
  /* القائمة تُبنى من روابط الشريط نفسه (فتتبع الصلاحيات تلقائياً)، وتُعاد بناؤها بعد كل شاشة */
  function sideMenu() {
    ['rafiqMenuBtn', 'rafiqOverlay', 'rafiqDrawer'].forEach(function (id) {
      var e = document.getElementById(id);
      if (e) e.parentNode.removeChild(e);
    });
    document.body.classList.remove('rafiq-has-menu', 'rafiq-menu-open');
    var nav = document.querySelector('nav.nav');
    var header = document.querySelector('header.topbar');
    if (!nav || !header || !nav.querySelector('a[href]')) return;   // شاشة الدخول: لا روابط ولا قائمة
    document.body.classList.add('rafiq-has-menu');

    var btn = document.createElement('button');
    btn.id = 'rafiqMenuBtn';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'القائمة');
    btn.textContent = '☰';
    btn.onclick = openMenu;
    header.insertBefore(btn, header.firstChild);

    var ov = document.createElement('div');
    ov.id = 'rafiqOverlay';
    ov.onclick = closeMenu;
    document.body.appendChild(ov);

    var who = header.querySelector('.who');
    var name = who ? who.textContent.trim() : '';
    var dr = document.createElement('div');
    dr.id = 'rafiqDrawer';
    var head = document.createElement('div');
    head.className = 'rd-head';
    var av = document.createElement('div');
    av.className = 'rd-av';
    av.textContent = name ? name.charAt(0) : '؟';
    var info = document.createElement('div');
    info.style.minWidth = '0';
    var nm = document.createElement('div');
    nm.className = 'rd-name';
    nm.textContent = name || 'رفيق';
    var sub = document.createElement('div');
    sub.className = 'rd-sub';
    sub.textContent = 'القائمة';
    info.appendChild(nm);
    info.appendChild(sub);
    head.appendChild(av);
    head.appendChild(info);
    dr.appendChild(head);

    Array.prototype.forEach.call(nav.querySelectorAll('a[href]'), function (a) {
      var href = a.getAttribute('href') || '';
      var text = a.textContent;
      dr.appendChild(menuItem(href, iconFor(href, text), labelOf(text), a.classList.contains('on')));
    });
    var logout = header.querySelector('a[href="/logout"]');
    if (logout) dr.appendChild(menuItem('/logout', '🚪', 'تسجيل الخروج', false));
    var bl = buildLabel();
    if (bl) {
      var b = document.createElement('div');
      b.className = 'rd-build';
      b.textContent = bl;
      dr.appendChild(b);
    }
    document.body.appendChild(dr);
  }

  function attach() {
    ensureStyle('rafiqUiCss', UI_CSS);
    ensureStyle('rafiqVoiceCss', VOICE_CSS);
    document.body.classList.toggle('rafiq-login', !!document.querySelector('.login-card'));
    var lc = document.querySelector('.login-card');
    if (lc && buildLabel() && !document.getElementById('rafiqBuild')) {
      var bd = document.createElement('div');
      bd.id = 'rafiqBuild';
      bd.setAttribute('style', 'text-align:center;font-size:.72rem;opacity:.6;margin-top:6px');
      bd.textContent = buildLabel();
      lc.appendChild(bd);
    }
    mobileLayout();
    installDeviceHooks();
    sideMenu();
    setupVoiceButton();
    if (listening) return;   // مستمعات المستند تُسجَّل مرة واحدة فقط
    listening = true;
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
      if (!a) return;
      var href = a.getAttribute('href') || '';
      if (href.charAt(0) === '/' && href.indexOf('/static') !== 0) {
        e.preventDefault();
        go(href);
      }
    }, true);
    document.addEventListener('submit', function (e) {
      // نماذج دفتر الخادم لا يُرسلها المحرك إلى NativeApi.page حتى لو لم تُحمّل شيفرتها.
      if (isCloudLedgerForm(e.target)) { e.preventDefault(); return; }
      e.preventDefault();
      sendForm(e.target);
    }, true);
  }

  function isCloudLedgerForm(f) {
    return !!(f && f.closest && f.closest('#cloudPos,#cloudCustomers,#cloudCashLedger,#cloudDashboard,#cloudEye'));
  }

  /* الإرسال البرمجي (form.submit) لا يُطلق حدث submit، لذلك نعترضه هنا أيضاً */
  function sendForm(f) {
    if (isCloudLedgerForm(f)) return;
    var data = {};
    var files = [];
    new FormData(f).forEach(function (v, k) {
      if (v instanceof File) { files.push(v); } else { data[k] = v; }
    });
    var method = (f.getAttribute('method') || 'GET').toUpperCase();
    var action = f.getAttribute('action') || CUR;
    if (!files.length) { show(callPage(method, action, JSON.stringify(data))); return; }
    /* ملف مرفوع: يُقرأ نصاً (UTF-8) ويُرسل باسم content مع اسم الملف */
    var file = files[0];
    var reader = new FileReader();
    reader.onload = function () {
      var s = String(reader.result || '');
      var i = s.indexOf(',');
      data.content_b64 = i >= 0 ? s.slice(i + 1) : '';   // البايتات كما هي، ويفكّ الترميز Kotlin
      data.filename = file.name || '';
      show(callPage(method, action, JSON.stringify(data)));
    };
    reader.readAsDataURL(file);
  }
  HTMLFormElement.prototype.submit = function () { sendForm(this); };
  HTMLFormElement.prototype.requestSubmit = function () { sendForm(this); };

  /* ---------- fetch: /api/ إلى Kotlin، وما عداه كما هو ---------- */

  var origFetch = window.fetch;
  window.fetch = function (url, opt) {
    var u = String(url);
    var method = ((opt && opt.method) || 'GET').toUpperCase();
    var body = (opt && opt.body) || '';
    if (typeof body !== 'string') body = JSON.stringify(body);
    if (u.indexOf('/api/') === 0) {
      var r = JSON.parse(window.RafiqNative.api(method, u, body));
      if (r.status === 403) {
        try {
          var denied = JSON.parse(r.body);
          if (denied.license_required) go('/license');
          else if (denied.security_setup_required) go('/setup');
        } catch (e) { /* استجابة غير متوقعة: لا نتجاوز رفض الخادم */ }
      }
      return Promise.resolve(new Response(r.body, {
        status: r.status, headers: { 'Content-Type': 'application/json' }
      }));
    }
    if (u.charAt(0) === '/' && u.indexOf('/static') !== 0) {
      var p = callPage(method, u, body);
      var payload = p.redirect ? { ok: true, redirect: p.redirect } : { ok: false };
      return Promise.resolve(new Response(JSON.stringify(payload), {
        status: p.status || 200, headers: { 'Content-Type': 'application/json' }
      }));
    }
    return origFetch.apply(this, arguments);
  };

  /* الطباعة والروابط الخارجية (واتساب) تُنفَّذ بالأدوات الأصلية للجهاز */
  window.print = function () { if (window.RafiqDevice) window.RafiqDevice.print(); };
  var nativeOpen = window.open;
  window.open = function (url) {
    var u = String(url || '');
    if (window.RafiqDevice && /^https?:/i.test(u)) { window.RafiqDevice.openUrl(u); return null; }
    return nativeOpen ? nativeOpen.apply(window, arguments) : null;
  };

  /* ---------- البدء ---------- */

  show(callPage('GET', CUR, ''));
})();
