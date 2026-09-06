/* ============================================================
   FCM 푸시 발송 — 서버(Cloud Functions) 없이, 지금 대시보드를 열어 놓은 브라우저/앱이
   직접 구글 OAuth2로 인증해 FCM HTTP v1 API를 호출한다.

   fcm-sender-config.js 에 서비스 계정 키가 채워져 있어야 동작하고, 없으면 조용히 아무 것도 하지 않는다.
   따라서 "누군가는 대시보드를 열어(혹은 라이브 모드 켜)두고 있을 때"만 다른 기기로 푸시가 나간다 —
   서버 상시 감시가 아니라는 한계는 있지만, 무료 요금제로 서버 없이 구현할 수 있는 방식이다.
   ============================================================ */

const FCM_SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

function base64UrlEncode(bytes) {
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function pemToArrayBuffer(pem) {
    const b64 = pem.replace(/-----BEGIN PRIVATE KEY-----/, '')
                    .replace(/-----END PRIVATE KEY-----/, '')
                    .replace(/\s+/g, '');
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
}

let cachedFcmAccessToken = null; // { token, expiresAt }

/** 서비스 계정 키로 OAuth2 access token 을 발급받는다(1시간 유효, 만료 전까지 재사용). */
async function getFcmAccessToken() {
    if (!FCM_SENDER_CONFIG.private_key || !FCM_SENDER_CONFIG.client_email) return null;

    if (cachedFcmAccessToken && cachedFcmAccessToken.expiresAt > Date.now() + 30000) {
        return cachedFcmAccessToken.token;
    }

    try {
        const now = Math.floor(Date.now() / 1000);
        const header = { alg: 'RS256', typ: 'JWT' };
        const claim = {
            iss: FCM_SENDER_CONFIG.client_email,
            scope: FCM_SCOPE,
            aud: 'https://oauth2.googleapis.com/token',
            iat: now,
            exp: now + 3600
        };

        const encHeader = base64UrlEncode(new TextEncoder().encode(JSON.stringify(header)));
        const encClaim = base64UrlEncode(new TextEncoder().encode(JSON.stringify(claim)));
        const signInput = `${encHeader}.${encClaim}`;

        const key = await crypto.subtle.importKey(
            'pkcs8', pemToArrayBuffer(FCM_SENDER_CONFIG.private_key),
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']
        );
        const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(signInput)));
        const jwt = `${signInput}.${base64UrlEncode(sig)}`;

        const res = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}&assertion=${jwt}`
        });
        const data = await res.json();
        if (!data.access_token) { console.error('FCM 액세스 토큰 발급 실패:', data); return null; }

        cachedFcmAccessToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
        return data.access_token;
    } catch (e) {
        console.error('FCM 액세스 토큰 발급 중 오류:', e);
        return null;
    }
}

/**
 * 등록된 Super Admin·관리자 기기 전체에 푸시를 보낸다.
 * 설정이 안 돼 있거나 통신에 실패해도 예외를 던지진 않는다 — 화면 배너 알림은 이 함수와 무관하게
 * 항상 동작해야 한다. 대신 실제로 하나라도 성공했는지를 boolean으로 돌려줘서, 호출한 쪽(pushOncePerId)이
 * 실패 시 "보낸 걸로 표시"하지 않고 다음 폴링에서 다시 시도할 수 있게 한다.
 *
 * @returns {Promise<boolean>} 하나 이상 성공적으로 전송됐으면 true.
 */
async function sendPushToAdmins(title, body, dataPayload) {
    try {
        const accessToken = await getFcmAccessToken();
        if (!accessToken) return false;

        const tokensSnap = await (await fetch(authDbUrl('fcm_tokens'))).json();
        if (!tokensSnap) return false;

        // fcm_tokens/{계정} = { token, role, updatedAt } — 계정당 최신 토큰 1개만 저장돼 있다.
        // 같은 기기로 여러 계정을 번갈아 로그인했다면 서로 다른 계정 밑에 같은 토큰이 중복 저장될 수
        // 있으므로, 토큰 값 자체로 한 번 더 중복 제거한다 — 안 그러면 같은 폰에 알림이 여러 번 간다.
        const targets = [...new Set(
            Object.values(tokensSnap)
                .filter(t => t && t.token && (t.role === 'admin' || t.role === 'manager'))
                .map(t => t.token)
        )];
        if (targets.length === 0) return false;

        const results = await Promise.all(targets.map(async token => {
            try {
                const res = await fetch(`https://fcm.googleapis.com/v1/projects/${FCM_SENDER_CONFIG.project_id}/messages:send`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        message: {
                            token,
                            notification: { title, body },
                            data: dataPayload || {},
                            android: { priority: 'high', notification: { channel_id: 'gap_default_channel' } }
                        }
                    })
                });
                if (!res.ok) { console.error('FCM 발송 실패:', res.status, await res.text()); }
                return res.ok;
            } catch (e) {
                console.error('FCM 발송 실패:', e);
                return false;
            }
        }));

        return results.some(ok => ok);
    } catch (e) {
        console.error('sendPushToAdmins 오류:', e);
        return false;
    }
}
