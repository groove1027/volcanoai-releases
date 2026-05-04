# Volcano Cookie Sync — Chrome Extension

Volcano 앱 으로 Google cookie 1초 자동 동기화.

## 왜 이게 필요한가

기존 Volcano 의 자동 로그인 버튼은 macOS 의 Chrome 단일 instance 정책 때문에 사용자의 일상 Chrome 가 가동 중일 때 작동 안 함 (별 instance 가 안 만들어짐). 본 extension 은 사용자의 일상 Chrome 안에서 `chrome.cookies` API 직접 호출 → 1초 안 모든 google.com cookie 추출 → Volcano companion 으로 자동 전송.

= F12/Network 같은 거 필요 없음. 일상 Chrome 그대로 사용.

## 설치 (개발자 모드 / Unpacked)

1. Chrome → `chrome://extensions` 진입
2. 우측 상단 **개발자 모드** 토글 ON
3. **압축해제된 확장 프로그램 로드** 클릭 → 본 폴더 (`companion-chrome-extension`) 선택
4. Chrome toolbar 에 🌋 Volcano Cookie Sync 아이콘 표시됨

## 사용법

1. Chrome 에서 google.com 에 로그인
2. Toolbar 의 🌋 아이콘 클릭 → popup
3. **[📤 Volcano 에 쿠키 동기화]** 버튼 클릭
4. Volcano 앱이 가동 중이면 자동으로 쿠키 박힘 (✅ 토스트 표시)
5. Volcano 의 [API 설정] → "쿠키 연결됨" 자동 표시

## 트러블슈팅

- **"google.com 쿠키 0개"**: Chrome 에서 google.com 에 로그인 안 한 상태. 먼저 google.com 가서 로그인.
- **"Volcano companion 미가동"**: Volcano 앱이 안 켜져 있음. dmg 실행 후 재시도.
- **Chrome extension 자동 종료**: Chrome 의 `chrome://extensions` 에서 본 extension 가 enabled 인지 확인.

## 권한

- `cookies` — google.com 쿠키 read (extension 의 chrome.cookies.getAll API)
- `host_permissions: *://*.google.com/*` — google.com 도메인의 cookie 만 (다른 사이트 cookie 는 못 봄)
- `host_permissions: 127.0.0.1:9876/9877` — Volcano companion 으로 POST

= **사용자의 다른 사이트 cookie 는 절대 안 보냄. Volcano 앱 외 누구에게도 전송 안 함.**

## 향후 (Chrome Web Store 발행 후)

현재는 unpacked 모드. 추후 Chrome Web Store 등록 시 1-click 설치 가능 예정.
