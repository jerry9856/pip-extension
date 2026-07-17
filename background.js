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
    () => {
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

// 這個函式會被序列化後注入到每個 frame 執行（所有依賴都寫在函式內部）
function togglePip() {
  const dpip = window.documentPictureInPicture;

  // 已經開著自訂子母畫面 → 關掉它
  if (dpip && dpip.window && !dpip.window.closed) {
    dpip.window.close();
    return;
  }
  // 已經開著原生子母畫面 → 關掉它
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

  // 優先用 Document PiP（可放自訂控制列）；不支援時退回原生 PiP
  if (dpip && typeof dpip.requestWindow === "function") {
    openDocumentPip(video, dpip).catch((err) => {
      console.warn("[PiP] Document PiP 失敗，改用原生：", err && err.message);
      nativePip(video);
    });
  } else {
    nativePip(video);
  }

  // ---- 自訂控制列版本（Document Picture-in-Picture）----
  async function openDocumentPip(video, dpip) {
    const rect = video.getBoundingClientRect();
    const w0 = Math.round(rect.width) || video.videoWidth || 640;
    const h0 = Math.round(rect.height) || video.videoHeight || 360;

    const pipWindow = await dpip.requestWindow({ width: w0, height: h0 });
    const pdoc = pipWindow.document;

    // 記住影片原本的位置與狀態，關閉時原封不動放回去
    const placeholder = document.createElement("span");
    placeholder.style.display = "none";
    video.parentNode.insertBefore(placeholder, video);
    const savedCss = video.style.cssText;
    const savedControls = video.controls;

    const style = pdoc.createElement("style");
    style.textContent = `
      *{box-sizing:border-box;}
      html,body{margin:0;height:100%;background:#000;overflow:hidden;
        font-family:-apple-system,BlinkMacSystemFont,system-ui,sans-serif;}
      .pip-wrap{position:relative;width:100%;height:100%;background:#000;}
      .pip-wrap video{width:100%;height:100%;object-fit:contain;background:#000;}
      .pip-bar{position:absolute;left:0;right:0;bottom:0;display:flex;align-items:center;
        gap:6px;padding:10px 12px;
        background:linear-gradient(to top, rgba(0,0,0,.78), rgba(0,0,0,0));
        opacity:0;transform:translateY(8px);pointer-events:none;
        transition:opacity .18s ease, transform .18s ease;}
      body.pip-show .pip-bar{opacity:1;transform:none;pointer-events:auto;}
      .pip-bar button{cursor:pointer;border:none;color:#fff;background:rgba(255,255,255,.15);
        border-radius:9px;height:36px;min-width:36px;padding:0 10px;font-size:14px;font-weight:600;
        line-height:1;display:inline-flex;align-items:center;justify-content:center;
        transition:background .12s ease;}
      .pip-bar button:hover{background:rgba(255,255,255,.30);}
      .pip-bar button:active{background:rgba(255,255,255,.42);}
      .pip-bar .play{min-width:44px;font-size:16px;}
      .pip-bar .spacer{flex:1;}
      .pip-bar select{height:36px;border:none;border-radius:9px;background:rgba(255,255,255,.15);
        color:#fff;font-size:13px;font-weight:600;padding:0 8px;cursor:pointer;}
      .pip-bar select:hover{background:rgba(255,255,255,.30);}
      .pip-bar select option{color:#000;}
    `;
    pdoc.head.appendChild(style);

    const wrap = pdoc.createElement("div");
    wrap.className = "pip-wrap";
    pdoc.body.appendChild(wrap);

    // 把影片搬進子母畫面，關掉自訂前的原生控制列（用我們自己的）
    video.controls = false;
    // 直接寫進 inline style，蓋掉原網站可能留下的固定寬高（否則拖曳邊角時影片不會跟著縮放）
    video.style.cssText =
      "width:100%;height:100%;max-width:none;max-height:none;object-fit:contain;display:block;background:#000;";
    wrap.appendChild(video);

    // 控制列
    const bar = pdoc.createElement("div");
    bar.className = "pip-bar";

    const btnBack = pdoc.createElement("button");
    btnBack.textContent = "«10";
    btnBack.title = "後退 10 秒";

    const btnPlay = pdoc.createElement("button");
    btnPlay.className = "play";
    btnPlay.title = "播放 / 暫停";

    const btnFwd = pdoc.createElement("button");
    btnFwd.textContent = "10»";
    btnFwd.title = "前進 10 秒";

    const spacer = pdoc.createElement("div");
    spacer.className = "spacer";

    const speed = pdoc.createElement("select");
    speed.title = "播放速度";
    [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].forEach((r) => {
      const o = pdoc.createElement("option");
      o.value = String(r);
      o.textContent = r + "x";
      speed.appendChild(o);
    });
    speed.value = String(video.playbackRate || 1);

    bar.append(btnBack, btnPlay, btnFwd, spacer, speed);
    wrap.appendChild(bar);

    // ---- 行為 ----
    const syncPlayIcon = () => { btnPlay.textContent = video.paused ? "▶" : "⏸"; };
    syncPlayIcon();

    btnPlay.addEventListener("click", () => {
      if (video.paused) video.play().catch(() => {});
      else video.pause();
    });
    btnBack.addEventListener("click", () => {
      video.currentTime = Math.max(0, video.currentTime - 10);
    });
    btnFwd.addEventListener("click", () => {
      const end = isFinite(video.duration) ? video.duration : Number.MAX_SAFE_INTEGER;
      video.currentTime = Math.min(end, video.currentTime + 10);
    });
    speed.addEventListener("change", () => {
      video.playbackRate = parseFloat(speed.value);
    });

    video.addEventListener("play", syncPlayIcon);
    video.addEventListener("pause", syncPlayIcon);
    video.addEventListener("ratechange", () => { speed.value = String(video.playbackRate); });

    // 游標移到子母畫面上才顯示控制列，靜止 2.5 秒後自動隱藏
    let hideTimer;
    const show = () => {
      pdoc.body.classList.add("pip-show");
      pipWindow.clearTimeout(hideTimer);
      hideTimer = pipWindow.setTimeout(
        () => pdoc.body.classList.remove("pip-show"),
        2500
      );
    };
    pdoc.body.addEventListener("pointermove", show);
    pdoc.body.addEventListener("pointerdown", show);
    pdoc.body.addEventListener("pointerleave", () => {
      pipWindow.clearTimeout(hideTimer);
      pdoc.body.classList.remove("pip-show");
    });
    show(); // 開啟時先亮一下讓使用者知道有控制列

    // 關閉子母畫面時，把影片放回原位並還原狀態
    pipWindow.addEventListener("pagehide", () => {
      video.controls = savedControls;
      video.style.cssText = savedCss;
      if (placeholder.parentNode) {
        placeholder.parentNode.insertBefore(video, placeholder);
      }
      placeholder.remove();
    }, { once: true });
  }

  // ---- 原生 PiP 版本（退回方案）----
  // 原生子母畫面視窗不支援自訂 UI／變速，但至少提供 播放/暫停 與 快轉/倒退
  function nativePip(video) {
    const enter = () => {
      video.requestPictureInPicture().then(() => {
        try {
          const ms = navigator.mediaSession;
          if (!ms) return;
          ms.setActionHandler("play", () => video.play().catch(() => {}));
          ms.setActionHandler("pause", () => video.pause());
          ms.setActionHandler("seekbackward", (d) => {
            const off = (d && d.seekOffset) || 10;
            video.currentTime = Math.max(0, video.currentTime - off);
          });
          ms.setActionHandler("seekforward", (d) => {
            const off = (d && d.seekOffset) || 10;
            const end = isFinite(video.duration) ? video.duration : Number.MAX_SAFE_INTEGER;
            video.currentTime = Math.min(end, video.currentTime + off);
          });
        } catch (e) {}
      }).catch((err) => {
        console.warn("[PiP] 無法進入子母畫面：", err && err.message);
      });
    };
    if (video.readyState >= 1) {
      enter();
    } else {
      video.addEventListener("loadedmetadata", enter, { once: true });
      try { video.load(); } catch (e) {}
    }
  }
}
