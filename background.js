// 點圖示或按快捷鍵時，把 togglePip 注入當前分頁（含所有 iframe）執行
function runTogglePip(tab) {
  if (!tab || !tab.id) return;
  const url = tab.url || "";
  // 不能注入到 chrome:// 等特殊頁面
  if (/^(chrome|edge|about|chrome-extension|devtools|view-source):/i.test(url)) {
    return;
  }
  chrome.scripting.executeScript(
    {
      target: { tabId: tab.id, allFrames: true },
      func: togglePip
    },
    (results) => {
      if (chrome.runtime.lastError) {
        console.warn("[PiP] 注入失敗：", chrome.runtime.lastError.message);
      }
    }
  );
}

chrome.action.onClicked.addListener((tab) => runTogglePip(tab));

chrome.commands.onCommand.addListener((command) => {
  if (command !== "toggle-pip") return;
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    runTogglePip(tabs[0]);
  });
});

// 這個函式會被序列化後注入到每個 frame 執行
function togglePip() {
  if (!("pictureInPictureEnabled" in document)) return;

  // 已經有影片在子母畫面 → 關掉它
  if (document.pictureInPictureElement) {
    document.exitPictureInPicture().catch(() => {});
    return;
  }

  const videos = Array.from(document.querySelectorAll("video"));
  if (videos.length === 0) return;

  const area = (v) => {
    const r = v.getBoundingClientRect();
    return Math.max(r.width * r.height, 0);
  };

  // 排序：正在播放優先，其次畫面最大
  videos.sort((a, b) => {
    const playA = a.paused ? 0 : 1;
    const playB = b.paused ? 0 : 1;
    if (playA !== playB) return playB - playA;
    return area(b) - area(a);
  });

  const video = videos[0];

  // 有些網站用屬性禁止 PiP，這裡幫忙解除
  if (video.disablePictureInPicture) {
    try {
      video.disablePictureInPicture = false;
      video.removeAttribute("disablePictureInPicture");
    } catch (e) {}
  }

  const enterPip = () =>
    video.requestPictureInPicture().catch((err) => {
      console.warn("[PiP] 無法進入子母畫面：", err && err.message);
    });

  // readyState 夠了就直接進，否則等 metadata 載入
  if (video.readyState >= 1) {
    enterPip();
  } else {
    video.addEventListener("loadedmetadata", enterPip, { once: true });
    // 觸發載入，避免一直卡在 readyState 0
    try { video.load(); } catch (e) {}
  }
}
