// Volcano Cookie Sync — content script (v0.1.4)
//
// 책임:
//   1) 웹앱 페이지 (volcanoai.io / app.volcanoai.io / pages.dev / localhost) 에 META 비콘
//      `aio-helper-bridge` 주입 — extensionBridge.ts 가 본 META 로 확장 설치 감지.
//      페이지별 unguessable bridge token 생성 (XSS oracle 방어 1차 layer).
//   2) 웹앱이 보내는 window.postMessage (token 검증 통과만) 를 chrome.runtime.sendMessage 로
//      background SW 에 전달 — 'aio-google-search-tab' / 'aio-fetch' 요청 처리.
//   3) background 응답 → window.postMessage 같은 origin 한정.
//
// Bridge ext (companion/chrome-extension/) 와 동일 protocol — 두 ext 가 같은 META beacon
// 사용. 사용자가 둘 다 설치 시 먼저 inject 한 ext 가 우선 (동일 protocol 이라 동작 무관).
//
// 보안 (Bridge 가이드 준용):
//   - bridge token = 페이지 lifetime 안만 유효 (crypto.randomUUID, 새로고침 시 신규)
//   - 매 postMessage 요청에 token 첨부 → content.js 검증 → background 전달
//   - 응답은 같은 origin 에만 postMessage (외부 frame 누출 차단)

(() => {
  const BRIDGE_TOKEN =
    crypto && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;

  function injectBeacon() {
    if (document.querySelector('meta[name="aio-helper-bridge"]')) return;
    const meta = document.createElement('meta');
    meta.name = 'aio-helper-bridge';
    meta.content = JSON.stringify({
      id: chrome.runtime.id,
      version: chrome.runtime.getManifest().version,
      product: 'volcano-cookie-sync',
      token: BRIDGE_TOKEN,
    });
    (document.head || document.documentElement).appendChild(meta);
  }

  if (document.head) {
    injectBeacon();
  } else {
    const observer = new MutationObserver(() => {
      if (document.head) {
        injectBeacon();
        observer.disconnect();
      }
    });
    observer.observe(document.documentElement, { childList: true });
  }

  // [Codex Phase 6 r1 P1] type allowlist — page-supplied type 무방비 forward 시 page 가
  //   `volcano-sync-cookies` 보내 cookie 동기화 (toolbar 클릭 강제 우회) 가능. 회피.
  //   허용 = web app search/health 만, cookie sync 는 popup 만 (background 가 sender.tab=undefined
  //   여부로 추가 검증해도 되지만 1차 layer 로 type allowlist 가 가장 강력).
  const ALLOWED_BRIDGE_TYPES = new Set(['aio-google-search-tab', 'aio-fetch']);

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    if (!e.data || e.data.__aioBridge !== true) return;
    if (typeof e.data.requestId !== 'string') return;
    if (e.data.token !== BRIDGE_TOKEN) return;
    if (!ALLOWED_BRIDGE_TYPES.has(e.data.type)) return;

    const requestId = e.data.requestId;

    chrome.runtime.sendMessage(
      {
        type: e.data.type, // 'aio-fetch' | 'aio-google-search-tab' (allowlist 통과)
        url: e.data.url,
        method: e.data.method,
        body: e.data.body,
        // tab-search 전용 fields
        query: e.data.query,
        count: e.data.count,
        hl: e.data.hl,
        gl: e.data.gl,
        imgsz: e.data.imgsz,
      },
      (response) => {
        const finalResponse = chrome.runtime.lastError
          ? { ok: false, error: chrome.runtime.lastError.message || 'no-response' }
          : response || { ok: false, error: 'empty-response' };

        window.postMessage(
          {
            __aioBridgeResponse: true,
            requestId,
            response: finalResponse,
          },
          window.location.origin,
        );
      },
    );
  });
})();
