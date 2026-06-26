# 子母畫面播放器 (Picture-in-Picture) Chrome 擴充套件

點一下工具列圖示（或按快捷鍵 **Alt+P**），就能把目前頁面正在播放的影片，
用瀏覽器原生的子母畫面浮窗播放。再點一次即可關閉。

## 功能特色
- 自動挑選頁面上「正在播放且畫面最大」的影片
- 支援 iframe 內嵌影片（會注入所有子框架尋找）
- 再次點擊 / 再按快捷鍵 = 關閉子母畫面（toggle）
- 不需要任何後端、不收集任何資料

## 安裝方式（開發者模式載入）
1. 開啟 Chrome，網址列輸入 `chrome://extensions`
2. 右上角開啟「**開發人員模式 / Developer mode**」
3. 點「**載入未封裝項目 / Load unpacked**」
4. 選擇這個 `pip-extension` 資料夾
5. 完成！工具列會出現圖示，到任何有影片的頁面點一下即可

## 使用方式
- 在有影片的分頁，點擊工具列上的擴充套件圖示
- 或直接按快捷鍵 **Alt+P**
- 要關閉子母畫面，再點一次圖示或再按一次快捷鍵

## 注意事項
- `chrome://`、Chrome 線上應用程式商店等特殊頁面無法使用（瀏覽器限制）
- 少數網站會用 `disablePictureInPicture` 禁止 PiP，這類影片無法浮窗
- 需要 Chrome / Edge 等支援 Picture-in-Picture API 的瀏覽器

## 自訂快捷鍵
到 `chrome://extensions/shortcuts` 可以修改或移除預設的 Alt+P。
