/* ============================================================
   FCM 발송용 서비스 계정 설정 — 이 파일은 절대 다른 사람과 공유하지 마세요.
   (Firebase 데이터베이스가 아니라 "푸시 발송 권한"만 담긴 키지만, 그래도 비밀 값입니다.)

   설정 방법
   1. https://console.cloud.google.com → 프로젝트 gap-tracker-b19d1 선택
      → IAM 및 관리자 → 서비스 계정 → "서비스 계정 만들기"
      - 이름: 아무거나 (예: gap-fcm-sender)
      - 역할: "Firebase Cloud Messaging API 관리자" (Firebase Cloud Messaging API Admin) 하나만 부여
        (이 역할은 푸시 "발송"만 가능하고 DB 데이터에는 접근하지 못합니다.)
   2. 방금 만든 서비스 계정 클릭 → 키 탭 → 키 추가 → 새 키 만들기 → JSON → 다운로드
   3. 다운로드된 .json 파일을 열어 아래 3개 값을 그대로 옮겨 적으세요.
      (project_id, client_email, private_key — 파일 안의 키 이름과 동일합니다)

   설정 전까지는 project_id 가 비어 있어 푸시 발송 코드가 조용히 아무 것도 하지 않습니다
   (배너 알림 자체는 이 파일과 무관하게 정상 작동합니다).
   ============================================================ */
const FCM_SENDER_CONFIG = {
    project_id: 'gap-tracker-b19d1',
    client_email: 'firebase-adminsdk-fbsvc@gap-tracker-b19d1.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCvt0ynkFiL8jNZ\nGb8SSpcxQZjQo80vc7P/MRLj9LRNRENhRe3/7tsZJBNPwnxSEOk7TuDUUklw1His\ngkSNaC26TER7jkGpkNpyVG0QKzv3GLyC1rCB0V97wKNUFMImm+RHHYmNjtwtuwIF\nDhCqhadl2zdrJHXQ/scqO1QDkpKtzd4U1HxhVPTdtrIR2bQXSmQNGSfliOJ+BARZ\n56icRCcF/KAVgL+boncP9f1u2cz06hyOBpQGE9OMcpraY7PW9IPCZNiJrnBeQ2Uk\no4tF0qqQXX3phaT0ehu/YktbxFWt/2UZs2h69zV2uP2v2TvgzOHJcRDONcBlLt1O\njleKuud3AgMBAAECggEABFtMl/KUJ3NSKTLiUf9Hpi2xe5Bo7XTDPgZtW/m8uklN\n5flrlob8p3zSZI3DZe6yaBYjRlBiyFyt2auCX8+SvRKk0TvSzlpfkcPpglc4FBic\nAx7a+Htq9r2gSKmzfwaQqRMgtNuAA26mdN6g58FxlMZtjNQC5QAnV8yc+PIafegM\nVkr0xltQXWII0A8jNn2/03WP7IMe0me0CZKE9NcLeZt01HSSP6nhAEx1Ii6nJGAM\niLJjDI3K4aSiP3xOYACw7cC8x4YLaqXxcbSPnBtw9oEZHWBp4tOyixvC0foDNZKA\nS3sphw2oy+wAnwGCHe62f3WJczWzgfK9K1MciK8p3QKBgQDmG2SKEAKTiC+LLdLr\nUZU++LRPisk3CUic+AxywZhixeV5krfSfSK7NtQtN37cJgDmxR51sBywW8r1UNrS\nJc9rdlvKtY/DbB1bzSwJ9+0s8GvS7IVeb1b9hAb5WUq+gVFjvWsROba1MZ4TDvij\nS095obEYvLr5t0qrt/w/FPVqzQKBgQDDfRXpsqAUX0/SWfWJgx4x+0RQaQP+Nkan\naeXnQoLBI3F3iTp4dwljn+7PV+wuM0lMGiaoa5sfr9dSdYR+AoYbrWfMY6R1iY8H\nHNOa+VEJrYvrmk71/aX7dcZeq60wlOFjDxMyz8GeoeaywrLC/U81fgCD2nixl271\nmX0FqkxjUwKBgA01cVYDiUJSxPfmT382layhtigCvX4tSD/KdVx5BHhXB88svuSU\nTlQU16Uo1F1qyQ52LkNvMpZlDod6drUtenSevLIsLe533E+SvX5s/u5fdrEK5rT/\nCy1OUOArYgEBh1yEWQsKFxTbnklVyKwG/K7suy/CVbFT9jNZQl+UomnZAoGBAJUe\nrcB/Ca2ApxsGlE45PqdRzGKqOOmJ7Yt3NHCcQ7Ggn8VXYMrTws3ECh8QKpFzfc4X\nhLWkn8gkElRMYKzer/4c4LkAqUsfi4MZcjEdTbvcLoeiRelPe3W9+Xvt6UbNysAN\nl8+Cu2eOiLSD4GjtYaakXzA1TyvpIDMoyj2wEmURAoGAOsNuteUJAvPjducY2YCJ\nXpCzaXlUByYpODQjDYP1jmEKAUG7BwDLaqR4CL2W0DXvZN5GL/AO4jqkNrUUwz0z\naugVYyMoitBupic/u/fBmCBwLqKDzEeIkN9Vxs51xZrKN4oAXaIRrpaJFMffPpU1\nX99u59TyQha7zMIlh/KYhgg=\n-----END PRIVATE KEY-----\n'
};
