/* ============================================================
   관리자 콘솔 — 페이지 컨트롤러
   섹션 전환 · 권한 제어 · 초기 데이터 로딩
   ============================================================ */

/* 공지 대상 목록에 쓰는 usage 데이터 (대시보드의 globalRawData 대체) */
let usageData = null;
let globalUsersList = [];
let noticeViews     = [];   // 목록에 실제로 그려지는 공지(묶음 반영)

/* 섹션 목록(ADMIN_SECTIONS)은 common.js 에 있다 — 대시보드 사이드바도 같은 목록을 쓴다.
   여기서는 각 섹션에 들어갈 때 실행할 로더만 id 로 연결한다. */
const SECTION_LOADERS = {
    accounts:  () => renderAdminUserList(),
    employees: () => loadBiosDataAccess(),
    notice:    () => loadAdminNotices(),
    feedback:  () => loadAdminFeedbacks(),
    typing:    () => { loadTypingSentences(); loadTypingScores(); },
    readme:    () => loadReadmeDoc(),
    release:   () => loadReleaseNotes(),
    roadmap:   () => loadPlans(),
    blocked:   () => loadBlocks(),
    models:    () => loadModelUsage(),
    audit:     () => loadAuditLogs(),
};

/* ── 목록 다중 선택 ─────────────────────────────────────
   계정 · 사원 명단 · 타자대결 순위가 같은 방식으로 체크박스와 선택 삭제를 쓴다. */

/** 행 앞에 붙는 체크박스. value 에 삭제 대상 키를 담는다. */
function rowCheckbox(cls, value) {
    // value는 대부분 사번·uid·push ID처럼 안전한 값이지만, 모델명(m.modelKey)처럼 기기가 보고하는
    // 자유 문자열도 들어올 수 있어 항상 이스케이프한다 — 속성값이라 escapeHtml로 충분하고,
    // 체크박스를 다시 읽을 때(.value)는 브라우저가 알아서 원문으로 디코딩해 주므로 동작엔 영향 없다.
    return `<input type="checkbox" class="${cls}" value="${escapeHtml(value)}" onclick="event.stopPropagation();"
                   style="margin-right:8px; cursor:pointer; accent-color:var(--lg-red); flex:0 0 auto;">`;
}

function toggleSelectAll(source, cls) {
    document.querySelectorAll('.' + cls).forEach(cb => { cb.checked = source.checked; });
}

function selectedValues(cls) {
    return Array.from(document.querySelectorAll('.' + cls + ':checked')).map(cb => cb.value);
}

/** 선택 삭제 직전 공통 확인. 대상이 없으면 안내하고 중단한다. */
function confirmBulkDelete(values, what) {
    if (values.length === 0) {
        alert(`삭제할 ${what}을(를) 체크박스로 먼저 선택해주세요.`);
        return false;
    }
    return confirm(`선택한 ${values.length}건의 ${what}을(를) 삭제하시겠습니까?\n되돌릴 수 없습니다.`);
}

/** 목록을 다시 그린 뒤 '전체 선택' 체크가 남아 있지 않도록 되돌린다. */
function resetSelectAll(id) {
    const box = document.getElementById(id);
    if (box) box.checked = false;
}

function showSection(id) {
    const sections = allowedAdminSections();
    const target = sections.find(s => s.id === id) || sections[0];
    if (!target) return;

    document.querySelectorAll('.section').forEach(el => el.classList.toggle('active', el.id === 'sec_' + target.id));
    document.querySelectorAll('#sidebar .nav-item[data-section]').forEach(el => el.classList.toggle('active', el.dataset.section === target.id));

    document.getElementById('pageTitle').innerText = target.title;
    document.getElementById('pageDesc').innerText  = target.desc;

    // 새로고침해도 보던 섹션으로 돌아오게 한다. (file:// 등에서 막히면 무시)
    try { history.replaceState(null, '', '#' + target.id); } catch (e) { /* noop */ }

    const load = SECTION_LOADERS[target.id];
    if (load) load();
}

/* 사이드바 링크는 admin.html#<섹션> 형태라, 콘솔 안에서는 해시만 바뀐다.
   페이지는 다시 로드되지 않으므로 여기서 섹션을 갈아끼운다. (뒤로가기도 동작) */
window.addEventListener('hashchange', () => showSection(location.hash.replace('#', '')));

/* 모달 바깥을 클릭하면 닫는다. */
window.onclick = function (e) {
    const readList = document.getElementById('readListModal');
    if (e.target === readList) readList.style.display = 'none';
    const modelChart = document.getElementById('modelChartModal');
    if (e.target === modelChart) modelChart.style.display = 'none';
    const modelFeatureUsers = document.getElementById('modelFeatureUsersModal');
    if (e.target === modelFeatureUsers) modelFeatureUsers.style.display = 'none';
};

window.onload = async function () {
    if (!requireLogin()) return;

    // 페이지를 새로 열 때마다 JS 상태가 초기화되므로(대시보드에서 넘어와도), 여기서도 인증 토큰을 복구한다.
    if (!(await restoreAuthSession())) {
        alert('세션이 만료되었습니다. 다시 로그인해주세요.');
        doLogout();
        return;
    }

    // 일반 사용자는 관리자 콘솔에 들어올 수 없다.
    if (userRole !== 'admin' && userRole !== 'manager') {
        alert("관리자 권한이 필요합니다.");
        window.location.href = 'dashboard.html';
        return;
    }

    initTheme();
    renderSidebar('sidebar', [
        { href: 'dashboard.html', icon: 'monitoring',           label: '대시보드' },
        { href: 'admin.html',     icon: 'admin_panel_settings', label: '관리자 콘솔', active: true, withAdminSections: true },
    ]);

    document.getElementById('roleBadge').innerHTML = userRole === 'admin'
        ? '<span class="tag tag-red">Super Admin</span>'
        : '<span class="tag tag-green">관리자</span>';

    // 공지 대상 선택과 피드백 표시에 필요한 기준 데이터
    await initEmployeeData();
    try { usageData = await (await fetch(authDbUrl('usage'))).json(); } catch (e) { usageData = null; }

    showSection(location.hash.replace('#', ''));
};


/* ── 타자게임 관리 ─────────────────────────────────────── */
async function loadTypingSentences() {
    const listArea = document.getElementById('adminTypingList');
    listArea.innerHTML = '<div style="text-align:center; padding:15px; color:var(--text-sub);">불러오는 중...</div>';
    try {
        const response = await fetch(authDbUrl('typing/sentences'));
        const data = await response.json();
        globalTypingSentences = data
            ? Object.entries(data).map(([key, val]) => ({
                id: key,
                // 문자열만 저장된 예전 형식도 함께 지원한다.
                text: (typeof val === 'string') ? val : (val.text || ''),
                enabled: (typeof val === 'string') ? true : (val.enabled !== false),
                createdAt: (typeof val === 'string') ? 0 : (val.createdAt || 0)
              })).sort((a, b) => b.createdAt - a.createdAt)
            : [];
        renderTypingSentences();
    } catch (e) {
        listArea.innerHTML = '<div style="text-align:center; padding:15px; color:var(--lg-red);">문장을 불러오지 못했습니다.</div>';
    }
}

function renderTypingSentences() {
    const listArea = document.getElementById('adminTypingList');
    const query = (document.getElementById('typingSearchInput')?.value || '').trim().toLowerCase();

    document.getElementById('typingTotalCount').innerText = globalTypingSentences.length;
    document.getElementById('typingEnabledCount').innerText = globalTypingSentences.filter(s => s.enabled).length;

    const rows = query
        ? globalTypingSentences.filter(s => s.text.toLowerCase().includes(query))
        : globalTypingSentences;

    if (rows.length === 0) {
        listArea.innerHTML = '<div style="text-align:center; padding:15px; color:var(--text-sub);">등록된 문장이 없습니다.</div>';
        return;
    }

    listArea.innerHTML = rows.map(s => {
        const safe = s.text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const stateBadge = s.enabled
            ? '<span style="color:var(--lg-green); font-weight:bold; font-size:11px;">[사용 중]</span>'
            : '<span style="color:var(--text-sub); font-weight:bold; font-size:11px;">[중지]</span>';
        const toggleLabel = s.enabled ? '사용 중지' : '사용';
        return `<div style="display:flex; justify-content:space-between; align-items:center; gap:10px; padding:8px 6px; border-bottom:1px solid var(--border-color);">
            <span style="flex:1; word-break:break-all; ${s.enabled ? '' : 'opacity:0.5;'}">${stateBadge} ${safe}
                <span style="color:var(--text-sub); font-size:11px;"> (${s.text.length}자)</span>
            </span>
            <span style="white-space:nowrap;">
                <button class="admin-action-btn" onclick="editTypingSentence('${s.id}')">수정</button>
                <button class="admin-action-btn reset" onclick="toggleTypingSentence('${s.id}', ${!s.enabled})">${toggleLabel}</button>
                <button class="admin-action-btn del" onclick="deleteTypingSentence('${s.id}')">삭제</button>
            </span>
        </div>`;
    }).join('');
}

/* 수정 중인 문장의 키. null 이면 신규 등록. */
let editingSentenceId = null;

async function saveTypingSentence() {
    if (!isManagerOrAbove()) return;

    const input = document.getElementById('typingSentenceInput');
    const text = input.value.trim();
    if (!text) return alert("등록할 문장을 입력해주세요.");
    if (text.length < 10) return alert("문장이 너무 짧습니다. 10자 이상 입력해주세요.");
    // 수정 중이면 자기 자신은 중복 검사에서 제외한다.
    if (globalTypingSentences.some(s => s.text === text && s.id !== editingSentenceId)) {
        return alert("이미 등록된 문장입니다.");
    }

    try {
        if (editingSentenceId) {
            // 사용 여부와 등록 시각은 그대로 두고 문장만 바꾼다.
            await fetch(authDbUrl(`typing/sentences/${editingSentenceId}`), {
                method: 'PATCH',
                body: JSON.stringify({ text: text, admin: loggedInUser }),
                headers: { 'Content-Type': 'application/json' }
            });
            await logAudit("EDIT_TYPING_SENTENCE", text.substring(0, 20));
        } else {
            await fetch(authDbUrl(`typing/sentences/${generatePushID()}`), {
                method: 'PUT',
                body: JSON.stringify({ text: text, enabled: true, createdAt: Date.now(), admin: loggedInUser }),
                headers: { 'Content-Type': 'application/json' }
            });
            await logAudit("ADD_TYPING_SENTENCE", text.substring(0, 20));
        }

        cancelSentenceEdit();
        loadTypingSentences();
    } catch (e) {
        alert("문장 저장 중 오류가 발생했습니다.");
    }
}

function editTypingSentence(id) {
    if (!isManagerOrAbove()) return;
    const s = globalTypingSentences.find(x => x.id === id);
    if (!s) return;

    editingSentenceId = id;
    const input = document.getElementById('typingSentenceInput');
    input.value = s.text;
    input.focus();

    document.getElementById('typingSaveBtn').innerText = '수정 저장';
    document.getElementById('typingCancelBtn').style.display = 'inline-flex';
}

function cancelSentenceEdit() {
    editingSentenceId = null;
    document.getElementById('typingSentenceInput').value = '';
    document.getElementById('typingSaveBtn').innerText = '문장 등록';
    document.getElementById('typingCancelBtn').style.display = 'none';
}

async function toggleTypingSentence(key, enabled) {
    if (!isManagerOrAbove()) return;
    try {
        await fetch(authDbUrl(`typing/sentences/${key}`), {
            method: 'PATCH',
            body: JSON.stringify({ enabled: enabled }),
            headers: { 'Content-Type': 'application/json' }
        });
        await logAudit(enabled ? "ENABLE_TYPING_SENTENCE" : "DISABLE_TYPING_SENTENCE", key);
        loadTypingSentences();
    } catch (e) {
        alert("상태 변경 중 오류가 발생했습니다.");
    }
}

async function deleteTypingSentence(key) {
    if (!isManagerOrAbove()) return;
    if (!confirm("이 문장을 완전히 삭제하시겠습니까?")) return;
    try {
        await fetch(authDbUrl(`typing/sentences/${key}`), {
            method: 'DELETE'
        });
        await logAudit("DELETE_TYPING_SENTENCE", key);
        if (editingSentenceId === key) cancelSentenceEdit();
        loadTypingSentences();
    } catch (e) {
        alert("삭제 중 오류가 발생했습니다.");
    }
}

// ── 타자게임 순위 관리 ────────────────────────────────────────────
let globalTypingScores = [];

async function loadTypingScores() {
    const listArea = document.getElementById('adminTypingScoreList');
    listArea.innerHTML = '<div style="text-align:center; padding:15px; color:var(--text-sub);">불러오는 중...</div>';
    try {
        const response = await fetch(authDbUrl('typing/scores'));
        const data = await response.json();
        globalTypingScores = data
            ? Object.entries(data).map(([key, val]) => ({
                id: key,
                empId: val.empId || key,
                name: val.name || '',
                center: val.center || '',
                cpm: val.cpm || 0,
                accuracy: val.accuracy || 0,
                // createdAt(시도별) → 없으면 updatedAt(구버전 최고기록 형식)
                at: val.createdAt || val.updatedAt || 0
              })).sort((a, b) => (b.cpm - a.cpm) || (b.accuracy - a.accuracy) || (a.at - b.at))
            : [];
        renderTypingScores();
    } catch (e) {
        listArea.innerHTML = '<div style="text-align:center; padding:15px; color:var(--lg-red);">순위를 불러오지 못했습니다.</div>';
    }
}

function renderTypingScores() {
    const listArea = document.getElementById('adminTypingScoreList');
    document.getElementById('typingScoreCount').innerText = globalTypingScores.length;

    if (globalTypingScores.length === 0) {
        listArea.innerHTML = '<div style="text-align:center; padding:15px; color:var(--text-sub);">등록된 기록이 없습니다.</div>';
        return;
    }

    resetSelectAll('selectAllScores');
    listArea.innerHTML = globalTypingScores.map((s, i) => {
        const rank = i + 1;
        const rankColor = rank <= 3 ? 'var(--lg-red)' : 'var(--text-sub)';
        const displayEmpId = getMaskedId(s.empId);
        const who = s.name ? `${s.name} (${displayEmpId})` : displayEmpId;
        const dateText = s.at ? new Date(s.at).toLocaleString('ko-KR', { dateStyle: 'short', timeStyle: 'short' }) : '';
        // 폭에 따른 배치는 theme.css 의 .score-row 가 맡는다(휴대폰에서는 소속·시각이 다음 줄로 접힘)
        return `<div class="score-row">
            ${rowCheckbox('score-checkbox', s.id)}
            <span class="rank" style="color:${rankColor};">${rank}위</span>
            <span class="who">${escapeHtml(who)}</span>
            <span class="cpm">${s.cpm}타</span>
            <span class="meta">${escapeHtml(s.center)}${dateText ? ' · ' + dateText : ''}</span>
            <button class="admin-action-btn del" onclick="deleteTypingScore('${s.id}', '${escapeJsAttr(who)}')">삭제</button>
        </div>`;
    }).join('');
}

async function deleteTypingScore(key, who) {
    if (!isManagerOrAbove()) return;
    if (!confirm(`[${who}] 의 이 기록을 삭제하시겠습니까?`)) return;
    try {
        await fetch(authDbUrl(`typing/scores/${key}`), {
            method: 'DELETE'
        });
        await logAudit("DELETE_TYPING_SCORE", who);
        loadTypingScores();
    } catch (e) {
        alert("삭제 중 오류가 발생했습니다.");
    }
}

/** 같은 사람(empId)이 여러 순위에 올라있으면 최고 기록(1건)만 남기고 나머지를 삭제한다.
 *  globalTypingScores는 이미 cpm desc → accuracy desc → at asc로 정렬돼 있으므로,
 *  같은 empId가 여러 번 나올 때 맨 처음(가장 앞) 것이 그 사람의 최고 기록이다. */
async function deduplicateTypingScores() {
    if (!isManagerOrAbove()) return;
    if (globalTypingScores.length === 0) return alert("삭제할 기록이 없습니다.");

    const seen = new Set();
    const duplicates = [];
    for (const s of globalTypingScores) {
        const key = s.empId || s.id;
        if (seen.has(key)) duplicates.push(s);
        else seen.add(key);
    }

    if (duplicates.length === 0) return alert("중복된 기록이 없습니다. 이미 모두 한 사람당 하나씩입니다.");

    const names = duplicates.map(s => s.name ? `${s.name}(${getMaskedId(s.empId)})` : getMaskedId(s.empId));
    const preview = [...new Set(names)].slice(0, 10).join(', ') + (names.length > 10 ? ' 외' : '');
    if (!confirm(`중복된 기록 ${duplicates.length}건을 삭제합니다(사람별 최고 기록만 남김).\n대상: ${preview}\n\n계속할까요?`)) return;

    const btn = document.getElementById('btnDedupTypingScores');
    if (btn) { btn.disabled = true; btn.innerText = '처리 중...'; }

    try {
        await Promise.all(duplicates.map(s => fetch(authDbUrl(`typing/scores/${s.id}`), { method: 'DELETE' })));
        await logAudit("DEDUP_TYPING_SCORES", `중복 ${duplicates.length}건 정리`);
        alert(`중복 기록 ${duplicates.length}건을 삭제했습니다.`);
        loadTypingScores();
    } catch (e) {
        alert("중복 삭제 중 오류가 발생했습니다.");
    } finally {
        if (btn) { btn.disabled = false; btn.innerText = '중복삭제'; }
    }
}

async function deleteAllTypingScores() {
    if (!isManagerOrAbove()) return;
    if (globalTypingScores.length === 0) return alert("삭제할 기록이 없습니다.");
    if (!confirm(`타자게임 순위 ${globalTypingScores.length}건을 모두 삭제하시겠습니까?\n되돌릴 수 없습니다.`)) return;
    if (!confirm("정말 전체 삭제할까요? 모든 사용자의 기록이 사라집니다.")) return;

    try {
        await fetch(authDbUrl('typing/scores'), { method: 'DELETE' });
        await logAudit("RESET_TYPING_SCORES", `${globalTypingScores.length}건`);
        alert("순위를 전체 삭제했습니다.");
        loadTypingScores();
    } catch (e) {
        alert("전체 삭제 중 오류가 발생했습니다.");
    }
}

/* ── 사원 명단 관리 ─────────────────────────────────────── */
function renderAdminEmpList() {
    const listArea = document.getElementById('adminEmpList');
    const searchInput = document.getElementById('empSearchInput');
    const query = searchInput ? searchInput.value.trim().toLowerCase() : '';
    const permFilterEl = document.getElementById('empPermFilter');
    const permFilter = permFilterEl ? permFilterEl.value : 'ALL';

    let empKeys = Object.keys(dynamicEmployeeData);

    if (query) {
        empKeys = empKeys.filter(id => {
            const e = dynamicEmployeeData[id];
            return id.toLowerCase().includes(query) ||
                   (e.name && e.name.toLowerCase().includes(query)) ||
                   (e.dept && e.dept.toLowerCase().includes(query)) ||
                   (e.center && e.center.toLowerCase().includes(query));
        });
    }

    // 특수권한(NT_WIN_Flash 업데이트 권한, biosDataAccess) 보유 여부로 필터링.
    if (permFilter === 'HAS') {
        empKeys = empKeys.filter(id => !!globalBiosDataAccess[id]);
    } else if (permFilter === 'NONE') {
        empKeys = empKeys.filter(id => !globalBiosDataAccess[id]);
    }

    document.getElementById('empTotalCount').innerText = empKeys.length;
    resetSelectAll('selectAllEmps');
    
    listArea.innerHTML = '';

    if (empKeys.length === 0) {
        listArea.innerHTML = '<div style="text-align:center; padding:15px; color:var(--text-sub);">검색 결과가 없습니다.</div>';
        return;
    }

    empKeys.forEach(id => {
        const e = dynamicEmployeeData[id];
        const displayId = getMaskedId(id);
        const hasBiosAccess = !!globalBiosDataAccess[id];
        // 배지 대신 버튼 자체를 상시 초록으로 물들여서(호버 아닐 때도) 부여 상태를 바로 알 수 있게 한다.
        const bioBtnStyle = hasBiosAccess ? ' style="color:var(--lg-green); border-color:var(--lg-green);"' : '';
        listArea.innerHTML += `
            <div style="display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border-color); font-size: 12px; flex-wrap:wrap; gap:5px;">
                <span style="display:flex; align-items:center; min-width:0;">${rowCheckbox('emp-checkbox', id)}
                    <span><b>${displayId}</b> | <span style="color:var(--lg-yellow)">${escapeHtml(e.name)}</span> | ${escapeHtml(e.dept)} | ${escapeHtml(e.center)}</span>
                </span>
                <div>
                    <button class="admin-action-btn"${bioBtnStyle} onclick="toggleBiosDataAccess('${id}')" title="NT_WIN_Flash 업데이트 버튼 노출 권한">${hasBiosAccess ? '특수권한 해제' : '특수권한 부여'}</button>
                    <button class="admin-action-btn reset" onclick="editEmpSetup('${id}', '${escapeJsAttr(e.name)}', '${escapeJsAttr(e.dept)}', '${escapeJsAttr(e.center)}')">수정</button>
                    <button class="admin-action-btn del" onclick="deleteEmpData('${id}')">삭제</button>
                </div>
            </div>
        `;
    });
}

/* ── 특수권한 (NT_WIN_Flash 업데이트 권한, 사원 명단 관리에서 개별 사번에 부여) ─────
   biosDataAccess/{사번} → true
   앱(gramAnalyzerPro.exe)의 BIOS 카드는 이 값이 true로 확인될 때만(즉 온라인 상태에서
   확인이 성공했을 때만) "NT_WIN_Flash 업데이트" 버튼을 보여준다 — 평소엔 숨겨져 있다.
   화면 표시는 "특수권한"으로 뭉뚱그려 부르지만, 실제로는 이 한 가지 권한(NT_WIN_Flash
   업데이트 버튼 노출)만 가리킨다 — 다른 권한 종류가 추가된 게 아니다. */
let globalBiosDataAccess = {};

async function loadBiosDataAccess() {
    try {
        const data = await (await fetch(authDbUrl('biosDataAccess'))).json();
        globalBiosDataAccess = data || {};
    } catch (e) {
        globalBiosDataAccess = {};
    }
    renderAdminEmpList();
}

async function toggleBiosDataAccess(id) {
    if (!requirePerm('employees')) return;

    const on = !globalBiosDataAccess[id];
    const emp = dynamicEmployeeData[id];
    const who = emp ? `${emp.name} (${id})` : id;
    if (!confirm(`[${who}] 사용자에게 특수권한(NT_WIN_Flash 업데이트)을 ${on ? '부여' : '해제'}하시겠습니까?`)) return;

    try {
        await fetch(authDbUrl(`biosDataAccess/${id}`), {
            method: 'PUT',
            body: JSON.stringify(on ? true : null),
            headers: { 'Content-Type': 'application/json' }
        });
        await logAudit(on ? 'GRANT_BIOS_DATA_ACCESS' : 'REVOKE_BIOS_DATA_ACCESS', id);
        toast(`[${who}] 특수권한을 ${on ? '부여' : '해제'}했습니다.`, 'success');
        await loadBiosDataAccess();
    } catch (e) {
        alert("권한 변경 중 오류가 발생했습니다.");
    }
}

function editEmpSetup(id, name, dept, center) {
    document.getElementById('empIdInput').value = id;
    document.getElementById('empNameInput').value = name;
    document.getElementById('empDeptInput').value = dept;
    document.getElementById('empCenterInput').value = center;
}

/** 위임 가능한 권한 가드. Super Admin 이거나 해당 권한을 받은 계정만 통과한다. */
function requirePerm(key) {
    if (hasPerm(key)) return true;
    const label = DELEGATABLE_PERMS.find(p => p.key === key)?.label || '이 기능';
    alert(`${label}을(를) 관리할 권한이 없습니다.`);
    return false;
}

async function saveEmpData() {
    if (!requirePerm('employees')) return;
    const id = document.getElementById('empIdInput').value.trim();
    const name = document.getElementById('empNameInput').value.trim();
    const dept = document.getElementById('empDeptInput').value.trim();
    const center = document.getElementById('empCenterInput').value.trim();

    if(!id || !name || !dept || !center) return alert("사원 정보를 모두 입력해주세요.");
    
    const isEdit = dynamicEmployeeData[id] ? true : false;
    dynamicEmployeeData[id] = { name, dept, center };
    
    await updateEmpDB();
    await logAudit(isEdit ? 'EDIT_EMPLOYEE' : 'ADD_EMPLOYEE', id);
    
    document.getElementById('empIdInput').value = '';
    document.getElementById('empNameInput').value = '';
    document.getElementById('empDeptInput').value = '';
    document.getElementById('empCenterInput').value = '';
    
    alert(isEdit ? "사원 정보가 수정되었습니다." : "신규 사원이 등록되었습니다.");
    renderAdminEmpList();
}

async function deleteEmpData(id) {
    if (!requirePerm('employees')) return;
    if(!confirm(`정말 사번 [${id}]의 명단 정보를 삭제하시겠습니까?`)) return;
    
    delete dynamicEmployeeData[id];
    await updateEmpDB();
    await logAudit('DELETE_EMPLOYEE', id);
    
    alert("삭제되었습니다.");
    renderAdminEmpList();
}


/* ── 계정 관리 ─────────────────────────────────────── */
/**
 * globalUsersList 는 이제 user_roles(uid로 색인)를 배열로 편 것이다.
 * 각 항목에 uid가 들어있고, u.id는 원래 쓰던 사번/아이디(originalId)를 그대로 담는다.
 */
async function renderAdminUserList() {
    const listArea = document.getElementById('adminUserList');
    listArea.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-sub);">사용자 정보를 불러오는 중입니다...</div>';
    const roles = await fetchUserRoles();
    globalUsersList = Object.entries(roles || {}).map(([uid, v]) => ({ uid, id: v.originalId, ...v }));
    // user_roles 는 uid(무작위 문자열) 순서로 오므로, 역할(Super Admin → 관리자 → 일반) → 사번/아이디 순으로 다시 정렬한다.
    const ROLE_ORDER = { admin: 0, manager: 1 };
    globalUsersList.sort((a, b) => {
        const ra = ROLE_ORDER[a.role] ?? 2, rb = ROLE_ORDER[b.role] ?? 2;
        if (ra !== rb) return ra - rb;
        return String(a.id).localeCompare(String(b.id), undefined, { numeric: true });
    });
    resetSelectAll('selectAllUsers');
    listArea.innerHTML = '';
    globalUsersList.forEach(u => {
        const isAdmin = u.role === 'admin';
        const isManager = u.role === 'manager';

        let roleBadge = '<span style="color:var(--text-sub)">[User]</span>';
        if (isAdmin) roleBadge = '<span style="color:var(--lg-red); font-weight:bold;">[Super Admin]</span>';
        else if (isManager) roleBadge = '<span style="color:var(--lg-green); font-weight:bold;">[관리자]</span>';

        // OTP는 선택 사항이라(강제 아님) 계정마다 등록 여부가 다르다 — Super Admin이 한눈에 보이게 배지로 표시.
        const otpBadge = u.totpSecret
            ? '<span style="font-size:10px; color:var(--lg-green); border:1px solid rgba(129,199,132,0.5); border-radius:4px; padding:1px 5px; margin-left:4px;">OTP 사용중</span>'
            : '<span style="font-size:10px; color:var(--text-sub); border:1px solid var(--border-color); border-radius:4px; padding:1px 5px; margin-left:4px;">OTP 미사용</span>';

        const uName = u.name || '';
        const uDesc = u.desc || '';
        const displayInfo = (uName || uDesc) ? `<span style="color:var(--lg-blue); font-size:11px; margin-left:8px;">${escapeHtml(uName)} ${uDesc ? `(${escapeHtml(uDesc)})` : ''}</span>` : '';

        // 휴대폰에서는 이름 바로 오른쪽에 두고, PC 에서는 기존처럼 버튼 묶음 안에 둔다.
        const editBtn = `<button class="admin-action-btn reset" onclick="editAdminSetup('${u.uid}', '${u.id}', '${u.role}', '${escapeJsAttr(uName)}', '${escapeJsAttr(uDesc)}')">정보 수정</button>`;
        const delBtn  = `<button class="admin-action-btn del" onclick="deleteAdminUser('${u.uid}', '${u.id}')">삭제</button>`;

        // OTP 재설정은 마스터 계정뿐 아니라 매니저 계정도 필요하다 — OTP는 이제 선택이라 계정마다 등록 여부가
        // 다르고, 기기를 분실하면 본인은 로그인 자체가 막히므로("등록해 둔 사람만 확인") Super Admin이
        // 풀어줄 수 있어야 한다("PW 초기화"와 대칭 구조). 등록 안 돼 있으면 눌러도 지울 게 없어 버튼을 숨긴다.
        const otpResetBtn = u.totpSecret
            ? `<button class="admin-action-btn reset" onclick="resetAdminOtp('${u.uid}', '${u.id}')">OTP 재설정</button>`
            : '';
        const actionBtns = isAdmin ? `<span style="color:#666; font-size:11px;">마스터 계정 (조작 불가)</span> ${otpResetBtn}` : `
            <div class="row-actions">
                <span class="only-desktop">${editBtn}</span>
                <select class="filter-select" style="padding:2px 4px; font-size:11px; min-width:80px;" onchange="changeUserRole('${u.uid}', '${u.id}', this.value)">
                    <option value="user" ${!isManager && !isAdmin ? 'selected' : ''}>일반 사용자</option>
                    <option value="manager" ${isManager ? 'selected' : ''}>관리자</option>
                </select>
                ${isManager ? DELEGATABLE_PERMS.map(pm => `
                    <label class="bulk-pick" title="${pm.hint}">
                        <input type="checkbox" ${u.perms && u.perms[pm.key] ? 'checked' : ''}
                               onchange="setUserPerm('${u.uid}', '${pm.key}', this.checked)"> ${pm.label}
                    </label>`).join('') : ''}
                <button class="admin-action-btn reset" onclick="resetAdminUserPw('${u.uid}', '${u.id}')">PW 초기화</button>
                ${otpResetBtn}
                <span class="only-desktop">${delBtn}</span>
            </div>`;
        // 마스터(Super Admin) 계정은 지울 수 없으므로 체크박스 자리만 비워 정렬을 맞춘다.
        const pick = isAdmin ? '' : rowCheckbox('user-checkbox', u.uid);
        listArea.innerHTML += `<div style="display: flex; justify-content: space-between; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--border-color); font-size: 13px; flex-wrap:wrap; gap:5px;">
            <span style="display:flex; align-items:center; min-width:0; gap:5px;">${pick}
                <span>${roleBadge}${otpBadge} &nbsp; <b>${escapeHtml(u.id)}</b> ${displayInfo}</span>
                ${isAdmin ? '' : `<span class="only-mobile">${editBtn}${delBtn}</span>`}
            </span>${actionBtns}</div>`;
    });
}

let editingUserUid = null; // "정보 수정"으로 열어놓은 기존 계정의 uid (null이면 신규 발급)

function editAdminSetup(uid, id, role, name, desc) {
    editingUserUid = uid;
    document.getElementById('newUserId').value = id;
    document.getElementById('newUserPw').value = '';
    document.getElementById('newUserName').value = name;
    document.getElementById('newUserDesc').value = desc;
    document.getElementById('newUserRole').value = role;
}

async function saveAdminUser() {
    const newId = document.getElementById('newUserId').value.trim();
    const newPw = document.getElementById('newUserPw').value.trim();
    const newName = document.getElementById('newUserName').value.trim();
    const newDesc = document.getElementById('newUserDesc').value.trim();
    const newRole = document.getElementById('newUserRole').value;

    if(!newId) return alert('아이디를 입력하세요.');

    if (editingUserUid) {
        // 기존 계정 정보 수정
        try {
            await fetch(authDbUrl(`user_roles/${editingUserUid}`), {
                method: 'PATCH',
                body: JSON.stringify({ role: newRole, name: newName, desc: newDesc }),
                headers: { 'Content-Type': 'application/json' }
            });
            if (newPw) await callCloudFunction(RESET_PW_FUNCTION_URL, { targetUid: editingUserUid, newPassword: newPw });
        } catch (e) {
            return alert('저장하지 못했습니다: ' + e.message);
        }
        await logAudit('EDIT_ACCOUNT_INFO', newId);
        alert(`[${newId}] 계정 정보가 수정되었습니다.`);
    } else {
        // 신규 계정 발급 — Firebase Auth 계정을 먼저 만들고, 역할 정보를 user_roles 에 적는다.
        if(!newPw) return alert('신규 계정 발급 시 초기 비밀번호를 입력해야 합니다.');

        const signUpRes = await fetch(`${IDENTITY_TOOLKIT_URL}/accounts:signUp?key=${FIREBASE_WEB_API_KEY}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email: toPseudoEmail(newId), password: toFirebasePassword(newPw), returnSecureToken: false })
        });
        const signUpData = await signUpRes.json();
        if (!signUpData.localId) {
            const msg = signUpData.error && signUpData.error.message === 'EMAIL_EXISTS' ? '이미 있는 아이디입니다.' : '계정 생성에 실패했습니다.';
            return alert(msg);
        }

        try {
            // mustChangePassword: true — 방금 입력한 초기 비밀번호를 계속 쓰지 못하게, 첫 로그인 때
            // 새 비밀번호로 바꾸도록 강제한다. 본인이 비밀번호를 바꾸면 이 표시는 지워진다.
            await fetch(authDbUrl(`user_roles/${signUpData.localId}`), {
                method: 'PUT',
                body: JSON.stringify({ role: newRole, originalId: newId, name: newName, desc: newDesc, mustChangePassword: true }),
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (e) {
            return alert('계정은 만들어졌지만 권한 저장에 실패했습니다: ' + e.message);
        }
        await logAudit('CREATE_ACCOUNT', newId);
        alert(`[${newId}] 계정이 발급되었습니다. (${newRole === 'manager' ? '관리자' : '일반 사용자'})`);
    }

    editingUserUid = null;
    document.getElementById('newUserId').value = '';
    document.getElementById('newUserPw').value = '';
    document.getElementById('newUserName').value = '';
    document.getElementById('newUserDesc').value = '';
    renderAdminUserList();
}

async function changeUserRole(uid, id, newRole) {
    const roleName = newRole === 'manager' ? '관리자' : '일반 사용자';
    if(!confirm(`정말 [${id}] 계정의 권한을 '${roleName}'(으)로 변경하시겠습니까?`)) {
        renderAdminUserList();
        return;
    }
    try {
        await fetch(authDbUrl(`user_roles/${uid}/role`), {
            method: 'PUT',
            body: JSON.stringify(newRole),
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) { return alert('서버에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.'); }
    await logAudit('EDIT_ACCOUNT_ROLE', id);
    alert(`[${id}] 계정 권한이 '${roleName}'(으)로 변경되었습니다.`);
    renderAdminUserList();
}

/**
 * 계정을 "삭제"한다 — Firebase Auth 계정 자체를 지우려면 서버 권한이 필요해서, 대신 user_roles
 * 항목을 지운다. 역할이 없어지면 보안 규칙상 이 계정은 아무 데도 접근할 수 없어 사실상 삭제와 같다.
 */
async function deleteAdminUser(uid, id) {
    if(!confirm(`정말 [${id}] 계정을 삭제하시겠습니까?\n삭제 후 복구할 수 없습니다.`)) return;
    try {
        await fetch(authDbUrl(`user_roles/${uid}`), { method: 'DELETE' });
    } catch (e) { return alert('서버에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.'); }
    await logAudit('DELETE_ACCOUNT', id);
    alert(`[${id}] 계정이 삭제되었습니다.`);
    renderAdminUserList();
}

async function resetAdminUserPw(uid, id) {
    if(!confirm(`[${id}] 계정의 비밀번호를 초기화하시겠습니까?`)) return;
    try {
        await callCloudFunction(RESET_PW_FUNCTION_URL, { targetUid: uid });
    } catch (e) { return alert('초기화하지 못했습니다: ' + e.message); }
    await logAudit('RESET_PASSWORD', id);
    alert(`[${id}] 비밀번호가 초기화되었습니다.`);
    renderAdminUserList();
}

/** Super Admin 계정의 구글 OTP 등록을 해제한다 — 인증 기기를 분실했을 때 다음 로그인에서 새로 등록하게 한다. */
async function resetAdminOtp(uid, id) {
    if(!confirm(`[${id}] 계정의 OTP 등록을 해제하시겠습니까?\n다음 로그인 시 새 기기로 다시 등록해야 합니다.`)) return;
    try {
        await fetch(authDbUrl(`user_roles/${uid}/totpSecret`), { method: 'DELETE' });
    } catch (e) { return alert('서버에 연결하지 못했습니다. 잠시 후 다시 시도해주세요.'); }
    await logAudit('RESET_OTP', id);
    alert(`[${id}] 계정의 OTP 등록이 해제되었습니다. 다음 로그인 시 새로 등록합니다.`);
    renderAdminUserList();
}


/* ── 알림/공지 ─────────────────────────────────────── */
/* 공지 대상 목록에서 '특정 버전 미만'을 고르면 기준 버전 입력칸을 연다. */
function onNoticeTargetChange() {
    const isVer = document.getElementById('noticeTarget').value === 'VER_BELOW';
    document.getElementById('noticeVerRow').style.display = isVer ? 'block' : 'none';
}

/**
 * 기준 버전보다 낮은 버전을 쓰는 사번 목록.
 * 앱은 공지의 target 을 자기 사번과 정확히 비교하므로(구버전 앱 포함),
 * 버전 조건은 여기서 사번 목록으로 풀어서 각각 보낸다.
 */
function versionBelowUsers(threshold) {
    if (!usageData) return [];
    return Object.keys(usageData).filter(id => {
        if (id.toLowerCase() === 'admin') return false;
        const v = usageData[id] && usageData[id].lastVersion;
        if (!v || v === '-') return true;                  // 버전 기록이 없으면 구버전으로 본다
        return compareVersionDesc(v, threshold) > 0;       // threshold 가 더 높다 = v 는 그보다 낮다
    });
}

/** 같은 batchId 로 보낸 공지들을 한 줄로 묶는다(읽음 수는 합산). */
function groupNotices(notices) {
    const views = [];
    const byBatch = {};

    notices.forEach(n => {
        if (!n.batchId) {
            views.push({ ...n, ids: [n.id], count: 1, isBatch: false });
            return;
        }
        let v = byBatch[n.batchId];
        if (!v) {
            v = byBatch[n.batchId] = { ...n, ids: [], reads: {}, count: 0, isBatch: true };
            views.push(v);
        }
        v.ids.push(n.id);
        v.count++;
        Object.assign(v.reads, n.reads || {});
    });
    return views;
}

async function sendNotice() {
    const target = document.getElementById('noticeTarget').value;
    const message = document.getElementById('noticeMessage').value.trim();
    const expireDays = document.getElementById('noticeExpire').value;

    if (!message) return alert("공지할 메시지 내용을 입력해주세요.");

    let recipients = null;      // null 이면 단일 대상(ALL 또는 개인)
    let batchLabel = '';

    if (target === 'VER_BELOW') {
        const threshold = document.getElementById('noticeVerInput').value.trim();
        if (!threshold) return alert("기준 버전을 입력해주세요. (예: 4.17)");
        if (!/^[\d.]+$/.test(threshold)) return alert("버전은 숫자와 점으로만 입력해주세요. (예: 4.17)");

        recipients = versionBelowUsers(threshold);
        if (recipients.length === 0) return alert(`v${threshold} 미만을 쓰는 사용자가 없습니다.`);

        batchLabel = `v${threshold} 미만`;
        if (!confirm(`${batchLabel} 사용자 ${recipients.length}명에게 공지를 전송하시겠습니까?`)) return;
    } else {
        if (!confirm(`대상을 '${target === 'ALL' ? '전체 사용자' : target}'(으)로 하여 공지를 전송하시겠습니까?`)) return;
    }

    const expiresAt = expireDays !== '0'
        ? Date.now() + (parseInt(expireDays) * 24 * 60 * 60 * 1000)
        : null;

    const base = { message, timestamp: Date.now(), admin: loggedInUser, expiresAt };

    try {
        if (recipients) {
            const batchId = generatePushID();
            await Promise.all(recipients.map(empId => fetch(authDbUrl(`notices/${generatePushID()}`), {
                method: 'PUT',
                body: JSON.stringify({ ...base, target: empId, batchId, batchLabel }),
                headers: { 'Content-Type': 'application/json' }
            })));
            await logAudit('SEND_NOTICE', `${batchLabel} ${recipients.length}명`);
            alert(`${batchLabel} 사용자 ${recipients.length}명에게 공지를 전송했습니다.`);
        } else {
            await fetch(authDbUrl(`notices/${generatePushID()}`), {
                method: 'PUT',
                body: JSON.stringify({ ...base, target }),
                headers: { 'Content-Type': 'application/json' }
            });
            await logAudit('SEND_NOTICE', target);
            alert('공지사항이 성공적으로 전송되었습니다.');
        }

        document.getElementById('noticeMessage').value = '';
        loadAdminNotices();
    } catch (e) {
        alert('공지 전송 중 오류가 발생했습니다.');
        console.error(e);
    }
}

async function loadAdminNotices() {
    const targetSelect = document.getElementById('noticeTarget');
    let optionsHtml = '<option value="ALL">전체 사용자 (앱 실행 시 모두에게 노출)</option>'
                    + '<option value="VER_BELOW">특정 버전 미만 사용자 (구버전 사용자에게만)</option>';
    
    let allTargetIds = new Set(Object.keys(dynamicEmployeeData));
    if (usageData) {
        Object.keys(usageData).forEach(id => {
            if (id !== 'admin' && id.toLowerCase() !== 'admin') {
                allTargetIds.add(id);
            }
        });
    }

    allTargetIds.forEach(id => {
        const displayId = getMaskedId(id);
        const isRegistered = dynamicEmployeeData[id];
        const nameLabel = isRegistered ? dynamicEmployeeData[id].name : "미등록 사용자";
        optionsHtml += `<option value="${id}">${nameLabel} (${displayId})</option>`;
    });
    
    targetSelect.innerHTML = optionsHtml;

    const listArea = document.getElementById('adminNoticeList');
    listArea.innerHTML = '<div style="text-align:center; padding:15px; color:var(--text-sub);">불러오는 중...</div>';
    
    try {
        const response = await fetch(authDbUrl('notices'));
        const data = await response.json();
        if(!data) { listArea.innerHTML = '<div style="text-align:center; padding:15px; color:var(--text-sub);">전송된 공지사항이 없습니다.</div>'; return; }
        
        globalAdminNotices = Object.entries(data).map(([key, val]) => ({ id: key, ...val })).sort((a,b) => b.timestamp - a.timestamp); 
        listArea.innerHTML = '';

        // 버전 조건으로 한 번에 보낸 공지는 여러 건이므로 한 줄로 묶어 보여준다.
        noticeViews = groupNotices(globalAdminNotices);

        noticeViews.forEach(notice => {
            const displayTargetId = getMaskedId(notice.target);
            let targetText = displayTargetId;
            if (notice.isBatch) {
                targetText = `${escapeHtml(notice.batchLabel)} 사용자 ${notice.count}명`;
            } else if (notice.target === 'ALL') {
                targetText = '전체 사용자';
            } else {
                const empInfo = dynamicEmployeeData[notice.target];
                targetText = empInfo ? `${escapeHtml(empInfo.name)} (${displayTargetId})` : `미등록 사용자 (${displayTargetId})`;
            }
            
            const readCount = notice.reads ? Object.keys(notice.reads).length : 0;
            const isExpired = notice.expiresAt && Date.now() > notice.expiresAt;
            const expiredBadge = isExpired ? `<span style="background-color:rgba(255,75,92,0.1); color:var(--lg-red); padding:2px 6px; border-radius:4px; font-size:10px; border:1px solid rgba(255,75,92,0.3); margin-right:5px;">만료됨</span>` : '';

            const readBadge = readCount > 0 
                ? `<span style="font-size:11px; background:var(--bg-base); border:1px solid var(--border-color); padding:1px 6px; border-radius:10px; margin-left:8px; color:var(--text-main); cursor:pointer;" onclick="showReadList('${notice.id}')" onmouseover="this.style.borderColor='var(--lg-green)'" onmouseout="this.style.borderColor='var(--border-color)'" title="클릭하여 수신 명단 보기">읽음: <b style="color:var(--lg-green);">${readCount}명</b></span>`
                : `<span style="font-size:11px; background:var(--bg-base); border:1px solid var(--border-color); padding:1px 6px; border-radius:10px; margin-left:8px; color:var(--text-sub);">읽음: 0명</span>`;

            listArea.innerHTML += `
                <div style="padding:10px 0; border-bottom:1px dashed var(--border-color); ${isExpired ? 'opacity:0.6;' : ''}">
                    <div style="display:flex; justify-content:space-between; margin-bottom:6px;">
                        <div style="display:flex; align-items:center;">
                            ${expiredBadge}
                            <span style="font-size:12px; color:var(--lg-blue); font-weight:bold;">TO: ${targetText}</span>
                            ${readBadge}
                        </div>
                        <div style="display:flex; align-items:center; gap:10px;">
                            <span style="font-size:11px; color:var(--text-sub);">${formatDateFull(notice.timestamp)}</span>
                            <button class="admin-action-btn del" style="margin:0; padding:2px 6px;" onclick="deleteNotice('${notice.id}')">삭제</button>
                        </div>
                    </div>
                    <div style="font-size:13px; color:var(--text-main); white-space:pre-wrap; margin-top:4px;">${escapeHtml(notice.message)}</div>
                </div>`;
        });
    } catch(e) { listArea.innerHTML = '오류 발생'; }
}

function showReadList(noticeId) {
    const notice = noticeViews.find(n => n.id === noticeId);
    if (!notice || !notice.reads) return;

    const contentArea = document.getElementById('readListContent');
    contentArea.innerHTML = '';

    const readEntries = Object.entries(notice.reads)
                              .map(([empId, time]) => ({ empId, time }))
                              .sort((a,b) => b.time - a.time);

    readEntries.forEach(r => {
        const empInfo = dynamicEmployeeData[r.empId] || { name: "미등록 사용자", dept: "-", center: "-" };
        const readTime = formatDateFull(r.time);
        
        const displayEmpId = getMaskedId(r.empId);
        
        contentArea.innerHTML += `
            <div style="display:flex; justify-content:space-between; align-items:center; padding:8px 0; border-bottom:1px dashed var(--border-color); font-size:12px;">
                <span><b style="color:var(--lg-blue)">${escapeHtml(empInfo.name)}</b> (${displayEmpId}) / ${escapeHtml(empInfo.center)}</span>
                <span style="color:var(--text-sub)">${readTime}</span>
            </div>
        `;
    });

    document.getElementById('readListModal').style.display = 'block';
}

async function deleteNotice(noticeId) {
    // 버전 조건으로 보낸 공지는 묶음 전체를 함께 지운다.
    const view = noticeViews.find(n => n.id === noticeId);
    const ids = view ? view.ids : [noticeId];

    if(!confirm("이 공지사항을 서버에서 완전히 삭제하시겠습니까?\n(이미 팝업을 본 사용자는 어쩔 수 없지만, 아직 보지 않은 사용자는 더 이상 알림을 받지 않습니다.)")) return;
    try {
        await Promise.all(ids.map(id => fetch(authDbUrl(`notices/${id}`), { method: 'DELETE' })));
        alert("삭제되었습니다.");
        loadAdminNotices(); 
    } catch(e) {
        alert("삭제 중 오류가 발생했습니다.");
    }
}


/* ── 피드백 ─────────────────────────────────────── */
async function loadAdminFeedbacks() {
    const listArea = document.getElementById('adminFbList');
    listArea.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-sub);">불러오는 중...</div>';
    try {
        const response = await fetch(authDbUrl('feedbacks'));
        const data = await response.json();
        if(!data) { listArea.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-sub);">수신된 피드백이 없습니다.</div>'; return; }
        
        const arr = Object.entries(data).map(([key, val]) => ({ id: key, ...val })).sort((a,b) => b.createdAt - a.createdAt); 
        listArea.innerHTML = '';
        arr.forEach(fb => {
            const empName = dynamicEmployeeData[fb.employeeId] ? dynamicEmployeeData[fb.employeeId].name : "미등록 사용자"; 
            const displayEmpId = getMaskedId(fb.employeeId);
            
            const status = fb.status || 'pending';
            const priority = fb.priority || 'normal';

            const statusBadge = status === 'completed' 
                ? '<span style="background:rgba(129, 199, 132, 0.2); color:var(--lg-green); border:1px solid rgba(129, 199, 132, 0.5); padding:2px 6px; border-radius:4px; font-size:10px; font-weight:bold; margin-right:5px;">처리완료</span>'
                : '<span style="background:rgba(255, 152, 0, 0.2); color:var(--lg-orange); border:1px solid rgba(255, 152, 0, 0.5); padding:2px 6px; border-radius:4px; font-size:10px; font-weight:bold; margin-right:5px;">대기중</span>';
                
            let prioBadge = '';
            if(priority === 'high') {
                prioBadge = '<span style="background:rgba(255, 75, 92, 0.2); color:var(--lg-red); border:1px solid rgba(255, 75, 92, 0.5); padding:2px 6px; border-radius:4px; font-size:10px; font-weight:bold; margin-right:5px;">긴급</span>';
            } else if(priority === 'low') {
                prioBadge = '<span style="background:rgba(158, 158, 158, 0.2); color:var(--text-sub); border:1px solid rgba(158, 158, 158, 0.5); padding:2px 6px; border-radius:4px; font-size:10px; font-weight:bold; margin-right:5px;">낮음</span>';
            } else {
                prioBadge = '<span style="background:rgba(79, 195, 247, 0.2); color:var(--lg-blue); border:1px solid rgba(79, 195, 247, 0.5); padding:2px 6px; border-radius:4px; font-size:10px; font-weight:bold; margin-right:5px;">보통</span>';
            }

            const isCompletedOpacity = status === 'completed' ? 'opacity:0.6;' : '';

            const resolutionHtml = (status === 'completed' && fb.resolution)
                ? `<div style="margin-top:8px; padding:6px 10px; background:rgba(129, 199, 132, 0.05); border-left:3px solid var(--lg-green); border-radius:0 4px 4px 0; font-size:12px; color:var(--lg-green);">
                      <span class="material-symbols-outlined" style="font-size:13px; vertical-align:text-bottom; margin-right:4px;">check_circle</span>
                      <strong>처리 결과:</strong> ${escapeHtml(fb.resolution)}
                   </div>`
                : '';

            listArea.innerHTML += `
                <div style="padding:10px; border-bottom:1px solid var(--border-color); margin-bottom:5px; ${isCompletedOpacity} transition:0.3s;">
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:5px; flex-wrap:wrap; gap:5px;">
                        <div style="display:flex; align-items:center;">
                            ${statusBadge}
                            ${prioBadge}
                            <strong style="color:var(--lg-blue); font-size:13px;">${escapeHtml(empName)} (${displayEmpId})</strong>
                            <span style="color:var(--lg-orange); font-size:11px; margin-left:6px; font-weight:bold;">v${fb.appVersion || '-'}</span>
                        </div>
                        <div style="display:flex; align-items:center; gap:8px;">
                            <span style="font-size:11px; color:var(--text-sub);">${formatDateFull(fb.createdAt)}</span>
                            
                            <select class="filter-select" style="padding:2px 4px; font-size:11px; min-width:60px;" onchange="changeFeedbackPriority('${fb.id}', '${escapeJsAttr(fb.employeeId)}', this.value)">
                                <option value="normal" ${priority === 'normal' ? 'selected' : ''}>보통</option>
                                <option value="high" ${priority === 'high' ? 'selected' : ''}>긴급</option>
                                <option value="low" ${priority === 'low' ? 'selected' : ''}>낮음</option>
                            </select>
                            
                            <button class="admin-action-btn ${status === 'completed' ? 'reset' : 'submit'}" style="margin:0; padding:2px 6px; ${status !== 'completed' ? 'color:var(--lg-green); border-color:rgba(129, 199, 132, 0.5);' : ''}" onclick="toggleFeedbackStatus('${fb.id}', '${escapeJsAttr(fb.employeeId)}', '${status}')">
                                ${status === 'completed' ? '대기 전환' : '완료 처리'}
                            </button>
                            
                            <button class="admin-action-btn del" style="margin:0; padding:2px 6px;" onclick="deleteFeedback('${fb.id}', '${escapeJsAttr(fb.employeeId)}')">삭제</button>
                        </div>
                    </div>
                    <div style="font-size:13px; line-height:1.4; color:var(--text-main); white-space:pre-wrap; padding-top:4px;">${escapeHtml(fb.message)}</div>
                    ${resolutionHtml}
                </div>`;
        });
    } catch(e) { listArea.innerHTML = '오류 발생'; }
}

async function toggleFeedbackStatus(fbId, empId, currentStatus) {
    let newStatus = currentStatus === 'completed' ? 'pending' : 'completed';
    let resolutionText = null;

    if (newStatus === 'completed') {
        resolutionText = prompt("완료 처리 결과를 간단히 입력해주세요.\n(예: v4.16 버전에서 수정됨, 확인 후 개별 안내 완료 등)");
        if (resolutionText === null) return; 
        if (resolutionText.trim() === "") resolutionText = "처리 완료됨"; 
    } else {
        if (!confirm("대기 상태로 다시 전환하시겠습니까? (기존에 입력한 처리 결과는 삭제됩니다)")) return;
    }

    try {
        await fetch(authDbUrl(`feedbacks/${fbId}`), {
            method: 'PATCH',
            body: JSON.stringify({ status: newStatus, resolution: resolutionText }),
            headers: { 'Content-Type': 'application/json' }
        });
        await logAudit('UPDATE_FEEDBACK', empId); 
        loadAdminFeedbacks();
    } catch(e) { alert("상태 변경 중 오류가 발생했습니다."); }
}

async function changeFeedbackPriority(fbId, empId, newPriority) {
    try {
        await fetch(authDbUrl(`feedbacks/${fbId}`), {
            method: 'PATCH',
            body: JSON.stringify({ priority: newPriority }),
            headers: { 'Content-Type': 'application/json' }
        });
        await logAudit('UPDATE_FEEDBACK', empId);
        loadAdminFeedbacks();
    } catch(e) { alert("중요도 변경 중 오류가 발생했습니다."); }
}

async function deleteFeedback(fbId, empId) {
    if(!confirm("이 피드백을 삭제하시겠습니까?")) return;
    try {
        await fetch(authDbUrl(`feedbacks/${fbId}`), {
            method: 'DELETE'
        });
        await logAudit('DELETE_FEEDBACK', empId);
        alert("피드백이 삭제되었습니다.");
        loadAdminFeedbacks(); 
    } catch(e) {
        alert("삭제 중 오류가 발생했습니다.");
    }
}


/* ── 감사 로그 ─────────────────────────────────────────────────────────
   전체를 한 번에 안 불러오고 최신순으로 AUDIT_LOG_PAGE_SIZE개씩 페이지 단위로 불러온다.
   "더 불러오기"를 누르면 지금까지 불러온 것보다 더 과거(oldest) 구간만 추가로 가져와
   globalAuditLogs에 이어붙인다(RTDB의 orderBy+endAt+limitToLast 커서 페이징). ─────── */
const AUDIT_LOG_PAGE_SIZE = 60;
let auditLogsOldestTs   = null;   // 지금까지 불러온 것 중 가장 과거 timestamp(다음 페이지 커서)
let auditLogsExhausted  = false;  // 더 가져올 과거 로그가 없으면 true

async function loadAuditLogs() {
    const listArea = document.getElementById('adminLogList');
    document.getElementById('selectAllLogs').checked = false;
    globalAuditLogs = [];
    auditLogsOldestTs = null;
    auditLogsExhausted = false;

    listArea.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-sub);">불러오는 중...</div>';
    try {
        const roles = await fetchUserRoles();
        globalUsersList = Object.entries(roles || {}).map(([uid, v]) => ({ uid, id: v.originalId, ...v }));

        await fetchAuditLogPage();
        renderAuditLogs();
    } catch(e) { listArea.innerHTML = '오류 발생'; }
}

/** audit_logs를 최신순으로 한 페이지(AUDIT_LOG_PAGE_SIZE개)만 서버에서 가져와 globalAuditLogs에
 *  이어붙인다. 이미 더 과거 로그가 없다고 확인됐으면(auditLogsExhausted) 아무것도 하지 않는다. */
async function fetchAuditLogPage() {
    if (auditLogsExhausted) return 0;

    let url = authDbUrl('audit_logs') + `&orderBy=%22timestamp%22&limitToLast=${AUDIT_LOG_PAGE_SIZE}`;
    if (auditLogsOldestTs !== null) {
        // 지금까지 불러온 것보다 하나 더 과거 시각까지만 조회(경계 겹침 방지)
        url += `&endAt=${auditLogsOldestTs - 1}`;
    }

    const response = await fetch(url);
    const data = await response.json();
    if (!data) { auditLogsExhausted = true; return 0; }

    const page = Object.entries(data).map(([key, val]) => ({ id: key, ...val }));
    if (page.length < AUDIT_LOG_PAGE_SIZE) auditLogsExhausted = true;

    globalAuditLogs = globalAuditLogs.concat(page).sort((a, b) => b.timestamp - a.timestamp);
    if (globalAuditLogs.length) {
        auditLogsOldestTs = globalAuditLogs[globalAuditLogs.length - 1].timestamp;
    }
    return page.length;
}

/** "더 불러오기" 버튼 클릭 — 다음 과거 페이지를 마저 불러와 이어붙이고 다시 그린다. */
async function loadMoreAuditLogs() {
    const btn = document.getElementById('btnLoadMoreLogs');
    if (btn) { btn.disabled = true; btn.innerText = '불러오는 중...'; }
    try {
        await fetchAuditLogPage();
    } catch (e) { /* 버튼을 다시 눌러 재시도할 수 있으니 조용히 무시 */ }
    renderAuditLogs();
}

function toggleSelectAllLogs(source) {
    const checkboxes = document.querySelectorAll('.log-checkbox');
    checkboxes.forEach(cb => cb.checked = source.checked);
}

async function deleteSelectedLogs() {
    const checkedBoxes = document.querySelectorAll('.log-checkbox:checked');
    if (checkedBoxes.length === 0) {
        return alert("삭제할 로그를 체크박스로 먼저 선택해주세요.");
    }
    if (!confirm(`선택한 ${checkedBoxes.length}개의 활동 로그를 데이터베이스에서 완전히 삭제하시겠습니까?`)) {
        return;
    }

    try {
        const deletePromises = Array.from(checkedBoxes).map(cb => {
            return fetch(authDbUrl(`audit_logs/${cb.value}`), { method: 'DELETE' });
        });

        await Promise.all(deletePromises);
        alert(`${checkedBoxes.length}개의 로그가 성공적으로 삭제되었습니다.`);
        document.getElementById('selectAllLogs').checked = false; 
        loadAuditLogs();
    } catch(e) {
        alert("일괄 삭제 처리 중 일부 오류가 발생했습니다.");
    }
}

/** 감사 로그 기간 프리셋 선택 시 사용자 지정 입력칸을 켜고 목록을 다시 그린다. */
function handleAuditDatePreset() {
    const preset = document.getElementById('auditDatePreset').value;
    document.getElementById('auditCustomDateRange').style.display = preset === 'custom' ? 'flex' : 'none';
    renderAuditLogs();
}

/** 지금 고른 기간을 [시작 00:00:00, 종료 23:59:59.999] 타임스탬프(ms) 범위로 바꾼다. */
function getAuditFilterRangeMs() {
    const preset = document.getElementById('auditDatePreset').value;
    if (preset === 'all') return { startMs: -Infinity, endMs: Infinity };

    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const todayStr = `${yyyy}-${mm}-${dd}`;

    let start = todayStr, end = todayStr;
    if (preset === 'last7') {
        const lastWeek = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
        start = `${lastWeek.getFullYear()}-${String(lastWeek.getMonth() + 1).padStart(2, '0')}-${String(lastWeek.getDate()).padStart(2, '0')}`;
        end = todayStr;
    } else if (preset === 'thisMonth') {
        start = `${yyyy}-${mm}-01`; end = todayStr;
    } else if (preset === 'custom') {
        start = document.getElementById('auditStartDate').value || '2000-01-01';
        end = document.getElementById('auditEndDate').value || '2100-12-31';
    }
    return { startMs: new Date(`${start}T00:00:00`).getTime(), endMs: new Date(`${end}T23:59:59.999`).getTime() };
}

function renderAuditLogs() {
    const listArea = document.getElementById('adminLogList');
    const filter = document.getElementById('auditLogFilter').value;
    const { startMs, endMs } = getAuditFilterRangeMs();
    document.getElementById('selectAllLogs').checked = false;

    const filtered = globalAuditLogs.filter(log => {
        if (log.timestamp < startMs || log.timestamp > endMs) return false;
        if (filter === 'ALL') return true;
        if (filter === 'ACCOUNT') return ['CREATE_ACCOUNT', 'DELETE_ACCOUNT', 'RESET_PASSWORD', 'RESET_OTP', 'EDIT_ACCOUNT_ROLE', 'EDIT_ACCOUNT_INFO', 'EDIT_ACCOUNT_PERM'].includes(log.action);
        if (filter === 'EMPLOYEE') return ['ADD_EMPLOYEE', 'EDIT_EMPLOYEE', 'DELETE_EMPLOYEE', 'GRANT_BIOS_DATA_ACCESS', 'REVOKE_BIOS_DATA_ACCESS'].includes(log.action);
        if (filter === 'NOTICE') return log.action === 'SEND_NOTICE';
        if (filter === 'LOGIN') return log.action === 'LOGIN';
        if (filter === 'FEEDBACK') return ['UPDATE_FEEDBACK', 'DELETE_FEEDBACK'].includes(log.action); 
        if (filter === 'TYPING') return ['ADD_TYPING_SENTENCE', 'EDIT_TYPING_SENTENCE', 'ENABLE_TYPING_SENTENCE', 'DISABLE_TYPING_SENTENCE', 'DELETE_TYPING_SENTENCE', 'DELETE_TYPING_SCORE', 'DEDUP_TYPING_SCORES', 'RESET_TYPING_SCORES'].includes(log.action);
        if (filter === 'DOCS') return ['ADD_RELEASE_NOTE', 'EDIT_RELEASE_NOTE', 'DELETE_RELEASE_NOTE', 'ADD_PLAN', 'EDIT_PLAN', 'DELETE_PLAN', 'UPDATE_README'].includes(log.action);
        if (filter === 'BLOCK') return ['BLOCK_USER', 'UNBLOCK_USER'].includes(log.action);
        if (filter === 'RAWDATA') return log.action === 'DELETE_RAW_DATA';
        if (filter === 'MODELUSAGE') return ['DELETE_MODEL_USAGE', 'CLEAN_ORPHAN_MODEL_USAGE'].includes(log.action);
        return true;
    });

    document.getElementById('logTotalCount').innerText = filtered.length;
    updateAuditLoadMoreUi();

    if (filtered.length === 0) {
        listArea.innerHTML = '<div style="text-align:center; padding:20px; color:var(--text-sub);">해당 카테고리의 로그가 없습니다.</div>';
        return;
    }

    listArea.innerHTML = '';
    filtered.forEach(log => {
        let actionText = ''; let color = 'var(--text-main)';
        if(log.action === 'CREATE_ACCOUNT') { actionText = '계정 신규 발급'; color = 'var(--lg-green)'; }
        if(log.action === 'DELETE_ACCOUNT') { actionText = '계정 영구 삭제'; color = 'var(--lg-red)'; }
        if(log.action === 'RESET_PASSWORD') { actionText = '비밀번호 강제 초기화'; color = 'var(--lg-blue)'; }
        if(log.action === 'RESET_OTP') { actionText = 'OTP 등록 해제'; color = 'var(--lg-blue)'; }
        if(log.action === 'EDIT_ACCOUNT_ROLE') { actionText = '계정 권한 변경'; color = 'var(--lg-blue)'; }
        if(log.action === 'EDIT_ACCOUNT_INFO') { actionText = '계정 정보 수정'; color = 'var(--lg-blue)'; }
        if(log.action === 'BLOCK_USER') { actionText = '사용자 차단'; color = 'var(--lg-red)'; }
        if(log.action === 'UNBLOCK_USER') { actionText = '사용자 차단 해제'; color = 'var(--lg-green)'; }
        if(log.action === 'EDIT_ACCOUNT_PERM') { actionText = '계정 권한 부여/해제'; color = 'var(--lg-orange)'; }
        if(log.action === 'ADD_EMPLOYEE') { actionText = '명단: 사원 추가'; color = 'var(--lg-green)'; }
        if(log.action === 'EDIT_EMPLOYEE') { actionText = '명단: 사원 수정'; color = 'var(--lg-blue)'; }
        if(log.action === 'DELETE_EMPLOYEE') { actionText = '명단: 사원 삭제'; color = 'var(--lg-red)'; }
        if(log.action === 'GRANT_BIOS_DATA_ACCESS') { actionText = '명단: 특수권한 부여'; color = 'var(--lg-green)'; }
        if(log.action === 'REVOKE_BIOS_DATA_ACCESS') { actionText = '명단: 특수권한 해제'; color = 'var(--lg-red)'; }
        if(log.action === 'SEND_NOTICE') { actionText = '공지 알림 전송'; color = 'var(--lg-orange)'; }
        if(log.action === 'LOGIN') { actionText = '시스템 로그인'; color = 'var(--lg-blue)'; }
        if(log.action === 'UPDATE_FEEDBACK') { actionText = '피드백 상태 변경'; color = 'var(--lg-green)'; } 
        if(log.action === 'DELETE_FEEDBACK') { actionText = '피드백 영구 삭제'; color = 'var(--lg-red)'; } 
        if(log.action === 'DELETE_RAW_DATA') { actionText = 'RAW DATA 삭제'; color = 'var(--lg-red)'; } 
        if(log.action === 'ADD_TYPING_SENTENCE') { actionText = '타자게임: 문장 등록'; color = 'var(--lg-green)'; }
        if(log.action === 'EDIT_TYPING_SENTENCE') { actionText = '타자게임: 문장 수정'; color = 'var(--lg-blue)'; }
        if(log.action === 'ENABLE_TYPING_SENTENCE') { actionText = '타자게임: 문장 사용'; color = 'var(--lg-blue)'; }
        if(log.action === 'DISABLE_TYPING_SENTENCE') { actionText = '타자게임: 문장 중지'; color = 'var(--lg-orange)'; }
        if(log.action === 'DELETE_TYPING_SENTENCE') { actionText = '타자게임: 문장 삭제'; color = 'var(--lg-red)'; }
        if(log.action === 'DELETE_TYPING_SCORE') { actionText = '타자게임: 기록 삭제'; color = 'var(--lg-red)'; }
        if(log.action === 'DEDUP_TYPING_SCORES') { actionText = '타자게임: 중복 기록 정리'; color = 'var(--lg-orange)'; }
        if(log.action === 'RESET_TYPING_SCORES') { actionText = '타자게임: 순위 전체 삭제'; color = 'var(--lg-red)'; }
        if(log.action === 'ADD_RELEASE_NOTE') { actionText = '릴리즈 노트 등록'; color = 'var(--lg-green)'; }
        if(log.action === 'EDIT_RELEASE_NOTE') { actionText = '릴리즈 노트 수정'; color = 'var(--lg-blue)'; }
        if(log.action === 'DELETE_RELEASE_NOTE') { actionText = '릴리즈 노트 삭제'; color = 'var(--lg-red)'; }
        if(log.action === 'UPDATE_README') { actionText = 'Readme 수정'; color = 'var(--lg-blue)'; }
        if(log.action === 'ADD_PLAN') { actionText = '업데이트 계획 추가'; color = 'var(--lg-green)'; }
        if(log.action === 'EDIT_PLAN') { actionText = '업데이트 계획 수정'; color = 'var(--lg-blue)'; }
        if(log.action === 'DELETE_PLAN') { actionText = '업데이트 계획 삭제'; color = 'var(--lg-red)'; }
        if(log.action === 'DELETE_MODEL_USAGE') { actionText = '모델별 사용현황 삭제'; color = 'var(--lg-red)'; }
        if(log.action === 'CLEAN_ORPHAN_MODEL_USAGE') { actionText = '모델별 사용현황: 고아 데이터 정리'; color = 'var(--lg-orange)'; }
        
        let checkboxHtml = '';
        if (userRole === 'admin') {
            checkboxHtml = `<input type="checkbox" class="log-checkbox" value="${log.id}" style="margin-right:8px; cursor:pointer; accent-color:var(--lg-red);">`;
        }

        let displayAdmin = log.admin || '';
        let titleAdmin = displayAdmin;
        if (displayAdmin && displayAdmin !== 'admin') {
            let aName = "";
            let aDesc = "";

            if (dynamicEmployeeData[displayAdmin] && dynamicEmployeeData[displayAdmin].name) {
                aName = dynamicEmployeeData[displayAdmin].name;
            }

            let u = globalUsersList.find(x => x.id === displayAdmin);
            if (u) {
                if (!aName && u.name) aName = u.name;
                if (u.desc) aDesc = u.desc;
            }

            // 아이디 자체도(계정 생성 시 자유 입력이라) 그대로 화면·title 속성에 들어가므로 이스케이프해 둔다.
            const safeAdminId = escapeHtml(displayAdmin);
            displayAdmin = aName ? `${escapeHtml(aName)} (${safeAdminId})` : safeAdminId;
            titleAdmin = displayAdmin;
            if (aDesc) {
                displayAdmin += `<span style="background:rgba(255, 255, 255, 0.1); color:var(--text-main); border:1px solid var(--border-color); padding:2px 6px; border-radius:4px; font-size:10px; font-weight:normal; margin-left:4px;">${escapeHtml(aDesc)}</span>`;
                titleAdmin += ` [${escapeHtml(aDesc)}]`;
            }
        }

        let displayTarget = log.target || '';
        let titleTarget = displayTarget;
        if (String(displayTarget).startsWith('-') && displayTarget.length > 15) {
            displayTarget = '(기존 피드백 데이터)';
            titleTarget = displayTarget;
        } else if (displayTarget && displayTarget !== 'ALL') {
            let tName = "";
            let tDesc = "";

            if (dynamicEmployeeData[displayTarget] && dynamicEmployeeData[displayTarget].name) {
                tName = dynamicEmployeeData[displayTarget].name;
            }

            let u = globalUsersList.find(x => x.id === displayTarget);
            if (u) {
                if (!tName && u.name) tName = u.name;
                if (u.desc) tDesc = u.desc;
            }

            // getMaskedId 는 Super Admin 에게는 원문을 그대로 돌려주고, log.target 자체도(타자대결 이름처럼)
            // 자유 텍스트가 그대로 들어올 수 있어서 여기서 이스케이프한다.
            const masked = escapeHtml(getMaskedId(log.target));
            displayTarget = tName ? `${escapeHtml(tName)} (${masked})` : masked;
            titleTarget = displayTarget;

            if (tDesc) {
                displayTarget += `<span style="background:rgba(255, 255, 255, 0.1); color:var(--text-main); border:1px solid var(--border-color); padding:2px 6px; border-radius:4px; font-size:10px; font-weight:normal; margin-left:4px;">${escapeHtml(tDesc)}</span>`;
                titleTarget += ` [${escapeHtml(tDesc)}]`;
            }
        }

        // 🔥 변경점: displayAdmin(실행자) 넓이 250px로 확장, displayTarget(대상)는 남은 공간(flex:1) 자연스럽게 채움
        listArea.innerHTML += `
            <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px dashed var(--border-color); align-items:center;">
                <div style="display:flex; gap:10px; align-items:center; width: 100%;">
                    ${checkboxHtml}
                    <span style="color:var(--text-sub); width:110px;">${formatDateFull(log.timestamp)}</span>
                    <span style="color:var(--lg-orange); width:250px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="${titleAdmin}">${displayAdmin}</span>
                    <strong style="color:${color}; width:130px;">${actionText}</strong>
                    <span style="color:var(--text-main); flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;" title="대상: ${titleTarget}">대상: ${displayTarget}</span>
                </div>
            </div>`;
    });
}

/** "더 불러오기" 버튼/상태 문구를 지금까지 불러온 개수·더 불러올 게 있는지에 맞춰 갱신한다. */
function updateAuditLoadMoreUi() {
    const btn = document.getElementById('btnLoadMoreLogs');
    const status = document.getElementById('auditLoadStatus');
    if (!btn || !status) return;

    btn.disabled = false;
    btn.innerText = '더 불러오기';

    if (auditLogsExhausted) {
        btn.style.display = 'none';
        status.innerText = `불러온 로그 ${globalAuditLogs.length}건 (전체 완료)`;
    } else {
        btn.style.display = 'inline-block';
        status.innerText = `불러온 로그 ${globalAuditLogs.length}건 — 필터는 지금까지 불러온 로그 안에서만 적용됩니다.`;
    }
}


/* ── 릴리즈 노트 · 업데이트 계획 ─────────────────────────
   작성·수정·삭제는 Super Admin 전용이고, 관리자(manager)는 열람만 한다.
   화면에서 폼과 버튼을 숨기는 것과 별개로 저장 함수마다 권한을 다시 확인한다. */

let globalReleaseNotes = [];
let globalPlans        = [];
let editingReleaseId   = null;
let editingPlanId      = null;

/** 이 화면에서 글을 쓸 수 있는 권한인지. (관리자는 열람 전용) */
const canWriteDocs = () => userRole === 'admin';

/** 열람 전용 사용자에게는 작성 폼을 감춘다. */
function applyDocsPermission() {
    if (canWriteDocs()) return;
    document.querySelectorAll('.writer-only').forEach(el => { el.style.display = 'none'; });
}

/* ── Readme ─────────────────────────────────────────────
   README.md 원문(마크다운 텍스트) 자체를 Firebase에 통째로 저장해 두고, marked.js로 파싱해
   깃허브에서 보는 것처럼 렌더링한다. 저장은 Super Admin만, 열람은 manager도 가능(canWriteDocs). */
async function loadReadmeDoc() {
    applyDocsPermission();
    const box = document.getElementById('readmeInput');
    if (box) box.value = '불러오는 중...';

    try {
        const data = await (await fetch(authDbUrl('readme_doc'))).json();
        const content = (data && data.content) || '';
        if (box) box.value = content;
        renderReadmePreview(content);

        const metaEl = document.getElementById('readmeMeta');
        if (metaEl) {
            metaEl.innerText = (data && data.updatedAt)
                ? `마지막 수정: ${formatDateFull(data.updatedAt)}${data.updatedBy ? ' · ' + escapeHtml(data.updatedBy) : ''}`
                : '아직 등록된 문서가 없습니다.';
        }
    } catch (e) {
        if (box) box.value = '';
        renderReadmePreview('');
        const metaEl = document.getElementById('readmeMeta');
        if (metaEl) metaEl.innerText = '문서를 불러오지 못했습니다.';
    }
}

/** marked 로 마크다운 원문을 HTML로 바꿔 미리보기 영역에 그대로 꽂는다.
 *  붙여넣는 즉시(oninput) 반영되므로 저장 전에도 결과를 바로 확인할 수 있다. */
function renderReadmePreview(md) {
    const preview = document.getElementById('readmePreview');
    if (!preview) return;

    const text = (md || '').trim();
    if (!text) {
        preview.innerHTML = '<div class="empty-state">아직 등록된 문서가 없습니다. 위 칸에 README.md 내용을 붙여넣어 주세요.</div>';
        return;
    }
    try {
        preview.innerHTML = (typeof marked !== 'undefined')
            ? marked.parse(text)
            : '<div class="empty-state">마크다운 렌더러를 불러오지 못했습니다.</div>';
    } catch (e) {
        preview.innerHTML = '<div class="empty-state">마크다운을 표시하는 중 오류가 발생했습니다.</div>';
    }
}

async function saveReadmeDoc() {
    if (!isSuperAdmin()) return;

    const box = document.getElementById('readmeInput');
    const content = box ? box.value : '';
    if (!content.trim()) { alert('저장할 마크다운 내용을 붙여넣어 주세요.'); return; }

    try {
        await fetch(authDbUrl('readme_doc'), {
            method: 'PUT',
            body: JSON.stringify({ content, updatedAt: Date.now(), updatedBy: loggedInUser || '-' }),
            headers: { 'Content-Type': 'application/json' }
        });
        await logAudit('UPDATE_README', 'README.md');
        toast('Readme를 저장했습니다.', 'success');
        loadReadmeDoc();
    } catch (e) {
        alert('저장 중 오류가 발생했습니다.');
    }
}

/** '4.17' > '4.9' 처럼 자리별로 비교해 최신 버전이 위로 오게 한다. */
function compareVersionDesc(a, b) {
    const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0);
    const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const diff = (pb[i] || 0) - (pa[i] || 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

/* ── 릴리즈 노트 ─────────────────────────────────────── */
async function loadReleaseNotes() {
    applyDocsPermission();
    const listArea = document.getElementById('releaseList');
    listArea.innerHTML = '<div class="empty-state">불러오는 중...</div>';
    try {
        const data = await (await fetch(authDbUrl('release_notes'))).json();
        globalReleaseNotes = data
            ? Object.entries(data).map(([id, v]) => ({ id, ...v })).sort((a, b) => compareVersionDesc(a.version, b.version))
            : [];
        renderReleaseNotes();
    } catch (e) {
        listArea.innerHTML = '<div class="empty-state">릴리즈 노트를 불러오지 못했습니다.</div>';
    }
}

function renderReleaseNotes() {
    const listArea = document.getElementById('releaseList');
    const query = (document.getElementById('relSearchInput')?.value || '').trim().toLowerCase();

    const rows = query
        ? globalReleaseNotes.filter(n => (n.version + ' ' + (n.body || '')).toLowerCase().includes(query))
        : globalReleaseNotes;

    document.getElementById('relCount').innerText = globalReleaseNotes.length;

    if (rows.length === 0) {
        listArea.innerHTML = '<div class="empty-state">등록된 릴리즈 노트가 없습니다.</div>';
        return;
    }

    listArea.innerHTML = rows.map(n => {
        const actions = canWriteDocs() ? `
            <span class="spacer">
                <button class="admin-action-btn reset" onclick="editReleaseNote('${n.id}')">수정</button>
                <button class="admin-action-btn del" onclick="deleteReleaseNote('${n.id}')">삭제</button>
            </span>` : '';
        return `<div class="doc-row">
            <div class="doc-head">
                <span class="ver">v${escapeHtml(n.version)}</span>
                <span class="when">${n.date ? escapeHtml(n.date) + ' 배포' : '배포일 미정'}</span>
                ${actions}
            </div>
            <div class="doc-body">${escapeHtml(n.body || '')}</div>
            <div class="doc-foot">${escapeHtml(n.author || '-')} · ${n.updatedAt ? formatDateFull(n.updatedAt) : ''}</div>
        </div>`;
    }).join('');
}

async function saveReleaseNote() {
    if (!isSuperAdmin()) return;

    const version = document.getElementById('relVersion').value.trim();
    const date    = document.getElementById('relDate').value;
    const body    = document.getElementById('relBody').value.trim();

    if (!version) return alert("버전을 입력해주세요. (예: 4.17)");
    if (!body)    return alert("업데이트 내용을 입력해주세요.");

    // 같은 버전이 이미 있으면 새로 만들지 않고 그 항목을 수정한다.
    const existing = globalReleaseNotes.find(n => n.version === version && n.id !== editingReleaseId);
    const id = editingReleaseId || existing?.id || generatePushID();
    const isEdit = Boolean(editingReleaseId || existing);

    if (existing && !editingReleaseId
        && !confirm(`이미 v${version} 노트가 있습니다. 기존 내용을 덮어쓸까요?`)) return;

    try {
        const prev = globalReleaseNotes.find(n => n.id === id);
        await fetch(authDbUrl(`release_notes/${id}`), {
            method: 'PUT',
            body: JSON.stringify({
                version, date, body,
                author: loggedInUser,
                createdAt: prev?.createdAt || Date.now(),
                updatedAt: Date.now()
            }),
            headers: { 'Content-Type': 'application/json' }
        });
        await logAudit(isEdit ? 'EDIT_RELEASE_NOTE' : 'ADD_RELEASE_NOTE', `v${version}`);

        cancelReleaseEdit();
        loadReleaseNotes();
        toast(`v${version} 릴리즈 노트를 저장했습니다.`, 'success');
    } catch (e) {
        alert("저장 중 오류가 발생했습니다.");
    }
}

function editReleaseNote(id) {
    if (!isSuperAdmin()) return;
    const n = globalReleaseNotes.find(x => x.id === id);
    if (!n) return;

    editingReleaseId = id;
    document.getElementById('relVersion').value = n.version || '';
    document.getElementById('relDate').value    = n.date || '';
    document.getElementById('relBody').value    = n.body || '';
    document.getElementById('relCancelBtn').style.display = 'inline-flex';
    document.getElementById('releaseForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function cancelReleaseEdit() {
    editingReleaseId = null;
    document.getElementById('relVersion').value = '';
    document.getElementById('relDate').value    = '';
    document.getElementById('relBody').value    = '';
    document.getElementById('relCancelBtn').style.display = 'none';
}

async function deleteReleaseNote(id) {
    if (!isSuperAdmin()) return;
    const n = globalReleaseNotes.find(x => x.id === id);
    if (!n) return;
    if (!confirm(`v${n.version} 릴리즈 노트를 삭제하시겠습니까?\n되돌릴 수 없습니다.`)) return;

    try {
        await fetch(authDbUrl(`release_notes/${id}`), { method: 'DELETE' });
        await logAudit('DELETE_RELEASE_NOTE', `v${n.version}`);
        if (editingReleaseId === id) cancelReleaseEdit();
        loadReleaseNotes();
    } catch (e) {
        alert("삭제 중 오류가 발생했습니다.");
    }
}

/* ── 업데이트 계획 ───────────────────────────────────── */
const PLAN_STATUS = {
    planned: { label: '예정',   tag: 'tag-gray',   order: 1 },
    doing:   { label: '진행중', tag: 'tag-blue',   order: 0 },
    done:    { label: '완료',   tag: 'tag-green',  order: 3 },
    hold:    { label: '보류',   tag: 'tag-orange', order: 2 },
};

async function loadPlans() {
    applyDocsPermission();
    const listArea = document.getElementById('planList');
    listArea.innerHTML = '<div class="empty-state">불러오는 중...</div>';
    try {
        const data = await (await fetch(authDbUrl('update_plans'))).json();
        globalPlans = data ? Object.entries(data).map(([id, v]) => ({ id, ...v })) : [];

        // 진행중 → 예정 → 보류 → 완료 순, 같은 상태 안에서는 최근에 적은 것부터
        globalPlans.sort((a, b) =>
            ((PLAN_STATUS[a.status]?.order ?? 9) - (PLAN_STATUS[b.status]?.order ?? 9))
            || ((b.updatedAt || 0) - (a.updatedAt || 0)));
        renderPlans();
    } catch (e) {
        listArea.innerHTML = '<div class="empty-state">업데이트 계획을 불러오지 못했습니다.</div>';
    }
}

function renderPlans() {
    const listArea = document.getElementById('planList');
    const filter = document.getElementById('planFilter').value;
    const rows = filter === 'ALL' ? globalPlans : globalPlans.filter(p => p.status === filter);

    document.getElementById('planCount').innerText = globalPlans.length;

    if (rows.length === 0) {
        listArea.innerHTML = '<div class="empty-state">해당하는 계획이 없습니다.</div>';
        return;
    }

    listArea.innerHTML = rows.map(p => {
        const st = PLAN_STATUS[p.status] || PLAN_STATUS.planned;
        const target = p.target ? `<span class="when">목표 v${escapeHtml(p.target)}</span>` : '';
        const actions = canWriteDocs() ? `
            <span class="spacer">
                ${p.status !== 'done' ? `<button class="admin-action-btn" onclick="setPlanStatus('${p.id}', 'done')">완료 처리</button>` : ''}
                <button class="admin-action-btn reset" onclick="editPlan('${p.id}')">수정</button>
                <button class="admin-action-btn del" onclick="deletePlan('${p.id}')">삭제</button>
            </span>` : '';
        return `<div class="doc-row">
            <div class="doc-head">
                <span class="tag ${st.tag}">${st.label}</span>
                <b>${escapeHtml(p.title)}</b>
                ${target}
                ${actions}
            </div>
            ${p.body ? `<div class="doc-body">${escapeHtml(p.body)}</div>` : ''}
            <div class="doc-foot">${escapeHtml(p.author || '-')} · ${p.updatedAt ? formatDateFull(p.updatedAt) : ''}</div>
        </div>`;
    }).join('');
}

async function savePlan() {
    if (!isSuperAdmin()) return;

    const title  = document.getElementById('planTitle').value.trim();
    const status = document.getElementById('planStatus').value;
    const target = document.getElementById('planTarget').value.trim();
    const body   = document.getElementById('planBody').value.trim();

    if (!title) return alert("계획 제목을 입력해주세요.");

    const id = editingPlanId || generatePushID();
    try {
        const prev = globalPlans.find(p => p.id === id);
        await fetch(authDbUrl(`update_plans/${id}`), {
            method: 'PUT',
            body: JSON.stringify({
                title, status, target, body,
                author: loggedInUser,
                createdAt: prev?.createdAt || Date.now(),
                updatedAt: Date.now()
            }),
            headers: { 'Content-Type': 'application/json' }
        });
        await logAudit(editingPlanId ? 'EDIT_PLAN' : 'ADD_PLAN', title.substring(0, 30));

        cancelPlanEdit();
        loadPlans();
        toast("업데이트 계획을 저장했습니다.", 'success');
    } catch (e) {
        alert("저장 중 오류가 발생했습니다.");
    }
}

function editPlan(id) {
    if (!isSuperAdmin()) return;
    const p = globalPlans.find(x => x.id === id);
    if (!p) return;

    editingPlanId = id;
    document.getElementById('planTitle').value  = p.title || '';
    document.getElementById('planStatus').value = p.status || 'planned';
    document.getElementById('planTarget').value = p.target || '';
    document.getElementById('planBody').value   = p.body || '';
    document.getElementById('planCancelBtn').style.display = 'inline-flex';
    document.getElementById('planForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function cancelPlanEdit() {
    editingPlanId = null;
    document.getElementById('planTitle').value  = '';
    document.getElementById('planStatus').value = 'planned';
    document.getElementById('planTarget').value = '';
    document.getElementById('planBody').value   = '';
    document.getElementById('planCancelBtn').style.display = 'none';
}

/** 목록에서 바로 상태만 바꾼다(폼을 거치지 않는 지름길). */
async function setPlanStatus(id, status) {
    if (!isSuperAdmin()) return;
    const p = globalPlans.find(x => x.id === id);
    if (!p) return;

    try {
        await fetch(authDbUrl(`update_plans/${id}`), {
            method: 'PATCH',
            body: JSON.stringify({ status, updatedAt: Date.now() }),
            headers: { 'Content-Type': 'application/json' }
        });
        await logAudit('EDIT_PLAN', `${p.title.substring(0, 30)} → ${PLAN_STATUS[status]?.label || status}`);
        loadPlans();
    } catch (e) {
        alert("상태 변경 중 오류가 발생했습니다.");
    }
}

async function deletePlan(id) {
    if (!isSuperAdmin()) return;
    const p = globalPlans.find(x => x.id === id);
    if (!p) return;
    if (!confirm(`[${p.title}] 계획을 삭제하시겠습니까?`)) return;

    try {
        await fetch(authDbUrl(`update_plans/${id}`), { method: 'DELETE' });
        await logAudit('DELETE_PLAN', p.title.substring(0, 30));
        if (editingPlanId === id) cancelPlanEdit();
        loadPlans();
    } catch (e) {
        alert("삭제 중 오류가 발생했습니다.");
    }
}

/* ── 선택 삭제 ─────────────────────────────────────────── */

/** 타자대결 순위 — 체크한 기록만 지운다. */
async function deleteSelectedScores() {
    if (!isManagerOrAbove()) return;
    const ids = selectedValues('score-checkbox');
    if (!confirmBulkDelete(ids, '순위 기록')) return;

    try {
        await Promise.all(ids.map(id => fetch(authDbUrl(`typing/scores/${id}`), { method: 'DELETE' })));
        await logAudit('DELETE_TYPING_SCORE', `선택 ${ids.length}건`);
        loadTypingScores();
        toast(`순위 기록 ${ids.length}건을 삭제했습니다.`, 'success');
    } catch (e) {
        alert("삭제 중 오류가 발생했습니다.");
    }
}

/** 사원 명단 — 체크한 사원만 지운다. 명단 전체를 한 번에 저장한다. */
async function deleteSelectedEmps() {
    if (!requirePerm('employees')) return;
    const ids = selectedValues('emp-checkbox');
    if (!confirmBulkDelete(ids, '사원 정보')) return;

    try {
        ids.forEach(id => { delete dynamicEmployeeData[id]; });
        await updateEmpDB();
        await Promise.all(ids.map(id => logAudit('DELETE_EMPLOYEE', id)));
        renderAdminEmpList();
        toast(`사원 ${ids.length}명을 명단에서 삭제했습니다.`, 'success');
    } catch (e) {
        alert("삭제 중 오류가 발생했습니다.");
    }
}

/** 계정 — 체크한 계정만 지운다(user_roles 항목 삭제). 마스터 계정은 체크박스가 없어 대상이 될 수 없다. */
async function deleteSelectedUsers() {
    if (!isSuperAdmin()) return;
    const uids = selectedValues('user-checkbox'); // 체크박스 값은 uid
    if (!confirmBulkDelete(uids, '계정')) return;

    try {
        // 만약의 경우에도 Super Admin 계정은 남긴다.
        const removable = uids.filter(uid => globalUsersList.find(u => u.uid === uid)?.role !== 'admin');
        await Promise.all(removable.map(uid => fetch(authDbUrl(`user_roles/${uid}`), { method: 'DELETE' })));
        await Promise.all(removable.map(uid => {
            const id = globalUsersList.find(u => u.uid === uid)?.id || uid;
            return logAudit('DELETE_ACCOUNT', id);
        }));
        renderAdminUserList();
        toast(`계정 ${removable.length}건을 삭제했습니다.`, 'success');
    } catch (e) {
        alert("삭제 중 오류가 발생했습니다.");
    }
}

/** 특정 계정에 개별 권한을 켜고 끈다. (Super Admin 전용) */
async function setUserPerm(uid, key, on) {
    if (!isSuperAdmin()) return;

    const u = globalUsersList.find(x => x.uid === uid);
    if (!u) return renderAdminUserList();
    const id = u.id;

    try {
        // 꺼진 권한은 아예 지워 데이터를 깔끔하게 둔다(null로 PATCH하면 그 키가 삭제된다).
        await fetch(authDbUrl(`user_roles/${uid}/perms/${key}`), {
            method: 'PUT',
            body: JSON.stringify(on ? true : null),
            headers: { 'Content-Type': 'application/json' }
        });
        await logAudit('EDIT_ACCOUNT_PERM', `${id} / ${key} ${on ? '부여' : '해제'}`);
        toast(`[${id}] 사원 명단 권한을 ${on ? '부여' : '해제'}했습니다.`, 'success');
        renderAdminUserList();
    } catch (e) {
        alert("권한 변경 중 오류가 발생했습니다.");
        renderAdminUserList();
    }
}

/* ── 사용자 차단 ─────────────────────────────────────────
   blocked/{사번} → { reason, by, at }
   앱은 시작할 때 이 노드를 확인해 차단이면 안내 후 종료한다.
   (통신 실패는 차단으로 보지 않으므로, 서버 장애로 전원이 막히지는 않는다) */

let globalBlocks = [];

async function loadBlocks() {
    const listArea = document.getElementById('blockList');
    listArea.innerHTML = '<div class="empty-state">불러오는 중...</div>';
    try {
        const data = await (await fetch(authDbUrl('blocked'))).json();
        globalBlocks = data
            ? Object.entries(data).map(([empId, v]) => ({
                empId,
                // true 한 개만 저장된 경우도 차단으로 인정한다(앱과 같은 규칙).
                reason: (v && typeof v === 'object') ? (v.reason || '') : '',
                by:     (v && typeof v === 'object') ? (v.by || '') : '',
                at:     (v && typeof v === 'object') ? (v.at || 0) : 0
              })).sort((a, b) => b.at - a.at)
            : [];
        renderBlocks();
    } catch (e) {
        listArea.innerHTML = '<div class="empty-state">차단 목록을 불러오지 못했습니다.</div>';
    }
}

function renderBlocks() {
    const listArea = document.getElementById('blockList');
    document.getElementById('blockCount').innerText = globalBlocks.length;
    resetSelectAll('selectAllBlocks');

    if (globalBlocks.length === 0) {
        listArea.innerHTML = '<div class="empty-state">차단된 사용자가 없습니다.</div>';
        return;
    }

    listArea.innerHTML = globalBlocks.map(b => {
        const emp = dynamicEmployeeData[b.empId];
        const displayEmpId = getMaskedId(b.empId);
        const who = emp ? `${escapeHtml(emp.name)} (${displayEmpId})` : `미등록 사용자 (${displayEmpId})`;
        return `<div class="score-row">
            ${rowCheckbox('block-checkbox', b.empId)}
            <span class="who">${who}</span>
            <span class="meta">${b.reason ? escapeHtml(b.reason) : '사유 없음'}
                ${b.by ? ' · ' + escapeHtml(b.by) : ''}${b.at ? ' · ' + formatDateFull(b.at) : ''}</span>
            <button class="admin-action-btn" onclick="removeBlock('${b.empId}')">차단 해제</button>
        </div>`;
    }).join('');
}

async function addBlock() {
    if (!requirePerm('blocked')) return;

    const empId  = document.getElementById('blockIdInput').value.trim();
    const reason = document.getElementById('blockReasonInput').value.trim();

    if (!/^\d{5,6}$/.test(empId)) return alert("사원번호는 숫자 5~6자리로 입력해주세요.");
    if (globalBlocks.some(b => b.empId === empId)) return alert("이미 차단된 사원번호입니다.");

    const emp = dynamicEmployeeData[empId];
    const who = emp ? `${emp.name} (${empId})` : empId;
    if (!confirm(`[${who}] 사용자의 앱 사용을 차단하시겠습니까?\n다음 실행부터 앱이 실행되지 않습니다.`)) return;

    try {
        await fetch(authDbUrl(`blocked/${empId}`), {
            method: 'PUT',
            body: JSON.stringify({ reason, by: loggedInUser, at: Date.now() }),
            headers: { 'Content-Type': 'application/json' }
        });
        await logAudit('BLOCK_USER', empId);

        document.getElementById('blockIdInput').value = '';
        document.getElementById('blockReasonInput').value = '';
        loadBlocks();
        toast(`[${who}] 사용자를 차단했습니다.`, 'success');
    } catch (e) {
        alert("차단 처리 중 오류가 발생했습니다.");
    }
}

async function removeBlock(empId) {
    if (!requirePerm('blocked')) return;
    if (!confirm(`[${empId}] 사용자의 차단을 해제하시겠습니까?`)) return;

    try {
        await fetch(authDbUrl(`blocked/${empId}`), { method: 'DELETE' });
        await logAudit('UNBLOCK_USER', empId);
        loadBlocks();
        toast(`[${empId}] 차단을 해제했습니다.`, 'success');
    } catch (e) {
        alert("차단 해제 중 오류가 발생했습니다.");
    }
}

async function deleteSelectedBlocks() {
    if (!requirePerm('blocked')) return;
    const ids = selectedValues('block-checkbox');
    if (!confirmBulkDelete(ids, '차단')) return;

    try {
        await Promise.all(ids.map(id => fetch(authDbUrl(`blocked/${id}`), { method: 'DELETE' })));
        await Promise.all(ids.map(id => logAudit('UNBLOCK_USER', id)));
        loadBlocks();
        toast(`${ids.length}명의 차단을 해제했습니다.`, 'success');
    } catch (e) {
        alert("차단 해제 중 오류가 발생했습니다.");
    }
}

/* ── 모델별 사용 현황 ─────────────────────────────────────
   model_usage/{모델키} = { model, features: { 기능키: { count, lastVisitedAt, daily } },
                             users: { 사번키: { empId, features: { 기능키: { count, lastVisitedAt, daily } } } } }
   진단 앱(exe)이 usage와는 별개로 메인보드 모델 기준으로 남기는 집계다.
   기간 필터는 daily(날짜별 증가치)를 그때그때 더해서 계산한다 — count는 전체 기간 합계라 필터링에 못 쓴다. */
let globalModelUsageRaw = null; // Firebase 원본(기간 안 걸러진 상태) — 기간만 바뀌면 다시 안 불러오게 캐시
let globalModelUsage = [];      // 지금 선택된 기간으로 계산된 결과(화면에 실제로 쓰는 것)

function handleModelDatePreset() {
    const preset = document.getElementById('modelDatePreset').value;
    document.getElementById('modelCustomDateRange').style.display = preset === 'custom' ? 'flex' : 'none';
    applyModelDateFilter();
}

/** dashboard.js의 기간 필터와 같은 프리셋이지만, 이 섹션 전용 input을 읽는다. */
function getModelFilterDateRange() {
    const preset = document.getElementById('modelDatePreset').value;
    let start = '2000-01-01', end = '2100-12-31';
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const todayStr = `${yyyy}-${mm}-${dd}`;

    if (preset === 'today') {
        start = todayStr; end = todayStr;
    } else if (preset === 'last7') {
        const lastWeek = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
        start = `${lastWeek.getFullYear()}-${String(lastWeek.getMonth() + 1).padStart(2, '0')}-${String(lastWeek.getDate()).padStart(2, '0')}`;
        end = todayStr;
    } else if (preset === 'thisMonth') {
        start = `${yyyy}-${mm}-01`; end = todayStr;
    } else if (preset === 'custom') {
        start = document.getElementById('modelStartDate').value || '2000-01-01';
        end = document.getElementById('modelEndDate').value || '2100-12-31';
    }
    return { start, end };
}

function sumDailyInRange(daily, start, end) {
    if (!daily) return 0;
    return Object.entries(daily).reduce((sum, [date, count]) => (date >= start && date <= end ? sum + (count || 0) : sum), 0);
}

let globalUsageRaw = null; // usage 노드 원본(사번별 실행 횟수/날짜별 실행 횟수) — 모델별 "실행 횟수" 추정에 쓴다.

async function loadModelUsage() {
    const listArea = document.getElementById('modelUsageList');
    listArea.innerHTML = '<div class="empty-state">불러오는 중...</div>';
    try {
        const [modelData, usageData] = await Promise.all([
            fetch(authDbUrl('model_usage')).then(r => r.json()),
            fetch(authDbUrl('usage')).then(r => r.json())
        ]);
        globalModelUsageRaw = modelData;
        globalUsageRaw = usageData;
        applyModelDateFilter();
    } catch (e) {
        listArea.innerHTML = '<div class="empty-state">불러오지 못했습니다.</div>';
    }
}

/**
 * 그 사원이 이 모델의 어떤 기능이든 쓴 "날짜"들을 모아(기간 필터 적용), 그 날짜의 usage/{사번}/daily
 * (그날 실행 횟수)를 한 번씩만 더한다 — 같은 날 이 모델의 기능을 여러 번/여러 개 눌렀어도 중복으로 안 더해진다.
 * 한계: 같은 날 이 사원이 다른 모델도 만졌다면, 그 날의 실행 횟수가 두 모델에 각각 잡혀 합계가 부풀 수 있다.
 */
function estimateUserRunsOnModel(userRaw, start, end) {
    const dates = new Set();
    for (const f of Object.values(userRaw.features || {})) {
        for (const [date, count] of Object.entries(f.daily || {})) {
            if (date >= start && date <= end && (count || 0) > 0) dates.add(date);
        }
    }
    const empUsage = globalUsageRaw && globalUsageRaw[userRaw.empId];
    let runs = 0;
    for (const date of dates) runs += (empUsage && empUsage.daily && empUsage.daily[date]) || 0;
    return runs;
}

/** 이미 불러온 원본(globalModelUsageRaw)에 지금 고른 기간만 다시 적용한다 — 네트워크 재요청 없음. */
function applyModelDateFilter() {
    const { start, end } = getModelFilterDateRange();
    const data = globalModelUsageRaw;

    globalModelUsage = data
        ? Object.entries(data).map(([modelKey, m]) => {
            const features = Object.entries(m.features || {})
                .map(([key, f]) => ({ key, count: sumDailyInRange(f.daily, start, end) }))
                .filter(f => f.count > 0)
                .sort((a, b) => b.count - a.count);
            const total = features.reduce((sum, f) => sum + f.count, 0);

            const users = Object.entries(m.users || {})
                .map(([empIdKey, u]) => {
                    const uFeatures = Object.entries(u.features || {})
                        .map(([key, f]) => ({ key, count: sumDailyInRange(f.daily, start, end) }))
                        .filter(f => f.count > 0)
                        .sort((a, b) => b.count - a.count);
                    const uTotal = uFeatures.reduce((sum, f) => sum + f.count, 0);
                    const uRuns = estimateUserRunsOnModel({ empId: u.empId || empIdKey, features: u.features }, start, end);
                    return { empId: u.empId || empIdKey, features: uFeatures, total: uTotal, runs: uRuns };
                })
                .filter(u => u.total > 0)
                .sort((a, b) => b.total - a.total);

            const runs = users.reduce((sum, u) => sum + u.runs, 0);

            // "최근 실행" 정렬용 — 기간 필터와 무관하게 이 모델이 마지막으로 쓰인 시각(전체 기간 기준).
            const lastVisitedAt = Object.values(m.features || {})
                .reduce((max, f) => Math.max(max, f.lastVisitedAt || 0), 0);

            return { modelKey, model: m.model || '(알 수 없음)', features, total, runs, users, lastVisitedAt };
          }).filter(m => m.total > 0)
        : [];

    renderModelUsage();
}

/* ── 모델별 사용현황 정렬 (실행순 · 최근 실행순 · 이름순) ─────────────── */
let modelSortKey = 'runs';   // 'runs' | 'recent' | 'name'
let modelSortAsc = false;    // 이름순은 기본 오름차순(가나다), 그 외엔 기본 내림차순이 자연스럽다.

/** 같은 버튼을 다시 누르면 방향을 뒤집고, 다른 버튼을 누르면 그 기준의 기본 방향으로 시작한다. */
function setModelSort(key) {
    if (modelSortKey === key) {
        modelSortAsc = !modelSortAsc;
    } else {
        modelSortKey = key;
        modelSortAsc = key === 'name';
    }
    renderModelUsage();
}

function sortModelRows(rows) {
    const dir = modelSortAsc ? 1 : -1;
    const sorted = rows.slice();
    if (modelSortKey === 'name') {
        sorted.sort((a, b) => dir * a.model.localeCompare(b.model, undefined, { numeric: true }));
    } else if (modelSortKey === 'recent') {
        sorted.sort((a, b) => dir * (a.lastVisitedAt - b.lastVisitedAt));
    } else {
        sorted.sort((a, b) => dir * (a.runs - b.runs));
    }
    return sorted;
}

/** 정렬 버튼들의 활성 표시(색상·화살표)를 지금 상태에 맞게 갱신한다. */
function updateModelSortButtons() {
    const map = { runs: 'sortBtn_runs', recent: 'sortBtn_recent', name: 'sortBtn_name' };
    const labels = { runs: '실행순', recent: '최근 실행순', name: '이름순' };
    for (const [key, id] of Object.entries(map)) {
        const btn = document.getElementById(id);
        if (!btn) continue;
        const isActive = modelSortKey === key;
        btn.classList.toggle('active', isActive);
        btn.textContent = isActive ? `${labels[key]} ${modelSortAsc ? '▲' : '▼'}` : labels[key];
    }
}

function renderModelUsage() {
    const listArea = document.getElementById('modelUsageList');

    // 삭제(체크박스·선택 삭제)는 Super Admin 전용 — 관리자(manager)는 조회만 가능.
    const bulkControls = document.getElementById('modelBulkControls');
    if (bulkControls) bulkControls.style.display = isSuperAdmin(true) ? 'inline-flex' : 'none';

    updateModelSortButtons();

    if (globalModelUsage.length === 0) {
        listArea.innerHTML = '<div class="empty-state">선택한 기간에 집계된 기록이 없습니다.</div>';
        return;
    }

    const query = (document.getElementById('modelSearchInput')?.value || '').trim().toLowerCase();
    const filtered = query ? globalModelUsage.filter(m => m.model.toLowerCase().includes(query)) : globalModelUsage;

    if (filtered.length === 0) {
        listArea.innerHTML = '<div class="empty-state">검색 결과가 없습니다.</div>';
        return;
    }

    const rows = sortModelRows(filtered);

    resetSelectAll('selectAllModels');
    listArea.innerHTML = rows.map(m => {
        const featureText = m.features.length
            ? m.features.map(f => `${featureNames[f.key] || f.key} ${f.count}회`).join(' · ')
            : '기록 없음';
        const pick = isSuperAdmin(true) ? rowCheckbox('model-checkbox', m.modelKey) : '';
        const lastVisitedText = m.lastVisitedAt ? formatDateFull(m.lastVisitedAt) : '-';
        return `<div class="score-row" style="flex-wrap:wrap; cursor:pointer;" onclick="openModelChartModal('${escapeJsAttr(m.modelKey)}')">
            ${pick}
            <span class="who"><b>${escapeHtml(m.model)}</b> <span style="color:var(--text-sub); font-size:11px;" title="실행 횟수는 사번·날짜 매칭 기반 추정치입니다(같은 날 여러 모델을 만졌으면 소폭 부정확할 수 있음).">실행 ${m.runs}회 · 기능 사용 ${m.total}회 · 사용자 ${m.users.length}명</span> <span class="model-lastrun" style="color:var(--text-sub); font-size:11px;">최근 실행 ${lastVisitedText}</span></span>
            <span class="meta" style="flex-basis:100%;">${escapeHtml(featureText)}</span>
        </div>`;
    }).join('');
}

/** 선택한 모델의 집계 기록을 통째로(전체 기간) 삭제한다(Super Admin 전용). */
async function deleteSelectedModels() {
    if (!isSuperAdmin()) return;
    const modelKeys = selectedValues('model-checkbox');
    if (!confirmBulkDelete(modelKeys, '모델별 사용 기록')) return;

    try {
        await Promise.all(modelKeys.map(key => fetch(authDbUrl(`model_usage/${key}`), { method: 'DELETE' })));
        await Promise.all(modelKeys.map(key => {
            const m = globalModelUsage.find(x => x.modelKey === key);
            return logAudit('DELETE_MODEL_USAGE', m ? m.model : key);
        }));
        loadModelUsage();
        toast(`모델 ${modelKeys.length}건의 사용 기록을 삭제했습니다.`, 'success');
    } catch (e) {
        alert("삭제 중 오류가 발생했습니다.");
    }
}

/**
 * RAW DATA 삭제는 model_usage 쪽 그 사람 몫도 같이 정리하지만, 그 기능이 생기기 전에
 * 이미 지워졌던 사람들은 model_usage에 흔적("고아 데이터")이 그대로 남아있다.
 * usage/{empId}가 실제로는 없는데 model_usage에만 남아있는 사람을 찾아 한 번에 정리한다.
 */
async function cleanOrphanModelUsage() {
    if (!isSuperAdmin()) return;
    if (!confirm('RAW DATA가 이미 삭제된 사람의 흔적이 모델별 사용현황에 남아있는지 찾아서 정리합니다.\n계속하시겠습니까?')) return;

    try {
        const [usageData, modelData] = await Promise.all([
            fetch(authDbUrl('usage')).then(r => r.json()),
            fetch(authDbUrl('model_usage')).then(r => r.json())
        ]);
        const existingEmpIds = new Set(Object.keys(usageData || {}));

        const updatesByModel = {}; // modelKey -> { 상대경로: 새 값(null이면 삭제) }
        let orphanCount = 0;

        for (const [modelKey, m] of Object.entries(modelData || {})) {
            for (const [userKey, u] of Object.entries(m.users || {})) {
                const empId = u.empId || userKey; // 사번에 못 쓰는 문자가 있었다면 키와 empId가 다를 수 있다.
                if (existingEmpIds.has(empId)) continue; // 아직 RAW DATA가 살아있는 사람 — 건드리지 않음

                orphanCount++;
                const updates = updatesByModel[modelKey] || (updatesByModel[modelKey] = {});
                updates[`users/${userKey}`] = null;

                for (const [fKey, f] of Object.entries(u.features || {})) {
                    for (const [date, count] of Object.entries(f.daily || {})) {
                        if (!count) continue;
                        const path = `features/${fKey}/daily/${date}`;
                        // 같은 모델·기능·날짜를 쓴 다른 고아가 먼저 처리됐다면 그 값을 이어받아 누적으로 뺀다.
                        const cur = updates[path] !== undefined
                            ? (updates[path] || 0)
                            : ((m.features && m.features[fKey] && m.features[fKey].daily && m.features[fKey].daily[date]) || 0);
                        const next = Math.max(0, cur - count);
                        updates[path] = next > 0 ? next : null;
                    }
                }
            }
        }

        if (orphanCount === 0) {
            toast('정리할 고아 데이터가 없습니다.', 'success');
            return;
        }

        const modelKeys = Object.keys(updatesByModel);
        await Promise.all(modelKeys.map(modelKey =>
            fetch(authDbUrl(`model_usage/${modelKey}`), {
                method: 'PATCH',
                body: JSON.stringify(updatesByModel[modelKey]),
                headers: { 'Content-Type': 'application/json' }
            })
        ));

        await logAudit('CLEAN_ORPHAN_MODEL_USAGE', `${orphanCount}건`);
        loadModelUsage();
        toast(`고아 데이터 ${orphanCount}건을 정리했습니다.`, 'success');
    } catch (e) {
        alert('정리 중 오류가 발생했습니다.');
        console.error(e);
    }
}

/** 모델 하나를 클릭하면, 메인 대시보드의 "세부 기능별 비중"과 같은 스타일로 그 모델의 기능 비중을 보여준다. */
function openModelChartModal(modelKey) {
    const m = globalModelUsage.find(x => x.modelKey === modelKey);
    if (!m) return;

    document.getElementById('modelChartTitle').innerText = `${m.model} — 세부 기능 비중`;
    document.getElementById('modelChartModal').style.display = 'block';
    renderModelChartUsers(m);

    if (chartInstances['modelFeatureChart']) { chartInstances['modelFeatureChart'].destroy(); delete chartInstances['modelFeatureChart']; }
    if (m.features.length === 0) return;

    // 세분화된 featureKey가 늘면서(PC 상세정보 세부·PC 점검 12항목 등) HTML에 박아둔 고정
    // 360px로는 다 안 들어갈 수 있어, 대시보드 메인 차트와 같은 방식으로 항목 수에 맞춰 늘린다.
    const modelChartBox = document.querySelector('#modelChartModal .chart-container');
    if (modelChartBox) modelChartBox.style.height = Math.max(220, m.features.length * 27) + 'px';

    const gridColor = isLightMode ? 'rgba(0,0,0,.1)' : 'rgba(255,255,255,.1)';
    createChart('modelFeatureChart', {
        type: 'bar',
        data: {
            labels: m.features.map(f => featureNames[f.key] || f.key),
            // palette는 6색뿐이라 featureKey 종류가 늘어난 만큼 인덱스로 순환시킨다(dashboard.js와 동일).
            datasets: [{ data: m.features.map(f => f.count), backgroundColor: m.features.map((_, i) => palette[i % palette.length]), borderRadius: 4 }]
        },
        options: {
            indexAxis: 'y',
            responsive: true,
            maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { x: { beginAtZero: true, grid: { color: gridColor } }, y: { grid: { display: false }, ticks: { autoSkip: false } } },
            onHover: (event, chartElement) => {
                event.native.target.style.cursor = chartElement[0] ? 'pointer' : 'default';
            },
            onClick: (event, elements) => {
                if (elements.length > 0) openModelFeatureUsersModal(modelKey, m.features[elements[0].index].key);
            }
        }
    });
}

/** 그래프 밑에 이 모델 전체(기능 구분 없이)를 쓴 사용자 목록을 보여준다. 실행 많은 순으로 정렬. */
function renderModelChartUsers(m) {
    const content = document.getElementById('modelChartUsersContent');
    if (!content) return;

    const users = (m.users || []).slice().sort((a, b) => b.runs - a.runs);
    content.innerHTML = users.length === 0
        ? '<div class="empty-state">사용자 기록이 없습니다.</div>'
        : users.map(u => {
            const emp = dynamicEmployeeData[u.empId];
            const displayEmpId = getMaskedId(u.empId);
            const who = emp
                ? `${escapeHtml(emp.name)} (${displayEmpId})${emp.center ? ` · ${escapeHtml(emp.center)}` : ''}`
                : `미등록 사용자 (${displayEmpId})`;
            return `<div class="score-row" style="flex-wrap:nowrap;">
                <span class="who" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${who}</span>
                <span class="meta" style="flex:0 0 auto;">실행 ${u.runs}회 · 기능 사용 ${u.total}회</span>
            </div>`;
          }).join('');
}

/** 그래프의 막대(기능 하나)를 클릭하면, 그 모델에서 그 기능을 쓴 사용자 목록을 보여준다. */
function openModelFeatureUsersModal(modelKey, featureKey) {
    const m = globalModelUsage.find(x => x.modelKey === modelKey);
    if (!m) return;
    const fName = featureNames[featureKey] || featureKey;

    document.getElementById('modelFeatureUsersTitle').innerText = `${m.model} — ${fName} 사용자`;

    const users = m.users
        .map(u => ({ empId: u.empId, count: (u.features.find(f => f.key === featureKey) || {}).count || 0 }))
        .filter(u => u.count > 0)
        .sort((a, b) => b.count - a.count);

    const content = document.getElementById('modelFeatureUsersContent');
    content.innerHTML = users.length === 0
        ? '<div class="empty-state">사용자 기록이 없습니다.</div>'
        : users.map(u => {
            const emp = dynamicEmployeeData[u.empId];
            const displayEmpId = getMaskedId(u.empId);
            const who = emp
                ? `${escapeHtml(emp.name)} (${displayEmpId})${emp.center ? ` · ${escapeHtml(emp.center)}` : ''}`
                : `미등록 사용자 (${displayEmpId})`;
            return `<div class="score-row" style="flex-wrap:nowrap;">
                <span class="who" style="white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${who}</span>
                <span class="meta" style="flex:0 0 auto;">${u.count}회</span>
            </div>`;
          }).join('');

    document.getElementById('modelFeatureUsersModal').style.display = 'block';
}
