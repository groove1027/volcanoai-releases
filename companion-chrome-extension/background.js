// background.js — Volcano Cookie Sync service worker.
//
// chrome.cookies API 로 .google.com domain 의 모든 cookie 추출 → Volcano companion
// `POST /api/google/cookie-set` 으로 전송. 일상 Chrome instance 그대로 사용 (별도 창 X,
// macOS sandbox 무관, F12/Network 무관).
//
// Manifest V3 service worker — popup 이 닫혀도 동작 가능. 하지만 본 작업은 popup 가
// trigger 한 1회 호출이라 idle 후 unload 돼도 OK.

// [Codex P2 fix] Volcano companion 가 binding 가능한 모든 fallback 포트.
//   src/services/companion/companionUrl.ts:20 의 PORT_CANDIDATES 와 동기화.
const COMPANION_PORTS = [
  9876, 9877, 9878, 9882, 9883, 9884, 9885, 9886, 9887, 9888, 9889, 9890, 9891, 9892, 9893, 9894,
  9895, 9896, 9897, 9898,
];
const COMPANION_HOSTS = ['127.0.0.1', 'localhost'];

// [Codex Phase 6 r1 P2 #2] aio-fetch / aio-google-search-tab rate limit — 60초 sliding window
//   안에서 최대 100건 (정상 사용 = 영상 1개당 8~16 검색). XSS / 버그 페이지 가 양산형 oracle 로
//   사용 차단. Bridge ext (companion/chrome-extension/) 와 동일 cap.
const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX = 100;
const _bridgeRequestTimestamps = [];

function checkBridgeRateLimit() {
  const now = Date.now();
  while (_bridgeRequestTimestamps.length > 0 && now - _bridgeRequestTimestamps[0] > RATE_LIMIT_WINDOW_MS) {
    _bridgeRequestTimestamps.shift();
  }
  if (_bridgeRequestTimestamps.length >= RATE_LIMIT_MAX) {
    return false;
  }
  _bridgeRequestTimestamps.push(now);
  return true;
}

// [Codex Phase 6 r1 P2 #1] aio-fetch URL allowlist — Bridge 와 동일 strict allowlist.
//   Google 이미지 검색 endpoint + /generate_204 health 만. URL.parse 로 host/path/searchParams
//   명시 검증 (regex 우회 차단).
const FETCH_ALLOWED_HOSTS = new Set(['google.com', 'www.google.com']);

function isAllowedFetchUrl(urlStr) {
  if (typeof urlStr !== 'string' || urlStr.length > 2048) return false;
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (!FETCH_ALLOWED_HOSTS.has(u.hostname)) return false;
  if (u.pathname === '/generate_204') return true;
  if (u.pathname !== '/search') return false;
  const udm = u.searchParams.get('udm');
  const tbm = u.searchParams.get('tbm');
  return udm === '2' || tbm === 'isch';
}

/**
 * google.com 도메인 cookie 전량 추출 → `name1=value1; name2=value2; ...` header 형식.
 *
 * 핵심 cookie (SID/HSID/__Secure-1PSID 등) 가 .google.com domain 에 박혀있어야 진짜 인증
 * cookie. www.google.com / accounts.google.com / mail.google.com 등 sub-domain 별로 다른
 * 것도 있지만 .google.com (leading dot, 모든 sub 적용) 이 핵심.
 */
async function extractGoogleCookies() {
  // chrome.cookies.getAll: domain 옵션 → 그 domain 또는 subdomain 매칭 cookie 전량.
  // ".google.com" 으로 query 하면 google.com / www.google.com / mail.google.com 등 전부.
  const cookies = await chrome.cookies.getAll({ domain: '.google.com' });
  if (!cookies || cookies.length === 0) {
    return { header: '', count: 0 };
  }
  // header 형식: "name=value; name=value; ..." — companion 의 cookie_validate /
  // build_cookies_for_injection 와 같은 포맷 (google.rs::normalize_cookie_header 가 추가
  // 정규화 — SOCS/CONSENT dedupe 등).
  const pairs = cookies.map((c) => `${c.name}=${c.value}`);
  return { header: pairs.join('; '), count: cookies.length };
}

/**
 * Volcano companion endpoint 자동 검색.
 *
 * [Codex P1 fix 0504] **반드시** Volcano signature 검증 — `/health` 응답이
 *   `{ "app": "volcano" }` 인 host:port 만 허용. 옛 구현은 404 도 alive 로 봐서
 *   다른 local service (예: 개발자 dev server) 에 Google auth cookie 를 잘못
 *   POST 할 위험. 본 fix 로 차단.
 *
 * 첫 verified host:port 반환. 모두 fail 시 null.
 */
async function findCompanionBaseUrl() {
  for (const host of COMPANION_HOSTS) {
    for (const port of COMPANION_PORTS) {
      const base = `http://${host}:${port}`;
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 1500);
        const res = await fetch(`${base}/health`, {
          method: 'GET',
          signal: ctrl.signal,
          cache: 'no-store',
        });
        clearTimeout(timer);
        if (!res.ok) continue; // 4xx/5xx → companion 아님 (또는 과부하 — skip)
        const data = await res.json().catch(() => null);
        if (data && data.app === 'volcano') {
          return base;
        }
        // app !== 'volcano' → 다른 local service. cookie POST 절대 금지.
      } catch {
        // network/timeout → 다음 후보
      }
    }
  }
  return null;
}

async function postCookieToCompanion(cookieHeader) {
  const base = await findCompanionBaseUrl();
  if (!base) {
    return {
      ok: false,
      reason: 'Volcano companion 미가동 (127.0.0.1:9876/9877 응답 없음). Volcano 앱을 켜주세요.',
    };
  }
  try {
    const res = await fetch(`${base}/api/google/cookie-set`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cookie: cookieHeader, source: 'chrome-extension' }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      return { ok: false, reason: `companion HTTP ${res.status}: ${text || '(no body)'}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `companion 통신 실패: ${e.message || e}` };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'volcano-sync-cookies') {
    (async () => {
      const { header, count } = await extractGoogleCookies();
      if (count === 0) {
        sendResponse({
          ok: false,
          reason: 'google.com 쿠키 0개 — 먼저 google.com 에서 로그인 해주세요.',
        });
        return;
      }
      const post = await postCookieToCompanion(header);
      if (!post.ok) {
        sendResponse(post);
        return;
      }
      sendResponse({ ok: true, count, bytes: header.length });
    })();
    return true; // async response
  }

  // [v0.1.4 search 2026-05-04] content.js → background search bridge — Phase 6.
  //   web app (extensionBridge.ts:extensionTabSearch) 가 postMessage 로 호출, content.js
  //   가 본 type 으로 forward. v0.1.3 의 popup-only `volcano-google-search` 는 dead code 였어서
  //   `aio-google-search-tab` 으로 명칭 통일 (Bridge ext companion/chrome-extension/ 와 동일).
  //
  //   Phase 3A Codex r1-r4 P2 fix 모두 반영:
  //     - r2 P2 #2: gl + imgsz URL params 정합 (사용자 선택 region/size 보존)
  //     - r3 P2 #3: imgsz validator letter codes ('m'/'l'/'2mp'/'4mp'/'6mp') 허용
  //     - r3 P2 #4: imgres href 없는 entry skip (encrypted-tbn 썸네일 promote 금지)
  //     - r3 P2 #5: tabs permission 미요청 (chrome.tabs.create/.remove/.onUpdated 만 사용)
  if (msg && msg.type === 'aio-google-search-tab') {
    // [Codex Phase 6 r1 P2 #2] rate limit 적용 — Bridge ext 와 동일.
    if (!checkBridgeRateLimit()) {
      sendResponse({ ok: false, error: 'Rate limit exceeded (100 requests / 60s)' });
      return true;
    }
    const query = typeof msg.query === 'string' ? msg.query.trim() : '';
    if (!query || query.length > 500) {
      sendResponse({ ok: false, error: 'query 비어있음 또는 500자 초과' });
      return true;
    }
    const count = Math.max(1, Math.min(60, Number(msg.count) || 30));
    const hl = typeof msg.hl === 'string' && /^[a-z]{2}(-[A-Z]{2})?$/.test(msg.hl) ? msg.hl : 'ko';
    const gl = typeof msg.gl === 'string' && /^[a-z]{2}$/.test(msg.gl) ? msg.gl : '';
    const imgsz =
      typeof msg.imgsz === 'string' && /^[a-z0-9]{1,4}$/.test(msg.imgsz) ? msg.imgsz : '';
    (async () => {
      try {
        const result = await searchGoogleImagesViaTab(query, count, hl, gl, imgsz);
        sendResponse({ ok: true, ...result });
      } catch (e) {
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return true; // async response
  }

  // [Codex Phase 6 r1 P2 #1] aio-fetch handler — Bridge ext 와 동일. content.js 의
  //   META 비콘 'aio-helper-bridge' 가 web app 에서 Cookie Sync 도 full Bridge 로 인식되게
  //   advertising 한 후 background 가 fetch 를 처리 안 하면 health check / SW fetch 폴백 모두
  //   empty/lastError → "확장 설치됨" UI 인데 실제로 안 작동하는 사고.
  //   strict allowlist: google.com / search?udm=2 또는 tbm=isch / generate_204 만. GET only.
  if (msg && msg.type === 'aio-fetch') {
    const method = (msg.method || 'GET').toUpperCase();
    if (method !== 'GET') {
      sendResponse({ ok: false, error: 'Only GET method allowed' });
      return true;
    }
    if (!isAllowedFetchUrl(msg.url)) {
      sendResponse({
        ok: false,
        error: 'URL not allowed by extension allowlist: ' + (msg.url || '').slice(0, 200),
      });
      return true;
    }
    if (!checkBridgeRateLimit()) {
      sendResponse({ ok: false, error: 'Rate limit exceeded (100 requests / 60s)' });
      return true;
    }
    (async () => {
      try {
        const r = await fetch(msg.url, {
          method: 'GET',
          credentials: 'include',
          cache: 'no-store',
        });
        // [Codex Phase 6 r2 P1] redirect bypass 차단 — fetch 가 default redirect:'follow' 라
        //   `/search?udm=2` 가 e.g. consent.google.com 등 *.google.com 다른 endpoint 로
        //   리다이렉트되면 user cookie 첨부된 sensitive endpoint body 가 page 로 반환 가능.
        //   redirect 후 최종 URL (r.url) 도 같은 allowlist 통과 강제.
        if (!isAllowedFetchUrl(r.url)) {
          sendResponse({
            ok: false,
            error: 'Redirect to disallowed URL: ' + (r.url || '').slice(0, 200),
            status: r.status,
          });
          return;
        }
        const text = await r.text();
        sendResponse({
          ok: true,
          status: r.status,
          statusText: r.statusText,
          text,
          url: r.url,
        });
      } catch (e) {
        sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) });
      }
    })();
    return true;
  }

  return false;
});

/**
 * [v0.1.4 Phase 6] Google 이미지 검색 — 사용자 진짜 Chrome 탭 열어 DOM 추출.
 *
 * 100% 사용자 session (cookie 자동) → /sorry/ bot 차단 거의 0.
 * tab.active=false 라 사용자 작업 방해 0. 추출 후 즉시 cleanup.
 *
 * gl (region) + imgsz (image size) URL 파라미터 정합 — googleSearchPaths.ts 의 기존
 * SW fetch 경로와 동일.
 */
async function searchGoogleImagesViaTab(query, count, hl, gl, imgsz) {
  const params = new URLSearchParams({
    q: query,
    udm: '2',
    hl,
    safe: 'active',
  });
  if (gl) params.set('gl', gl);
  if (imgsz) params.set('imgsz', imgsz);
  const url = `https://www.google.com/search?${params.toString()}`;
  const tab = await chrome.tabs.create({ url, active: false });
  const tabId = tab.id;
  if (!tabId) throw new Error('tab id 없음');
  try {
    await waitForTabComplete(tabId, 15000);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: extractGoogleImagesFromDom,
      args: [count],
    });
    return {
      images: Array.isArray(result) ? result : [],
      provider: 'extension-cookie-sync-tab',
      query,
    };
  } finally {
    chrome.tabs.remove(tabId).catch(() => {});
  }
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(handler);
      reject(new Error('tab load timeout'));
    }, timeoutMs);
    const handler = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(handler);
        // page render + JS 안정 대기 (1초).
        setTimeout(resolve, 1000);
      }
    };
    chrome.tabs.onUpdated.addListener(handler);
  });
}

/**
 * 페이지 컨텍스트에서 실행 (chrome.scripting.executeScript func).
 * Google 이미지 검색 결과 페이지에서 진짜 원본 image URL 추출.
 *
 * `<img>.src` 는 보통 Google 의 encrypted thumbnail (encrypted-tbn0...). 진짜 원본 URL 은
 * 부모 `<a href="/imgres?imgurl=ENCODED&imgrefurl=ENCODED">` 의 imgurl 파라미터.
 * imgres href 가 없는 entry 는 skip — encrypted-tbn 썸네일 promote 시 low-res 노출 회귀.
 */
function extractGoogleImagesFromDom(maxCount) {
  const items = [];
  const seen = new Set();
  const imgs = document.querySelectorAll('div[data-ri] img, g-img img, div.isv-r img, img.rg_i, img[data-src]');
  for (const img of imgs) {
    if (items.length >= maxCount) break;
    const thumbnail = img.src || img.getAttribute('data-src') || '';
    if (!/^https?:\/\//.test(thumbnail) && !thumbnail.startsWith('data:')) continue;
    let anchor = img.parentElement;
    while (anchor && anchor.tagName !== 'A') anchor = anchor.parentElement;
    let originalUrl = '';
    let sourcePage = '';
    if (anchor && anchor.href) {
      try {
        const parsed = new URL(anchor.href, location.href);
        if (parsed.pathname === '/imgres') {
          originalUrl = parsed.searchParams.get('imgurl') || '';
          sourcePage = parsed.searchParams.get('imgrefurl') || '';
        } else {
          sourcePage = anchor.href;
        }
      } catch {
        sourcePage = anchor.href;
      }
    }
    // imgres href 없으면 entry skip — 호출자가 0건 → SW fetch / Naver 폴백으로 자연 흐름.
    if (!originalUrl) continue;
    if (seen.has(originalUrl)) continue;
    seen.add(originalUrl);
    items.push({
      url: originalUrl,
      thumbnail: thumbnail.startsWith('data:') ? originalUrl : thumbnail,
      source: sourcePage,
      title: img.alt || '',
    });
  }
  return items;
}
