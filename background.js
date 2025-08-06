// background.js

const EXT_START = Date.now();
const deactivatedAt = {};
const warned = new Set();
let currentTabId = null;

function toMs(d,h,m,s){ return (d*86400+h*3600+m*60+s)*1000; }

function formatDuration(ms){
  ms = Math.max(0,ms);
  let s = Math.floor(ms/1000),
      d = Math.floor(s/86400); s-=d*86400,
      h = Math.floor(s/3600);  s-=h*3600,
      m = Math.floor(s/60);    s-=m*60;
  const parts = [];
  if(d) parts.push(`${d}天`);
  if(h) parts.push(`${h}時`);
  if(m) parts.push(`${m}分`);
  if(s) parts.push(`${s}秒`);
  if(parts.length===0) parts.push(`0秒`);
  return parts.join('');
}

function loadPrefs(){
  return new Promise(res=>{
    chrome.storage.sync.get({
      idleDays:0,idleHours:0,idleMinutes:30,idleSeconds:0,
      notifyDays:0,notifyHours:0,notifyMinutes:10,notifySeconds:0,
      enableNotify:true,
      whitelist:[],blacklist:[]
    },prefs=>res(prefs));
  });
}

function initTabs(){
  chrome.tabs.query({active:true,lastFocusedWindow:true},tabs=>{
    if(tabs.length) currentTabId=tabs[0].id;
  });
  chrome.tabs.query({},tabs=>{
    for(const t of tabs){
      if(!t.active&&t.id!=null) deactivatedAt[t.id]=EXT_START;
    }
  });
}
chrome.runtime.onInstalled.addListener(initTabs);
chrome.runtime.onStartup  .addListener(initTabs);

chrome.tabs.onCreated.addListener(tab=>{
  if(!tab.active&&tab.id!=null) deactivatedAt[tab.id]=Date.now();
});

chrome.tabs.onRemoved.addListener(tabId=>{
  delete deactivatedAt[tabId];
  warned.delete(tabId);
  if(currentTabId===tabId) currentTabId=null;
});

chrome.tabs.onActivated.addListener(({tabId})=>{
  if(currentTabId!=null&&currentTabId!==tabId){
    deactivatedAt[currentTabId]=Date.now();
    warned.delete(currentTabId);
  }
  currentTabId=tabId;
  delete deactivatedAt[tabId];
  warned.delete(tabId);
});

chrome.runtime.onMessage.addListener((msg,sender,sendResponse)=>{
  if(msg.type==='getDeactivatedTimes'){
    sendResponse({deactivatedAt});
    return true;
  }
});

async function checkTabs(){
  const prefs = await loadPrefs();
  const thrMs = toMs(prefs.idleDays,prefs.idleHours,prefs.idleMinutes,prefs.idleSeconds);
  const warnMs= toMs(prefs.notifyDays,prefs.notifyHours,prefs.notifyMinutes,prefs.notifySeconds);
  const now   = Date.now();

  chrome.tabs.query({},tabs=>{
    for(const tab of tabs){
      const id=tab.id, url=tab.url||'';
      // 黑名單：不論活躍都關
      if(prefs.blacklist.some(p=>url.includes(p))){
        chrome.tabs.remove(id,()=>{});
        delete deactivatedAt[id];
        warned.delete(id);
        continue;
      }
      // 只對已記錄離開的分頁處理
      if(id==null||!(id in deactivatedAt)) continue;
      // 白名單：跳過
      if(prefs.whitelist.some(p=>url.includes(p))){
        delete deactivatedAt[id];
        warned.delete(id);
        continue;
      }

      const idleMs = now - deactivatedAt[id];
      const remain = thrMs - idleMs;

      // 提前通知
      if(prefs.enableNotify && remain>0 && remain<=warnMs && !warned.has(id)){
        chrome.notifications.create(`warn_${id}_${Date.now()}`,{
          type:'basic',
          iconUrl:chrome.runtime.getURL('icon.png'),
          title:'分頁即將關閉',
          message:`「${tab.title||url}」將在 ${formatDuration(remain)} 後被關閉`,
          priority:2
        });
        warned.add(id);
      }

      // 到達閾值：直接關閉
      if(remain<=0){
        setTimeout(()=>chrome.tabs.remove(id,()=>{}),50);
        delete deactivatedAt[id];
        warned.delete(id);
      }
    }
  });
}

(function tick(){
  checkTabs();
  setTimeout(tick,1000);
})();
