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
      // 在頁面主世界執行，才能取用 Netflix 等網站的內部播放器 API
      world: "MAIN",
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
  const isTop = window === window.top;

  // 同網域 iframe 裡的影片統一交給上層框架處理：上層看得到這裡的 <video>，
  // 而且 Document PiP 只能由最上層框架開啟。跨網域 iframe 上層看不到，才自己處理。
  if (!isTop) {
    try {
      if (window.parent.document) return;
    } catch (e) {}
  }

  // 已經開著自訂子母畫面 → 關掉它
  if (dpip && dpip.window && !dpip.window.closed) {
    dpip.window.close();
    return;
  }
  // 已經開著原生子母畫面（含同網域 iframe 裡的影片）→ 關掉它
  const pipDoc = findNativePipDoc(document, 0);
  if (pipDoc) {
    pipDoc.exitPictureInPicture().catch(() => {});
    return;
  }

  // 收集本文件與同網域 iframe 裡的影片（friDay 影音等網站把播放器放在 iframe）
  const found = collectVideos();
  if (found.length === 0) return;

  const area = (v) => {
    const r = v.getBoundingClientRect();
    return Math.max(r.width * r.height, 0);
  };

  // 排序：正在播放優先，其次畫面最大
  found.sort((a, b) => {
    const playA = a.video.paused ? 0 : 1;
    const playB = b.video.paused ? 0 : 1;
    if (playA !== playB) return playB - playA;
    return area(b.video) - area(a.video);
  });

  // 用 let：Netflix 重新緩衝時會換掉 <video> 元素，屆時要把參照換成新元素
  let video = found[0].video;
  // 影片所在的同網域 iframe（本文件裡的那一個）；null 表示影片就在本文件
  const hostFrame = found[0].frame;
  const ctrl = makeController();

  // 有些網站用屬性禁止 PiP，這裡幫忙解除
  if (video.disablePictureInPicture) {
    try {
      video.disablePictureInPicture = false;
      video.removeAttribute("disablePictureInPicture");
    } catch (e) {}
  }

  // 優先用 Document PiP（可放自訂控制列）；不支援時退回原生 PiP。
  // 影片在同網域 iframe 裡時，改把整個 iframe 搬進浮窗（見 openIframePip）。
  if (dpip && typeof dpip.requestWindow === "function") {
    const opening = hostFrame ? openIframePip(dpip, hostFrame) : openDocumentPip(dpip);
    opening.catch((err) => {
      console.warn("[PiP] Document PiP 失敗，改用原生：", err && err.message);
      nativePip();
    });
  } else {
    nativePip();
  }

  // ---- 播放控制抽象層 ----
  // Netflix 的串流由它自己的播放器管理，直接操作 <video>（play()/currentTime）
  // 在暫停較久或跳轉時會失效，必須改呼叫 Netflix 內部播放器 API；
  // 其他網站則直接控制 <video>。
  function makeController() {
    const isNetflix = /(^|\.)netflix\.com$/.test(location.hostname);

    // 取得 Netflix 內部播放器（非 Netflix 或取不到時回傳 null）
    const nf = () => {
      try {
        const app =
          window.netflix &&
          window.netflix.appContext &&
          window.netflix.appContext.state &&
          window.netflix.appContext.state.playerApp;
        const api = app && app.getAPI();
        const vp = api && api.videoPlayer;
        if (!vp) return null;
        const ids = vp.getAllPlayerSessionIds() || [];
        const id = ids.find((s) => String(s).indexOf("watch-") === 0) || ids[0];
        return (id && vp.getVideoPlayerBySessionId(id)) || null;
      } catch (e) {
        return null;
      }
    };

    return {
      play() {
        const p = nf();
        if (p) {
          try { p.play(); return; } catch (e) {}
        }
        video.play().catch(() => {});
      },
      pause() {
        const p = nf();
        if (p) {
          try { p.pause(); return; } catch (e) {}
        }
        video.pause();
      },
      // 跳轉一律直接改 currentTime（Netflix API 的 seek() 每次都會觸發重新緩衝而卡住；
      // 直接改 currentTime 在緩衝範圍內是瞬間完成）。跳出緩衝範圍造成的卡住，
      // 由分段的復原機制處理：先試著恢復播放，還是卡就原地 seek 逼引擎重抓片段。
      // 元素被 Netflix 換新的情況則由浮窗的接手監視器處理。
      seekTo(sec) {
        const wasPlaying = !video.paused;
        video.currentTime = sec;
        if (!isNetflix || !wasPlaying) return;
        // 用影片目前所在視窗（浮窗）的計時器，原分頁在背景時計時器會被瀏覽器降速
        const win = (video.ownerDocument && video.ownerDocument.defaultView) || window;
        const stalled = () => video.paused || video.readyState < 3;
        win.setTimeout(() => {
          if (!stalled()) return;
          const p = nf();
          if (p) {
            try { p.play(); } catch (e) {}
          }
          video.play().catch(() => {});
        }, 1000);
        win.setTimeout(() => {
          if (!stalled()) return;
          const p = nf();
          if (p) {
            try { p.seek(p.getCurrentTime()); p.play(); } catch (e) {}
          }
        }, 2500);
      },
    };
  }

  // ---- 自訂控制列版本（Document Picture-in-Picture）----
  async function openDocumentPip(dpip) {
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
      /* 網站播放器（YouTube、Netflix 等）換下一部影片時，常會把原頁面播放器的固定 px 寬高、
         定位寫進 <video> 的 inline style，蓋掉我們的 100% 而讓浮窗縮小時影片被裁切。
         樣式表的 !important 優先於網站寫的 inline style，所以尺寸一律在這裡鎖住。 */
      .pip-wrap video{width:100%!important;height:100%!important;
        min-width:0!important;min-height:0!important;max-width:none!important;max-height:none!important;
        position:static!important;inset:auto!important;margin:0!important;transform:none!important;
        object-fit:contain!important;display:block!important;background:#000;}
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

    // 直接寫進 inline style，蓋掉原網站可能留下的固定寬高（否則拖曳邊角時影片不會跟著縮放）
    const VIDEO_CSS =
      "width:100%;height:100%;max-width:none;max-height:none;object-fit:contain;display:block;background:#000;";

    // 把影片搬進子母畫面，關掉自訂前的原生控制列（用我們自己的）
    video.controls = false;
    video.style.cssText = VIDEO_CSS;
    wrap.appendChild(video);

    // Netflix、friDay 影音等網站的字幕是疊在影片上的 HTML，搬走影片後會留在原頁面，這裡把它鏡射進浮窗
    setupSubtitleMirror(pdoc, wrap, pipWindow, placeholder);

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
      ctrl.seekTo(t);
    };
    seek.addEventListener("pointerdown", () => {
      dragging = true;
      wasPlaying = !video.paused;
      if (wasPlaying) ctrl.pause(); // 拖曳時暫停，畫面才會即時停在拖到的位置
    });
    seek.addEventListener("input", seekToSlider);
    const endDrag = () => {
      seekToSlider();
      dragging = false;
      if (wasPlaying) { wasPlaying = false; ctrl.play(); }
    };
    seek.addEventListener("change", endDrag);
    seek.addEventListener("pointerup", endDrag);
    seek.addEventListener("pointercancel", endDrag);
    syncSeek();

    btnPlay.addEventListener("click", () => {
      if (video.paused) ctrl.play();
      else ctrl.pause();
    });
    btnBack.addEventListener("click", () => {
      ctrl.seekTo(Math.max(0, video.currentTime - 10));
    });
    btnFwd.addEventListener("click", () => {
      const end = isFinite(video.duration) ? video.duration : Number.MAX_SAFE_INTEGER;
      ctrl.seekTo(Math.min(end, video.currentTime + 10));
    });
    speed.addEventListener("change", () => {
      video.playbackRate = parseFloat(speed.value);
    });

    // 集中綁定影片事件，元素被 Netflix 換新接手後要重綁一次
    const onRate = () => { speed.value = String(video.playbackRate); };
    const bindVideo = () => {
      video.addEventListener("timeupdate", syncSeek);
      video.addEventListener("durationchange", syncSeek);
      video.addEventListener("loadedmetadata", syncSeek);
      video.addEventListener("play", syncPlayIcon);
      video.addEventListener("pause", syncPlayIcon);
      video.addEventListener("ratechange", onRate);
    };
    bindVideo();

    // ---- Netflix 影片元素接手 ----
    // Netflix 跳轉到緩衝範圍外（或自動播下一集）時，播放器可能把 <video>
    // 換成新元素放回原頁面，浮窗就會停在死掉的舊畫面。定期檢查原頁面，
    // 一出現影片元素就接手搬進浮窗、重綁控制列。
    const adoptVideo = (nv) => {
      nv.controls = false;
      nv.style.cssText = VIDEO_CSS;
      if (nv !== video) {
        if (video.parentNode === wrap) video.remove();
        video = nv;
        video.playbackRate = parseFloat(speed.value) || 1;
        bindVideo();
      }
      if (video.parentNode !== wrap) wrap.insertBefore(video, wrap.firstChild);
      syncPlayIcon();
      syncSeek();
    };
    let adoptTimer = null;
    if (/(^|\.)netflix\.com$/.test(location.hostname)) {
      adoptTimer = pipWindow.setInterval(() => {
        // 影片被我們搬走後，原頁面查得到 <video> 就代表 Netflix 換了新元素
        // （或把原本那顆搬回去了），兩種情況都重新接手。
        // 換新元素只在目前影片確實卡住時才接手，避免頁面上還有其他影片
        // （例如瀏覽頁的預告片）時誤抓
        const nv = document.querySelector("video");
        if (nv && (nv === video || video.readyState < 3)) adoptVideo(nv);
      }, 500);
    }

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
      if (adoptTimer) pipWindow.clearInterval(adoptTimer);
      video.controls = savedControls;
      video.style.cssText = savedCss;
      if (placeholder.parentNode) {
        placeholder.parentNode.insertBefore(video, placeholder);
      }
      placeholder.remove();
    }, { once: true });
  }

  // ---- 同網域 iframe 支援 ----
  // 收集本文件與巢狀同網域 iframe 裡的 <video>。frame 是影片所屬、位於本文件裡的那個 iframe
  // （null＝影片就在本文件）；跨網域 iframe 讀不到內容，會由它自己那份注入腳本處理。
  function collectVideos() {
    const out = [];
    const walk = (doc, frame, depth) => {
      doc.querySelectorAll("video").forEach((v) => out.push({ video: v, frame }));
      if (depth >= 3) return;
      doc.querySelectorAll("iframe").forEach((f) => {
        let d = null;
        try { d = f.contentDocument; } catch (e) {}
        if (d) walk(d, frame || f, depth + 1);
      });
    };
    walk(document, null, 0);
    return out;
  }

  // 找出目前有影片在原生子母畫面裡的文件（會往同網域 iframe 裡找）
  function findNativePipDoc(doc, depth) {
    const el = doc.pictureInPictureElement;
    if (el && el.tagName === "VIDEO") return doc;
    if (depth < 3) {
      for (const f of doc.querySelectorAll("iframe")) {
        let d = null;
        try { d = f.contentDocument; } catch (e) {}
        const r = d && findNativePipDoc(d, depth + 1);
        if (r) return r;
      }
    }
    // 瀏覽器可能把 iframe 裡的子母畫面元素回報成該 <iframe>，這種情況直接用本文件關
    return el ? doc : null;
  }

  // 取得 iframe 內的主要影片：有多個時取長度最長的（避開廣告用的短影片），再看是否正在播
  function frameVideo(frame) {
    let d = null;
    try { d = frame.contentDocument; } catch (e) {}
    if (!d) return null;
    const vs = Array.from(d.querySelectorAll("video"));
    if (vs.length <= 1) return vs[0] || null;
    const dur = (v) => (isFinite(v.duration) ? v.duration : 0);
    vs.sort((a, b) => (dur(b) - dur(a)) || ((a.paused ? 1 : 0) - (b.paused ? 1 : 0)));
    return vs[0];
  }

  // iframe 重新載入後，等網站播放器真的播起來，再把位置一次調回 t（差不多就不動）
  function resumeAfterReload(frame, t) {
    if (!(t > 5)) return;
    const win = frame.ownerDocument.defaultView;
    let tries = 0;
    const timer = win.setInterval(() => {
      tries++;
      const v = frameVideo(frame);
      const playing = v && v.readyState >= 3 && !v.paused && v.currentTime > 1;
      if (playing && isFinite(v.duration) && v.duration > t + 5) {
        if (Math.abs(v.currentTime - t) > 5) v.currentTime = t;
        win.clearInterval(timer);
      } else if (tries > 240) {
        win.clearInterval(timer); // 等了 2 分鐘還沒播起來（廣告、驗證失敗等）就放棄
      }
    }, 500);
  }

  // ---- iframe 播放器版本 ----
  // friDay 影音等網站把整個播放器放在同網域 iframe 裡。Document PiP 只能由最上層框架開啟，
  // 而 <video> 一旦從 iframe 搬到別的文件就會被 Chrome 整個重置（MSE／DRM 串流中斷），
  // 所以改成把整個 iframe 搬進浮窗：網站的播放器、字幕、控制列原封不動在浮窗裡運作。
  // 代價是 iframe 搬移時會重新載入（關閉浮窗搬回去時也是），因此記住播放位置在重載後接續。
  async function openIframePip(dpip, frame) {
    const rect = frame.getBoundingClientRect();
    const w0 = Math.round(rect.width) || 640;
    const h0 = Math.round(rect.height) || 360;
    const pipWindow = await dpip.requestWindow({ width: w0, height: h0 });
    const pdoc = pipWindow.document;

    const style = pdoc.createElement("style");
    style.textContent = `
      html,body{margin:0;height:100%;background:#000;overflow:hidden;}
      iframe{display:block!important;width:100%!important;height:100%!important;border:0!important;margin:0!important;
        min-width:0!important;min-height:0!important;max-width:none!important;max-height:none!important;
        position:static!important;inset:auto!important;transform:none!important;}
    `;
    pdoc.head.appendChild(style);

    // 記住 iframe 原本的位置，關閉時放回去
    const placeholder = document.createElement("span");
    placeholder.style.display = "none";
    frame.parentNode.insertBefore(placeholder, frame);

    // 搬進浮窗重新載入後，播放器仍需能自動播放、使用 DRM、進全螢幕
    const savedAllow = frame.getAttribute("allow");
    const allow = new Set((savedAllow || "").split(";").map((s) => s.trim()).filter(Boolean));
    ["autoplay", "encrypted-media", "fullscreen", "picture-in-picture"].forEach((t) => allow.add(t));
    frame.setAttribute("allow", Array.from(allow).join("; "));

    // 搬移會重新載入 iframe：先記住播放位置，載入後接續
    let lastTime = video.currentTime;
    pdoc.body.appendChild(frame);
    resumeAfterReload(frame, lastTime);

    // 持續記錄浮窗內的播放位置，關閉浮窗搬回原頁面時要用
    const tracker = pipWindow.setInterval(() => {
      const v = frameVideo(frame);
      if (v && v.currentTime > 0) lastTime = v.currentTime;
    }, 1000);

    // 播放器對上層（現在是浮窗）發的 postMessage 轉給原頁面，
    // 網站靠這個做的換集、播完處理等流程才會繼續運作
    pipWindow.addEventListener("message", (e) => {
      if (e.source !== frame.contentWindow) return;
      try { window.postMessage(e.data, location.origin); } catch (err) {}
    });

    // 關閉子母畫面時，把 iframe 放回原位（會再重新載入一次）並接續播放位置
    pipWindow.addEventListener("pagehide", () => {
      pipWindow.clearInterval(tracker);
      if (savedAllow === null) frame.removeAttribute("allow");
      else frame.setAttribute("allow", savedAllow);
      if (placeholder.parentNode) {
        placeholder.parentNode.insertBefore(frame, placeholder);
      }
      placeholder.remove();
      if (frame.ownerDocument === document) resumeAfterReload(frame, lastTime);
    }, { once: true });
  }

  // ---- 字幕鏡射 ----
  // 有些網站的字幕不在影片串流裡，而是用 HTML 疊在 <video> 上（Netflix、YouTube、friDay 影音等）。
  // 影片被搬進浮窗後，網站的播放器仍會持續更新原頁面上的字幕節點，
  // 所以只要監聽那個節點，把文字同步到浮窗裡的字幕層即可。
  // （瀏覽器原生繪製的 <track> 字幕會跟著 <video> 一起搬進浮窗，不需要另外處理。）
  function setupSubtitleMirror(pdoc, wrap, pipWindow, anchor) {
    const SUB_SELECTORS = [
      ".player-timedtext",             // Netflix
      ".ytp-caption-window-container", // YouTube
      ".vop-caption-container",        // VisualOn Player（friDay 影音等）：TTML 字幕畫在與影片同層的這個 div
      "#TTMLRenderingDiv",             // VisualOn Player 同一個容器的 id（保險）
      ".shaka-text-container",         // Shaka Player（不少自架播放器）
      ".vjs-text-track-display",       // Video.js
      ".jw-captions",                  // JW Player
      ".bmpui-ui-subtitle-overlay",    // Bitmovin Player
      ".plyr__captions",               // Plyr
    ];

    const subs = pdoc.createElement("div");
    subs.className = "pip-subs";
    wrap.appendChild(subs);

    let observer = null;
    let source = null;

    // 先從影片原本的位置（anchor 佔位節點）往上一層層找，優先抓同一個播放器裡的字幕容器，
    // 避免頁面上有多個播放器時抓錯；佔位節點已被網站移除時退回整份文件搜尋
    const findSource = () => {
      let node = anchor && anchor.parentNode;
      while (node && node.nodeType === 1) {
        for (const sel of SUB_SELECTORS) {
          const el = node.matches(sel) ? node : node.querySelector(sel);
          if (el) return el;
        }
        node = node.parentNode;
      }
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
  function nativePip() {
    const enter = () => {
      video.requestPictureInPicture().then(() => {
        try {
          const ms = navigator.mediaSession;
          if (!ms) return;
          ms.setActionHandler("play", () => ctrl.play());
          ms.setActionHandler("pause", () => ctrl.pause());
          ms.setActionHandler("seekbackward", (d) => {
            const off = (d && d.seekOffset) || 10;
            ctrl.seekTo(Math.max(0, video.currentTime - off));
          });
          ms.setActionHandler("seekforward", (d) => {
            const off = (d && d.seekOffset) || 10;
            const end = isFinite(video.duration) ? video.duration : Number.MAX_SAFE_INTEGER;
            ctrl.seekTo(Math.min(end, video.currentTime + off));
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
