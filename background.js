// background.js

// 擴充啟動時間，用於初始化已存在背景分頁倒數起點
const EXT_START = Date.now();

// 記錄每個分頁真正「離開時刻」的 timestamp（ms）
const deactivatedAt = {};
// 已發過提前通知的 tabId
const warned = new Set();
// 目前活躍分頁
let currentTabId = null;
// 用來追蹤哪些 tab 因 skipAudible 自動加入白名單
const audibleMap = new Map(); // tabId → hostname

// 用來追蹤哪些 tab 有未送出的表單
const unsavedTabs = new Set();

// 單位換算：天/時/分/秒 → 毫秒
function toMs(d, h, m, s) {
  return (d*86400 + h*3600 + m*60 + s) * 1000;
}

// 格式化毫秒為「D天H時M分S秒」，若全 0 則「0秒」
function formatDuration(ms) {
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
  if (parts.length === 0) parts.push(`0秒`);
  return parts.join('');
}

// 讀取使用者設定
function loadPrefs() {
  return new Promise(res => {
    chrome.storage.sync.get({
      idleDays:      0,
      idleHours:     0,
      idleMinutes:   30,
      idleSeconds:   0,
      notifyDays:    0,
      notifyHours:   0,
      notifyMinutes: 10,
      notifySeconds: 0,
      enableNotify:  true,
      skipPinned:    true,
      skipAudible:   true,
      skipForm:      true,
      whitelist:     [],
      blacklist:     []
    }, prefs => res(prefs));
  });
}

// 初始化：
// 1) 記下當前活躍分頁
// 2) 對所有已存在背景分頁設倒數起點為 EXT_START
function initTabs() {
  chrome.tabs.query({active:true, lastFocusedWindow:true}, tabs => {
    if (tabs[0]) currentTabId = tabs[0].id;
  });
  chrome.tabs.query({}, tabs => {
    for (const t of tabs) {
      if (!t.active && t.id != null) {
        deactivatedAt[t.id] = EXT_START;
      }
    }
  });
}
chrome.runtime.onInstalled.addListener(initTabs);
chrome.runtime.onStartup.addListener(initTabs);

// 新分頁建立：若一開始就在背景，就從現在開始倒數
chrome.tabs.onCreated.addListener(tab => {
  if (!tab.active && tab.id != null) {
    deactivatedAt[tab.id] = Date.now();
  }
});

// 當任何 tab 被關閉
chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
  // 如果這個 tabId 在 audibleMap 裡，代表它曾因 skipAudible 而加入白名單
  if (audibleMap.has(tabId)) {
    const host = audibleMap.get(tabId);
    audibleMap.delete(tabId);

    // 確認現在沒有其他 tab 仍在播放該 host 再移除
    const tabs = await new Promise(r => chrome.tabs.query({}, r));
    const stillAudible = tabs.some(t =>
      t.audible && t.url && new URL(t.url).hostname === host
    );
    if (!stillAudible) {
      // 從 whitelist 移除該 host
      const { whitelist=[] } = await new Promise(r =>
        chrome.storage.sync.get({whitelist:[]}, r)
      );
      const updated = whitelist.filter(h => h !== host);
      if (updated.length !== whitelist.length) {
        chrome.storage.sync.set({ whitelist: updated });
      }
    }
  }
  delete deactivatedAt[tabId];
  warned.delete(tabId);
  unsavedTabs.delete(tabId);
  if (currentTabId === tabId) currentTabId = null;
});

// 活頁切換：用 currentTabId 追蹤前一活躍分頁
chrome.tabs.onActivated.addListener(({tabId}) => {
  if (currentTabId != null && currentTabId !== tabId) {
    deactivatedAt[currentTabId] = Date.now();
    warned.delete(currentTabId);
  }
  currentTabId = tabId;
  delete deactivatedAt[tabId];
  warned.delete(tabId);
});

// 監聽 Content Script 回報的表單狀態
chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg.type === 'form-status' && sender.tab?.id != null) {
    if (msg.hasUnsaved) unsavedTabs.add(sender.tab.id);
    else                unsavedTabs.delete(sender.tab.id);
  }
});

// Popup 取得 deactivatedAt
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'getDeactivatedTimes') {
    sendResponse({deactivatedAt});
    return true;
  }
});

// 當分頁屬性更新時（含 pinned、audible、URL 等）
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // 1) 取消釘選時移除白名單
  if ('pinned' in changeInfo && changeInfo.pinned === false) {
    if (tab.url) {
      try {
        const host = new URL(tab.url).hostname;
        const { whitelist = [] } = await new Promise(r =>
          chrome.storage.sync.get({ whitelist: [] }, r)
        );
        if (whitelist.includes(host)) {
          const updated = whitelist.filter(h => h !== host);
          chrome.storage.sync.set({ whitelist: updated });
        }
      } catch {}
    }
  }

  // 2) 偵測 audible 從 true → false，移除白名單
  if ('audible' in changeInfo && changeInfo.audible === false) {
    if (tab.url) {
      try {
        const host = new URL(tab.url).hostname;
        const { whitelist = [] } = await new Promise(r =>
          chrome.storage.sync.get({ whitelist: [] }, r)
        );
        if (whitelist.includes(host)) {
          const updated = whitelist.filter(h => h !== host);
          chrome.storage.sync.set({ whitelist: updated });
        }
      } catch {}
    }
  }
});

chrome.runtime.onMessage.addListener(async (msg, sender, sendResponse) => {
  if (!sender.tab?.id) return;

  // 表單狀態回報
  if (msg.type === 'form-status') {
    const tabId = sender.tab.id;
    const url   = sender.tab.url || '';
    // 1) 記錄有無未提交
    if (msg.hasUnsaved) {
      unsavedTabs.add(tabId);
    } else {
      unsavedTabs.delete(tabId);

      // 2) 當 hasUnsaved === false 時，把該 host 從白名單移除
      try {
        const host = new URL(url).hostname;
        // 讀現有白名單
        const { whitelist = [] } = await new Promise(r =>
          chrome.storage.sync.get({ whitelist: [] }, r)
        );
        if (whitelist.includes(host)) {
          const updated = whitelist.filter(h => h !== host);
          chrome.storage.sync.set({ whitelist: updated });
        }
      } catch (e) {
        // URL 解析失敗，略過
      }
    }
    return;
  }

  // Popup 取得 deactivatedAt
  if (msg.type === 'getDeactivatedTimes') {
    sendResponse({ deactivatedAt });
    return true;
  }
});

// 核心：每秒檢查一次
async function checkTabs() {
  const prefs = await loadPrefs();
  const thrMs = toMs(prefs.idleDays, prefs.idleHours, prefs.idleMinutes, prefs.idleSeconds);
  const warnMs= toMs(prefs.notifyDays,prefs.notifyHours,prefs.notifyMinutes,prefs.notifySeconds);
  const now   = Date.now();

  chrome.tabs.query({}, async tabs => {
    if (prefs.skipAudible) {
      for (const t of tabs) {
        if (t.audible && t.url && !audibleMap.has(t.id)) {
          const host = new URL(t.url).hostname;
          audibleMap.set(t.id, host);
          // 加入 whitelist
          const { whitelist=[] } = await new Promise(r =>
            chrome.storage.sync.get({whitelist:[]}, r)
          );
          if (!whitelist.includes(host)) {
            whitelist.push(host);
            chrome.storage.sync.set({ whitelist });
          }
        }
      }
    }
    // 讀現有白名單
    chrome.storage.sync.get({ whitelist: [] }, data => {
      const wlSet = new Set(data.whitelist);

      // 1) skipPinned → 加入所有 pinned 分頁的 host
      if (prefs.skipPinned) {
        for (const t of tabs) {
          if (t.pinned && t.url) {
            try { wlSet.add(new URL(t.url).hostname); } catch {}
          }
        }
      }

      // 2) skipAudible → 加入所有正在播放的 host
      if (prefs.skipAudible) {
        for (const t of tabs) {
          if (t.audible && t.url) {
            try { wlSet.add(new URL(t.url).hostname); } catch {}
          }
        }
      }

      // 3) skipForm → 加入所有 unsavedTabs 裡的 host
      if (prefs.skipForm) {
        for (const tabId of unsavedTabs) {
          const t = tabs.find(x => x.id === tabId);
          if (t?.url) {
            try { wlSet.add(new URL(t.url).hostname); } catch {}
          }
        }
      }

      const newWL = Array.from(wlSet);
      // 若有變動，寫回 storage 並更新 prefs.whitelist
      if (newWL.length !== data.whitelist.length) {
        chrome.storage.sync.set({ whitelist: newWL }, () => {
          prefs.whitelist = newWL;
          // （可選）加個 console.log 幫你除錯
          console.log('[AutoClose] updated whitelist:', newWL);
        });
      }
    });

    // 開始原本的黑白名單、倒數、提醒、關閉邏輯
    for (const tab of tabs) {
      const id  = tab.id;
      const url = tab.url || '';
      if (id == null || !(id in deactivatedAt)) continue;

      // 黑名單：立即關閉
      if (prefs.blacklist.some(pat => url.includes(pat))) {
        chrome.tabs.remove(id, () => {});
        delete deactivatedAt[id];
        warned.delete(id);
        continue;
      }

      // 白名單：永不關閉
      if (prefs.whitelist.some(pat => url.includes(pat))) {
        delete deactivatedAt[id];
        warned.delete(id);
        continue;
      }

      const idleMs = now - deactivatedAt[id];
      const remain = thrMs - idleMs;

      // 提前通知
      if (prefs.enableNotify && remain > 0 && remain <= warnMs && !warned.has(id)) {
        chrome.notifications.create(`warn_${id}_${Date.now()}`, {
          type: 'basic',
          iconUrl: chrome.runtime.getURL('icon.png'),
          title: '分頁即將關閉',
          message: `「${tab.title||url}」將在 ${formatDuration(remain)} 後被關閉`,
          priority: 2
        });
        warned.add(id);
      }

      // 到達閾值：直接關閉（可保留通知選擇）
      if (remain <= 0) {
        if (prefs.enableNotify) {
          chrome.notifications.create(`close_${id}_${Date.now()}`, {
            type: 'basic',
            iconUrl: chrome.runtime.getURL('icon.png'),
            title: '分頁關閉通知',
            message: `「${tab.title||url}」閒置超過 ${formatDuration(thrMs)}，即將關閉`
          });
        }
        setTimeout(() => chrome.tabs.remove(id, () => {}), 50);
        delete deactivatedAt[id];
        warned.delete(id);
      }
    }
  });
}

// 啟動秒級循環
(function tick(){
  checkTabs();
  setTimeout(tick, 1000);
})();
