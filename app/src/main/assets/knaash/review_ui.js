/*
 * مراجعة يدوية محفوظة على هاتف المالك؛ لا إنشاء زبائن ولا تغيير أرصدة.
 * لا يختار أي عميل بالاسم المستخرج من PDF تلقائياً.
 */
(function (root, make) {
  if (typeof module === 'object' && module.exports) module.exports = make();
  else root.RafiqKnaashReview = make();
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  async function deviceRequest(method, path, body) {
    const options = {method: method, headers: {'Content-Type': 'application/json'}};
    if (body) options.body = JSON.stringify(body);
    const response = await fetch(path, options); // /api/ يتجه إلى كود رفيق في الهاتف، لا إلى الإنترنت.
    const json = await response.json();
    if (!response.ok || !json.ok) throw new Error(json.error || 'تعذّر حفظ مراجعة العميل');
    return json;
  }
  const plain = value => String(value == null ? '' : value);

  function create(config) {
    const box = config.root;
    const rows = config.rows;
    const sha = config.sourceSha256;
    const date = config.reportDateIso;
    const request = config.request || deviceRequest;
    const notify = config.onChange || function () {};
    const isActive = config.isActive || function () { return box.isConnected; };
    const get = id => box.querySelector('#' + id);
    const panel = get('knaashReviewPanel');
    const progress = get('knaashProgress');
    const otherBox = get('knaashOtherFile');
    const rowTitle = get('knaashRowTitle');
    const note = get('knaashReviewMsg');
    const checked = get('knaashChecked');
    const newFields = get('knaashNewFields');
    const existingFields = get('knaashExistingFields');
    const zeroText = get('knaashZeroText');
    const inputName = get('knaashNewName');
    const inputPhone = get('knaashNewPhone');
    const search = get('knaashSearch');
    const matches = get('knaashMatches');
    const picked = get('knaashPicked');
    const save = get('knaashSave');
    const choices = new Map();
    const listeners = [];
    let disposed = false;
    function on(element, event, handler) {
      element.addEventListener(event, handler);
      listeners.push([element, event, handler]);
    }
    function dispose() {
      disposed = true;
      listeners.forEach(([element, event, handler]) => element.removeEventListener(event, handler));
      listeners.length = 0;
    }
    function active() { return !disposed && isActive(); }
    let current = null, mode = '', selected = null, busy = false;
    let otherFile = false, oldSha = '', problem = '', searchEpoch = 0;

    function message(value, error) {
      note.textContent = value;
      note.style.color = error ? '#b91c1c' : '';
    }
    function update() {
      if (!active()) return;
      const count = choices.size;
      if (otherFile) {
        progress.textContent = 'هناك مراجعة محفوظة لكشف مختلف. لا يمكن خلط الكشفين؛ اختر مسح المراجعة القديمة إذا أردت البدء من جديد.';
      } else {
        progress.textContent = 'راجعت ' + count + ' من ' + rows.length + ' عميلاً. اختياراتك محفوظة على هذا الهاتف فقط. لم ننقل أي دين.' +
          (problem ? ' انتبه: ' + problem : '');
      }
      progress.style.color = problem || otherFile ? '#b91c1c' : '';
      otherBox.style.display = otherFile ? '' : 'none';
      notify();
    }
    function label(index) {
      const choice = choices.get(index);
      if (!choice) return 'راجع هذا العميل';
      if (choice.mode === 'zero') return 'راجعت: رصيده صفر';
      if (choice.mode === 'new') return 'راجعت: عميل جديد';
      return 'راجعت: موجود في رفيق';
    }
    function canReview() { return active() && !otherFile; }
    function selectMode(next) {
      if (!active() || !current || busy) return;
      ++searchEpoch; // أي نتائج بحث معلّقة تخص الاختيار القديم.
      mode = next;
      selected = null;
      checked.checked = false;
      newFields.style.display = mode === 'new' ? '' : 'none';
      existingFields.style.display = mode === 'existing' ? '' : 'none';
      zeroText.style.display = mode === 'zero' ? '' : 'none';
      picked.textContent = '';
      matches.textContent = '';
      message('', false);
      if (mode === 'new' && current) {
        const previous = choices.get(current.index);
        inputName.value = previous && previous.mode === 'new' ? previous.name : current.sourceName;
        inputPhone.value = previous && previous.mode === 'new' ? previous.phone : current.phone;
      }
    }
    function open(row, afterSave) {
      if (!canReview() || !row || (busy && !afterSave)) return;
      ++searchEpoch;
      current = row;
      mode = '';
      selected = null;
      checked.checked = false;
      search.value = '';
      picked.textContent = '';
      matches.textContent = '';
      newFields.style.display = existingFields.style.display = zeroText.style.display = 'none';
      const balanceText = row.balanceCents > 0 ? 'دين على العميل' :
        row.balanceCents < 0 ? 'رصيد لصالح العميل' : 'رصيده صفر';
      rowTitle.textContent = 'صف ' + row.index + ' من صفحة ' + row.page + ' — ' + row.sourceName +
        ' — ' + balanceText + ' (' + Math.abs(row.balanceCents / 100).toLocaleString('en-US') + ')';
      get('knaashZero').style.display = row.balanceCents === 0 ? '' : 'none';
      panel.style.display = '';
      message(choices.has(row.index) ? 'يمكنك تعديل اختيارك السابق بعد المقارنة مع PDF.' :
        'اختر هل هذا عميل جديد أم موجود، ثم تحقق من الاسم والرصيد.', false);
      if (panel.scrollIntoView) {
        try { panel.scrollIntoView({behavior: 'smooth', block: 'start'}); } catch (_) { /* هاتف قديم */ }
      }
    }
    async function find() {
      if (!canReview() || !current || mode !== 'existing' || busy) return;
      const epoch = ++searchEpoch;
      const row = current.index;
      const term = search.value.trim().slice(0, 80);
      matches.textContent = '';
      picked.textContent = '';
      selected = null;
      message('نبحث في دفتر زبائن رفيق على هذا الهاتف…', false);
      try {
        const result = await request('GET', '/api/imports/knaash/customers?q=' + encodeURIComponent(term));
        if (!canReview() || epoch !== searchEpoch || row !== current.index ||
            mode !== 'existing' || term !== search.value.trim().slice(0, 80)) return;
        const list = result.customers || [];
        if (!list.length) {
          matches.textContent = 'لم نجد عميلاً مطابقاً للبحث؛ يمكنك تعديل البحث أو اختيار عميل جديد.';
        }
        list.forEach(function (c) {
          const button = document.createElement('button');
          button.type = 'button'; button.className = 'btn ghost sm mt';
          button.style.display = 'block'; button.style.width = '100%';
          button.style.textAlign = 'right';
          button.textContent = plain(c.code) + ' • ' + plain(c.name) +
            (c.phone ? ' • ' + plain(c.phone) : '') +
            (c.has_history || c.balance_cents !== 0 ? ' — لديه عمليات سابقة، لا يمكن إضافة رصيد' : ' — يمكن مراجعته');
          button.disabled = !!c.has_history || c.balance_cents !== 0;
          button.addEventListener('click', function () {
            if (!canReview() || !current || current.index !== row || mode !== 'existing') return;
            selected = c;
            picked.textContent = 'اخترت ' + plain(c.code) + ' • ' + plain(c.name) +
              '. قارن هويته مع صف كناش قبل أن تؤكد.';
            checked.checked = false;
          });
          matches.appendChild(button);
        });
        message('اختر العميل الصحيح بنفسك؛ تشابه الاسم وحده ليس دليلاً.', false);
      } catch (e) {
        if (canReview() && epoch === searchEpoch && row === current.index) {
          message(e.message || 'تعذّر البحث الآن', true);
        }
      }
    }
    async function saveChoice() {
      if (!current || busy || !canReview()) return;
      if (!mode || !checked.checked) {
        message('اختر حالة العميل، ثم أكد أنك قارنت الاسم والرصيد مع PDF.', true);
        return;
      }
      const c = {index: current.index, mode: mode};
      if (mode === 'existing') {
        if (!selected) { message('اختر زبوناً موجوداً من نتائج البحث أولاً.', true); return; }
        c.customer_id = selected.id;
      } else if (mode === 'new') {
        c.name = inputName.value.trim();
        c.phone = inputPhone.value.trim();
        if (!c.name) { message('اكتب الاسم الصحيح للزبون الجديد.', true); return; }
      } else if (mode === 'zero') {
        if (current.balanceCents !== 0) { message('هذا الصف ليس صفراً؛ لا يمكن استبعاده.', true); return; }
        c.reported_balance_cents = 0;
      }
      busy = true; save.disabled = true;
      try {
        const result = await request('POST', '/api/imports/knaash/review', {
          sha: sha, date: date, count: rows.length, choice: c,
        });
        if (!active()) return;
        choices.clear();
        (result.choices || []).forEach(row => choices.set(row.index, row));
        problem = result.problem || '';
        const last = current.index;
        update();
        const next = rows.find(row => row.index > last && !choices.has(row.index)) ||
          rows.find(row => !choices.has(row.index));
        if (next) {
          open(next, true);
          message('حُفظت مراجعتك. هذا هو العميل التالي؛ لم تُنقل ديون.', false);
        } else {
          panel.style.display = 'none';
          progress.textContent += ' اكتملت مراجعة الأسماء، لكن نقل الديون غير متاح بعد.';
        }
      } catch (e) {
        if (active()) message(e.message || 'تعذّر حفظ المراجعة؛ لم تتغير الأرصدة.', true);
      } finally {
        busy = false; save.disabled = false;
      }
    }
    async function load() {
      const url = '/api/imports/knaash/review?sha=' + encodeURIComponent(sha) +
        '&date=' + encodeURIComponent(date) + '&count=' + rows.length;
      const result = await request('GET', url);
      if (!active()) return;
      choices.clear();
      (result.choices || []).forEach(c => choices.set(c.index, c));
      otherFile = !!result.other_file;
      oldSha = result.previous_sha256 || '';
      problem = result.problem || '';
      if (otherFile) {
        get('knaashOtherFileMessage').textContent = 'هناك مراجعة محفوظة لكشف بتاريخ ' +
          plain(result.previous_date) + '. لا نخلطها بهذا الكشف.';
      }
      update();
    }
    async function clearOld() {
      if (!active() || !otherFile || !oldSha || busy) return;
      if (!window.confirm('تمسح مراجعة الأسماء المحفوظة للكشف القديم فقط؛ لا تمسح أي دين. هل تريد ذلك؟')) return;
      busy = true;
      try {
        await request('DELETE', '/api/imports/knaash/review?sha=' + encodeURIComponent(oldSha));
        if (!active()) return;
        otherFile = false; oldSha = ''; choices.clear(); problem = '';
        update();
        message('حُذفت مراجعة الكشف القديم فقط؛ يمكنك مراجعة هذا الكشف الآن.', false);
      } catch (e) {
        if (active()) progress.textContent = e.message || 'تعذّر مسح المراجعة القديمة.';
      } finally { busy = false; }
    }

    on(get('knaashNew'), 'click', () => selectMode('new'));
    on(get('knaashExisting'), 'click', () => selectMode('existing'));
    on(get('knaashZero'), 'click', () => selectMode('zero'));
    on(get('knaashFind'), 'click', find);
    on(search, 'input', () => {
      if (!active()) return;
      ++searchEpoch;
      selected = null;
      picked.textContent = '';
      matches.textContent = '';
      checked.checked = false;
    });
    on(search, 'keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); find(); }
    });
    on(get('knaashSave'), 'click', saveChoice);
    on(get('knaashClose'), 'click', () => { if (active() && !busy) panel.style.display = 'none'; });
    on(get('knaashClearOld'), 'click', clearOld);
    return {load, open, label, canReview, dispose};
  }
  return {create};
});
