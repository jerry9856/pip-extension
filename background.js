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
      .pip-bar{position:absolute;left:0;right:0;bottom:0;display:flex;flex-direction:column;
        gap:8px;padding:10px 12px;
        background:linear-gradient(to top, rgba(0,0,0,.78), rgba(0,0,0,0));
        opacity:0;transform:translateY(8px);pointer-events:none;
        transition:opacity .18s ease, transform .18s ease;}
      body.pip-show .pip-bar{opacity:1;transform:none;pointer-events:auto;}
      .pip-row{display:flex;align-items:center;gap:8px;width:100%;}
      .pip-time{color:#fff;font-size:12px;font-weight:600;font-variant-numeric:tabular-nums;
        min-width:40px;text-align:center;flex:none;}
      .pip-seek{flex:1;height:16px;margin:0;cursor:pointer;accent-color:#fff;}
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
      .pip-subs{position:absolute;left:4%;right:4%;bottom:6%;display:none;
        text-align:center;pointer-events:none;white-space:pre-line;
        color:#fff;font-size:clamp(13px, 5.2vh, 40px);font-weight:600;line-height:1.35;
        text-shadow:0 0 4px #000,0 1px 2px #000,0 0 8px rgba(0,0,0,.85);
        transition:bottom .18s ease;}
      body.pip-show .pip-subs{bottom:106px;}
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

    // Netflix 等網站的字幕是疊在影片上的 HTML，搬走影片後會留在原頁面，這裡把它鏡射進浮窗
    setupSubtitleMirror(pdoc, wrap, pipWindow);

    // 控制列
    const bar = pdoc.createElement("div");
    bar.className = "pip-bar";

    // 進度條列：目前時間 / 進度條 / 總時間
    const seekRow = pdoc.createElement("div");
    seekRow.className = "pip-row";

    const timeCur = pdoc.createElement("span");
    timeCur.className = "pip-time";
    timeCur.textContent = "0:00";

    const seek = pdoc.createElement("input");
    seek.className = "pip-seek";
    seek.type = "range";
    seek.min = "0";
    seek.max = "1000";
    seek.step = "1";
    seek.value = "0";
    seek.title = "拖曳調整播放進度";

    const timeDur = pdoc.createElement("span");
    timeDur.className = "pip-time";
    timeDur.textContent = "0:00";

    seekRow.append(timeCur, seek, timeDur);

    // 按鈕列
    const ctrlRow = pdoc.createElement("div");
    ctrlRow.className = "pip-row";

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

    ctrlRow.append(btnBack, btnPlay, btnFwd, spacer, speed);
    bar.append(seekRow, ctrlRow);
    wrap.appendChild(bar);

    // ---- 行為 ----
    const syncPlayIcon = () => { btnPlay.textContent = video.paused ? "▶" : "⏸"; };
    syncPlayIcon();

    // 進度條：把 0~1000 對應到 0~duration，直播/未知長度時停用
    const fmt = (s) => {
      if (!isFinite(s) || s < 0) return "0:00";
      s = Math.floor(s);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = String(s % 60).padStart(2, "0");
      return h > 0 ? h + ":" + String(m).padStart(2, "0") + ":" + sec : m + ":" + sec;
    };
    let dragging = false;
    let wasPlaying = false;
    const seekable = () => isFinite(video.duration) && video.duration > 0;
    const syncSeek = () => {
      timeDur.textContent = seekable() ? fmt(video.duration) : "直播";
      seek.disabled = !seekable();
      if (dragging || !seekable()) return;
      seek.value = String(Math.round((video.currentTime / video.duration) * 1000));
      timeCur.textContent = fmt(video.currentTime);
    };
    const seekToSlider = () => {
      if (!seekable()) return;
      const t = (parseFloat(seek.value) / 1000) * video.duration;
      timeCur.textContent = fmt(t);
      video.currentTime = t;
    };
    seek.addEventListener("pointerdown", () => {
      dragging = true;
      wasPlaying = !video.paused;
      if (wasPlaying) video.pause(); // 拖曳時暫停，畫面才會即時停在拖到的位置
    });
    seek.addEventListener("input", seekToSlider);
    const endDrag = () => {
      seekToSlider();
      dragging = false;
      if (wasPlaying) { wasPlaying = false; video.play().catch(() => {}); }
    };
    seek.addEventListener("change", endDrag);
    seek.addEventListener("pointerup", endDrag);
    seek.addEventListener("pointercancel", endDrag);
    video.addEventListener("timeupdate", syncSeek);
    video.addEventListener("durationchange", syncSeek);
    video.addEventListener("loadedmetadata", syncSeek);
    syncSeek();

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

  // ---- 字幕鏡射 ----
  // 有些網站的字幕不在影片串流裡，而是用 HTML 疊在 <video> 上（Netflix、YouTube 等）。
  // 影片被搬進浮窗後，網站的播放器仍會持續更新原頁面上的字幕節點，
  // 所以只要監聽那個節點，把文字同步到浮窗裡的字幕層即可。
  function setupSubtitleMirror(pdoc, wrap, pipWindow) {
    const SUB_SELECTORS = [
      ".player-timedtext",             // Netflix
      ".ytp-caption-window-container", // YouTube
      ".shaka-text-container",         // Shaka Player（不少自架播放器）
    ];

    const subs = pdoc.createElement("div");
    subs.className = "pip-subs";
    wrap.appendChild(subs);

    let observer = null;
    let source = null;

    const findSource = () => {
      for (const sel of SUB_SELECTORS) {
        const el = document.querySelector(sel);
        if (el) return el;
      }
      return null;
    };

    const render = () => {
      const text = source ? (source.innerText || "").trim() : "";
      if (text) {
        subs.textContent = text;
        subs.style.display = "block";
      } else {
        subs.style.display = "none";
      }
    };

    const attach = () => {
      const el = findSource();
      if (el === source) return;
      if (observer) observer.disconnect();
      source = el;
      if (!source) {
        render();
        return;
      }
      observer = new MutationObserver(render);
      observer.observe(source, { subtree: true, childList: true, characterData: true });
      render();
    };

    attach();
    // 字幕容器可能被網站砍掉重建（換集、切換字幕語言），定期確認有掛在對的節點上
    const rebindTimer = setInterval(attach, 1000);

    pipWindow.addEventListener("pagehide", () => {
      clearInterval(rebindTimer);
      if (observer) observer.disconnect();
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
