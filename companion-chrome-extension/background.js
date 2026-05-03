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
  return false;
});
