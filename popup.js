// popup.js
document.addEventListener('DOMContentLoaded', () => {
  const $ = id => document.getElementById(id);

  const DEFAULTS = {
    idleDays:0, idleHours:0, idleMinutes:30, idleSeconds:0,
    notifyDays:0, notifyHours:0, notifyMinutes:10, notifySeconds:0,
    enableNotify:true,
    skipPinned:true, skipAudible:true, skipForm:true,
    whitelist:[], blacklist:[]
  };

  const toInt = id => {
    const el = $(id);
    const n = el ? parseInt(el.value,10) : 0;
    return isNaN(n) ? 0 : n;
  };

  const fmt = (ms) => {
    ms = Math.max(0, ms);
    let s = Math.floor(ms/1000),
        d = Math.floor(s/86400); s -= d*86400,
        h = Math.floor(s/3600);  s -= h*3600,
        m = Math.floor(s/60);    s -= m*60;
    const parts = [];
    if (d) parts.push(`${d}天`);
    if (h) parts.push(`${h}時`);
    if (m) parts.push(`${m}分`);
    if (s) parts.push(`${s}秒`);
    if (parts.length===0) parts.push('0秒');
    return parts.join('');
  };

  const thresholdMs = p =>
    p.idleDays*86400000 + p.idleHours*3600000 + p.idleMinutes*60000 + p.idleSeconds*1000;

  // 與 background 同步的白/黑名單比對
  function urlMatches(url, patterns) {
    if (!patterns || !patterns.length || !url) return false;
    try {
      const u = new URL(url);
      const host = u.hostname;
      return patterns.some(raw => {
        const p = String(raw || '').trim();
        if (!p) return false;
        if (host === p) return true;
        if (host.endsWith('.' + p)) return true;
        return u.href.includes(p);
      });
    } catch {
      return patterns.some(raw => (url || '').includes(String(raw || '').trim()));
    }
  }

  function fetchDeactivated() {
    return new Promise(res => {
      chrome.runtime.sendMessage({type:'getDeactivatedTimes'}, r => res(r?.deactivatedAt || {}));
    });
  }

  // 載入設定
  chrome.storage.sync.get(DEFAULTS, p => {
    $('days').value          = p.idleDays;
    $('hours').value         = p.idleHours;
    $('minutes').value       = p.idleMinutes;
    $('seconds').value       = p.idleSeconds;
    $('notifyDays').value    = p.notifyDays;
    $('notifyHours').value   = p.notifyHours;
    $('notifyMinutes').value = p.notifyMinutes;
    $('notifySeconds').value = p.notifySeconds;

    $('enableNotify').checked = p.enableNotify;
    $('skipPinned').checked   = p.skipPinned;
    $('skipAudible').checked  = p.skipAudible;
    $('skipForm').checked     = p.skipForm;

    $('whitelist').value = p.whitelist.join('\n');
    $('blacklist').value = p.blacklist.join('\n');
  });

  // 儲存設定並套用黑名單
  $('save').addEventListener('click', () => {
    const prefs = {
      idleDays:toInt('days'), idleHours:toInt('hours'),
      idleMinutes:toInt('minutes'), idleSeconds:toInt('seconds'),
      notifyDays:toInt('notifyDays'), notifyHours:toInt('notifyHours'),
      notifyMinutes:toInt('notifyMinutes'), notifySeconds:toInt('notifySeconds'),
      enableNotify:$('enableNotify').checked,
      skipPinned:$('skipPinned').checked,
      skipAudible:$('skipAudible').checked,
      skipForm:$('skipForm').checked,
      whitelist:$('whitelist').value.split('\n').map(s=>s.trim()).filter(Boolean),
      blacklist:$('blacklist').value.split('\n').map(s=>s.trim()).filter(Boolean)
    };
    chrome.storage.sync.set(prefs, () => {
      $('status').textContent = '已儲存';
      setTimeout(() => $('status').textContent = '', 2000);

      // 立即關閉黑名單分頁
      chrome.tabs.query({}, tabs => {
        for (const t of tabs) {
          if (urlMatches(t.url || '', prefs.blacklist)) {
            chrome.tabs.remove(t.id, () => {});
          }
        }
      });

      updateIdleList();
    });
  });

  // 更新列表（排除活躍與白名單）
  async function updateIdleList() {
    const [prefs, deact] = await Promise.all([
      new Promise(r => chrome.storage.sync.get(DEFAULTS, r)),
      fetchDeactivated()
    ]);
    const thr = thresholdMs(prefs), now = Date.now();

    chrome.tabs.query({}, tabs => {
      const list = tabs
        .filter(t => t.id != null && !t.active)
        .filter(t => !urlMatches(t.url || '', prefs.whitelist || []))
        .map(t => {
          const start = deact[t.id] !== undefined ? deact[t.id] : now;
          const idle  = now - start;
          return { title: t.title || t.url, idle, remain: thr - idle };
        })
        .sort((a,b) => b.idle - a.idle);

      const ul = $('idleList'); ul.innerHTML = '';
      list.forEach(o => {
        const li = document.createElement('li');
        li.textContent = `${o.title} — 已閒置 ${fmt(o.idle)}，倒數 ${fmt(o.remain)}`;
        ul.appendChild(li);
      });
    });
  }

  updateIdleList();
  setInterval(updateIdleList, 1000);
});
