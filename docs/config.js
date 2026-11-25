// 車長班表：GitHub Pages 靜態前端設定
// API_URL：GAS「網頁應用程式」部署的 /exec 網址（部署後貼上；留空時頁面會提示尚未設定）
// 注意：此檔會公開在 GitHub Pages，不要放 LINE token 或其他秘密。
window.APP_CONFIG = {
  API_URL: 'https://script.google.com/macros/s/AKfycbxMevgb-gMenHgMG737cQDJwIBwTPOV64CAy4PilPkbR3H1I5IwYDWkgDV-upmSRL8jCQ/exec',
  BOOTSTRAP_CACHE_TTL_MS: 6 * 60 * 60 * 1000,
  // 受影響列車頁：data/timetable.json 的版本（tools/build-timetable.js 重新產生時自動更新）
  TIMETABLE_VERSION: '20261124T135148'
};
