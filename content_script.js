// content_script.js
// 此腳本偵測頁面是否有未提交的表單內容
// 當偵測到輸入或變更時，向背景腳本回報 hasUnsaved=true；提交表單時回報 false。

(function(){
    let hasUnsaved = false;
    // 傳送狀態給 background
    function report(status) {
      if (hasUnsaved !== status) {
        hasUnsaved = status;
        chrome.runtime.sendMessage({ type: 'form-status', hasUnsaved });
      }
    }
    // 監聽輸入與變更事件
    document.addEventListener('input', () => report(true), true);
    document.addEventListener('change', () => report(true), true);
    // 監聽表單提交，提交後視為無未提交資料
    document.addEventListener('submit', () => report(false), true);
    // 初始狀態回報一次，以便 background 建立對應資料
    chrome.runtime.sendMessage({ type: 'form-status', hasUnsaved: false });
  })();
  