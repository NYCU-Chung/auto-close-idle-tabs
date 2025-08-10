// background.js

// -------------------- 狀態（持久化到 storage.local） --------------------
let deactivatedAt = {};           // { tabId: ts }
let pausedBase    = {};           // { tabId: 當下 pausedTotal 快照 }
let warned        = new Set();    // 通知過的 tabId
let currentTabId  = null;
const unsavedTabs = new Set();

// 全域暫停
let pauseStart = null;
let pauseAccum = 0;

let stateLoaded = false;
async function loadState() {
  const s = await chrome.storage.local.get([
    'deactivatedAt','pausedBase','warned','pauseStart','pauseAccum'
  ]);
  deactivatedAt = s.deactivatedAt ?? {};
  pausedBase    = s.pausedBase    ?? {};
  warned        = new Set(s.warned ?? []);
  pauseStart    = s.pauseStart ?? null;
  pauseAccum    = s.pauseAccum ?? 0;
  stateLoaded = true;
}
function saveState() {
  chrome.storage.local.set({
    deactivatedAt,
    pausedBase,
    warned: [...warned],
    pauseStart,
    pauseAccum
  });
}
async function ensureState(){ if(!stateLoaded) await loadState(); }

// -------------------- 偏好 --------------------
function loadPrefs() {
  return new Promise(res=>{
    chrome.storage.sync.get({
      idleDays:0, idleHours:0, idleMinutes:30, idleSeconds:0,
      notifyDays:0, notifyHours:0, notifyMinutes:10, notifySeconds:0,
      enableNotify:true,
      skipPinned:true, skipAudible:true, skipForm:true,
      whitelist:[], blacklist:[]
    }, res);
  });
}

// -------------------- 工具 --------------------
function toMs(d,h,m,s){ return (d*86400 + h*3600 + m*60 + s) * 1000; }
function formatDuration(ms){
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
  if (!parts.length) parts.push('0秒');
  return parts.join('');
}
function pausedTotal(now=Date.now()){
  return pauseAccum + (pauseStart ? (now - pauseStart) : 0);
}
function startCounting(tabId, startTs=Date.now(), now=Date.now()){
  deactivatedAt[tabId] = startTs;
  pausedBase[tabId]    = pausedTotal(now);
  warned.delete(tabId);
  saveState();
}
function stopCounting(tabId){
  delete deactivatedAt[tabId];
  delete pausedBase[tabId];
  warned.delete(tabId);
  saveState();
}
function closeTabNow(id){
  setTimeout(()=>chrome.tabs.remove(id, ()=>{}), 50);
  stopCounting(id);
}

// 安全白/黑名單比對（支援 *.example.com）
function urlMatches(url, patterns){
  if (!patterns?.length || !url) return false;
  try {
    const u = new URL(url);
    const host = u.hostname;
    return patterns.some(raw=>{
      const p = String(raw||'').trim();
      if (!p) return false;
      if (p.includes('*')) {
        const regex = '^' + p.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*') + '$';
        const re = new RegExp(regex);
        return re.test(host) || re.test(u.href);
      }
      if (host === p) return true;
      if (host.endsWith('.' + p)) return true;
      return u.href.includes(p);
    });
  } catch {
    return patterns.some(raw => {
      const p = String(raw||'').trim();
      if (!p) return false;
      if (p.includes('*')) {
        const regex = '^' + p.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('.*') + '$';
        return new RegExp(regex).test(url);
      }
      return (url||'').includes(p);
    });
  }
}

// -------------------- 初始化 --------------------
async function initTabs(){
  await ensureState();

  // 記錄目前作用中的 tab
  chrome.tabs.query({active:true, lastFocusedWindow:true}, tabs=>{
    if (tabs[0]) currentTabId = tabs[0].id;
  });

  // 為所有背景分頁建立起點；若已有紀錄則不覆蓋
  chrome.tabs.query({}, tabs=>{
    const now = Date.now();
    for (const t of tabs) {
      if (t.id==null || t.active) continue;
      if (!(t.id in deactivatedAt)) {
        // 用 lastAccessed 當起點回推（fallback: now）
        const start = (typeof t.lastAccessed === 'number' && t.lastAccessed > 0) ? t.lastAccessed : now;
        startCounting(t.id, start, now);
      }
    }
  });

  saveState();
}
chrome.runtime.onInstalled.addListener(initTabs);
chrome.runtime.onStartup.addListener(initTabs);

// -------------------- idle/locked 暫停控制 --------------------
chrome.idle.setDetectionInterval(60); // 拉長避免誤觸
chrome.idle.onStateChanged.addListener(state=>{
  if (state === 'locked' || state === 'idle') {
    if (!pauseStart) { pauseStart = Date.now(); saveState(); }
  } else if (state === 'active') {
    if (pauseStart) {
      pauseAccum += Date.now() - pauseStart;
      pauseStart = null;
      saveState();
    }
  }
});
// 啟動時補查目前是否處於 locked/idle
chrome.idle.queryState(60, state => {
  if ((state === 'locked' || state === 'idle') && !pauseStart) {
    pauseStart = Date.now();
    saveState();
  }
});

// -------------------- 右鍵加入白/黑名單 --------------------
chrome.runtime.onInstalled.addListener(()=>{
  chrome.contextMenus.create({ id:'add-whitelist', title:'加入白名單', contexts:['page'] });
  chrome.contextMenus.create({ id:'add-blacklist', title:'加入黑名單', contexts:['page'] });
});
chrome.contextMenus.onClicked.addListener((info, tab)=>{
  if (!tab?.url) return;
  let host; try { host = new URL(tab.url).hostname; } catch { return; }
  chrome.storage.sync.get(['whitelist','blacklist'], prefs=>{
    let { whitelist=[], blacklist=[] } = prefs;
    if (info.menuItemId==='add-whitelist' && !whitelist.includes(host)) {
      whitelist.push(host); chrome.storage.sync.set({whitelist});
    }
    if (info.menuItemId==='add-blacklist' && !blacklist.includes(host)) {
      blacklist.push(host);
      chrome.storage.sync.set({blacklist}, ()=>{
        chrome.tabs.query({}, ts=>{
          for (const t of ts) {
            try { if (new URL(t.url||'').hostname===host) closeTabNow(t.id); } catch {}
          }
        });
      });
    }
  });
});

// -------------------- 分頁事件 --------------------
chrome.tabs.onCreated.addListener(async tab=>{
  if (!tab.active && tab.id!=null) {
    const { whitelist=[] } = await new Promise(r=>chrome.storage.sync.get({whitelist:[]}, r));
    if (urlMatches(tab.url||'', whitelist)) { stopCounting(tab.id); return; }
    // 用 lastAccessed（新分頁通常接近 now）
    const start = (typeof tab.lastAccessed==='number' && tab.lastAccessed>0) ? tab.lastAccessed : Date.now();
    startCounting(tab.id, start);
  }
});
chrome.tabs.onActivated.addListener(({tabId})=>{
  if (currentTabId!=null && currentTabId!==tabId) {
    // 前一個開始倒數（不要覆蓋它既有起點）
    if (!(currentTabId in deactivatedAt)) startCounting(currentTabId);
  }
  currentTabId = tabId;
  stopCounting(tabId); // 目前作用中：不倒數
});
chrome.tabs.onRemoved.addListener(tabId=>{
  stopCounting(tabId);
  unsavedTabs.delete(tabId);
  if (currentTabId===tabId) currentTabId=null;
});
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab)=>{
  if (changeInfo.url) {
    const { whitelist=[] } = await new Promise(r=>chrome.storage.sync.get({whitelist:[]}, r));
    if (urlMatches(tab?.url||'', whitelist)) stopCounting(tabId);
  }
});

// -------------------- content-script 回報表單狀態 --------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse)=>{
  if (msg.type==='form-status' && sender.tab?.id!=null) {
    if (msg.hasUnsaved) unsavedTabs.add(sender.tab.id);
    else                unsavedTabs.delete(sender.tab.id);
    return;
  }
  if (msg.type==='getDeactivatedTimes') {
    (async ()=>{
      await ensureState();
      sendResponse({
        deactivatedAt,
        pausedBase,
        pausedTotal: pausedTotal()
      });
    })();
    return true;
  }
});

// -------------------- 每秒檢查 --------------------
async function checkTabs(){
  await ensureState();
  if (pauseStart) return;

  const prefs  = await loadPrefs();
  const wl     = prefs.whitelist || [];
  const thrMs  = toMs(prefs.idleDays, prefs.idleHours, prefs.idleMinutes, prefs.idleSeconds);
  const warnMs = toMs(prefs.notifyDays,prefs.notifyHours,prefs.notifyMinutes,prefs.notifySeconds);
  const now    = Date.now();
  const pTot   = pausedTotal(now);

  const tabs = await new Promise(r=>chrome.tabs.query({}, r));
  for (const tab of tabs) {
    const id  = tab.id;
    const url = tab.url || '';
    if (id==null) continue;

    // 黑名單：立即關
    if (urlMatches(url, prefs.blacklist)) { closeTabNow(id); continue; }

    // 白名單：永不處理
    if (urlMatches(url, wl)) { stopCounting(id); continue; }

    // 執行期跳過
    if ((prefs.skipPinned && tab.pinned) ||
        (prefs.skipAudible && tab.audible) ||
        (prefs.skipForm && unsavedTabs.has(id))) {
      stopCounting(id);
      continue;
    }

    // 沒有起點：僅在非活躍時開始（避免覆蓋既有起點）
    if (!(id in deactivatedAt)) {
      if (!tab.active) {
        const start = (typeof tab.lastAccessed==='number' && tab.lastAccessed>0) ? tab.lastAccessed : now;
        startCounting(id, start, now);
      }
      continue;
    }

    // 正常倒數（扣除自該分頁起算的暫停量）
    const base = pausedBase[id] ?? pTot;
    const idleMs = Math.max(0, (now - deactivatedAt[id]) - (pTot - base));
    const remain = thrMs - idleMs;

    if (prefs.enableNotify && remain > 0 && remain <= warnMs && !warned.has(id)) {
      chrome.notifications.create(`warn_${id}_${Date.now()}`, {
        type:'basic',
        iconUrl: chrome.runtime.getURL('icon.png'),
        title:'分頁即將關閉',
        message:`「${tab.title || url}」將在 ${formatDuration(remain)} 後被關閉`,
        priority:2
      });
      warned.add(id);
      saveState();
    }

    if (remain <= 0) {
      if (prefs.enableNotify) {
        chrome.notifications.create(`close_${id}_${Date.now()}`, {
          type:'basic',
          iconUrl: chrome.runtime.getURL('icon.png'),
          title:'分頁關閉通知',
          message:`「${tab.title || url}」閒置超過 ${formatDuration(thrMs)}，即將關閉`
        });
      }
      closeTabNow(id);
    }
  }
}

// 啟動循環
(function tick(){
  (async () => {
    await ensureState();
    await checkTabs();
  })().finally(() => setTimeout(tick, 1000));
})();
