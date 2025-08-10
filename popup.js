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
    const el = $(id); const n = el ? parseInt(el.value,10) : 0;
    return isNaN(n) ? 0 : n;
  };
  const fmt = (ms)=>{
    ms = Math.max(0,ms);
    let s = Math.floor(ms/1000),
        d = Math.floor(s/86400); s -= d*86400,
        h = Math.floor(s/3600);  s -= h*3600,
        m = Math.floor(s/60);    s -= m*60;
    const parts=[]; if(d)parts.push(`${d}天`); if(h)parts.push(`${h}時`);
    if(m)parts.push(`${m}分`); if(s)parts.push(`${s}秒`);
    if(!parts.length) parts.push('0秒'); return parts.join('');
  };
  const thresholdMs = p => (p.idleDays*86400000 + p.idleHours*3600000 + p.idleMinutes*60000 + p.idleSeconds*1000);

  function urlMatches(url, patterns){
    if (!patterns?.length || !url) return false;
    try{
      const u=new URL(url), host=u.hostname;
      return patterns.some(raw=>{
        const p=String(raw||'').trim(); if(!p) return false;
        if(host===p) return true;
        if(host.endsWith('.'+p)) return true;
        return u.href.includes(p);
      });
    }catch{
      return patterns.some(raw=>(url||'').includes(String(raw||'').trim()));
    }
  }

  function fetchState(){
    return new Promise(res=>{
      chrome.runtime.sendMessage({type:'getDeactivatedTimes'}, r=>res(r||{}));
    });
  }

  // 載入設定
  chrome.storage.sync.get(DEFAULTS, p=>{
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

  // 儲存
  $('save').addEventListener('click', ()=>{
    const prefs = {
      idleDays:toInt('days'), idleHours:toInt('hours'), idleMinutes:toInt('minutes'), idleSeconds:toInt('seconds'),
      notifyDays:toInt('notifyDays'), notifyHours:toInt('notifyHours'), notifyMinutes:toInt('notifyMinutes'), notifySeconds:toInt('notifySeconds'),
      enableNotify:$('enableNotify').checked,
      skipPinned:$('skipPinned').checked, skipAudible:$('skipAudible').checked, skipForm:$('skipForm').checked,
      whitelist:$('whitelist').value.split('\n').map(s=>s.trim()).filter(Boolean),
      blacklist:$('blacklist').value.split('\n').map(s=>s.trim()).filter(Boolean)
    };
    chrome.storage.sync.set(prefs, ()=>{
      $('status').textContent='已儲存';
      setTimeout(()=>$('status').textContent='', 1500);

      // 立即關閉黑名單
      chrome.tabs.query({}, tabs=>{
        for (const t of tabs) {
          if (urlMatches(t.url||'', prefs.blacklist)) chrome.tabs.remove(t.id, ()=>{});
        }
      });

      updateList();
    });
  });

  async function updateList(){
    const [prefs, state] = await Promise.all([
      new Promise(r=>chrome.storage.sync.get(DEFAULTS, r)),
      fetchState()
    ]);
    const thr = thresholdMs(prefs);
    const now = Date.now();
    const pTot = state.pausedTotal || 0;
    const deact = state.deactivatedAt || {};
    const pbase = state.pausedBase || {};

    chrome.tabs.query({}, tabs=>{
      const list = tabs
        .filter(t => t.id!=null && !t.active)
        .filter(t => !urlMatches(t.url||'', prefs.whitelist||[]))
        .map(t=>{
          const start = deact[t.id];
          let idle = 0;
          if (start != null) {
            const base = pbase[t.id] || pTot;
            idle = Math.max(0, (now - start) - (pTot - base));
          }
          return { title: t.title || t.url, idle, remain: thr - idle };
        })
        .sort((a,b)=>b.idle - a.idle);

      const ul = $('idleList'); ul.innerHTML='';
      for (const o of list) {
        const li = document.createElement('li');
        li.textContent = `${o.title} — 已閒置 ${fmt(o.idle)}，倒數 ${fmt(o.remain)}`;
        ul.appendChild(li);
      }
    });
  }

  updateList();
  setInterval(updateList, 1000);
});
