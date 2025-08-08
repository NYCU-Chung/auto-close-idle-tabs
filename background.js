// background.js

// -------------------- 狀態（持久化到 storage.session） --------------------
let EXT_START = Date.now();             // 擴充啟動時間（同瀏覽器工作階段）
let deactivatedAt = {};                 // { tabId: lastDeactivatedTs }
let warned = new Set();                 // 已發過提前通知的 tabId
let currentTabId = null;                // 目前活躍分頁
const unsavedTabs = new Set();          // 含未提交表單的 tabId（由 content-script 回報）

async function loadState() {
  const s = await chrome.storage.session.get(['extStart', 'deactivatedAt', 'warned']);
  if (s.extStart) EXT_START = s.extStart; else await chrome.storage.session.set({ extStart: EXT_START });
  if (s.deactivatedAt) deactivatedAt = s.deactivatedAt;
  if (s.warned) warned = new Set(s.warned);
}
function saveState() {
  chrome.storage.session.set({
    extStart: EXT_START,
    deactivatedAt,
    warned: [...warned]
  });
}

// -------------------- 使用者偏好 --------------------
function loadPrefs() {
  return new Promise(res => {
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
  ms = Math.max(0,ms);
  let s = Math.floor(ms/1000),
      d = Math.floor(s/86400); s -= d*86400,
      h = Math.floor(s/3600);  s -= h*3600,
      m = Math.floor(s/60);    s -= m*60;
  const parts = [];
  if(d) parts.push(`${d}天`);
  if(h) parts.push(`${h}時`);
  if(m) parts.push(`${m}分`);
  if(s) parts.push(`${s}秒`);
  if(parts.length===0) parts.push('0秒');
  return parts.join('');
}
function closeTabNow(id){
  setTimeout(() => {
    chrome.tabs.remove(id, () => {/* ignore any remove error */});
  }, 50);
  delete deactivatedAt[id];
  warned.delete(id);
  saveState();
}

// 安全的白/黑名單比對：以 hostname 為主、退回 href 包含
function urlMatches(url, patterns) {
  if (!patterns || !patterns.length || !url) return false;
  try {
    const u = new URL(url);
    const host = u.hostname;
    return patterns.some(raw => {
      const p = String(raw || '').trim();
      if (!p) return false;
      if (host === p) return true;          // 完全相等
      if (host.endsWith('.' + p)) return true; // 子網域邊界命中
      return u.href.includes(p);            // 最後退路：整串包含
    });
  } catch {
    return patterns.some(raw => (url || '').includes(String(raw || '').trim()));
  }
}

// -------------------- 初始化 --------------------
async function initTabs() {
  await loadState();
  chrome.tabs.query({active:true, lastFocusedWindow:true}, tabs=>{
    if (tabs[0]) currentTabId = tabs[0].id;
  });
  chrome.tabs.query({}, tabs=>{
    for (const t of tabs) {
      if (!t.active && t.id!=null && !(t.id in deactivatedAt)) {
        deactivatedAt[t.id] = EXT_START;
      }
    }
    saveState();
  });
}
chrome.runtime.onInstalled.addListener(initTabs);
chrome.runtime.onStartup.addListener(initTabs);

// -------------------- 右鍵加入白/黑名單 --------------------
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({ id:'add-whitelist', title:'加入白名單', contexts:['page'] });
  chrome.contextMenus.create({ id:'add-blacklist', title:'加入黑名單', contexts:['page'] });
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab?.url) return;
  let host;
  try { host = new URL(tab.url).hostname; } catch { return; }
  chrome.storage.sync.get(['whitelist','blacklist'], prefs => {
    let {whitelist=[], blacklist=[]} = prefs;
    if (info.menuItemId === 'add-whitelist' && !whitelist.includes(host)) {
      whitelist.push(host);
      chrome.storage.sync.set({whitelist});
    }
    if (info.menuItemId === 'add-blacklist' && !blacklist.includes(host)) {
      blacklist.push(host);
      chrome.storage.sync.set({blacklist}, () => {
        // 立即關閉同 host 的分頁
        chrome.tabs.query({}, ts=>{
          for (const t of ts) {
            try {
              if (new URL(t.url||'').hostname === host) closeTabNow(t.id);
            } catch {}
          }
        });
      });
    }
  });
});

// -------------------- 事件：分頁建立/切換/關閉/休眠/換網址 --------------------
// 新分頁：若是白名單就不納入倒數
chrome.tabs.onCreated.addListener(async tab => {
  if (!tab.active && tab.id!=null) {
    const { whitelist = [] } = await new Promise(r => chrome.storage.sync.get({ whitelist: [] }, r));
    if (urlMatches(tab.url || '', whitelist)) {
      delete deactivatedAt[tab.id];
      warned.delete(tab.id);
      saveState();
      return;
    }
    deactivatedAt[tab.id] = Date.now();
    warned.delete(tab.id);
    saveState();
  }
});

chrome.tabs.onActivated.addListener(({tabId}) => {
  if (currentTabId!=null && currentTabId!==tabId) {
    deactivatedAt[currentTabId] = Date.now();
    warned.delete(currentTabId);
  }
  currentTabId = tabId;
  delete deactivatedAt[tabId];
  warned.delete(tabId);
  saveState();
});

chrome.tabs.onRemoved.addListener(tabId => {
  delete deactivatedAt[tabId];
  warned.delete(tabId);
  unsavedTabs.delete(tabId);
  if (currentTabId===tabId) currentTabId=null;
  saveState();
});

// 換網址 & 休眠/喚醒
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // URL 改變：若進入白名單，立即退出倒數
  if (changeInfo.url) {
    const { whitelist = [] } = await new Promise(r => chrome.storage.sync.get({ whitelist: [] }, r));
    if (urlMatches(tab?.url || '', whitelist)) {
      delete deactivatedAt[tabId];
      warned.delete(tabId);
      saveState();
    }
  }
  // 被 Chrome 休眠或喚醒：將起點重設為現在，避免卡在 0 秒
  if (changeInfo.discarded === true || changeInfo.discarded === false) {
    deactivatedAt[tabId] = Date.now();
    warned.delete(tabId);
    saveState();
  }
});

// -------------------- 事件：content-script 回報表單狀態 --------------------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'form-status' && sender.tab?.id != null) {
    if (msg.hasUnsaved) unsavedTabs.add(sender.tab.id);
    else                unsavedTabs.delete(sender.tab.id);
    return;
  }
  if (msg.type === 'getDeactivatedTimes') {
    (async () => {
      if (!deactivatedAt || !Object.keys(deactivatedAt).length) {
        const s = await chrome.storage.session.get(['deactivatedAt']);
        sendResponse({deactivatedAt: s.deactivatedAt || {}});
      } else {
        sendResponse({deactivatedAt});
      }
    })();
    return true; // async
  }
});

// -------------------- 核心：每秒檢查 --------------------
async function checkTabs() {
  const prefs  = await loadPrefs();
  const wl     = prefs.whitelist || [];
  const thrMs  = toMs(prefs.idleDays,  prefs.idleHours,  prefs.idleMinutes,  prefs.idleSeconds);
  const warnMs = toMs(prefs.notifyDays,prefs.notifyHours,prefs.notifyMinutes,prefs.notifySeconds);
  const now    = Date.now();

  const tabs = await new Promise(r => chrome.tabs.query({}, r));

  for (const tab of tabs) {
    const id  = tab.id;
    const url = tab.url || '';
    if (id == null) continue;

    // 0) 黑名單：不論狀態立即關
    if (urlMatches(url, prefs.blacklist)) {
      closeTabNow(id);
      continue;
    }

    // 1) 白名單：永不處理（先判斷，避免任何倒數）
    if (urlMatches(url, wl)) {
      delete deactivatedAt[id];
      warned.delete(id);
      continue;
    }

    // 2) 執行期跳過（不寫入白名單）
    if ((prefs.skipPinned  && tab.pinned) ||
        (prefs.skipAudible && tab.audible) ||
        (prefs.skipForm    && unsavedTabs.has(id))) {
      delete deactivatedAt[id];
      warned.delete(id);
      continue;
    }

    // 3) 沒有起點記錄：只在「非活躍」時開始倒數
    if (!(id in deactivatedAt)) {
      if (!tab.active) {
        deactivatedAt[id] = now; // 或 EXT_START
        saveState();
      }
      continue;
    }

    // 4) 正常倒數
    const idleMs = now - deactivatedAt[id];
    const remain = thrMs - idleMs;

    // 提前通知
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

    // 到期關閉
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
  checkTabs();
  setTimeout(tick, 1000);
})();
