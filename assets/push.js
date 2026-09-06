/* ============================================================
   FCM 푸시 등록 — 안드로이드 앱(Capacitor 네이티브 셸) 안에서 실행 중일 때만 동작한다.
   일반 브라우저(PC 크롬 등)에서는 Capacitor 브리지 자체가 없으므로 아무 것도 하지 않는다.
   ============================================================ */

/** 지금 이 페이지가 Capacitor 로 감싼 안드로이드 앱 안에서 실행 중인지. */
function isNativeApp() {
    return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}

/**
 * 로그인 직후(대시보드 진입 시) 호출한다. 알림 권한을 요청하고, 이 기기의 FCM 토큰을 발급받아
 * fcm_tokens/{계정} 에 저장해 둔다 — sendPushToAdmins() 가 이 목록을 대상으로 발송한다.
 * Super Admin·관리자에게만 의미가 있으므로 그 외 권한은 등록하지 않는다.
 *
 * 계정당 토큰 1개만 유지한다(새로 등록하면 이전 값을 덮어씀) — APK를 재설치하는 등으로 토큰이
 * 바뀌어도 옛 토큰이 계속 쌓여 같은 기기에 알림이 중복으로 가는 걸 막기 위해서다.
 */
async function registerPushIfNative() {
    if (!isNativeApp() || !loggedInUser) return;
    if (userRole !== 'admin' && userRole !== 'manager') return;

    const PushNotifications = window.Capacitor.Plugins && window.Capacitor.Plugins.PushNotifications;
    if (!PushNotifications) return;

    try {
        let perm = await PushNotifications.checkPermissions();
        if (perm.receive !== 'granted') perm = await PushNotifications.requestPermissions();
        if (perm.receive !== 'granted') return; // 사용자가 알림 권한을 거부함

        PushNotifications.addListener('registration', async (token) => {
            try {
                await fetch(authDbUrl(`fcm_tokens/${loggedInUser}`), {
                    method: 'PUT',
                    body: JSON.stringify({ token: token.value, role: userRole, updatedAt: Date.now() }),
                    headers: { 'Content-Type': 'application/json' }
                });
            } catch (e) { console.error('FCM 토큰 저장 실패:', e); }
        });

        PushNotifications.addListener('registrationError', (err) => {
            console.error('FCM 등록 실패:', err);
        });

        await PushNotifications.register();
    } catch (e) {
        console.error('푸시 알림 초기화 실패:', e);
    }
}
