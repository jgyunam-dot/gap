/* ============================================================
   gram Analyzer Pro — 공통 스크립트
   dashboard.html / admin.html 이 함께 사용한다.
   (index.html 로그인 페이지는 인증 전이라 일부만 사용)
   ============================================================ */

/* ── Firebase Realtime Database ─────────────────────────── */
// 예전엔 데스크톱 진단 앱(gramAnalyzerPro.exe)이 쓰는 것과 같은 레거시 시크릿(보안 규칙을
// 우회하는 만능 키)을 여기서도 usage 읽기·쓰기에 썼는데, 로그인 없이 이 파일만 보면 그대로
// 노출되는 문제라 전부 제거했다. 이제 웹사이트 코드는 전 구간 Firebase Auth 로그인
// 토큰(authDbUrl)만 쓴다. 앱은 이 파일과 무관하게 자기 코드 안에 독립적으로 같은 시크릿을
// 갖고 있으므로 여기서 지워도 앱 동작에는 영향이 없다.
const DB_ROOT = "https://gap-tracker-b19d1-default-rtdb.firebaseio.com";

/* ── Firebase Authentication(이메일/비밀번호) — users/employees(쓰기)/audit_logs/fcm_tokens 보호용 ── */
const FIREBASE_WEB_API_KEY = "AIzaSyCcizs7Iq6rWVYBvKw0QzIM07Bgb_RuZ5c";
const IDENTITY_TOOLKIT_URL = "https://identitytoolkit.googleapis.com/v1";
const SECURE_TOKEN_URL     = "https://securetoken.googleapis.com/v1";
const RESET_PW_FUNCTION_URL = "https://us-central1-gap-tracker-b19d1.cloudfunctions.net/resetUserPassword";

let AUTH_TOKEN = null; // 로그인한 사용자의 Firebase ID 토큰(1시간 유효, 자동 갱신됨)
let AUTH_UID   = null;
let authRefreshTimer = null;

/** employees(쓰기)/users/audit_logs/fcm_tokens 등 새로 보호되는 경로 전용. */
const authDbUrl = (path) => `${DB_ROOT}/${path}.json?auth=${AUTH_TOKEN}`;

/**
 * 옛 비밀번호("1234" 등 4자리)도 Firebase Auth 최소 6자 제약을 통과하도록 맞춘다.
 * functions/migrate-users.js 의 같은 이름 함수와 반드시 동일해야 한다 — 하나만 고치면 로그인이 깨진다.
 */
function toFirebasePassword(pw) {
    pw = String(pw ?? '');
    return pw.length >= 6 ? pw : pw.padEnd(6, '#');
}

/** Firebase Auth 는 이메일 형식이 필요해서, 기존 사번/아이디를 그대로 로컬파트로 쓴 가짜 이메일을 만든다. */
function toPseudoEmail(id) {
    const safe = String(id).replace(/[^a-zA-Z0-9._-]/g, '_');
    return `${safe}@gap.local`;
}

/** 실패하면 null. 성공하면 { idToken, refreshToken, localId, ... }. */
async function firebaseSignIn(id, pw) {
    try {
        const res = await fetch(`${IDENTITY_TOOLKIT_URL}/accounts:signInWithPassword?key=${FIREBASE_WEB_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: toPseudoEmail(id), password: toFirebasePassword(pw), returnSecureToken: true })
        });
        if (!res.ok) return null;
        return await res.json();
    } catch (e) { console.error('로그인 요청 실패:', e); return null; }
}

async function firebaseRefreshToken(refreshToken) {
    try {
        const res = await fetch(`${SECURE_TOKEN_URL}/token?key=${FIREBASE_WEB_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(refreshToken)}`
        });
        if (!res.ok) return null;
        return await res.json();
    } catch (e) { console.error('토큰 갱신 실패:', e); return null; }
}

/** 로그인 성공 직후(index.html) 호출한다 — 토큰을 세션에 담고 자동 갱신을 건다. */
function establishAuthSession(idToken, refreshToken, uid) {
    AUTH_TOKEN = idToken;
    AUTH_UID = uid;
    sessionStorage.setItem('gap_fb_refresh_token', refreshToken);
    scheduleTokenRefresh();
}

function scheduleTokenRefresh() {
    if (authRefreshTimer) clearTimeout(authRefreshTimer);
    authRefreshTimer = setTimeout(refreshAuthSession, 45 * 60 * 1000); // 1시간 유효 토큰을 45분마다 미리 갱신
}

async function refreshAuthSession() {
    const refreshToken = sessionStorage.getItem('gap_fb_refresh_token');
    if (!refreshToken) return false;
    const data = await firebaseRefreshToken(refreshToken);
    if (!data) return false;
    AUTH_TOKEN = data.id_token;
    AUTH_UID = data.user_id;
    sessionStorage.setItem('gap_fb_refresh_token', data.refresh_token);
    scheduleTokenRefresh();
    return true;
}

/** dashboard.html/admin.html 로드 시(이미 로그인된 세션) 호출 — 저장해 둔 refreshToken으로 복구한다. */
async function restoreAuthSession() {
    return refreshAuthSession();
}

/** Cloud Functions 의 콜러블 함수를 SDK 없이 순수 fetch 로 호출한다. */
async function callCloudFunction(url, data) {
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AUTH_TOKEN}` },
        body: JSON.stringify({ data })
    });
    const body = await res.json();
    if (!res.ok || body.error) throw new Error((body.error && body.error.message) || `HTTP ${res.status}`);
    return body.result;
}

/** 앱 메뉴(기능) 키 → 화면 표시용 한글 이름. dashboard.js·admin.js 둘 다에서 쓴다. */
const featureNames = {
    bsod: "BSOD 분석", diagnostics: "PC 점검하기", eventLog: "이벤트 로그", pcInfo: "PC 상세정보",
    home: "홈", aging: "Aging Test", ddu: "DDU", romWriter: "롬라이팅", securityCleanup: "보안 지우개", settings: "시스템 설정",
    // romWriter는 '롬라이팅 메뉴 진입'만 세고, 아래 둘은 그중 실제로 '자동'(지우기+쓰기[+검증])을
    // 시도해 성공/실패 메시지까지 본 경우만 센다 — 메뉴만 열어보고 안 쓴 경우와 구분된다.
    romWriteSuccess: "롬라이팅 성공", romWriteFail: "롬라이팅 실패",

    // PC 상세정보 카드의 개별 버튼 — pcInfo(탭 진입 자체)와는 별개로, 그 안에서 실제로 어느
    // 버튼을 눌렀는지까지 센다.
    dmiOnline: "모델/제번입력 (온라인)", dmiOffline: "모델/제번입력 (오프라인)",
    biosOnline: "BIOS 업데이트 (온라인)", biosOffline: "BIOS 업데이트 (오프라인)",
    memoryDetail: "메모리 상세정보", rdpkCheck: "RDPK 체크", rdpkRun: "RDPK 입력",

    // PC 점검하기 12항목 — diagnostics(탭 진입 자체)와는 별개로, 12개 중 실제로 어느 항목을
    // 열어봤는지까지 센다(전체점검 마법사를 통한 진입은 포함 안 됨 — 직접 타일 클릭만).
    checkWifi: "점검: Wi-Fi", checkBluetooth: "점검: 블루투스", checkKeyboard: "점검: 키보드",
    checkDisk: "점검: 저장장치", checkBattery: "점검: 배터리", checkCamera: "점검: 카메라",
    checkPixel: "점검: 불량화소", checkLid: "점검: LID", checkCpuTemp: "점검: CPU온도",
    checkFan: "점검: FAN", checkSpeaker: "점검: 스피커", checkMic: "점검: 마이크"
};

/** 세부 추적 featureKey가 어느 상위 메뉴에 딸린 것인지. 상위 메뉴 자체의 방문 집계(pcInfo/diagnostics/
 *  romWriter)와는 별개 항목이라, "세부 기능별 비중" 메인 차트에는 상위 메뉴만 막대로 보이고(안 그러면
 *  30개 가까이 뒤섞여 복잡해짐), 상위 메뉴 막대를 클릭하면 그 안에 속한 하위 항목들만 따로 보여준다.
 *  dashboard.js·admin.js 둘 다에서 쓴다. */
const featureGroups = {
    pcInfo: ['dmiOnline', 'dmiOffline', 'biosOnline', 'biosOffline', 'memoryDetail', 'rdpkCheck', 'rdpkRun'],
    diagnostics: ['checkWifi', 'checkBluetooth', 'checkKeyboard', 'checkDisk', 'checkBattery', 'checkCamera',
                  'checkPixel', 'checkLid', 'checkCpuTemp', 'checkFan', 'checkSpeaker', 'checkMic'],
    romWriter: ['romWriteSuccess', 'romWriteFail']
};
/** featureGroups에 하위 항목으로 속한 모든 키의 집합 — 메인 차트를 그릴 때 이 키들은 걸러낸다. */
const featureChildKeys = new Set(Object.values(featureGroups).flat());

/** openFeatureGroupModal 제목의 "OO — ○○○" 뒷부분. romWriter는 하위 항목이 성공/실패
 *  '결과'라 "세부 기능 비중"보다 "시도횟수 비중"이 더 맞다 — 없으면 기본값(세부 기능 비중). */
const featureGroupTitleSuffix = { romWriter: '시도횟수 비중' };

/** 센터/소속 집계용 표시 이름. 예전에는 "OO센터"처럼 문자 그대로 "센터"로 끝나는 사람만
 *  담당별·센터별 차트에 잡았는데, 그러면 소속이 다르게 적혀 있거나("본사" 등) 아예 비어있는("-")
 *  사람은 조용히 빠졌다. 이제는 다 잡되, 비어있거나 "-"인 사람은 "소속 미상"으로 묶어서 보여준다.
 *  dashboard.js에서 집계 키·표시 라벨 양쪽에 그대로 쓴다. */
function centerDisplayName(raw) {
    const v = (raw || '').toString().trim();
    return (!v || v === '-') ? '소속 미상' : v;
}

/* ── 차트 공통 설정 (Chart.js) — dashboard.js·admin.js 둘 다에서 쓴다.
   admin.html처럼 차트를 안 쓰는 페이지도 common.js를 로드하므로, Chart.js가 없을 때는 건너뛴다. */
let chartInstances = {};
const themeColors = { red: '#ff4b5c', orange: '#ff9800', yellow: '#ffc107', blue: '#4fc3f7', green: '#81c784', darkRed: '#d32f2f', purple: '#ab47bc' };
const palette = [themeColors.orange, themeColors.blue, themeColors.green, themeColors.purple, themeColors.yellow, themeColors.red];

if (typeof Chart !== 'undefined') {
    Chart.defaults.color = '#9e9e9e';
    Chart.defaults.font.family = "'Segoe UI', 'Malgun Gothic', sans-serif";
    // 휴대폰에서는 차트를 작게 눕히므로 축·범례 글자도 함께 줄인다.
    if (window.matchMedia('(max-width: 600px)').matches) Chart.defaults.font.size = 9;
}

function createChart(canvasId, config) {
    const ctx = document.getElementById(canvasId).getContext('2d');
    if (chartInstances[canvasId]) chartInstances[canvasId].destroy();
    chartInstances[canvasId] = new Chart(ctx, config);
    return ctx;
}

/* ── 세션 ───────────────────────────────────────────────── */
const loggedInUser = sessionStorage.getItem('gap_logged_in_user');
const userRole     = sessionStorage.getItem('gap_logged_in_role');

/**
 * 계정별로 따로 부여한 권한. users/{계정}/perms 에 저장되며 로그인할 때 세션에 담긴다.
 * 예) { employees: true } → 관리자여도 사원 명단을 등록·수정할 수 있다.
 */
let userPerms = {};
try { userPerms = JSON.parse(sessionStorage.getItem('gap_logged_in_perms') || '{}') || {}; }
catch (e) { userPerms = {}; }

/** Super Admin 은 모든 권한을 가진 것으로 본다. */
function hasPerm(key) {
    return userRole === 'admin' || userPerms[key] === true;
}

/** 로그인하지 않았으면 로그인 페이지로 돌려보낸다. 각 페이지 최상단에서 호출. */
function requireLogin() {
    if (!loggedInUser) {
        alert("보안을 위해 로그인이 필요합니다.");
        window.location.href = 'index.html';
        return false;
    }
    return true;
}

/** Super Admin 전용 기능 가드. */
function isSuperAdmin(silent) {
    if (userRole !== 'admin') {
        if (!silent) alert("이 기능은 Super Admin 만 사용할 수 있습니다.");
        return false;
    }
    return true;
}

/** 관리 권한(Super Admin + 관리자) 가드. */
function isManagerOrAbove(silent) {
    if (userRole !== 'admin' && userRole !== 'manager') {
        if (!silent) alert("관리자 권한이 필요합니다.");
        return false;
    }
    return true;
}

function doLogout() {
    sessionStorage.removeItem('gap_logged_in_user');
    sessionStorage.removeItem('gap_logged_in_role');
    sessionStorage.removeItem('gap_logged_in_perms');
    sessionStorage.removeItem('gap_audit_login_logged');
    sessionStorage.removeItem('gap_fb_refresh_token');
    if (typeof authRefreshTimer !== 'undefined' && authRefreshTimer) clearTimeout(authRefreshTimer);
    window.location.href = 'index.html';
}

/* ── 테마 ───────────────────────────────────────────────── */
let isLightMode = false;

/** 저장된 테마를 적용한다. 차트가 있는 페이지는 onApplied 로 Chart 색을 맞춘다. */
function initTheme(onApplied) {
    isLightMode = localStorage.getItem('gap_theme') === 'light';
    document.body.classList.toggle('light-mode', isLightMode);
    paintThemeButton();
    if (typeof onApplied === 'function') onApplied(isLightMode);
}

function toggleTheme(onChanged) {
    isLightMode = !isLightMode;
    document.body.classList.toggle('light-mode', isLightMode);
    localStorage.setItem('gap_theme', isLightMode ? 'light' : 'dark');
    paintThemeButton();
    if (typeof onChanged === 'function') onChanged(isLightMode);
}

function paintThemeButton() {
    const icon = document.getElementById('themeIcon');
    const text = document.getElementById('themeText');
    if (icon) icon.innerText = isLightMode ? 'dark_mode' : 'light_mode';
    if (text) text.innerText = isLightMode ? 'DARK' : 'LIGHT';
}

/* ── 관리자 콘솔 섹션 ───────────────────────────────────── */
/**
 * 관리자 콘솔의 섹션 목록.
 * 사이드바는 두 페이지 모두에서 이 목록으로 그리므로 공통 파일에 둔다.
 * (실제 데이터를 불러오는 함수는 admin.js 의 SECTION_LOADERS 가 id 로 연결한다)
 */
const ADMIN_SECTIONS = [
    { id: 'accounts',  icon: 'admin_panel_settings', label: '계정 관리',
      title: '계정 관리',       desc: '대시보드에 접속할 수 있는 계정을 발급·수정·삭제합니다.',
      roles: ['admin'] },

    { id: 'employees', icon: 'badge', label: '사원 명단',
      title: '사원 명단 관리',   desc: '앱에서 사원번호로 이름·담당·센터를 표시하기 위한 명단입니다.',
      roles: ['admin', 'manager'], perm: 'employees' },

    { id: 'notice',    icon: 'campaign', label: '알림 · 공지',
      title: '알림 · 공지 전송', desc: '앱 실행 시 사용자에게 노출할 공지를 보냅니다.',
      roles: ['admin', 'manager'] },

    { id: 'feedback',  icon: 'forum', label: '수신된 피드백',
      title: '수신된 피드백',    desc: '앱에서 보내온 개선 의견을 확인하고 처리 상태를 관리합니다.',
      roles: ['admin', 'manager'] },

    { id: 'typing',    icon: 'keyboard', label: '타자대결',
      title: '타자대결 관리',    desc: '출제 문장과 순위 기록을 관리합니다.',
      roles: ['admin', 'manager'] },

    /* 아래 두 항목은 관리자(manager)도 열람할 수 있다. 작성·수정은 Super Admin 전용. */
    { id: 'release',   icon: 'new_releases', label: '릴리즈 노트',
      title: '릴리즈 노트',     desc: '앱 버전별로 무엇이 바뀌었는지 기록합니다.',
      roles: ['admin', 'manager'] },

    { id: 'roadmap',   icon: 'checklist', label: '업데이트 계획',
      title: '업데이트 계획',    desc: '앞으로 반영할 개선 항목을 메모해 둡니다.',
      roles: ['admin', 'manager'] },

    { id: 'blocked',   icon: 'block', label: '사용자 차단',
      title: '사용자 차단',     desc: '차단된 사원번호는 앱 실행 시 안내 후 종료됩니다.',
      roles: ['admin', 'manager'], perm: 'blocked' },

    { id: 'models',    icon: 'devices', label: '모델별 사용 현황',
      title: 'PC 모델별 기능 사용 현황', desc: '진단 앱이 실행된 PC 모델별로 어떤 기능이 얼마나 사용됐는지 보여줍니다.',
      roles: ['admin', 'manager'] },

    /* README.md 원문을 붙여넣으면 깃허브처럼 렌더링해 보여준다. 열람은 manager도 가능하지만
       수정은 Super Admin 전용(canWriteDocs, admin.js). */
    { id: 'readme',    icon: 'menu_book', label: 'Readme',
      title: 'Readme',         desc: '프로젝트 문서(README.md)를 붙여넣어 그대로 문서처럼 보여줍니다.',
      roles: ['admin', 'manager'] },

    { id: 'audit',     icon: 'history', label: '감사 로그',
      title: '감사 로그',       desc: '관리자 활동 기록입니다.',
      roles: ['admin'] },
];

/**
 * Super Admin 이 관리자 계정에 개별로 넘겨줄 수 있는 권한.
 * 여기에 항목을 더하면 계정 관리 화면의 체크박스도 자동으로 늘어난다.
 * (key 는 ADMIN_SECTIONS 의 perm 값과 같아야 한다)
 */
const DELEGATABLE_PERMS = [
    { key: 'employees', label: '사원 명단',   hint: '사원 명단을 등록·수정할 수 있게 합니다' },
    { key: 'blocked',   label: '사용자 차단', hint: '앱 사용자를 차단·해제할 수 있게 합니다' },
];

function allowedAdminSections() {
    return ADMIN_SECTIONS.filter(s => {
        if (!s.roles.includes(userRole)) return false;
        // perm 이 걸린 항목은 Super Admin 이거나 따로 권한을 받은 계정만 볼 수 있다.
        return !s.perm || hasPerm(s.perm);
    });
}

/* ── 공용 셸(사이드바 · 사용자 칩) ──────────────────────── */
/**
 * 좌측 사이드바를 그린다. 페이지마다 nav 항목만 다르게 넘긴다.
 *   items: [{ href, icon, label, active, roles }]
 *   roles 가 있으면 해당 권한에서만 노출한다.
 */
function renderSidebar(containerId, items) {
    const el = document.getElementById(containerId);
    if (!el) return;

    // 관리자 콘솔의 섹션들 — 두 페이지 모두에서 하위 메뉴로 펼쳐 둬 바로 이동할 수 있게 한다.
    // 콘솔 안에서는 해시만 바뀌므로 admin.js 의 hashchange 가 섹션을 전환한다.
    const adminSubs = allowedAdminSections().map(s => `
            <a class="nav-item sub" data-section="${s.id}" href="admin.html#${s.id}">
                <span class="material-symbols-outlined">${s.icon}</span>${s.label}
            </a>`).join('');

    const links = items
        .filter(it => !it.roles || it.roles.includes(userRole))
        .map(it => `
            <a class="nav-item ${it.active ? 'active' : ''}" href="${it.href}">
                <span class="material-symbols-outlined">${it.icon}</span>${it.label}
            </a>` + (it.withAdminSections ? adminSubs : '')).join('');

    const roleLabel = userRole === 'admin' ? 'Super Admin'
                    : userRole === 'manager' ? '관리자' : '일반 사용자';

    el.innerHTML = `
        <div class="brand">
            <div class="brand-mark"><img src="ico.png" alt="gram Analyzer Pro"></div>
            <div class="brand-text">
                <b>gram Analyzer Pro</b>
                <span>Service Console</span>
            </div>
        </div>
        <nav class="side-nav">
            <div class="nav-label">MENU</div>
            ${links}
        </nav>
        <div class="side-foot">
            <div class="user-chip">
                <div class="avatar"><span class="material-symbols-outlined">person</span></div>
                <div class="who">
                    <b>${loggedInUser || '-'}</b>
                    <span>${roleLabel}</span>
                </div>
            </div>
        </div>`;

    setupMobileNav();
}

/* ── 모바일 메뉴(서랍) ──────────────────────────────────── */
/**
 * 좁은 화면에서는 사이드바가 화면 밖으로 밀려 있다(theme.css).
 * 이를 여닫을 햄버거 버튼과 뒷배경을 만들어 붙인다.
 * 페이지 HTML 을 건드리지 않도록 사이드바를 그린 뒤 여기서 주입한다.
 */
function setupMobileNav() {
    const topbar = document.querySelector('.topbar');
    if (!topbar || document.getElementById('navToggle')) return;

    const btn = document.createElement('button');
    btn.id = 'navToggle';
    btn.className = 'nav-toggle';
    btn.type = 'button';
    btn.setAttribute('aria-label', '메뉴 열기');
    btn.innerHTML = '<span class="material-symbols-outlined">menu</span>';
    btn.addEventListener('click', () => document.body.classList.toggle('nav-open'));
    topbar.insertBefore(btn, topbar.firstChild);

    const backdrop = document.createElement('div');
    backdrop.className = 'nav-backdrop';
    backdrop.addEventListener('click', closeMobileNav);
    document.body.appendChild(backdrop);

    // 메뉴를 고르면 서랍을 닫는다(같은 페이지 안에서 섹션만 바뀌는 경우 포함)
    document.querySelectorAll('#sidebar .nav-item').forEach(a => a.addEventListener('click', closeMobileNav));
    window.addEventListener('keydown', e => { if (e.key === 'Escape') closeMobileNav(); });
}

function closeMobileNav() {
    document.body.classList.remove('nav-open');
}

/* ── 값 유틸 ────────────────────────────────────────────── */
function formatDateFull(ts) {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} `
         + `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 일반 사용자에게는 사번 뒷자리를 가린다. */
function getMaskedId(id) {
    const strId = String(id || '');
    if (userRole === 'admin') return strId;
    if (strId.length > 2) return strId.substring(0, 2) + '*'.repeat(strId.length - 2);
    return strId;
}

function escapeHtml(text) {
    return String(text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 이름 등 자유 텍스트를 onclick="fn('${...}')" 처럼 홑따옴표로 감싼 JS 문자열 인자로 안전하게 넣을 때 쓴다.
 * escapeHtml 하나만으로는 홑따옴표(')를 안 막아줘서 onclick 문자열 밖으로 빠져나갈 수 있다 — 여기서는
 * 먼저 JS 문자열 기준으로 이스케이프(\, ')한 뒤, 그 결과를 다시 HTML 속성(큰따옴표) 기준으로 이스케이프한다.
 * 브라우저가 속성값을 HTML 언디코딩하고 나면 원래 문자열이 그대로(이스케이프 없이) 함수 인자로 들어간다 —
 * 그래서 confirm()/입력창 값처럼 원문 그대로 써야 하는 곳엔 이 결과가 아니라 원본 변수를 그대로 쓰면 된다.
 */
function escapeJsAttr(text) {
    return String(text ?? '')
        .replace(/\\/g, '\\\\')
        .replace(/'/g, "\\'")
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** Firebase 푸시 키와 같은 형식의 정렬 가능한 고유 키. */
const generatePushID = (function () {
    const PUSH_CHARS = '-0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz';
    let lastPushTime = 0;
    let lastRandChars = [];
    return function () {
        let now = new Date().getTime();
        const duplicateTime = (now === lastPushTime);
        lastPushTime = now;

        const timeStampChars = new Array(8);
        for (let i = 7; i >= 0; i--) {
            timeStampChars[i] = PUSH_CHARS.charAt(now % 64);
            now = Math.floor(now / 64);
        }
        if (now !== 0) throw new Error('We should have converted the entire timestamp.');

        let id = timeStampChars.join('');
        let i;
        if (!duplicateTime) {
            for (i = 0; i < 12; i++) lastRandChars[i] = Math.floor(Math.random() * 64);
        } else {
            for (i = 11; i >= 0 && lastRandChars[i] === 63; i--) lastRandChars[i] = 0;
            lastRandChars[i]++;
        }
        for (i = 0; i < 12; i++) id += PUSH_CHARS.charAt(lastRandChars[i]);
        return id;
    };
})();

/* ── 데이터 접근 ────────────────────────────────────────── */
let dynamicEmployeeData = {};

async function initEmployeeData() {
    try {
        // 읽기는 로그인한 사람이면 누구나 되지만(대시보드 표에 이름 표시용), 그래도 인증 토큰이 필요하다.
        const response = await fetch(authDbUrl('employees'));
        const data = await response.json();
        if (data) dynamicEmployeeData = data;
    } catch (e) { console.error("사원 명단 로딩 실패:", e); }
    return dynamicEmployeeData;
}

async function updateEmpDB() {
    await fetch(authDbUrl('employees'), {
        method: 'PUT',
        body: JSON.stringify(dynamicEmployeeData),
        headers: { 'Content-Type': 'application/json' }
    });
}

/**
 * 계정 목록(user_roles, uid로 색인됨)을 읽는다.
 * 통신 실패는 null 로 돌려준다.
 */
async function fetchUserRoles() {
    try { return await (await fetch(authDbUrl('user_roles'))).json() || {}; }
    catch (e) { console.error("계정 목록 로딩 실패:", e); return null; }
}

/** 관리자 활동 기록. 액션은 대문자 코드로 남긴다(감사 로그 필터 기준). */
async function logAudit(action, targetId) {
    try {
        await fetch(authDbUrl('audit_logs'), {
            method: 'POST',
            body: JSON.stringify({ admin: loggedInUser, action, target: targetId, timestamp: Date.now() }),
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) { console.error("감사 로그 기록 실패:", e); }
}

/* ── 화면 알림 ──────────────────────────────────────────── */
/** 우측 하단 토스트. alert 보다 흐름을 끊지 않는다. */
function toast(message, type = 'info') {
    let host = document.getElementById('toastHost');
    if (!host) {
        host = document.createElement('div');
        host.id = 'toastHost';
        host.style.cssText = 'position:fixed;right:22px;bottom:22px;z-index:2000;display:flex;flex-direction:column;gap:8px;';
        document.body.appendChild(host);
    }

    const color = type === 'error' ? 'var(--lg-red)'
                : type === 'success' ? 'var(--lg-green)' : 'var(--lg-blue)';
    const box = document.createElement('div');
    box.style.cssText = `background:var(--bg-panel);color:var(--text-main);border:1px solid var(--border-color);
        border-left:3px solid ${color};border-radius:10px;padding:12px 16px;font-size:13px;font-weight:600;
        box-shadow:var(--panel-shadow);min-width:220px;max-width:360px;animation:modalFadeIn .2s ease;`;
    box.innerText = message;
    host.appendChild(box);

    setTimeout(() => {
        box.style.transition = 'opacity .3s';
        box.style.opacity = '0';
        setTimeout(() => box.remove(), 300);
    }, 2600);
}
