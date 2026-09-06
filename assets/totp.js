/* ============================================================
   TOTP (RFC 6238) — 구글 OTP(Google Authenticator) 호환 2차 인증
   Super Admin 로그인에만 사용한다. index.html 전용 스크립트.
   ============================================================ */

const TOTP_ISSUER = 'gramAnalyzerPro';
const TOTP_STEP   = 30;   // 초
const TOTP_DIGITS = 6;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(bytes) {
    let bits = '';
    for (const b of bytes) bits += b.toString(2).padStart(8, '0');

    let output = '';
    for (let i = 0; i + 5 <= bits.length; i += 5) {
        output += BASE32_ALPHABET[parseInt(bits.substr(i, 5), 2)];
    }
    const rem = bits.length % 5;
    if (rem !== 0) {
        const chunk = bits.substr(bits.length - rem).padEnd(5, '0');
        output += BASE32_ALPHABET[parseInt(chunk, 2)];
    }
    return output;
}

function base32Decode(str) {
    str = (str || '').toUpperCase().replace(/[^A-Z2-7]/g, '');

    let bits = '';
    for (const ch of str) {
        const idx = BASE32_ALPHABET.indexOf(ch);
        if (idx === -1) continue;
        bits += idx.toString(2).padStart(5, '0');
    }
    const bytes = [];
    for (let i = 0; i + 8 <= bits.length; i += 8) {
        bytes.push(parseInt(bits.substr(i, 8), 2));
    }
    return new Uint8Array(bytes);
}

/** 새 계정용 무작위 시크릿(160bit)을 만든다. */
function generateTotpSecret() {
    const bytes = new Uint8Array(20);
    crypto.getRandomValues(bytes);
    return base32Encode(bytes);
}

/** Google Authenticator 앱이 QR로 스캔하는 등록 URI. */
function totpAuthUrl(secret, accountId) {
    const label  = encodeURIComponent(`${TOTP_ISSUER}:${accountId}`);
    const issuer = encodeURIComponent(TOTP_ISSUER);
    return `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP}`;
}

async function hotp(secretBytes, counter) {
    const counterBuf = new ArrayBuffer(8);
    const view = new DataView(counterBuf);
    // counter 는 30초 단위 카운터라 32bit 로 충분하지만, 상위 4바이트도 규격대로 채운다.
    view.setUint32(0, Math.floor(counter / 0x100000000));
    view.setUint32(4, counter >>> 0);

    const key = await crypto.subtle.importKey(
        'raw', secretBytes, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
    );
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, counterBuf));

    const offset = sig[sig.length - 1] & 0x0f;
    const code = ((sig[offset] & 0x7f) << 24) |
                 ((sig[offset + 1] & 0xff) << 16) |
                 ((sig[offset + 2] & 0xff) << 8) |
                 (sig[offset + 3] & 0xff);

    return String(code % (10 ** TOTP_DIGITS)).padStart(TOTP_DIGITS, '0');
}

async function generateTotp(secret, stepOffset = 0) {
    const secretBytes = base32Decode(secret);
    const counter = Math.floor(Date.now() / 1000 / TOTP_STEP) + stepOffset;
    return hotp(secretBytes, counter);
}

/** 기기 시계 오차를 감안해 앞뒤 1스텝(총 90초)까지 허용한다. */
async function verifyTotp(secret, token) {
    token = (token || '').trim();
    if (!secret || !/^\d{6}$/.test(token)) return false;

    for (const offset of [0, -1, 1]) {
        if (await generateTotp(secret, offset) === token) return true;
    }
    return false;
}
