# gram Analyzer Pro (GAP) — 기능·로직 완전 명세

LG gram 노트북 **서비스·진단 전용 통합 도구**. Windows 정상 환경과 커스텀 **Windows PE(WTG)** 양쪽에서 동작한다. 이 문서는 **처음 보는 사람도 개발자 수준으로 이해**할 수 있도록, **사이드 메뉴 순서대로** 각 화면의 모든 버튼과 그 내부 동작(참조 파일·서버 주소·판정 조건까지)을 기술한다.

> ⚠️ LG 서비스매니저 수리 목적 전용(앱 시작 시 EULA 명시). **항상 관리자 권한**(`app.manifest: requireAdministrator`)으로 실행된다.

---

## 0. 기본 정보

| 항목 | 값 |
|---|---|
| 프로젝트 / 산출물 | `PCInfoDashboard` → **`gramAnalyzerPro.exe`** |
| 네임스페이스 | `PCInfoDashboard` |
| 프레임워크 | .NET 8 WPF (`net8.0-windows10.0.26100.0`) |
| 외부 리소스 기준 경로 | `AppDomain.CurrentDomain.BaseDirectory`(= exe 폴더) |
| 데이터 수집 | 일반 Windows → **WMI**, PE → **Direct(IOCTL/레지스트리)** (`CollectorFactory`가 자동 분기) |
| 로그 | `<exe폴더>\gramAnalyzerPro.log` (`AppLogger`) |

**사이드 메뉴 순서**: 홈 → PC 상세정보 → 시스템 설정 → PC 점검하기 → *(구분선)* → Aging Test → 이벤트 로그 → BSOD 분석 → 롬라이팅 → DDU → 로그전송

---

## 1. 홈

간단 사양 요약 화면. 시작 시 `CollectHomeQuick()`(느린 SMART/배터리 제외)로 빠르게 먼저 채우고, 전체 수집이 끝나면 갱신한다.

### 표기 정보
- CPU / RAM / GPU / 저장장치 / **Windows 버전** / 모델·제조번호 등 핵심 사양 한눈 보기.
- Windows 버전 행 우측 **[업데이트 이력]** 버튼 → WUA COM으로 설치 이력 조회, 카테고리(품질/드라이버/기능/정의/기타) 필터·정렬, 행 더블클릭 시 전체 내용(`UpdateHistoryDialog`).

### 버튼·동작
- **"홈" 타이틀 클릭 → 창 해상도(크기) 설정** (`MainWindow.Resolution.cs` → `ResolutionDialog`)
  - 현재 창 크기를 넘겨 팝업 표시. 선택 시 **즉시 적용 + `WindowSizeManager`로 저장**(다음 실행부터 그 크기로 시작).
  - "기본값 복원" 선택 시 저장 초기화 후 기본 크기로. PE에서는 시작 시 최대화가 우선이라 영향 없음.
- **Wi-Fi 행 [연결] 버튼** (`MainWindow.WifiConnect.cs` → `WifiConnectDialog`)
  - `netsh wlan` 기반. **[검색]** = `netsh wlan show networks`로 주변 SSID 목록 파싱(위치권한 거부 시 안내). **[연결]** = SSID/암호로 프로필 XML 생성 → `netsh wlan add profile` → 연결. 비동기 실행, 상태 문구 표시.

---

## 2. PC 상세정보

시스템/BIOS/OS/CPU/RAM/GPU 카드 + 하단 3개 카드(포트/네트워크/전원이력). 카드는 `MainWindow.UiBuilders.cs`가 코드로 생성한다.

### 2-1. 시스템 정보 (`BuildSystem`)
**표기**: 제조사 · 모델명(복사 가능) · 제조번호(복사 가능)

**[모델/제번입력] — Online / Offline 버튼** (DMI 기록: 모델명·제조번호를 메인보드에 쓰는 작업)

- **Offline** (`RunDmiUpdate`) — 전부 **로컬 파일**로 처리. 판정 순서:
  1. `yamlDB\ModelDataFile.yaml`에서 감지된 모델 조회(**MS 보드 포함 우선**) → 있으면 `{biosBaseDir}\{executeDMIFlashFile}` 로컬 실행(`ExecuteDmiFlash`).
  2. yaml에 없고 **MS로 시작**(데스크탑 보드) → `DT_DMI\amidewinx64.exe` 로 폴백(`RunMsModelDmi`). `DmiUpdateDialog`로 모델/제번을 입력받아 `amidewinx64 /SP "모델" /SS "제번"` 직접 기록.
  3. yaml 파일 자체가 없음 → "yamlDB 폴더에 파일을 넣어주세요" 오류.
  4. 일반 gram인데 yaml에 없음 → 모델명 입력 팝업(→ 다중 매칭 드롭다운) 후 재조회.
  - `biosBaseDir`(폴더)와 `executeDMIFlashFile`(그 안의 배치)이 **둘 다 있어야** 실행된다.

- **Online** (`RunDmiOnline`) — 서버에서 압축을 받아 그 안의 실행 파일을 돌린다.
  - **MS 보드**: `https://liu.lge.com/SmartBIOS/DT/DMI/{모델}.ZIP` 다운(예: `MS-BA03.ZIP`) → 압축 내 **`FLASH_ModelName.bat`** 실행. 서버에 없으면 **"서버에 해당 모델 DMI 파일이 없습니다"**.
  - **gram 보드**: `CheckAsync`로 `info.xml` 조회 → `<download_file>` zip 다운 → 압축 내 **`executeDMIFlashFile`**(yaml 값) 실행. (경로는 아래 BIOS와 동일 규칙, 실행 파일만 다름)
  - 진행률은 버튼에 `%` 표기, 완료 시 토스트. 실패 안내의 "BIOS"는 "DMI"로 치환해 표시.

**[로고변경] — Unlock / Run 버튼** (부팅 로고 변경)
- **Unlock** (`RunLogoUnlock`) — yaml의 `logoBaseDir` + `executeLogoFlashFile`이 있으면 `{logoBaseDir}\{실행파일}` 로컬 실행. 로고 대상 아니면 "로고변경 대상 모델이 아닙니다".
- **Run** (`OpenLogoFolder`) — yaml의 `logoBaseDir` 폴더를 **탐색기로 연다**(로고 이미지 교체용).

### 2-2. BIOS (`BuildBios`)
**표기**: BIOS 버전 · BIOS 날짜 · 메인보드 모델

**[BIOS Update] — Online / Offline 버튼**

- **Online** (`BiosUpdateChecker.CheckAsync`)
  1. **연도 판별**(`GetYear`): 2016~2019는 명시적 매핑, 2020년 이후는 모델명 내 연도 문자(N=2020…U=2026).
  2. 조회 URL: **`https://liu.lge.com/SmartBIOS/{연도}/{모델대문자}/info.xml`** (예: `16Z90Q` → `.../SmartBIOS/2022/16Z90Q/info.xml`).
  3. `info.xml`의 `<latest_version>`으로 최신 여부 판단, `<download_file>`로 zip URL 구성: `.../SmartBIOS/{연도}/{모델}/{download_file}`.
  4. `BiosCheckDialog`에 릴리스 노트·진행률 표시 → 다운로드 → 압축 해제 → 압축 내 **`<flash_name>`**(info.xml 값, 예: `BIOS64.BAT`) `runas` 실행.
  - MS 보드는 yaml에 있으면 지원, 없으면 **"데스크탑은 지원하지 않습니다"**.
  - 미지원 연도/서버에 없음 → 각각 안내 메시지.
- **Offline** (`RunBiosUpdate`) — 모델명 확정 후 `{biosBaseDir}\{executeBIOSFlashFile}` 로컬 실행. yaml에 없으면 모델명 입력 팝업(→ 다중 매칭).

### 2-3. 운영체제 (`BuildOs`)
**표기**: OS 이름 · 버전 · 빌드 · 아키텍처 · 마지막 부팅

**[RDPK] — Check / Run 버튼** (Windows 정품 키/DPK 관련, PE에서도 사용 가능)
- **Check** (`RunRdpkCheck`) → `DPK Checking Tool v1.0\OA3QAClient.exe` (`runas`)
- **Run** (`RunRdpkRun`) → `RDPK\OA3ServiceClient.exe` (`runas`)

### 2-4. 프로세서 / 메모리 / 그래픽
- **CPU** (`BuildCpu`): 모델명 · 제조사 · 코어/스레드(예: `8C / 16T`) · 최대 클럭 · L2/L3 캐시 · **현재 사용률(실시간 바)**.
- **RAM** (`BuildMemory`): 총 용량 · 폼팩터 · 속도 · 제조사 · 부품번호 · **사용률 바**.
- **GPU** (`BuildGpu`, 다중 GPU 나열): 이름 · 제조사 · 드라이버 버전 · 해상도 · 재생률 · 현재 사용률(가능 시).

### 2-5. 포트 연결상태 (`PortInfoProvider`, `MainWindow.Ports.cs`)
> gram 펌웨어의 USB 커넥터 정보가 부정확해, **물리 포트 나열 대신 "현재 연결된 것만"** 표시한다.

**표기되는 LIST(연결된 것만)**
- **HDMI** / **USB-C (영상 출력 · DP Alt)** — DisplayConfig로 감지. 모니터명 + 해상도·주사율(예: `2880×1800 · 60Hz`).
- **USB 연결 장치** — SetupAPI로 열거, `CM_DEVCAP_REMOVABLE`(외장)만. 드라이버키→친숙한 이름(예: `UAS 대용량 저장 장치`). 허브 자체는 제외.
- **3.5mm 오디오 잭** — Core Audio 활성 엔드포인트 중 폼팩터가 헤드폰/마이크/헤드셋인 것(내장 마이크 어레이 제외). 출력/입력 구분.
- **MicroSD 슬롯** — WMI로 카드 리더/삽입 카드(용량) 감지.

**자동 갱신**: 창에 `WM_DEVICECHANGE` 훅을 걸어 USB 착탈 시 0.8초 디바운스 후 목록을 다시 읽는다(**앱 재실행 불필요**). 상세정보 화면일 때만 갱신.
> 안정성: 디스플레이는 `QDC_ONLY_ACTIVE_PATHS` 사용, `DISPLAYCONFIG_PATH_INFO`는 **72바이트**(source에 statusFlags), **비관리 버퍼**로 받아 힙 손상 방지.

### 2-6. 네트워크
**표기되는 모든 정보**
- Wi-Fi/유선 어댑터: 이름 · IP(IPv4/IPv6) · MAC · 속도 · 연결 상태 배지.
- **블루투스 연결 기기**: 기기명 · 배터리(%) · 연결/미연결.

### 2-7. 전원 사용 이력 (`PowerHistoryReader`)
**표기되는 정보**: 각 세션의 `시작 ~ 종료(또는 "진행 중")` · 지속시간 · 종료 유형(사용 중/절전 진입/정상 종료/비정상 종료) · 종료 사유(1074가 있으면). 헤더 우측에 **"비정상 종료 : N회"**.
**최대 기간**: **최근 30일** (`Read(30)`).
**재구성 방식**: System 이벤트 로그의 부팅(Kernel-General 12) · 절전 재개(Power-Troubleshooter 1) · 절전 진입(Kernel-Power 42) · 정상 종료(13) · 비정상 재부팅(41) + 종료 사유(User32 1074)로 "켜짐 구간"을 만든다. 정상 종료 기록 없이 재부팅되면 직전 세션을 "비정상 종료"로 마감.
**카드 높이**: 네트워크 카드 높이에 맞추고, 넘치면 카드 안에서 스크롤.

---

## 3. 시스템 설정

**Windows 기능/설정의 바로가기 모음** 화면. 시작 프로그램·전원·디스플레이 등 자주 쓰는 Windows 설정 페이지(`ms-settings:…`)와 제어판 항목을 버튼으로 바로 연다(`Launch` 헬퍼, `UseShellExecute`).
- PE 환경에서는 의미가 없어 **메뉴 비활성화**(`ApplyPeMode`).

---

## 4. PC 점검하기

12개 진단 타일(6×2) + **전체점검(마법사)**. 코드는 `MainWindow.CheckTab.cs`, 마법사는 `MainWindow.FullCheck.cs`.

### 12개 버튼 동작 로직
| 타일 | 핸들러 | 동작 |
|---|---|---|
| **Wi-Fi** | `Check_Wifi` | Wi-Fi 어댑터/신호/프로필 정보 조회 |
| **블루투스** | `Check_Bluetooth` | BT 어댑터·연결 기기 확인 |
| **키보드** | `Check_Keyboard` | `KeyboardTestWindow` — 실제 키 입력 시각화(눌린 키 하이라이트) |
| **저장장치** | `Check_Disk` | 물리 디스크별 **SMART**(NVMe `PropertyId 50`, SATA `ATA_PASS_THROUGH`), 디스크 탭 선택, **불량섹터 검사**(`ChkdskWindow`, 물리 디스크 단위), System 로그 저장장치 이벤트를 물리 디스크에 귀속(`DiskEventReader` + `EventCatalog` 소스 검증으로 오귀속 방지) |
| **배터리** | `Check_Battery` | Battery Class IOCTL(`BatteryIoctlReader`)로 전압/전류/전력/잔량/FCC/설계/수명/사이클(4열) + 실시간 충·방전 차트(`MiniChart`) + `powercfg /batteryreport` 분석(`BatteryReportAnalyzer`: 노화 추이·이상 방전) |
| **카메라** | `Check_Camera` | OpenCV/AForge로 카메라 영상 출력(IR 카메라는 WinRT MediaCapture) |
| **불량화소** | `Check_Pixel` | `PixelCheckWindow` — 단색 전체화면으로 데드/스턱 픽셀 육안 점검 |
| **LID** | `Check_Lid` | LID 스위치(덮개 열닫) 감지. **앱 내부 구현**(외부 exe·결과 파일 불필요): `RegisterPowerSettingNotification`으로 `GUID_LIDSWITCH_STATE_CHANGE`를 구독해 덮개를 닫았다 열면 상태 변화 감지 → 즉시 PASS. (PE에서는 전원 서비스 필요) |
| **CPU온도** | `Check_CpuTemp` | `LibreHardwareMonitor`로 실시간 온도 그래프 |
| **FAN** | `Check_Fan` | 팬 RPM(인하우스=EC, ODM=센서 노출 모델) |
| **스피커** | `Check_Speaker` | 좌·우·스테레오 톤 재생. WASAPI 우선, 실패 시 WaveOut(WinMM) 폴백(PE 호환). 루프백으로 채널 출력 자동 검증 |
| **마이크** | `Check_Mic` | 6초 녹음 후 입력 감지 PASS/FAIL |

### 전체점검(마법사) PASS 조건 (`MainWindow.FullCheck.cs`)
`TaskCompletionSource` 기반 순차 진행. 순서: **Wi-Fi → 블루투스 → 저장장치 → 배터리 → (FAN) → 스피커 → 마이크 → LID → 키보드 → 카메라 → 불량화소 → CPU온도**. 판정값: `PASS/FAIL/SKIP/ABORT/NA`.

- **Wi-Fi**: 모듈/신호 정보 + 핑 + 속도 측정 자동 실행 → **핑·속도 정상** → 자동 PASS, 아니면 결과 확인 후 수동 판정.
- **블루투스**: 어댑터·연결 기기 감지되면 자동 PASS, 미감지 → FAIL.
- **저장장치**: 모든 디스크 **SMART = 정상(Healthy)** → 자동 PASS. 하나라도 위험/주의 → FAIL. 미확인 → 수동 판정.
- **배터리**: 배터리 **수명(효율) ≥ 60%** → PASS, 그 미만(경고/교체권장) → FAIL, 배터리 없으면 NA.
- **FAN**: 고속(UP)·저속(DOWN) 구동 후 **RPM 변화량 ≥ 1000RPM** → PASS(듀얼팬은 두 팬 모두), 변화 거의 없으면 FAIL. 종료 시 자동 제어로 복귀. **미지원(ODM) 모델은 단계 자체 제외**(NA).
- **스피커**: 좌/우 채널 우세 + 스테레오 양쪽 신호 → 자동 PASS(루프백 미지원 시에만 수동).
- **마이크**: 6초 녹음에 입력 감지되면 PASS.
- **LID**: 덮개를 닫았다 여는 상태 변화가 감지되면 PASS(앱 내부 전원 알림 방식, 결과 파일 없음).
- **불량화소 · 키보드 · 카메라 · CPU온도**: 모달 창/패널로 확인 후 기술자가 **[이상 없음]/[불량]** 수동 판정.

---

## 5. Aging Test

번들·인앱 부하 테스트 모음. 진입 시 **BurnInTest** 기본 선택. 옵션 영역은 고정 높이라 아래 진행 로그 크기가 일정. (`MainWindow.Aging.cs`)

| 타일 | 동작 |
|---|---|
| **BurnInTest** | `BurnInTest\bit.exe` 실행(별도 창). 테스트 종류/시간은 BurnInTest 자체에서 설정 |
| **전원 반복** | 인앱 리부트/절전(S3) 반복. 반복횟수·딜레이·Windows 암호(자동 로그인용). 재부팅 후 자동 이어서 진행(`aging_state.json`), 완료/중지 시 자동 로그인·전원 설정 원복 |
| **부하 테스트** | CPU 전 코어 과부하, 5초 간격으로 CPU 온도·FAN RPM을 진행 로그에 기록 |
| **디스크 복사(XCopy)** | 임시 대용량 파일을 지정 시간 반복 복사(디스크 부하) |
| **화면 녹화** | `ScreenRecorderLib`로 화면을 .mp4 녹화(증상 재현·확인용) |

---

## 6. 이벤트 로그

Windows **System 로그**를 진단 친화적으로 표시(`MainWindow.EventLog.cs` + `EventCatalog`).
- **확인 가능한 것**: 위험(1)/오류(2)/경고(3) 이벤트를, `EventCatalog`가 **(EventId, 소스) → (카테고리, 의미)** 로 해석해 보여준다(예: 저장장치/디스플레이/전원 등).
- **필터**: "진단 이벤트만" · "노이즈 숨기기"(경고 포함이 기본).
- 같은 ID라도 **소스가 다르면 다른 의미**로 구분(예: ID 11 = FilterManager vs disk) → 오분류 방지.

---

## 7. BSOD 분석

임베드된 `BlueScreenAnalyzer`(UserControl, 별도 어셈블리 `ItGgyu_BSOD`). **PE에서도 사용 가능**(로컬 분석).
- **동작 로직**: 미니덤프(.dmp)를 선택 → **CDB(Windows 디버거, 로컬)**로 스캔(`CdbRunner`) → 원시 로그에서 핵심 요약 추출(`DumpSummary`: 실패 모듈·BugCheck 코드 등).
- **선택적 AI 분석**: `GeminiAnalyzer`로 원인/조치 자연어 해설(API 키 입력 시). 다중 덤프 스캔 후 AI는 별도로 요청.

---

## 8. 롬라이팅 (SPI ROM)

CH341A/CH347 프로그래머로 SPI ROM 읽기/쓰기(`RomWriterPanel`, `SpiEngine`, `CH341DLL`/`CH347DLL`). USB 착탈 자동 인식(`WM_DEVICECHANGE` + 디바운스). 작업 중에는 **모든 버튼 상호 비활성화**(`SetBusy`).

### 버튼 카드 5개 동작
| 카드 | 버튼 | 동작 로직 |
|---|---|---|
| **열기** | **열기** | 파일 선택 대화상자로 ROM(.bin/.rom/.cap)을 열어 메모리(`_romData`)에 로드 + HEX 뷰 |
| | **자동** | `ModelInputDialog`로 모델명 입력(→ 다중 매칭 드롭다운) → `ModelDataFile.yaml`의 **`romFile`**이 가리키는 ROM을 자동 로드(상대경로는 exe 폴더 기준) |
| **롬읽기** | **읽기** | 칩 → 메모리로 읽어 HEX 표시(`ReadSpiChip`) |
| | **저장** | 메모리(`_romData`)를 파일로 저장 |
| **지우기** | **지우기** | 칩 전체 지우기(Chip Erase). 되돌릴 수 없어 확인 |
| **검증** | **검증** | **열린 파일 ↔ 칩 데이터 비교**(`VerifySpiChip`). 파일이 없거나 칩 용량과 크기가 다르면 차단. 일치/불일치를 로그·팝업으로 보고 |
| **자동** | **자동 실행** | 지우기 + 쓰기 (+ "검증" 체크 시 검증까지). 파일 크기가 칩 용량과 다르면 작업 차단 |

- 상단에 프로그래머 장치 상태·제조사/칩 선택 콤보·칩 정보·진행률·HEX 뷰·복사·칩 추가(`AddChipDialog`) 등.

---

## 9. DDU (그래픽 드라이버 제거)

파괴적 제거 로직을 자체 구현하지 않고, **번들된 DDU(Display Driver Uninstaller, MIT 라이선스)** 를 명령줄로 호출(`MainWindow.Ddu.cs`). **PE에서는 비활성화**.

### 동작 로직
1. **감지된 GPU 표시** — 수집이 끝나면 화면 이동 없이 자동 새로고침. GPU 이름으로 벤더 자동 선택(외장 우선).
2. **벤더 선택** — NVIDIA / AMD / Intel / 모든 GPU.
3. **옵션** — 시스템 복원 지점 생성(기본 ON) · 완료 후 재부팅(기본 ON) · Windows Update 드라이버 차단 · NVIDIA 제어판 유지 · 자동 진행(Silent).
4. **경고 확인 후 실행** — `runas`로 DDU 실행. 인자 조립 예: `-Silent -CleanNvidia -Restart -PreventWinUpdate` (복원 지점은 **해제 시에만** `-NoRestorePoint`).
5. **로그보기** (`DduLogViewerDialog`) — DDU 로그(XML)를 **날짜별 목록** + 사람이 읽기 쉬운 카드로 표시: 정보/경고/오류 배지 · 시각 · `Key=Value` 표 · 자주 나오는 영문 메시지 한글화. 우측 상단 아이콘으로 원본 XML 열기.
- 위치: `DDU\Display Driver Uninstaller.exe` (+ `settings\`, `DDU Logs\` 필수).

---

## 10. 로그전송

`LogSend_Click` — **온라인/오프라인 선택 팝업**(CustomMessageBox의 "온라인"=OK / "오프라인"=Cancel) 후 해당 수집기 실행:
- **온라인** → `ITLogCollector\ITLogCollector.exe`
- **오프라인** → `LogCollector_LGENT_v3.9_offline\LogCollector_x64.exe`
- 창을 그냥 닫으면 아무 동작도 하지 않음.

---

## 11. 하단 공통 / 자동 업데이트

- **만든사람 보기** — 제작 정보 팝업(`AuthorDialog`).
- **버전 배지 / 자동 업데이트** (`MainWindow.Updater.cs`)
  - 시작 시 `version.json`(GitHub raw) 조회 → 하단 배지: **`최신버전`**(초록) / **`업데이트 필요`**(주황, 클릭 시 업데이트) / `확인 실패`.
  - `version.json` = `{ version, url, changelog }`. 클라이언트는 `url` 하나를 받아 zip 다운 → 압축 해제 → 설치 폴더 덮어쓰기(`AppUpdateDialog`).
  - 현재 버전 상수 `AppVersion`(예: `4.02`) + 하단 `Ver x.xx`.

---

## 12. 외부 번들 도구 / 폴더 구조

앱은 exe 폴더 기준으로 외부 리소스를 읽는다. **소스에 없으므로 배포 시 함께 넣어야** 한다.

```
<GAP 폴더>\
 ├ gramAnalyzerPro.exe / .dll                 앱 본체
 ├ ItGgyu_BSOD.dll                            BSOD 분석 모듈
 ├ yamlDB\ModelDataFile.yaml                  모델별 BIOS/DMI/로고/ROM 데이터
 ├ DT_DMI\amidewinx64.exe                     MS 보드 DMI 직접 기록(오프라인)
 ├ BurnInTest\bit.exe                         Aging BurnInTest
 ├ DDU\Display Driver Uninstaller.exe + settings\ + DDU Logs\
 ├ DPK Checking Tool v1.0\OA3QAClient.exe     RDPK Check
 ├ RDPK\OA3ServiceClient.exe                  RDPK Run
 ├ ITLogCollector\ITLogCollector.exe          로그전송(온라인)
 ├ LogCollector_LGENT_v3.9_offline\LogCollector_x64.exe   로그전송(오프라인)
 └ gramAnalyzerPro.log                        실행 로그
```

### ModelDataFile.yaml 항목 (모델 데이터 편집기 `ModelDataEditorDialog`)
`targetModel` · `biosBaseDir` · `logoBaseDir` · `executeDMIFlashFile` · `executeBIOSFlashFile` · `executeLogoFlashFile` · **`romFile`**(롬라이팅 자동 로드용) · `year`
- 연도별 그룹(최신 위), 위/아래 이동, 추가/삭제, 각 경로 **찾아보기**. 모델 전환·닫기 시 **미저장 변경 감지**(확인창). **저장하기**=원본 yaml에 저장, **다른이름으로 저장**=백업.
- **모델명 확정 공통 로직**: yaml 조회 → 없으면 입력 팝업 → 접두사 매칭(`FindModelsInYaml`)으로 여러 개면 **드롭다운 선택**(`ModelPickDialog`, 예 `16Z90R`→`16Z90R`/`16Z90RT`), 없으면 변형문자 제거(`14ZB90Q`→`14Z90Q`) 재검색.

---

## 13. 배포 시 주의사항

- **Release 빌드**를 배포. `dotnet clean`/`bin` 삭제 시 위 데이터·도구 폴더가 함께 지워질 수 있으니 원본 별도 보관.
- 코드만 바뀐 증분 업데이트는 보통 **`gramAnalyzerPro.dll`/`.exe`/`.deps.json`/`.runtimeconfig.json`**(+ BSOD 수정 시 `ItGgyu_BSOD.dll`)만 교체. `.pdb`·`.log`는 배포 제외(log는 사용자 로그를 덮어씀).
- 버전 파편화가 걱정되면 배포 zip을 **전체 패키지**로 만들어 URL 하나로 통일.
- 번들 도구 라이선스: **DDU=MIT**(고지 유지), 그 외 도구는 배포 라이선스 별도 확인.
- XAML 수정 후 첫 증분 빌드가 `CS2001(.g.cs 없음)`로 실패하면 **한 번 더 빌드**(`dotnet clean` 지양).

---

_문서 기준 버전: v4.02_
