// popup.js — Volcano Cookie Sync 의 popup 동작.
// 사용자가 [동기화] 클릭 → background service worker 에 메시지 → google.com cookie 추출
// → Volcano companion (127.0.0.1:9876) POST /api/google/cookie-set.

const $ = (id) => document.getElementById(id);

function setStatus(text, kind) {
  const el = $('status');
  el.textContent = text;
  el.className = '';
  if (kind === 'ok') el.classList.add('status-ok');
  else if (kind === 'err') el.classList.add('status-err');
  else if (kind === 'info') el.classList.add('status-info');
}

async function syncCookies() {
  const btn = $('syncBtn');
  btn.disabled = true;
  setStatus('🔎 google.com 쿠키 추출 중...', 'info');

  try {
    const reply = await chrome.runtime.sendMessage({ type: 'volcano-sync-cookies' });
    if (!reply || !reply.ok) {
      const reason = reply && reply.reason ? reply.reason : '알 수 없는 오류';
      setStatus(`❌ 실패: ${reason}`, 'err');
      btn.disabled = false;
      return;
    }
    setStatus(
      `✅ 동기화 완료 — ${reply.count}개 쿠키 (${reply.bytes} bytes) Volcano 로 전송됨`,
      'ok',
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setStatus(`❌ 통신 오류: ${msg}`, 'err');
  } finally {
    btn.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $('syncBtn').addEventListener('click', syncCookies);
});
