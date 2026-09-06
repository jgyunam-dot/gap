/* ============================================================
   gram Analyzer Pro — 대시보드(분석) 스크립트
   공통 설정·세션·테마는 common.js, 관리 기능은 admin.js 가 담당한다.
   ============================================================ */

let globalRawData   = null;
let liveInterval    = null;
let globalUsersList = [];

// "세부 기능별 비중" 차트가 마지막으로 계산해 둔 집계(기간 필터 적용됨) — 기능 상세 모달의
// [기능상세] 버튼이 openFeatureGroupModal을 열 때 다시 씀(재계산 안 하려고 저장해 둔다).
let globalFeatureStats = {};
// 기능 상세 모달(featureDetailModal)이 지금 보여주고 있는 기능 — [기능상세] 버튼 클릭 시 참조.
let _fdCurrentKey  = null;
let _fdCurrentName = null;

window.currentUserData = [];
let currentDisplayData = [];
let currentPage  = 1;
const rowsPerPage = 10;
let searchQuery   = "";
let sortColIndex  = null;
let sortAsc       = false;
let sortIsNumeric = false;

/** 차트 눈금 색은 테마에 따라 달라진다. */
function applyChartTheme(light) {
    Chart.defaults.color = light ? '#636e72' : '#9e9e9e';
}

window.onload = async function () {
    if (!requireLogin()) return;

    // 세션 저장소엔 로그인 정보가 있는데 Firebase 인증 토큰 복구가 실패하면(예: 오래돼서 만료)
    // employees/user_roles 등 보호된 데이터를 전혀 못 읽으므로 다시 로그인하게 한다.
    if (!(await restoreAuthSession())) {
        alert('세션이 만료되었습니다. 다시 로그인해주세요.');
        doLogout();
        return;
    }

    initTheme(applyChartTheme);

    renderSidebar('sidebar', [
        { href: 'dashboard.html', icon: 'monitoring',           label: '대시보드', active: true },
        { href: 'admin.html',     icon: 'admin_panel_settings', label: '관리자 콘솔', roles: ['admin', 'manager'], withAdminSections: true },
    ]);

    // RAW DATA 삭제·엑셀(CSV) 다운로드는 Super Admin 에게만 노출 (관리자 콘솔 진입은 사이드바 메뉴로)
    if (userRole === 'admin') {
        const btnDeleteRaw = document.getElementById('btnDeleteRaw');
        if (btnDeleteRaw) btnDeleteRaw.style.display = 'inline-flex';

        const btnExportCsv = document.getElementById('btnExportCsv');
        if (btnExportCsv) btnExportCsv.style.display = 'inline-flex';
    }

    // 저장해 둔 기간 필터 복원
    const savedPreset = localStorage.getItem('gap_date_preset');
    if (savedPreset) {
        document.getElementById('datePreset').value = savedPreset;
        document.getElementById('customDateRange').style.display = savedPreset === 'custom' ? 'flex' : 'none';
        if (savedPreset === 'custom') {
            document.getElementById('startDate').value = localStorage.getItem('gap_date_start') || '';
            document.getElementById('endDate').value   = localStorage.getItem('gap_date_end') || '';
        }
    }
    if (localStorage.getItem('gap_show_weekend') === 'true') {
        const chk = document.getElementById('showWeekendCheckbox');
        if (chk) chk.checked = true;
    }

    await initEmployeeData();
    const roles = await fetchUserRoles();
    globalUsersList = Object.entries(roles || {}).map(([uid, v]) => ({ uid, id: v.originalId, ...v }));

    initNotifBell();
    fetchData();
    toggleLiveMode();
    registerPushIfNative().catch(e => console.error('푸시 등록 실패:', e));

    if (!sessionStorage.getItem('gap_audit_login_logged')) {
        logAudit('LOGIN', loggedInUser).catch(() => {});
        sessionStorage.setItem('gap_audit_login_logged', 'true');
    }
};

/* 테마를 바꾸면 차트도 다시 그려야 눈금·범례 색이 맞는다. */
function switchTheme() {
    toggleTheme(light => { applyChartTheme(light); renderDashboard(); });
}

function handleWeekendToggle() {
    localStorage.setItem('gap_show_weekend', document.getElementById('showWeekendCheckbox').checked);
    renderDashboard();
}


async function deleteSelectedRawData() {
    const checkedBoxes = document.querySelectorAll('.raw-data-checkbox:checked');
    if (checkedBoxes.length === 0) {
        return alert("삭제할 대상을 체크박스로 먼저 선택해주세요.");
    }
    const empIds = Array.from(checkedBoxes).map(cb => cb.value);
    if (!confirm(`선택한 ${empIds.length}명의 진단 앱 사용 기록(RAW DATA)을 완전히 삭제하시겠습니까?\n(삭제 시 차트 및 통계에서도 즉시 제외되며 복구할 수 없습니다)`)) {
        return;
    }

    try {
        // usage/{empId}만 지우면 "모델별 사용현황"(model_usage)에는 그대로 남는다 — 그쪽 모델별
        // 합계는 사람별이 아니라 모델 전체 누적치라 usage 삭제와 자동으로 연동되지 않기 때문이다.
        // 지우기 전에 이 사람들이 각 모델에 기여한 만큼을 모델 합계에서 먼저 빼준다.
        await purgeFromModelUsage(empIds);

        const deletePromises = empIds.map(async empId => {
            await fetch(authDbUrl(`usage/${empId}`), { method: 'DELETE' });
            await logAudit('DELETE_RAW_DATA', empId);
        });

        await Promise.all(deletePromises);
        alert(`${empIds.length}명의 데이터가 성공적으로 삭제되었습니다.`);
        fetchData();
    } catch(e) {
        alert("일괄 삭제 처리 중 오류가 발생했습니다.");
        console.error(e);
    }
}

/**
 * RAW DATA(usage/{empId})를 지우기 전에 "모델별 사용현황"(model_usage) 쪽 집계에서도
 * 그 사람들이 기여한 몫을 빼서, 삭제 후엔 모델별 합계·비중에도 안 잡히게 한다.
 * model_usage/{model}/features/{feature}/daily/{date} 는 그 모델을 쓴 "모든 사람"의 합산치라서
 * usage 삭제만으로는 자동으로 줄지 않는다 — 그 사람의 개인 기록(users/{empId})에 남아있는
 * 정확히 같은 수치를 모델 합계에서 빼는 방식으로 정리한다(0 이하가 되면 그 항목은 지운다).
 */
async function purgeFromModelUsage(empIds) {
    let modelData;
    try {
        modelData = await fetch(authDbUrl('model_usage')).then(r => r.json());
    } catch (e) {
        console.error('model_usage 조회 실패 — 모델별 사용현황 정리를 건너뜁니다.', e);
        return;
    }
    if (!modelData) return;

    const updatesByModel = {};  // modelKey -> { 상대경로: 새 값(null이면 삭제) }
    const workingCounts  = {};  // "modelKey|featureKey|date" -> 이번 일괄 삭제에서 지금까지 깎인 값

    function countOf(modelKey, m, fKey, date) {
        const k = `${modelKey}|${fKey}|${date}`;
        if (!(k in workingCounts)) {
            workingCounts[k] = (m.features && m.features[fKey] && m.features[fKey].daily && m.features[fKey].daily[date]) || 0;
        }
        return workingCounts[k];
    }

    for (const [modelKey, m] of Object.entries(modelData)) {
        for (const empId of empIds) {
            const u = m.users && m.users[empId];
            if (!u) continue;

            const updates = updatesByModel[modelKey] || (updatesByModel[modelKey] = {});
            updates[`users/${empId}`] = null; // 그 사람의 이 모델 개인 기록은 통째로 삭제

            for (const [fKey, f] of Object.entries(u.features || {})) {
                for (const [date, count] of Object.entries(f.daily || {})) {
                    if (!count) continue;
                    const next = Math.max(0, countOf(modelKey, m, fKey, date) - count);
                    workingCounts[`${modelKey}|${fKey}|${date}`] = next;
                    updates[`features/${fKey}/daily/${date}`] = next > 0 ? next : null;
                }
            }
        }
    }

    const modelKeys = Object.keys(updatesByModel);
    if (modelKeys.length === 0) return;

    await Promise.all(modelKeys.map(modelKey =>
        fetch(authDbUrl(`model_usage/${modelKey}`), {
            method: 'PATCH',
            body: JSON.stringify(updatesByModel[modelKey]),
            headers: { 'Content-Type': 'application/json' }
        })
    ));
}

function openFeatureDetailModal(fKey, fName) {
    document.getElementById('fdModalTitle').innerText = `'${fName}' 상세 분석`;

    // PC 상세정보/PC 점검하기/롬라이팅처럼 하위 세부 항목이 있는 기능일 때만 [기능상세] 버튼을 보여준다.
    _fdCurrentKey = fKey;
    _fdCurrentName = fName;
    const groupBtn = document.getElementById('fdGroupBtn');
    if (groupBtn) groupBtn.style.display = featureGroups[fKey] ? '' : 'none';

    const range = getFilterDateRange();
    const showWeekend = document.getElementById('showWeekendCheckbox') ? document.getElementById('showWeekendCheckbox').checked : false;

    let userCounts = {};
    let centerCounts = {};

    for (const empId in globalRawData) {
        if (empId === 'admin' || empId.toLowerCase() === 'admin') continue;

        const info = globalRawData[empId];
        if (!info.features || !info.features[fKey] || !info.features[fKey].daily) continue;

        const empInfo = dynamicEmployeeData[empId] || { name: "미등록 사용자", dept: "-", center: "-" };
        const safeName = empInfo.name;
        const safeCenter = empInfo.center;

        let count = 0;
        for (const date in info.features[fKey].daily) {
            if (date >= range.start && date <= range.end) {
                const d = new Date(date);
                if (!showWeekend && (d.getDay() === 0 || d.getDay() === 6)) continue;
                count += info.features[fKey].daily[date];
            }
        }

        if (count > 0) {
            userCounts[empId] = { name: safeName, count: count, center: safeCenter };
            // 예전엔 소속이 "OO센터"로 끝나는 사람만 잡았는데, 이제는 전부 잡고 표시만 정리한다.
            const centerKey = centerDisplayName(safeCenter);
            centerCounts[centerKey] = (centerCounts[centerKey] || 0) + count;
        }
    }

    const sortedUsers = Object.entries(userCounts).sort((a, b) => b[1].count - a[1].count);
    const sortedCenters = Object.entries(centerCounts).sort((a, b) => b[1] - a[1]);

    let usersHtml = '';
    sortedUsers.forEach((item, index) => {
        const empId = item[0];
        const uData = item[1];
        const displayId = getMaskedId(empId);
        const rankBadge = index < 3 ? `<span style="color:var(--lg-yellow); font-weight:bold;">${index+1}.</span>` : `<span style="color:var(--text-sub);">${index+1}.</span>`;
        usersHtml += `
            <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px dashed var(--border-color);">
                <span>${rankBadge} ${escapeHtml(uData.name)} (${displayId}) <span style="color:var(--text-sub); font-size:10px;">${escapeHtml(uData.center)}</span></span>
                <strong style="color:var(--lg-red);">${uData.count}회</strong>
            </div>
        `;
    });
    if (!usersHtml) usersHtml = '<div style="text-align:center; padding:10px; color:var(--text-sub);">사용 기록이 없습니다.</div>';
    document.getElementById('fdTopUsers').innerHTML = usersHtml;

    let centersHtml = '';
    sortedCenters.forEach((item, index) => {
        const cName = item[0];   // centerCounts 키는 이미 centerDisplayName으로 정리된 표시용 이름이다
        const count = item[1];
        const rankBadge = index < 3 ? `<span style="color:var(--lg-yellow); font-weight:bold;">${index+1}.</span>` : `<span style="color:var(--text-sub);">${index+1}.</span>`;
        centersHtml += `
            <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px dashed var(--border-color);">
                <span>${rankBadge} <span style="color:var(--lg-blue); font-weight:bold;">${escapeHtml(cName)}</span></span>
                <strong style="color:var(--lg-red);">${count}회</strong>
            </div>
        `;
    });
    if (!centersHtml) centersHtml = '<div style="text-align:center; padding:10px; color:var(--text-sub);">사용 기록이 없습니다.</div>';
    document.getElementById('fdTopCenters').innerHTML = centersHtml;

    document.getElementById('featureDetailModal').style.display = 'block';
}

/** 기능 상세 모달의 [기능상세] 버튼 — 지금 보고 있는 기능(_fdCurrentKey)에 하위 항목이 있을
 *  때만 버튼이 보이므로, 눌리면 그 하위 항목 비중(openFeatureGroupModal)으로 넘어간다. */
function openFeatureDetailGroupBtn() {
    if (!_fdCurrentKey || !featureGroups[_fdCurrentKey]) return;
    document.getElementById('featureDetailModal').style.display = 'none';
    openFeatureGroupModal(_fdCurrentKey, _fdCurrentName, globalFeatureStats);
}

/** 상위 메뉴(pcInfo/diagnostics/romWriter) 막대를 클릭했을 때, 그 안의 하위 항목만 따로 보여준다.
 *  statsSource는 renderDashboard가 이미 현재 기간 필터로 집계해 둔 featureStats — 그대로 재사용해
 *  전체를 다시 훑지 않는다. 막대를 다시 클릭하면 그 하위 항목의 사용자 목록(openFeatureDetailModal)으로 이어진다. */
function openFeatureGroupModal(parentKey, parentName, statsSource) {
    const children = featureGroups[parentKey] || [];
    const rows = children
        .map(k => [k, statsSource[k] || 0])
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1]);

    document.getElementById('fgModalTitle').innerText = `${parentName} — ${featureGroupTitleSuffix[parentKey] || '세부 기능 비중'}`;
    document.getElementById('featureGroupModal').style.display = 'block';

    if (chartInstances['featureGroupChart']) { chartInstances['featureGroupChart'].destroy(); delete chartInstances['featureGroupChart']; }

    const emptyEl = document.getElementById('featureGroupEmpty');
    const boxEl = document.getElementById('featureGroupChartBox');

    if (rows.length === 0) {
        if (emptyEl) emptyEl.style.display = 'block';
        if (boxEl) boxEl.style.display = 'none';
        return;
    }
    if (emptyEl) emptyEl.style.display = 'none';
    if (boxEl) { boxEl.style.display = ''; boxEl.style.height = Math.max(160, rows.length * 27) + 'px'; }

    const gridColor = isLightMode ? 'rgba(0,0,0,.1)' : 'rgba(255,255,255,.1)';
    createChart('featureGroupChart', {
        type: 'bar',
        data: {
            labels: rows.map(r => featureNames[r[0]] || r[0]),
            datasets: [{ data: rows.map(r => r[1]), backgroundColor: rows.map((_, i) => palette[i % palette.length]), borderRadius: 4 }]
        },
        options: {
            indexAxis: 'y', responsive: true, maintainAspectRatio: false,
            plugins: { legend: { display: false } },
            scales: { x: { beginAtZero: true, grid: { color: gridColor } }, y: { grid: { display: false }, ticks: { autoSkip: false } } },
            onHover: (event, chartElement) => { event.native.target.style.cursor = chartElement[0] ? 'pointer' : 'default'; },
            onClick: (event, elements) => {
                if (elements.length === 0) return;
                const childKey = rows[elements[0].index][0];
                document.getElementById('featureGroupModal').style.display = 'none';
                openFeatureDetailModal(childKey, featureNames[childKey] || childKey);
            }
        }
    });
}

function fetchData() {
    fetch(authDbUrl('usage'))
        .then(response => response.json())
        .then(data => {
            if(data) {
                globalRawData = data.usage ? data.usage : data;
                renderDashboard();
            }
        }).catch(error => console.error("데이터 로딩 실패:", error));

    checkPendingFeedback();
    checkNewLogins();
    updateNotifBadge();
}

function toggleLiveMode() {
    const isLive = document.getElementById('liveToggle').checked;
    const statusText = document.getElementById('liveStatusText');
    const iconText = document.getElementById('liveIcon');
    if(isLive) {
        statusText.innerText = 'LIVE ON';
        statusText.classList.add('live-active-text');
        iconText.classList.add('live-active-text');
        liveInterval = setInterval(fetchData, 60000); 
    } else {
        statusText.innerText = 'LIVE OFF';
        statusText.classList.remove('live-active-text');
        iconText.classList.remove('live-active-text');
        clearInterval(liveInterval);
    }
}

/** globalRawData 에는 있지만 사원 명단(dynamicEmployeeData)에는 없는 사번 목록. */
function getUnregisteredUserIds() {
    if (!globalRawData) return [];
    return Object.keys(globalRawData).filter(empId =>
        empId.toLowerCase() !== 'admin' && !dynamicEmployeeData[empId]
    );
}

/**
 * 미등록 사용자가 있으면 대시보드 상단에 알림을 띄운다.
 * 한 번 확인(닫기)한 사번은 새로 나타난 사람이 없는 한 다시 띄우지 않는다 — 매번 로그인할 때마다
 * 같은 미등록자를 반복해서 알려주면 결국 무시하게 되므로, 브라우저에 확인 이력을 남겨 둔다.
 */
function updateUnregisteredAlert() {
    const banner = document.getElementById('unregisteredAlert');
    // 사원 명단 등록 권한이 없는 계정(일반 사용자)에게는 띄워도 할 수 있는 일이 없다.
    if (!banner || !hasPerm('employees')) return;

    const unregisteredIds = getUnregisteredUserIds();
    if (unregisteredIds.length === 0) { banner.style.display = 'none'; return; }

    let dismissed = [];
    try { dismissed = JSON.parse(localStorage.getItem('gap_dismissed_unregistered') || '[]'); }
    catch (e) { dismissed = []; }

    const newIds = unregisteredIds.filter(id => !dismissed.includes(id));
    if (newIds.length === 0) { banner.style.display = 'none'; return; }

    banner.dataset.ids = JSON.stringify(unregisteredIds);
    const preview = newIds.slice(0, 5).map(getMaskedId).join(', ') + (newIds.length > 5 ? ' 외' : '');
    document.getElementById('unregisteredAlertText').innerHTML =
        `사원 명단에 없는 <b>미등록 사용자 ${newIds.length}명</b>이 확인되었습니다. (${preview})`;
    banner.style.display = 'flex';

    pushOncePerId('gap_pushed_unregistered', newIds, (toPush) => ({
        title: '미등록 사용자 발생',
        body: `사원 명단에 없는 사용자 ${toPush.length}명이 새로 확인되었습니다.`
    }));
}

/**
 * 같은 ID로는 한 번만 푸시를 보낸다 — 배너는 60초마다 다시 계산되므로, 이 기록이 없으면
 * 사용자가 닫기 전까지 매 폴링마다 같은 알림을 반복 발송하게 된다.
 *
 * "보낸 적 있음" 기록을 DB(fcm_notified/{storageKey})에 남겨 모든 기기가 공유한다 — 브라우저별
 * localStorage에만 남기면, PC 탭과 폰 앱처럼 서로 다른 기기가 동시에 같은 새 항목을 감지했을 때
 * 각자 따로 푸시를 보내 같은 이벤트에 알림이 여러 개 오는 문제가 있었다.
 *
 * 마킹은 실제 발송을 시도하기 "전"에 먼저 해서 여러 기기가 동시에 감지했을 때의 경합을 최대한 줄이고,
 * 발송이 실패하면(설정 미비, 네트워크 오류 등) 마킹을 되돌려 다음 폴링에서 다시 시도하게 한다 —
 * 안 그러면 첫 시도가 실패했을 때 그 항목은 영영 "보낸 걸로" 처리돼 실제로는 알림이 안 가는 채로
 * 계속 무시된다.
 *
 * @param {(toPush: string[]) => {title: string, body: string}} buildMessage
 *   메시지는 ids 전체가 아니라 "이번에 새로 확인된" toPush 만으로 만든다 — ids를 그대로 쓰면(예전 버그),
 *   1건만 새로 생겨도 예전에 이미 처리된 것까지 다 합친 개수/이름이 알림 문구에 실려 나갔다
 *   (예: 로그인 1건만 새로 생겼는데 "새 로그인 20건"으로 표시됨).
 */
async function pushOncePerId(storageKey, ids, buildMessage) {
    if (ids.length === 0) return;
    const markPath = `fcm_notified/${storageKey}`;

    let toPush = [];
    try {
        const marked = await (await fetch(authDbUrl(markPath))).json() || {};
        toPush = ids.filter(id => !marked[id]);
        if (toPush.length === 0) return;

        const updates = {};
        toPush.forEach(id => { updates[id] = Date.now(); });
        await fetch(authDbUrl(markPath), {
            method: 'PATCH',
            body: JSON.stringify(updates),
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) { console.error('푸시 마킹 실패:', e); return; }

    const { title, body } = buildMessage(toPush);

    try {
        const sent = await sendPushToAdmins(title, body);
        if (!sent) throw new Error('발송 실패(설정 미비 또는 통신 오류)');

        // 종 아이콘 알림 이력에 남긴다 — 폰에 안 온 사람도 대시보드에서 다시 볼 수 있게.
        fetch(authDbUrl('notification_log'), {
            method: 'POST',
            body: JSON.stringify({ type: storageKey, title, body, timestamp: Date.now() }),
            headers: { 'Content-Type': 'application/json' }
        }).catch(e => console.error('알림 이력 기록 실패:', e));
    } catch (e) {
        console.error('푸시 발송 실패, 다음 폴링에서 재시도합니다:', e);
        try {
            const rollback = {};
            toPush.forEach(id => { rollback[id] = null; }); // null 로 PATCH하면 해당 키가 삭제된다
            await fetch(authDbUrl(markPath), {
                method: 'PATCH',
                body: JSON.stringify(rollback),
                headers: { 'Content-Type': 'application/json' }
            });
        } catch (e2) { console.error('푸시 마킹 롤백 실패:', e2); }
    }
}

/** 알림을 닫으면, 지금 보인 미등록 사번들은 새 사람이 또 나타나기 전까진 다시 알리지 않는다. */
function dismissUnregisteredAlert() {
    const banner = document.getElementById('unregisteredAlert');
    let ids = [];
    try { ids = JSON.parse(banner.dataset.ids || '[]'); } catch (e) { ids = []; }

    let dismissed = [];
    try { dismissed = JSON.parse(localStorage.getItem('gap_dismissed_unregistered') || '[]'); }
    catch (e) { dismissed = []; }

    localStorage.setItem('gap_dismissed_unregistered', JSON.stringify([...new Set([...dismissed, ...ids])]));
    banner.style.display = 'none';
}

/**
 * 처리하지 않은(대기중) 피드백이 있으면 대시보드 상단에 알림을 띄운다.
 * '미등록 사용자' 알림과 같은 방식으로, 한 번 닫은 건은 새 피드백이 또 들어오기 전까진 다시 띄우지 않는다.
 */
async function checkPendingFeedback() {
    const banner = document.getElementById('pendingFeedbackAlert');
    // 피드백 확인은 관리자 콘솔 진입 권한(Super Admin·관리자)이 있어야 의미가 있다.
    if (!banner || !isManagerOrAbove(true)) return;

    let data;
    try { data = await (await fetch(authDbUrl('feedbacks'))).json(); }
    catch (e) { console.error('피드백 목록 로딩 실패:', e); return; }
    if (!data) { banner.style.display = 'none'; return; }

    const pending = Object.entries(data)
        .filter(([, fb]) => (fb.status || 'pending') !== 'completed')
        .map(([id, fb]) => ({ id, ...fb }));
    if (pending.length === 0) { banner.style.display = 'none'; return; }

    let dismissed = [];
    try { dismissed = JSON.parse(localStorage.getItem('gap_dismissed_feedback') || '[]'); }
    catch (e) { dismissed = []; }

    const newOnes = pending.filter(fb => !dismissed.includes(fb.id));
    if (newOnes.length === 0) { banner.style.display = 'none'; return; }

    const hasUrgent = newOnes.some(fb => fb.priority === 'high');
    banner.dataset.ids = JSON.stringify(pending.map(fb => fb.id));
    document.getElementById('pendingFeedbackText').innerHTML =
        `처리하지 않은 <b>피드백 ${newOnes.length}건</b>이 있습니다.` +
        (hasUrgent ? ' <b style="color:var(--lg-red);">(긴급 포함)</b>' : '');
    banner.style.display = 'flex';

    pushOncePerId('gap_pushed_feedback', newOnes.map(fb => fb.id), (toPush) => ({
        title: hasUrgent ? '긴급 피드백 도착' : '새 피드백 도착',
        body: `새 피드백 ${toPush.length}건이 도착했습니다.` + (newOnes.length > toPush.length ? ` (미확인 총 ${newOnes.length}건)` : '')
    }));
}

/**
 * 감사 로그에 새 LOGIN 기록이 생기면 Super Admin·관리자에게 푸시로 알린다 — 다른 계정이 로그인할 때마다
 * 알 수 있게 하기 위함. 감사 로그 화면에서 언제든 다시 볼 수 있으므로 메인 화면 배너는 따로 안 띄운다.
 *
 * Super Admin(admin)만으로 감지 대상을 좁혀놨더니, 정작 폰이 admin 계정으로 로그인돼 있는 시간이
 * 짧아서(평소엔 관리자 계정을 씀) 거의 감지가 안 됐다 — 피드백 알림처럼 관리자 이상이면 감지하도록 맞춘다.
 * (알림을 받는 대상 자체는 sendPushToAdmins에서 이미 admin+manager 전체였으니 바뀌는 건 없다.)
 */
async function checkNewLogins() {
    if (!isManagerOrAbove(true)) return;

    let data;
    try {
        // orderBy/limitToLast 는 DB에 .indexOn 설정이 없으면 에러가 나므로(콘솔 규칙을 안 건드리려고),
        // 관리자 콘솔의 감사 로그 화면과 같은 방식으로 전체를 받아 여기서 걸러낸다.
        data = await (await fetch(authDbUrl('audit_logs'))).json();
    } catch (e) { console.error('감사 로그 로딩 실패:', e); return; }
    if (!data) return;

    const logins = Object.entries(data)
        .filter(([, e]) => e && e.action === 'LOGIN')
        .map(([id, e]) => ({ id, ...e }))
        .sort((a, b) => a.timestamp - b.timestamp)
        .slice(-20); // 최근 20건만 — 처음 배포 시 과거 로그인 전부가 한꺼번에 몰리지 않도록
    if (logins.length === 0) return;

    const roleLabel = (id) => {
        const user = globalUsersList.find(u => u.id === id);
        if (!user) return '';
        if (user.role === 'admin') return ' (Super Admin)';
        if (user.role === 'manager') return ' (관리자)';
        return '';
    };
    const loginById = Object.fromEntries(logins.map(e => [e.id, e]));

    // 문구는 logins(최근 20건 전체)가 아니라 toPush(이번에 새로 확인된 것)만으로 만든다 —
    // 안 그러면 실제로는 1명만 로그인했는데 예전에 이미 처리된 로그인까지 합쳐서
    // "새 로그인 20건"처럼 매번 잘못 표시된다.
    pushOncePerId('gap_pushed_login', logins.map(e => e.id), (toPush) => {
        const names = toPush.map(id => `${loginById[id].target}${roleLabel(loginById[id].target)}`);
        return {
            title: toPush.length === 1 ? '새 로그인' : `새 로그인 ${toPush.length}건`,
            body: toPush.length === 1
                ? `${names[0]}님이 로그인했습니다.`
                : `${names.join(', ')} 계정이 로그인했습니다.`
        };
    });
}

/* ── 알림 종(bell) · 이력 패널 ──────────────────────────────────
   pushOncePerId 가 실제로 푸시를 보낼 때마다 notification_log 에도 같은 내용을 남겨 둔다.
   폰에 알림이 안 갔거나(설정 전, 권한 거부 등) 놓쳤어도, 대시보드에서 지난 알림을 다시 볼 수 있다. */

const NOTIF_TYPE_ICON = {
    gap_pushed_login: 'login',
    gap_pushed_feedback: 'forum',
    gap_pushed_unregistered: 'person_alert'
};

/** Super Admin·관리자에게만 종 아이콘을 보여준다 — 알림을 받는 대상과 동일하다. */
function initNotifBell() {
    const wrap = document.getElementById('notifWrap');
    if (!wrap || !isManagerOrAbove(true)) return;
    wrap.style.display = 'block';
    updateNotifBadge();
}

function getNotifLastSeen() {
    return Number(localStorage.getItem('gap_notif_last_seen') || 0);
}

/** 안 읽은(마지막으로 연 이후 새로 생긴) 알림 개수만 가볍게 확인해 종에 배지로 표시한다. */
async function updateNotifBadge() {
    const badge = document.getElementById('notifBadge');
    if (!badge || document.getElementById('notifWrap').style.display === 'none') return;

    let data;
    try { data = await (await fetch(authDbUrl('notification_log'))).json(); }
    catch (e) { console.error('알림 이력 로딩 실패:', e); return; }
    if (!data) { badge.style.display = 'none'; return; }

    const lastSeen = getNotifLastSeen();
    const unread = Object.values(data).filter(n => n && n.timestamp > lastSeen).length;

    if (unread > 0) {
        badge.textContent = unread > 99 ? '99+' : String(unread);
        badge.style.display = 'block';
    } else {
        badge.style.display = 'none';
    }
}

/**
 * 종 버튼 위치를 기준으로 패널을 화면 안에 들어오게 배치한다(position: fixed).
 * 오른쪽 정렬을 우선하되, 화면이 좁아 왼쪽 밖으로 나가면 최소 여백만큼 안으로 당긴다 —
 * 모바일에서 종 버튼이 화면 오른쪽 끝이 아닐 때(테마·로그아웃 버튼이 더 오른쪽에 있음) 생기던
 * "패널이 왼쪽으로 잘려 보이는" 문제를 막는다.
 */
function positionNotifPanel() {
    const wrap = document.getElementById('notifWrap');
    const panel = document.getElementById('notifPanel');
    if (!wrap || !panel) return;

    const margin = 10;
    const rect = wrap.getBoundingClientRect();
    const panelWidth = Math.min(340, window.innerWidth - margin * 2);

    let left = rect.right - panelWidth; // 버튼 오른쪽 끝에 맞춰 정렬
    left = Math.max(margin, Math.min(left, window.innerWidth - panelWidth - margin));

    panel.style.width = panelWidth + 'px';
    panel.style.left = left + 'px';
    panel.style.top = (rect.bottom + 8) + 'px';
}

/** 종을 누르면 패널을 열고닫는다. 열 때마다 위치를 다시 계산하고 최신 이력을 불러온다. */
function toggleNotifPanel(e) {
    if (e) e.stopPropagation();
    const panel = document.getElementById('notifPanel');
    if (!panel) return;

    const opening = panel.style.display === 'none';
    if (opening) positionNotifPanel();
    panel.style.display = opening ? 'block' : 'none';
    if (opening) loadNotificationHistory();
}

/** 안 읽은(마지막으로 "모두 읽음"을 누른 뒤 생긴) 알림만 보여준다 — 배지 숫자와 목록이 항상 일치한다. */
async function loadNotificationHistory() {
    const list = document.getElementById('notifList');
    if (!list) return;
    list.innerHTML = '<div class="notif-empty">불러오는 중...</div>';

    let data;
    try { data = await (await fetch(authDbUrl('notification_log'))).json(); }
    catch (e) { list.innerHTML = '<div class="notif-empty">불러오지 못했습니다.</div>'; return; }

    if (!data) { list.innerHTML = '<div class="notif-empty">새 알림이 없습니다.</div>'; return; }

    const lastSeen = getNotifLastSeen();
    const items = Object.values(data)
        .filter(n => n && n.timestamp > lastSeen)
        .sort((a, b) => b.timestamp - a.timestamp)
        .slice(0, 50);

    list.innerHTML = items.map(n => `
            <div class="notif-item">
                <span class="material-symbols-outlined">${NOTIF_TYPE_ICON[n.type] || 'notifications'}</span>
                <div class="notif-item-body">
                    <div class="notif-item-title">${escapeHtml(n.title || '')}</div>
                    <div class="notif-item-text">${escapeHtml(n.body || '')}</div>
                    <div class="notif-item-time">${formatDateFull(n.timestamp)}</div>
                </div>
            </div>`).join('') || '<div class="notif-empty">새 알림이 없습니다.</div>';
}

/** "모두 읽음" — 목록을 비우고 배지를 지운다(기준 시각을 지금으로 갱신). */
function markAllNotifRead() {
    localStorage.setItem('gap_notif_last_seen', String(Date.now()));
    const badge = document.getElementById('notifBadge');
    if (badge) badge.style.display = 'none';
    loadNotificationHistory();
}

/* 종 패널 바깥을 클릭하면 닫는다. */
window.addEventListener('click', (e) => {
    const wrap = document.getElementById('notifWrap');
    const panel = document.getElementById('notifPanel');
    if (!wrap || !panel || panel.style.display === 'none') return;
    if (!wrap.contains(e.target)) panel.style.display = 'none';
});

/** 알림을 닫으면, 지금 보인 피드백들은 새 피드백이 또 들어오기 전까진 다시 알리지 않는다. */
function dismissPendingFeedbackAlert() {
    const banner = document.getElementById('pendingFeedbackAlert');
    let ids = [];
    try { ids = JSON.parse(banner.dataset.ids || '[]'); } catch (e) { ids = []; }

    let dismissed = [];
    try { dismissed = JSON.parse(localStorage.getItem('gap_dismissed_feedback') || '[]'); }
    catch (e) { dismissed = []; }

    localStorage.setItem('gap_dismissed_feedback', JSON.stringify([...new Set([...dismissed, ...ids])]));
    banner.style.display = 'none';
}

function handleDatePreset() {
    const preset = document.getElementById('datePreset').value;
    localStorage.setItem('gap_date_preset', preset); 
    const customDiv = document.getElementById('customDateRange');
    customDiv.style.display = preset === 'custom' ? 'flex' : 'none';
    renderDashboard();
}

function saveCustomDates() {
    localStorage.setItem('gap_date_start', document.getElementById('startDate').value);
    localStorage.setItem('gap_date_end', document.getElementById('endDate').value);
}

function getFilterDateRange() {
    const preset = document.getElementById('datePreset').value;
    let start = '2000-01-01', end = '2100-12-31';
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    const todayStr = `${yyyy}-${mm}-${dd}`;

    if (preset === 'today') {
        start = todayStr;
        end = todayStr;
    } else if (preset === 'last7') {
        const lastWeek = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
        start = `${lastWeek.getFullYear()}-${String(lastWeek.getMonth()+1).padStart(2,'0')}-${String(lastWeek.getDate()).padStart(2,'0')}`;
        end = todayStr;
    } else if (preset === 'thisMonth') {
        start = `${yyyy}-${mm}-01`;
        end = todayStr;
    } else if (preset === 'custom') {
        start = document.getElementById('startDate').value || '2000-01-01';
        end = document.getElementById('endDate').value || '2100-12-31';
    }
    return { start, end };
}

/** 지금 화면이 휴대폰 폭인지. (차트 라벨·폭 조정에만 쓴다) */
const isNarrowScreen = () => window.matchMedia('(max-width: 600px)').matches;

/**
 * 휴대폰에서 차트 안쪽 폭을 늘려 "한 번에 N개만 보이도록" 맞춘다.
 * 좁은 화면에 전부 밀어 넣으면 축 글자가 기울거나 잘리므로, 보이는 영역을
 * N등분한 폭을 항목마다 주고 나머지는 좌우로 밀어 보게 한다.
 * 화면 크기와 무관하게 N개가 딱 들어오며, PC 에서는 손대지 않는다.
 */
function stretchChartToFit(wrapperId, count, visibleCount) {
    const el = document.getElementById(wrapperId);
    if (!el || !el.parentElement) return;

    if (!isNarrowScreen() || count <= visibleCount) { el.style.width = '100%'; return; }
    el.style.width = Math.round(count * (el.parentElement.clientWidth / visibleCount)) + 'px';
}

/**
 * 실행 추이는 최근 날짜가 중요하므로 오른쪽 끝을 먼저 보여준다.
 * 다만 LIVE 자동 새로고침(60초)마다 되돌리면 과거를 보던 중에 화면이 튕기므로,
 * 표시 구간이 실제로 바뀌었을 때만 이동한다.
 */
let _trendPointCount = -1;
function scrollTrendToLatest(count) {
    const area = document.getElementById('trendChartWrapper')?.parentElement;
    if (!area || count === _trendPointCount) return;
    _trendPointCount = count;
    requestAnimationFrame(() => { area.scrollLeft = area.scrollWidth; });
}

/** 휴대폰에서는 축 글자를 눕히지 않고 전부 표시한다(폭은 stretchChartToFit 이 확보). */
function flatTicks() {
    return isNarrowScreen()
        ? { ticks: { maxRotation: 0, minRotation: 0, autoSkip: false } }
        : {};
}

/** 차트 축 라벨용 짧은 날짜 — '2026-08-19' → '8/19' */
function shortDate(ymd) {
    const p = String(ymd).split('-');
    return p.length === 3 ? `${Number(p[1])}/${Number(p[2])}` : ymd;
}

function updateTable() {
    currentDisplayData = window.currentUserData.filter(u => {
        if(!searchQuery) return true;
        const sq = searchQuery.toUpperCase();
        return String(u.name || '').toUpperCase().includes(sq) || 
               String(u.dept || '').toUpperCase().includes(sq) || 
               String(u.center || '').toUpperCase().includes(sq);
    });

    if (sortColIndex !== null) {
        currentDisplayData.sort((a, b) => {
            let aVal, bVal;
            if(sortColIndex === 0) { aVal = a.empId; bVal = b.empId; }
            else if(sortColIndex === 1) { aVal = a.name; bVal = b.name; }
            else if(sortColIndex === 2) { aVal = a.dept; bVal = b.dept; }
            else if(sortColIndex === 3) { aVal = a.center; bVal = b.center; }
            else if(sortColIndex === 4) { aVal = a.filteredCount; bVal = b.filteredCount; }
            else if(sortColIndex === 5) { aVal = a.lastVersion; bVal = b.lastVersion; }
            else if(sortColIndex === 6) { aVal = a.lastRunAt || 0; bVal = b.lastRunAt || 0; }
            
            if(sortIsNumeric) {
                return sortAsc ? aVal - bVal : bVal - aVal;
            } else {
                let strA = String(aVal).replace(/<[^>]*>?/gm, '').trim();
                let strB = String(bVal).replace(/<[^>]*>?/gm, '').trim();
                return sortAsc ? strA.localeCompare(strB) : strB.localeCompare(strA);
            }
        });
    }

    const totalItems = currentDisplayData.length;
    const totalPages = Math.ceil(totalItems / rowsPerPage) || 1;
    if (currentPage > totalPages) currentPage = totalPages;
    if (currentPage < 1) currentPage = 1;

    const startIdx = (currentPage - 1) * rowsPerPage;
    const pageData = currentDisplayData.slice(startIdx, startIdx + rowsPerPage);

    let tbodyHtml = '';
    pageData.forEach(user => {
        let t = '-';
        if(user.lastRunAt) {
            const d = new Date(user.lastRunAt);
            t = `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} <span class="time-text">${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}</span>`;
        }

        let rankBadge = '';
        if (user.globalRank === 0) rankBadge = '<span class="material-symbols-outlined" style="color:var(--lg-yellow); font-size:18px; vertical-align:middle;">military_tech</span>'; 
        else if (user.globalRank === 1) rankBadge = '<span class="material-symbols-outlined" style="color:#b0bec5; font-size:18px; vertical-align:middle;">military_tech</span>'; 
        else if (user.globalRank === 2) rankBadge = '<span class="material-symbols-outlined" style="color:#a1887f; font-size:18px; vertical-align:middle;">military_tech</span>';

        const displayEmpId = getMaskedId(user.empId);

        let checkboxHtml = '';
        if (userRole === 'admin') {
            checkboxHtml = `<input type="checkbox" class="raw-data-checkbox" value="${user.empId}" onclick="event.stopPropagation();" style="margin-right:8px; cursor:pointer; accent-color:var(--lg-red);">`;
        }

        tbodyHtml += `
            <tr class="clickable-row" onclick="openModal('${user.empId}')">
                <td style="text-align:left; padding-left:15px;">${checkboxHtml}${displayEmpId}</td>
                <td style="font-weight:bold;">${rankBadge} ${escapeHtml(user.name)}</td>
                <td>${escapeHtml(user.dept)}</td>
                <td>${escapeHtml(user.center)}</td>
                <td class="highlight-text" style="font-size:15px;">${user.filteredCount}</td>
                <td>v${user.lastVersion}</td>
                <td>${t}</td>
            </tr>
        `;
    });
    document.getElementById('allUsersTbody').innerHTML = tbodyHtml || '<tr><td colspan="7">데이터가 없습니다.</td></tr>';

    let pageHtml = '';
    pageHtml += `<button class="page-btn" onclick="changePage(${currentPage - 1})" ${currentPage === 1 ? 'disabled' : ''}>&lt;</button>`;
    
    let startPage = Math.max(1, currentPage - 2);
    let endPage = Math.min(totalPages, startPage + 4);
    if (endPage - startPage < 4) startPage = Math.max(1, endPage - 4);
    
    for(let i = startPage; i <= endPage; i++) {
        pageHtml += `<button class="page-btn ${i === currentPage ? 'active' : ''}" onclick="changePage(${i})">${i}</button>`;
    }
    
    pageHtml += `<button class="page-btn" onclick="changePage(${currentPage + 1})" ${currentPage === totalPages ? 'disabled' : ''}>&gt;</button>`;
    
    document.getElementById('paginationArea').innerHTML = pageHtml;
}

function handleSearch() {
    searchQuery = document.getElementById("searchInput").value;
    currentPage = 1; 
    updateTable();
}

function handleSort(colIdx, isNum) {
    if (sortColIndex === colIdx) {
        sortAsc = !sortAsc; 
    } else {
        sortColIndex = colIdx;
        sortAsc = false; 
    }
    sortIsNumeric = isNum;
    currentPage = 1; 
    
    const ths = document.getElementById("dataTable").querySelectorAll("th");
    ths.forEach(th => th.classList.remove('sort-asc', 'sort-desc'));
    ths[colIdx].classList.add(sortAsc ? 'sort-asc' : 'sort-desc');
    
    updateTable();
}

window.changePage = function(page) {
    currentPage = page;
    updateTable();
};

function downloadCSV() {
    if (!isSuperAdmin()) return;

    let csv = [];
    csv.push(['사원번호', '이름', '담당', '센터', '기간 내 실행', '기능 활용 내역', '최근 버전', '최종 사용시간'].map(h => `"${h}"`).join(","));
    
    currentDisplayData.forEach(user => {
        let fHtml = '';
        if(Object.keys(user.userFeatures).length > 0) {
            const sortedFeatures = Object.entries(user.userFeatures).sort((a, b) => b[1] - a[1]);
            fHtml = sortedFeatures.map(([k,v]) => `${featureNames[k]||k} ${v}`).join(' / ');
        }
        
        let t = '-';
        if(user.lastRunAt) {
            const d = new Date(user.lastRunAt);
            t = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        }

        const displayEmpId = getMaskedId(user.empId);

        csv.push([displayEmpId, user.name, user.dept, user.center, user.filteredCount, fHtml, `v${user.lastVersion}`, t].map(c => `"${c}"`).join(","));
    });

    const blob = new Blob(["\uFEFF" + csv.join("\n")], { type: "text/csv;charset=utf-8;" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob); link.download = `gap_report.csv`; link.click();
}

function openModal(empId) {
    const user = window.currentUserData.find(u => u.empId === empId);
    if(!user) return;

    const displayEmpId = getMaskedId(user.empId);

    document.getElementById('mName').innerHTML = `<span class="material-symbols-outlined" style="font-size:28px;">account_circle</span> ${escapeHtml(user.name)} (${displayEmpId})`;
    document.getElementById('mInfo').innerText = `${user.dept} / ${user.center}`;
    document.getElementById('mCount').innerText = user.filteredCount + '회';
    let bestF = '-', maxC = 0;
    for(const [k, v] of Object.entries(user.userFeatures)) { if(v > maxC) { maxC = v; bestF = featureNames[k] || k; } }
    document.getElementById('mBestFeature').innerText = bestF;
    let t = '-';
    if(user.lastRunAt) { const d = new Date(user.lastRunAt); t = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; }
    document.getElementById('mLastDate').innerText = t;

    let featureHtml = '';
    if(Object.keys(user.userFeatures).length > 0) {
        const sortedFeatures = Object.entries(user.userFeatures).sort((a, b) => b[1] - a[1]);
        for(const [fKey, count] of sortedFeatures) {
            featureHtml += `<span class="feature-tag">${featureNames[fKey] || fKey} ${count}</span>`;
        }
    } else { featureHtml = '<span style="color:var(--text-sub)">-</span>'; }
    document.getElementById('mFeatureList').innerHTML = featureHtml;

    const gridCol = isLightMode ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.1)';
    const dates = Object.keys(user.dailyStats).sort();
    createChart('modalChart', { type: 'bar', data: { labels: dates, datasets: [{ label: '일별 실행', data: dates.map(d => user.dailyStats[d]), backgroundColor: themeColors.blue, borderRadius: 4 }] }, options: { responsive: true, maintainAspectRatio: false, plugins:{legend:{display:false}}, scales:{x:{grid:{display:false}}, y:{beginAtZero:true, grid:{color:gridCol}}} } });
    document.getElementById('userModal').style.display = "block";
}

function closeModal() { document.getElementById('userModal').style.display = "none"; }

/* 모달 바깥을 클릭하면 닫는다. */
window.onclick = function (e) {
    if (e.target == document.getElementById('userModal')) closeModal();
    if (e.target == document.getElementById('featureDetailModal')) document.getElementById('featureDetailModal').style.display = 'none';
};

function renderDashboard() {
    if (!globalRawData) return;
    
    const range = getFilterDateRange();
    const showWeekend = document.getElementById('showWeekendCheckbox') ? document.getElementById('showWeekendCheckbox').checked : false;
    
    let userList = [];
    let trendStats = {};
    let versionStats = {}; let deptStats = {}; let centerStats = {}; let featureStats = {}; 
    let dowStats = [0, 0, 0, 0, 0, 0, 0]; 
    let totalUsageCount = 0;

    for (const empId in globalRawData) {
        if (empId === 'admin' || empId.toLowerCase() === 'admin') continue;

        const info = globalRawData[empId];
        let filteredCount = 0; 
        let dailyStats = {}; 
        
        const empInfo = dynamicEmployeeData[empId] || {};
        const safeName = empInfo.name || "-";
        const safeDept = empInfo.dept || "-";
        const safeCenter = empInfo.center || "-";
        
        for (const date in (info.daily || {})) {
            if (date >= range.start && date <= range.end) {
                const d = new Date(date);
                // "주말 표시"를 끄면 주말 활동은 실행 횟수·트렌드·요일별 통계 어디에도 안 잡혀야 하는데,
                // 예전엔 여기서는 항상 다 잡고 아래쪽(기능별 비중) 및 모달의 TOP 사용자/센터 집계만
                // 주말을 걸러내서, 같은 기간인데 "전체 실행 횟수"와 "TOP 사용자 합계"가 안 맞았다
                // (특히 주말에 테스트하면 막대 숫자는 올라가는데 그 사람이 TOP 목록엔 안 보임).
                if (!showWeekend && (d.getDay() === 0 || d.getDay() === 6)) continue;

                const count = info.daily[date];
                filteredCount += count;
                trendStats[date] = (trendStats[date] || 0) + count;
                dailyStats[date] = count;
                dowStats[d.getDay()] += count;
            }
        }

        let userFeatures = {};
        if (info.features) {
            for (const fKey in info.features) {
                const fData = info.features[fKey];
                let fCount = 0;
                for (const date in (fData.daily || {})) {
                    if (date >= range.start && date <= range.end) {
                        const d = new Date(date);
                        if (!showWeekend && (d.getDay() === 0 || d.getDay() === 6)) continue;
                        fCount += fData.daily[date];
                    }
                }
                if (fCount > 0) {
                    userFeatures[fKey] = fCount;
                    featureStats[fKey] = (featureStats[fKey] || 0) + fCount;
                }
            }
        }

        if (filteredCount === 0) continue;

        totalUsageCount += filteredCount;
        const lastVersion = info.lastVersion || '-';
        
        userList.push({
            empId, name: safeName, dept: safeDept, center: safeCenter,
            filteredCount, lastVersion, lastRunAt: info.lastRunAt, 
            userFeatures, dailyStats
        });

        // 실행 횟수가 아니라 '사람 수'로 센다 — 몇 명이 어느 버전을 쓰는지가 알고 싶은 값이다.
        versionStats[lastVersion] = (versionStats[lastVersion] || 0) + 1;
        
        // 예전엔 소속이 "OO센터"로 끝나는 사람만 담당별/센터별 차트에 잡았는데, 그러면 소속이
        // 다르게 적혀 있거나 비어있는 사람은 조용히 빠졌다 — 이제는 전부 잡는다.
        deptStats[safeDept] = (deptStats[safeDept] || 0) + filteredCount;
        const centerKey = centerDisplayName(safeCenter);
        centerStats[centerKey] = (centerStats[centerKey] || 0) + filteredCount;
    }

    userList.sort((a, b) => b.filteredCount - a.filteredCount);
    userList.forEach((u, i) => u.globalRank = i);
    window.currentUserData = userList;

    updateUnregisteredAlert();

    document.getElementById('kpiTotalUsage').innerText = totalUsageCount.toLocaleString();
    document.getElementById('kpiTotalUsers').innerText = userList.length + '명';
    const topDept = Object.entries(deptStats).sort((a,b)=>b[1]-a[1])[0]; document.getElementById('kpiTopDept').innerText = topDept ? topDept[0] : '-';
    const topCenter = Object.entries(centerStats).sort((a,b)=>b[1]-a[1])[0]; document.getElementById('kpiTopCenter').innerText = topCenter ? topCenter[0].replace('센터', '').trim() : '-';
    const topFeature = Object.entries(featureStats).sort((a,b)=>b[1]-a[1])[0]; document.getElementById('kpiTopFeature').innerText = topFeature ? (featureNames[topFeature[0]] || topFeature[0]) : '-';
    const topVer = Object.entries(versionStats).sort((a,b)=>b[1]-a[1])[0];
    document.getElementById('kpiTopVersion').innerText = topVer ? 'v' + topVer[0] : '-';
    // 몇 명이 그 버전을 쓰는지 함께 보여줘야 '가장 많이'가 어느 정도인지 읽힌다.
    document.getElementById('kpiTopVersionSub').innerText =
        topVer ? `${userList.length}명 중 ${topVer[1]}명` : 'Most Used Version';

    let insights = [];
    if(totalUsageCount > 0) insights.push(`<span class="material-symbols-outlined" style="font-size:15px; vertical-align:text-bottom;">bar_chart</span> 조회된 기간 동안 총 <b><span class="highlight">${totalUsageCount.toLocaleString()}회</span></b>의 진단이 수행되었습니다.`);
    if(topCenter) insights.push(`<span class="material-symbols-outlined" style="font-size:15px; vertical-align:text-bottom;">domain</span> <b><span class="highlight">${escapeHtml(topCenter[0].replace('센터', '').trim())}센터</span></b>에서 앱 활용도가 가장 높게 나타납니다.`);
    if(topFeature) insights.push(`<span class="material-symbols-outlined" style="font-size:15px; vertical-align:text-bottom;">insights</span> 서비스매니저들이 가장 많이 의존하는 핵심 기능은 <b><span class="highlight">${featureNames[topFeature[0]] || topFeature[0]}</span></b> 입니다.`);
    if(userList.length > 0 && userList[0].name !== '-') insights.push(`<span class="material-symbols-outlined" style="font-size:15px; vertical-align:text-bottom;">emoji_events</span> 우수 활용자: <b><span class="highlight">${escapeHtml(userList[0].name)}</span></b> 서비스매니저가 압도적인 1위를 기록 중입니다! 멋집니다.`);
    
    const tickerStr = insights.length > 0 ? insights.join(' &nbsp;&nbsp;&nbsp;&nbsp; <span class="material-symbols-outlined" style="font-size:15px; vertical-align:text-bottom; color:var(--lg-yellow);">bolt</span> &nbsp;&nbsp;&nbsp;&nbsp; ') : "데이터를 수집하여 지능형 분석을 준비 중입니다...";
    document.getElementById('aiTicker').innerHTML = tickerStr + ' &nbsp;&nbsp;&nbsp;&nbsp; <span class="material-symbols-outlined" style="font-size:15px; vertical-align:text-bottom; color:var(--lg-yellow);">bolt</span> &nbsp;&nbsp;&nbsp;&nbsp; ' + tickerStr;

    const gridColor = isLightMode ? 'rgba(0, 0, 0, 0.1)' : 'rgba(255, 255, 255, 0.1)';

    const trendCtx = document.getElementById('trendChart').getContext('2d');
    const gradientFill = trendCtx.createLinearGradient(0, 0, 0, 300);
    gradientFill.addColorStop(0, 'rgba(255, 75, 92, 0.6)'); gradientFill.addColorStop(1, 'rgba(255, 75, 92, 0.0)');
    
    const trendSorted = Object.entries(trendStats).sort((a, b) => a[0].localeCompare(b[0]));
    let displayTrend = [];
    for(let i=0; i<trendSorted.length; i++) {
        const d = new Date(trendSorted[i][0]);
        if(!showWeekend && (d.getDay() === 0 || d.getDay() === 6)) continue;
        displayTrend.push(trendSorted[i]);
    }

    // 휴대폰에서는 한 화면에 5일씩 보여주고, 나머지 기간은 좌우로 밀어 본다.
    stretchChartToFit('trendChartWrapper', displayTrend.length, 5);

    if (chartInstances['trendChart']) chartInstances['trendChart'].destroy();
    // 축에는 '8/19' 만 쓰고, 연도를 포함한 전체 날짜는 툴팁에서 보여준다.
    chartInstances['trendChart'] = new Chart(trendCtx, { type: 'line', data: { labels: displayTrend.map(t => shortDate(t[0])), datasets: [{ label: '앱 실행', data: displayTrend.map(t => t[1]), borderColor: themeColors.red, backgroundColor: gradientFill, borderWidth: 2, fill: true, tension: 0.4, pointBackgroundColor: '#1e1e1e', pointBorderColor: themeColors.red, pointRadius: 3, pointHoverRadius: 6 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { title: items => displayTrend[items[0].dataIndex][0] } } }, scales: { x: { grid: { display: false }, ...flatTicks() }, y: { beginAtZero: true, grid: { color: gridColor } } } } });
    
    scrollTrendToLatest(displayTrend.length);

    const top10 = userList.slice(0, 10);
    stretchChartToFit('top10ChartWrapper', top10.length, 5);   // 한 화면에 5명씩, 나머지는 밀어서
    createChart('top10Chart', {
        type: 'bar', 
        data: { 
            labels: top10.map((u, i) => { 
                let dName = u.name !== '-' ? u.name : getMaskedId(u.empId); 
                if (typeof dName === 'string' && dName.includes('(')) {
                    let idx = dName.indexOf('(');
                    return [dName.substring(0, idx).trim(), dName.substring(idx).trim()];
                }
                return dName;
            }), 
            datasets: [{ 
                label: '실행 횟수', 
                data: top10.map(u => u.filteredCount), 
                backgroundColor: top10.map((_, i) => i === 0 ? themeColors.yellow : i === 1 ? '#b0bec5' : i === 2 ? '#a1887f' : themeColors.red), 
                borderRadius: 4 
            }] 
        }, 
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false }, ...flatTicks() }, y: { beginAtZero: true, grid: { color: gridColor } } } }
    });
    
    // PC 상세정보 세부 버튼(dmiOnline 등)·PC 점검 12항목·롬라이팅 성공/실패 같은 하위 항목
    // (featureChildKeys)은 메인 차트에 안 보인다 — 상위 메뉴(pcInfo/diagnostics/romWriter) 막대
    // 하나로 뭉쳐 보이고, 그 막대를 클릭하면 openFeatureGroupModal이 하위 항목만 따로 보여준다.
    // 그렇게 안 하면 메인 차트가 10개 남짓에서 30개 가까이로 늘어나 한눈에 안 들어온다.
    // [기능상세] 버튼(openFeatureDetailGroupBtn)이 나중에 다시 쓸 수 있게 저장해 둔다.
    globalFeatureStats = featureStats;

    const featureSorted = Object.entries(featureStats)
        .filter(([k]) => !featureChildKeys.has(k))
        .sort((a, b) => b[1] - a[1]);

    // 가로 막대라 항목이 세로로 쌓인다. 높이가 모자라면 Chart.js 가 라벨을 건너뛰므로
    // 항목 수에 맞춰 카드 높이를 늘려 전부 보이게 한다.
    const featureBox = document.getElementById('featureChartBox');
    if (featureBox) {
        const minHeight = isNarrowScreen() ? 155 : 280;
        featureBox.style.height = Math.max(minHeight, featureSorted.length * 27) + 'px';
    }

    createChart('featureChart', {
        type: 'bar', 
        // palette는 6색뿐이라, featureKey가 6개보다 많아지면(지금은 30개 가까이) 그냥 palette를
        // 통째로 넘기면 나머지 막대는 색이 안 입혀진다 — 인덱스로 순환시켜 항상 색이 채워지게 한다.
        data: { labels: featureSorted.map(f => featureNames[f[0]] || f[0]), datasets: [{ data: featureSorted.map(f => f[1]), backgroundColor: featureSorted.map((_, i) => palette[i % palette.length]), borderRadius: 4 }] },
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
                if (elements.length > 0) {
                    const index = elements[0].index;
                    const fKey = featureSorted[index][0];
                    const fName = featureNames[fKey] || fKey;
                    // 예전처럼 TOP 사용자/TOP 센터 랭킹부터 그대로 보여준다. 하위 항목이 있는
                    // 상위 메뉴(pcInfo/diagnostics/romWriter)는 openFeatureDetailModal 안에서
                    // [기능상세] 버튼으로 세부 항목 비중을 추가로 볼 수 있다.
                    openFeatureDetailModal(fKey, fName);
                }
            }
        } 
    });
    
    const deptSorted = Object.entries(deptStats).sort((a, b) => b[1] - a[1]);
    createChart('deptChart', { type: 'doughnut', data: { labels: deptSorted.map(d => d[0]), datasets: [{ data: deptSorted.map(d => d[1]), backgroundColor: [themeColors.red, themeColors.orange, themeColors.blue, themeColors.green], borderColor: isLightMode ? '#ffffff' : '#1e1e1e', borderWidth: 2 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { color: isLightMode ? '#636e72' : '#f0f0f0', font: {size: 11}, padding: 10, boxWidth: 12 } } }, cutout: '65%' } });
    
    let dowLabels = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일'];
    let displayDowLabels = showWeekend ? dowLabels : ['월요일', '화요일', '수요일', '목요일', '금요일'];
    let displayDowStats = showWeekend ? dowStats : dowStats.slice(1, 6);

    // 휴대폰에서는 '월요일'이 다 안 들어가므로 '월'로 줄인다. 툴팁에는 전체 요일명을 남긴다.
    const dowFull = displayDowLabels;
    if (isNarrowScreen()) displayDowLabels = displayDowLabels.map(d => d.charAt(0));

    createChart('dowChart', { type: 'bar', data: { labels: displayDowLabels, datasets: [{ data: displayDowStats, backgroundColor: themeColors.purple, borderRadius: 4 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false }, tooltip: { callbacks: { title: items => dowFull[items[0].dataIndex] } } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, grid: { color: gridColor } } } } });

    const centerSorted = Object.entries(centerStats).sort((a, b) => b[1] - a[1]);
    // 휴대폰에서는 한 화면에 5개 센터씩, PC 에서는 기존처럼 센터당 50px 로 늘려 둔다.
    if (isNarrowScreen()) {
        stretchChartToFit('centerChartWrapper', centerSorted.length, 5);
    } else {
        document.getElementById('centerChartWrapper').style.width = (centerSorted.length * 50) + 'px';
    }
    createChart('centerChart', { type: 'bar', data: { labels: centerSorted.map(c => c[0].replace('센터', '').trim()), datasets: [{ data: centerSorted.map(c => c[1]), backgroundColor: themeColors.blue, borderRadius: 4 }] }, options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { x: { grid: { display: false }, ...flatTicks() }, y: { beginAtZero: true, grid: { color: gridColor } } } } });

    updateTable();
}
