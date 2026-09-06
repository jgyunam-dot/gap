# GAP — 코드베이스 아키텍처 지도 (개발 인수인계용)

이 문서는 **다른 개발자나 AI가 이 프로젝트를 이어서 만들 때** 참고하도록, 모든 소스 파일이 **어떤 기능을 담당하고 어떤 로직으로 동작하는지**를 파일별로 정리한다. 기능 사용법·화면 순서는 [README.md](README.md), 이 문서는 **코드 구조**에 집중한다.

> 프로젝트: `PCInfoDashboard` → `gramAnalyzerPro.exe` · .NET 8 WPF (`net8.0-windows10.0.26100.0`) · x64 · requireAdministrator · 루트 네임스페이스 `PCInfoDashboard`.

---

## 1. 전체 아키텍처 (먼저 이해할 것)

### 1-1. MainWindow = 거대한 partial 클래스
`MainWindow`는 **하나의 클래스를 기능별 파일로 쪼갠 partial**이다. XAML(`MainWindow.xaml`)에 모든 화면 패널(`panelHome`, `panelMain`, `panelCheck`, `panelAging`, `panelEventLog`, `panelBsod`, `panelRomWriter`, `panelDdu`, `panelCleanSec` …)이 한 파일에 들어있고, 각 기능의 코드비하인드가 `MainWindow.<기능>.cs`로 분리돼 있다.

- **네비게이션 패턴**: 각 `NavXxx_Click`(또는 `SetNav`)이 **모든 패널을 Collapsed로 만들고 자기 패널만 Visible**로 바꾼다. 새 메뉴를 추가하면 **모든 네비 핸들러에 `panelXxx.Visibility=Collapsed` 한 줄씩** 넣어야 한다(누락 시 이전 패널이 겹쳐 보임). 관련 파일: `MainWindow.xaml.cs`(SetNav), `.Aging/.EventLog/.Bsod/.Ddu/.RomWriter/.CleanSec` 각 NavXxx_Click.

### 1-2. 데이터 수집 = Collector 패턴 (환경 자동 분기)
일반 Windows와 커스텀 **Windows PE**에서 같은 UI가 동작하도록, 데이터 수집을 인터페이스로 추상화했다.
```
IProviders.cs (인터페이스)  ──►  CollectorFactory (환경 감지)  ──►  WMI 구현 | Direct(IOCTL/레지스트리) 구현
                                        │
                              PCInfoCollector.CollectAll() → PCSnapshot(Models.cs) → UI
```
- **일반 Windows** → WMI 구현체, **PE** → Direct(IOCTL/레지스트리) 구현체를 `CollectorFactory`가 자동 선택.
- `CollectorFactory.IsWindowsPE` 는 앱 전역에서 **PE 전용 기능 게이팅**에 쓰인다(예: DDU/보안지우개/암호해제/드라이버로드).

### 1-3. PE 전용 기능
`ApplyPeMode()`(`MainWindow.xaml.cs`)가 PE에서 호출되어 일부 메뉴 비활성(시스템설정/로그전송/Aging/DDU/보안지우개) + **PE 전용 버튼 표시**(드라이버 로드, 윈도우 암호 해제).

### 1-4. 외부 도구/서버
- 번들 exe들은 exe 폴더 기준 상대경로로 실행(폴더 구조는 README.md 참조).
- LG 서버: `https://liu.lge.com/SmartBIOS/...`(BIOS/DMI), 같은 서버 아래 `.../GAP/version.json`(앱 자동 업데이트) · `.../GAP/version_BIOS.json`(NT_WIN_Flash/yamlDB 데이터) · `.../GAP/master_knowledge.json`(BSOD 족보). **GitHub는 4.24부터 더 이상 쓰지 않는다.**
- Firebase(`gap-tracker-b19d1`, RTDB): 사용량 집계·공지사항·앱 개선 의견·타자대결·사용자 목록/차단·NT_WIN_Flash 접근 권한. 앱은 **익명 인증**(`AnonymousAuthClient`)으로 토큰을 받아 통신하고, 사번 단건 조회처럼 열거 공격에 취약한 항목(사용자 이름·차단여부·BIOS데이터 접근권한)은 IP 레이트리밋이 걸린 **Cloud Functions**(`getEmployeeName`/`checkBlocked`/`checkBiosDataAccess`)를 거친다. 자세한 흐름은 1-5 참조.

### 1-5. Firebase/대시보드 연동 레이어
앱과 웹 대시보드(`대시보드/`, 정적 페이지는 GitHub→Vercel 배포)가 같은 RTDB(`gap-tracker-b19d1-default-rtdb.firebaseio.com`, 프로젝트 `gap-tracker-b19d1`)를 공유한다. 앱 쪽 서비스 클래스는 전부 `internal static`, `HttpClient` 직접 호출(REST) 방식이라 Firebase SDK 의존성이 없다. 인증은 전부 **익명 인증**(Anonymous Auth) — 앱 자체에는 아이디/비밀번호 로그인 화면이 없다(로그인 UI는 대시보드 쪽 관리자 계정 전용).

**인증 흐름** (`AnonymousAuthClient.cs`): `POST https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=<WebApiKey>` (body `{"returnSecureToken":true}`) → 응답의 `idToken`/`expiresIn`을 메모리에 캐시(`SemaphoreSlim`으로 동시요청 직렬화), 만료 5분 전에 자동 재발급. `GetTokenAsync()` 하나만 노출하며, RTDB REST 호출은 URL에 `?auth={idToken}`을, Cloud Functions 호출은 `Authorization: Bearer {idToken}` 헤더를 붙인다.

| 파일 | 역할 | RTDB 경로 / 엔드포인트 |
|---|---|---|
| `AnonymousAuthClient.cs` | 익명 `idToken` 발급/캐시 | (Identity Toolkit, RTDB 아님) |
| `UserProfileStore.cs` | `user.json`에 사번+이름/소속 캐시 저장. 파일 존재 = EULA 동의+등록 완료로 취급. `Volume` 필드(등록 당시 실행 드라이브 볼륨 일련번호)로 다른 저장장치 복사를 감지 | — (로컬 파일) |
| `EmployeeDirectory.cs` | 사번→이름/소속 조회 + 등록 여부 검증 | `GET .../getEmployeeName?empId=` |
| `BlockService.cs` | 차단 여부 확인 | `GET .../checkBlocked?empId=` |
| `BiosDataAccessService.cs` | "NT_WIN_Flash 업데이트" 버튼 노출 권한 확인 | `GET .../checkBiosDataAccess?empId=` |
| `UsageTracker.cs` | 실행 횟수/메뉴 방문/모델별 사용 집계(PATCH, `.sv:increment`로 서버측 원자 증가) | `usage/{empId}`, `usage/{empId}/daily/{yyyy-MM-dd}`, `usage/{empId}/features/{key}`, `model_usage/{modelKey}`, `model_usage/{modelKey}/users/{empId}` |
| `NoticeService.cs` | 안 읽은 공지 팝업(`NoticePopupDialog`)·읽음 처리·이력(`NoticeHistoryDialog`) | `GET notices`, `PATCH notices/{id}/reads`(맵으로 `{empId: timestamp}` 기록) |
| `FeedbackService.cs` | 의견 전송(`FeedbackDialog`) | `POST feedbacks`(자동 키) |
| `TypingRaceService.cs` | 문장 조회·기록 조회/등록(정렬: 타수↓→정확도↓→달성시각↑). 상위 50건 초과 정리는 서버가 담당 — 앱엔 삭제 권한이 없다(`PruneRankingAsync`는 4.2x에서 제거됨) | `GET typing/sentences`, `GET typing/scores`, `POST typing/scores`(자동 키) |
| `TypingRaceDialog.xaml(.cs)` `TypingMetrics.cs` | 타자대결 게임 UI/타수·정확도 계산 | — |
| `FeedbackDialog.xaml(.cs)` `NoticePopupDialog.xaml(.cs)` `NoticeHistoryDialog.xaml(.cs)` `EmployeeIdDialog.xaml(.cs)` | 위 서비스들의 다이얼로그 | — |

**RTDB 보안 규칙 요지**(`대시보드/database.rules.json`, `firebase.json`이 가리키는 실제 경로): 노드별로 다르며, "관리자/매니저(대시보드 로그인 계정)"와 "익명(앱)"의 권한이 갈린다.
- `usage/{empId}`, `model_usage/{modelKey}`: 익명은 **생성/자기 갱신만**(`newData.exists()`) 가능, **삭제는 admin만**(대시보드에서 사용 이력 삭제 시 필요) — `usage/{empId}.write`: `auth != null && $empId.matches(/^[0-9]{4,10}$/) && (admin || newData.exists())`.
- `notices`: `.read`는 admin/manager/익명 모두 가능(공지는 모두가 봐야 하니), 공지 본문 작성은 admin/manager만, `reads`(읽음 표시)는 익명도 자기 항목 추가 가능.
- `typing/sentences`, `typing/scores`: 읽기는 `auth != null`. `scores` 쓰기는 신규 생성만(`!data.exists()`) + `cpm`(0<cpm≤2000)·`accuracy`(0~100) 유효성 검증. **삭제 불가**(익명에게 삭제 권한을 주면 순위표 전체를 지울 수 있어, 서버 함수로 이관).
- `feedbacks`: 익명은 생성만(`!data.exists()`), 읽기/수정/삭제는 admin/manager만.
- `audit_logs`: 익명이라도 **대시보드 계정으로 로그인된(`user_roles`에 존재하는) 경우만** 쓰기 가능 — 순수 익명(앱)은 로그 위조 불가.
- `employees`, `blocked`, `biosDataAccess`: RTDB 규칙에서는 아예 열어주지 않는다(사번 하나→그 사람 정보 하나 조회라 열거 공격에 취약). 대신 아래 Cloud Functions를 Admin SDK로 거치게 해 IP 레이트리밋을 건다.

**사번 조회 3종 Cloud Function 공통 처리 순서**(`functions/index.js`, `guardAndGetEmpId`):
1. `Authorization: Bearer <idToken>` 검증(`verifyIdToken`) — 없거나 무효면 `401 {"error":"unauthenticated"}` (완전 비로그인 스캔 차단; 익명 로그인도 통과 대상 — 여기서 보는 건 "우리 프로젝트에 로그인했는지"뿐).
2. IP당 분당 요청수 제한 — `rate_limits/{ip 치환}/{분버킷}`에 RTDB 트랜잭션으로 원자 증가, **분당 100회** 초과 시 `429 {"error":"rate_limited"}`(서비스센터처럼 여러 PC가 NAT를 공유하는 환경을 고려한 값; 정상 사용은 실행당 조회 3건 수준이라 걸릴 일이 없고, 공격 측면에선 6자리 사번 전체를 이 한도로 훑는 데 일주일 이상 걸려 사실상 무력화됨).
3. `empId` 형식 검증(`/^[0-9]{4,10}$/`) — 아니면 `400 {"error":"invalid_empId"}`.
4. 통과하면 각 함수가 Admin SDK로 직접 읽어 반환(Admin SDK는 RTDB 규칙을 우회하므로 위 규칙에 `employees`/`blocked`/`biosDataAccess` 관련 항목이 없어도 동작함):
   - `getEmployeeName?empId=` → `{notRegistered:true}` 또는 `{name,center,dept}`
   - `checkBlocked?empId=` → `{blocked:false}` 또는 `{blocked:true,reason}`
   - `checkBiosDataAccess?empId=` → `{allowed:true|false}`

**그 외 Cloud Functions**(대시보드 관리자 계정용, 앱과는 무관): `resetUserPassword`(`onCall`, Super Admin이 남의 비밀번호를 강제 초기화 — 호출자가 실제로 `user_roles/{uid}/role==='admin'`인지 서버에서 재확인), `onNewLogin`/`onNewFeedback`/`onNewUsage`(각각 `audit_logs`/`feedbacks`/`usage` 신규 생성을 `onValueCreated`로 감지해 관리자 기기에 FCM 푸시 — `fcm_notified/{key}/{id}` 트랜잭션으로 중복 발송 방지), `onNewTypingScore`(`typing/scores` 신규 생성마다 상위 50건만 남기고 `update({...:null})`로 정리 — MAX_RANK_KEEP=50).

---

## 2. 진입점 · 셸

| 파일 | 역할 / 핵심 로직 |
|---|---|
| `App.xaml` / `App.xaml.cs` | 앱 진입. **주의: `App.xaml`에 `<Application.Resources>`를 두지 않는다**(마크업 컴파일러 증분 버그로 `DeferrableContent` 이중초기화 크래시). 테마 병합 딕셔너리(Dark.xaml, BSOD 테마/언어)와 `IconFont`는 `App.OnStartup()`에서 **코드로 병합**. 전역 폰트(LG스마트체) `OverrideMetadata`. `DispatcherUnhandledException`에서 로깅+에러창, **시작단계 치명오류면 Shutdown**(좀비→빌드손상 악순환 방지). |
| `MainWindow.xaml` | 모든 화면 패널 + 사이드 네비 버튼 + 홈 히어로 카드 + 하단 버전배지. 스타일(`NavBtn`, `AgingBtn`, `HSection` 등) 정의. **파일이 큼** — 편집 시 해당 패널 구역만 수정. |
| `MainWindow.xaml.cs` | 생성자, `SetNav(idx)`(홈/PC상세/시스템설정/점검 전환), `ApplyPeMode()`(PE 게이팅 + PE전용 버튼 노출), `DisableNavForPe()`, `RunStartupVersionCheck` 호출, `BtnClose_Click`. 색 브러시 헬퍼 `Res()/CBlue/CGreen/CRed/CText/CSub`. |
| `MainWindow.Monitoring.cs` | 실시간 갱신 타이머들(`_liveStatsTimer` CPU/RAM 사용률, `_batteryTimer`, `_tempTimer`). 홈/상세 화면의 라이브 수치 업데이트. |

---

## 3. 데이터 수집 레이어

| 파일 | 역할 |
|---|---|
| `Collectors/Interfaces/IProviders.cs` | 수집 인터페이스 정의: `ISystemInfoProvider`, `ICpuInfoProvider`, `IMemoryInfoProvider`, `IGpuInfoProvider`, `IDiskInfoProvider`, `INetworkInfoProvider`, `IBatteryInfoProvider`. |
| `CollectorFactory.cs` | `IsWindowsPE` 감지 + 각 `CreateXxxProvider()`가 환경에 맞는 구현체 반환. **새 수집기 추가 시 여기서 분기**. |
| `PCInfoCollector.cs` | `CollectAll()` — 모든 provider를 호출해 `PCSnapshot` 조립. |
| `Models.cs` | DTO들: `SystemInfo`, `CpuInfo`, `MemoryInfo`, `GpuInfo`, `DiskInfo`, `NetworkInfo`, `BatteryInfo`, 그리고 이들을 담는 `PCSnapshot`. UI는 이 모델만 본다. |
| `WmiSystemInfoProvider.cs` `WmiCpuMemoryGpuProviders.cs` `WmiDiskInfoProvider.cs` `WmiNetworkInfoProvider.cs` `WmiBatteryInfoProvider.cs` `WmiBluetoothInfoProvider.cs` | **일반 Windows용 WMI 구현체.** 각각 `Win32_*`/`MSFT_*` 쿼리로 수집. `WmiHelper.cs`가 쿼리 헬퍼. |
| `DirectSystemInfoProvider.cs` `DirectDiskInfoProvider.cs` | **PE용 Direct 구현체.** WMI 없이 레지스트리/IOCTL로 수집(PE엔 WMI가 불완전). |
| `WmiHelper.cs` | `ManagementObjectSearcher` 래핑, 속성 안전 읽기. |
| `PortInfoProvider.cs` | 포트 연결상태(“연결된 것만”). **DisplayConfig API**(HDMI/USB-C 영상, `DISPLAYCONFIG_PATH_INFO`=**72바이트**, `QDC_ONLY_ACTIVE_PATHS`, 비관리버퍼로 힙손상 방지), **SetupAPI**(외장 USB, `CM_DEVCAP_REMOVABLE`), **Core Audio**(3.5mm 잭), WMI(MicroSD). |
| `PowerHistoryReader.cs` | 전원 사용 이력(최근 30일). System 이벤트로그(Kernel-General 12/13, Power-Troubleshooter 1, Kernel-Power 41/42, User32 1074)로 세션 재구성 + 비정상종료 카운트. |
| `BatteryIoctlReader.cs` | 배터리 Class IOCTL로 전압/전류/전력/FCC/설계/사이클 직접 읽기. |
| `BatteryReportAnalyzer.cs` | `powercfg /batteryreport` XML 분석(노화 추이·이상 방전). |
| `DiskEventReader.cs` | System 로그의 저장장치 이벤트를 물리 디스크에 귀속(`EventCatalog` 소스검증으로 오귀속 방지). |
| `GpuUsageMonitor.cs` | GPU 사용률(성능 카운터). |
| `EventCatalog.cs` | `(EventId, 소스) → (카테고리, 의미)` 매핑 테이블. 이벤트로그/디스크이벤트 해석의 공용 사전. |
| `DEV_INFOR.cs` `BitInfo.cs` | 장치/사양 보조 구조체. |

---

## 4. MainWindow 기능별 partial 파일

| 파일 | 담당 메뉴/기능 | 핵심 로직 |
|---|---|---|
| `MainWindow.UiBuilders.cs` | **PC 상세정보** 카드 코드생성 | `BuildSystem/Bios/Os/Cpu/Memory/Gpu/Ports/Network/PowerHistory`. 각 카드의 버튼(모델/제번 Online·Offline, 로고, BIOS, RDPK)도 여기서 배선. |
| `MainWindow.Actions.cs` | 시스템정보 버튼 동작 | `RunDmiUpdate`(오프라인 DMI, yaml우선→MS보드 amidewin 폴백), `RunDmiOnline`/`RunMsDmiOnline`(온라인 DMI), `RunLogoUnlock`/`OpenLogoFolder`, `RunRdpkCheck/Run`, `LogSend_Click`(온·오프라인 수집기), 모델명 확정 공통(`FindModelsInYaml`/`ResolveModelChoice`/`PromptModelName`/`ResolveBiosModel`). |
| `MainWindow.CheckTab.cs` | **PC 점검하기** 12항목 | `Check_Wifi/Bluetooth/Keyboard/Disk/Battery/Camera/Pixel/Lid/CpuTemp/Fan/Speaker/Mic`. LID=`GUID_LIDSWITCH_STATE_CHANGE` 전원알림 구독(내부구현, 외부파일X). 카메라=OpenCV/AForge(+IR은 WinRT). 스피커=WASAPI→WaveOut 폴백. |
| `MainWindow.FullCheck.cs` | **전체점검 마법사** | `TaskCompletionSource` 기반 순차 진행 + 판정(PASS/FAIL/SKIP/ABORT/NA). 자동판정 기준: 배터리 수명≥60%, FAN RPM변화≥1000, SMART 정상 등. |
| `MainWindow.Aging.cs` | **Aging Test** | BurnInTest 실행, 전원반복(S3, `aging_state.json`으로 재부팅 후 이어서), CPU부하, XCopy, **화면녹화(ScreenRecorderLib)**. `OnClosing`에서 녹화정리는 **`FinalizeRecorderOnClose()`(NoInlining)로 분리 + PE에선 호출안함**(PE에 ScreenRecorderLib 의존성 없어 종료 크래시 방지). |
| `MainWindow.Monitoring.cs` | 라이브 수치 타이머 | (3장 참조) |
| `MainWindow.EventLog.cs` | **이벤트 로그** | System 로그를 `EventCatalog`로 해석, 필터(진단만/노이즈숨기기). |
| `MainWindow.Bsod.cs` | **BSOD 분석** 진입 | `AnalyzerView`(별도 어셈블리 `ItGgyu_BSOD`) 지연 생성해 `panelBsod`에 임베드. PE에서도 사용. |
| `MainWindow.RomWriter.cs` | **롬라이팅** 네비/버튼 | 패널 초기화, 자동(yaml romFile 로드), 검증 버튼 등 → 실제 로직은 `RomWriterPanel.cs`. |
| `MainWindow.Ddu.cs` | **DDU** | 번들 DDU를 명령줄로 실행(`-CleanNvidia` 등 인자 조립), 로그뷰어(`DduLogViewerDialog`). PE 비활성. |
| `MainWindow.CleanSec.cs` | **보안 지우개** UI | 탐지 목록 표 렌더/정렬(헤더클릭), 선택/전체 제거, 잔재 정리 옵션. 엔진=`SecurityPluginCatalog.cs`. |
| `MainWindow.DriverLoad.cs` | **드라이버 로드**(PE) 버튼 | 히어로카드 버튼 → `DriverLoadDialog`. **윈도우 암호 해제 버튼** → `PasswordResetDialog`(둘 다 PE 게이트). |
| `MainWindow.Resolution.cs` | 창 크기 설정 | 홈 타이틀 클릭 → `ResolutionDialog` + `WindowSizeManager`. |
| `MainWindow.WifiConnect.cs` | Wi-Fi 연결 버튼 | → `WifiConnectDialog`(netsh wlan). |
| `MainWindow.Chkdsk.cs` | 불량섹터 검사 진입 | → `ChkdskWindow`. |
| `MainWindow.Updater.cs` | 버전배지/자동업데이트 | **`AppVersion` 상수(현재 4.24)** — 하단 표기는 `RunStartupVersionCheck`에서 자동 반영. `version.json`(`liu.lge.com/SmartBIOS/GAP`) 조회 → `AppUpdateDialog`. 이 시점에 `UsageTracker.ReportRunAsync`로 실행 집계도 같이 전송(await 안 함, 배지 지연 방지). |
| `MainWindow.SkinPopup.cs` | **스킨 변경** 팝업 | 코드 입력으로 새 스킨 잠금 해제(`SkinCatalog`), 팝업 열기/기본·잠금해제 스킨 선택은 `MainWindow.xaml.cs` 쪽. 자세한 건 5부속(스킨 시스템) 참조. |

---

## 4-1. NT_WIN_Flash / BIOS 데이터 서브시스템

| 파일 | 역할 |
|---|---|
| `TdkErrorPatcher.cs` | `NT_WIN_Flash_model` 하위 모든 `WinFlash64.exe`를 exe 폴더에 놓인 신규 파일로 일괄 교체(TDK 에러패치 버튼). |
| `BiosDataUpdater.cs` | 앱 자체 업데이트와 별개. `version_BIOS.json` 조회 → zip 다운로드/해제 → `NT_WIN_Flash_model`(모델 폴더 단위 통째 교체, 그 외는 병합)/`yamlDB`(항상 병합)/`Drivers`·`DT_DMI`·`RDPK`(폴더 전체 통째 교체, 비어있으면 스킵) 적용. 적용한 버전은 `bios_data_version.json`에 기록. |
| `BiosDataUpdateDialog.xaml(.cs)` | "NT_WIN_Flash 업데이트" 전용 진행 팝업(디자인은 `AppUpdateDialog`와 동일 톤). |

---

## 5. 롬라이팅(SPI ROM) 서브시스템

| 파일 | 역할 |
|---|---|
| `RomWriterPanel.cs` | 롬라이팅 핵심. 프로그래머 상태·칩선택·읽기(`ReadSpiChip`)/쓰기/검증(`VerifySpiChip`)/지우기/자동, HEX뷰, `SetBusy`(작업 중 버튼잠금), USB 착탈 자동인식(`WM_DEVICECHANGE`). |
| `CH341DLL.cs` `CH347DLL.cs` | CH341A/CH347 프로그래머 DLL P/Invoke 래퍼. |
| `SPI_CONFIG.cs` `mUSB_SETUP_PKT.cs` `mWIN32_COMMAND_*.cs` | SPI/USB 통신 구조체·상수. |
| `ChipSelectDialog.cs` `AddChipDialog.cs` | 칩 제조사/모델 선택, 칩 정의 추가. |
| `ModelInputDialog.xaml(.cs)` `ModelPickDialog.xaml(.cs)` | 자동 로드 시 모델명 입력 / 다중매칭 드롭다운. |

---

## 6. PE 전용 서브시스템 (드라이버 · 암호 해제)

| 파일 | 역할 / 핵심 로직 |
|---|---|
| `DriverLoadDialog.xaml(.cs)` | 드라이버 로드. 소스=윈도우 드라이브(드롭다운) 또는 폴더선택 → `pnputil /add-driver "*.inf" /subdirs /install` + `/scan-devices`. 진행표시 애니메이션, 성공/스킵 집계. 다크 콤보박스 스타일 내장. |
| `PasswordResetDialog.xaml(.cs)` | 윈도우 암호 해제 UI. Windows 목록 + **계정 테이블**(사용자/그룹/MS계정/PIN/암호/잠김/사용여부). 버튼: 새로고침·백업·복원·계정활성화·**비밀번호 제거**(MS계정이면 자동 로컬 전환). BitLocker 잠김 감지 안내. |
| `SamEditor.cs` | **오프라인 SAM 편집 엔진.** `reg load`로 하이브 마운트 + **SeBackup/SeRestore 권한 + `REG_OPTION_BACKUP_RESTORE`(백업 모드)로 ACL 우회** 읽기/쓰기(SAM 계정값은 SYSTEM 전용 ACL이라 필수). 기능: `EnumerateWindows`(파티션 스캔), `ReadAccounts`(계정 V/F 파싱), `BlankPassword`(V의 LM/NT 해시 길이=0), `EnableUnlock`(F 플래그), `RemovePin`(Ngc 폴더), `BackupHives/RestoreHives`(SAM·SYSTEM·SECURITY·SOFTWARE), `GetBitLockerStatus`(manage-bde). **MSA 감지**: SAM V의 이메일 raw 스캔 + 실패 시 **SOFTWARE\IdentityStore\Cache**에서 이메일 추출 → 머신 SID(`SAM\Domains\Account` V값 끝 12바이트)로 로컬 RID 귀속(안되면 활성 사용자에 폴백). **MSA→로컬 전환**(`ConvertMsaToLocal`): SAM V 이메일 제거 + 비번 블랭크 + SOFTWARE IdentityStore 캐시 삭제. 그룹(Admin/Users/Guest) 판별=Administrators 별칭 C값 SID 스캔, PIN 감지=Ngc 컨테이너 SID 매칭. |

> ⚠️ SAM/SOFTWARE 편집은 잘못되면 로그인 손상 위험 → 모든 편집 전 자동 백업. 오프셋(V: 0xa0/0xac 해시길이, 0x0c 이름, F: 0x38 플래그)이 핵심.

---

## 7. 보안 지우개 서브시스템

| 파일 | 역할 |
|---|---|
| `SecurityPluginCatalog.cs` | 국내 보안 플러그인(구라) 탐지·제거 엔진. `Targets`(제품 토큰 30여종), `Scan()`(레지스트리 Uninstall HKLM 64/32+HKCU), `BuildUninstall()`(MSI/Inno/NSIS 무인화), `CleanupLeftover()`(서비스/폴더 잔재), `RegistryEntryExists/DeleteRegistryEntry`(유령 항목 강제 제거), 설치일(`InstallDate`→폴더생성일→키 LastWriteTime 폴백). |
| (UI) `MainWindow.CleanSec.cs` | 표 렌더·정렬·제거 흐름(6장 표 참조). |

---

## 8. BSOD 분석 서브프로젝트 (`BlueScreenAnalyzer/`, 어셈블리 `ItGgyu_BSOD`)

메인앱에 **라이브러리로 참조**되어 `AnalyzerView`(UserControl)를 임베드. 독립 프로젝트라 자체 테마/언어 리소스를 가짐(App.xaml에서 병합).

| 파일 | 역할 |
|---|---|
| `AnalyzerView.xaml(.cs)` | BSOD 분석 메인 UI. 덤프 선택→스캔→요약→(선택)AI. |
| `CdbRunner.cs` | 로컬 CDB(Windows 디버거)로 .dmp 스캔. |
| `DumpSummary.cs` | 원시 로그에서 실패 모듈·BugCheck 코드 등 핵심 요약 추출(모듈→설명 매핑 포함). |
| `GeminiAnalyzer.cs` | (선택) Gemini API로 원인·조치 자연어 해설. `ApiKeyDialog`로 키 입력. |
| `KnowledgeManagerWindow` `KnowledgeReport.cs` | 사례 지식 관리/리포트. |
| `Languages/Dictionary.*.xaml` | 다국어(ko/en/ja/zh) 리소스. |

---

## 9. 공용 다이얼로그 · 인프라

| 파일 | 역할 |
|---|---|
| `CustomMessageBox.xaml(.cs)` | 앱 공통 팝업(WindowStyle=None 커스텀). **우측상단 X + Esc 닫기** 지원. 2버튼 라벨 커스텀 오버로드(온라인/오프라인 등). 닫기=`Result=None`. |
| `ModelDataEditorDialog.xaml(.cs)` | **F5로 열리는 모델 데이터 편집기.** `yamlDB\ModelDataFile.yaml` 편집(연도별 그룹, 미저장 변경 감지, 저장/다른이름저장). 키: targetModel·biosBaseDir·logoBaseDir·execute{DMI,BIOS,Logo}FlashFile·romFile·year. |
| `BiosUpdateChecker.cs` `BiosCheckDialog.xaml(.cs)` | BIOS 온라인 확인(`CheckAsync`→info.xml), 릴리스노트·진행률 다이얼로그, `DownloadAndRunFileAsync`(DMI 온라인도 공용). |
| `DmiUpdateDialog.xaml(.cs)` | MS 데스크탑 보드 DMI 직접입력(amidewin). |
| `AppUpdateDialog.xaml(.cs)` | 자동 업데이트(zip 다운→압축해제→덮어쓰기). |
| `UpdateHistoryDialog.xaml(.cs)` | Windows 업데이트 이력(WUA COM). |
| `WifiConnectDialog.xaml(.cs)` | netsh wlan 검색/연결. |
| `ResolutionDialog.xaml(.cs)` `WindowSizeManager.cs` | 창 크기 설정/저장. |
| `KeyboardTestWindow.xaml(.cs)` | 키 입력 시각화. |
| `PixelCheckWindow.xaml(.cs)` | 불량화소 단색 전체화면. |
| `ChkdskWindow.xaml(.cs)` | 불량섹터 검사(물리 디스크 단위). |
| `DduLogViewerDialog.xaml(.cs)` | DDU 로그(XML) 날짜별 뷰어. |
| `AuthorDialog.xaml(.cs)` | 제작 정보. |
| `MiniChart.cs` | 배터리 충·방전 등 실시간 미니 차트 컨트롤. |
| `AppLogger.cs` | 파일 로거(`<exe>\gramAnalyzerPro.log`). `Info/Error`. |
| `ThemeManager.cs` | 다크/라이트 테마 토글 **+ 스킨 적용**. `Skin`(현재 "Basic" 또는 `SkinCatalog` 키), `IsFixedSkin`(Basic 아니면 다크/라이트 전환 불가). `ApplyGapDictionary`/`ApplyBsodDictionary`가 GAP 쪽(`Themes/*.xaml`)과 별도 어셈블리인 BSOD 쪽(`ItGgyu_BSOD`의 `Theme.*.xaml`) 리소스 딕셔너리를 각각 정확히 하나씩 찾아 교체 — 새 스킨을 추가해도 이름을 나열할 필요 없음. |
| `SkinCatalog.cs` | 코드로 잠금 해제하는 고정 배색 스킨 목록(현재 6종: 네온·미드나이트·모던·카본·모노·파스텔). `SkinDef{Key,DisplayName,Code,GapThemeFile,BsodThemeFile}`. 새 스킨 추가 = `Themes/<이름>.xaml`(GAP) + `BlueScreenAnalyzer/Themes/Theme.<이름>.xaml`(BSOD) 만들고 `All` 배열에 한 줄 추가. |
| `MainWindow.SkinPopup.cs`(4장) | 코드 입력 잠금 해제 UI. `AppSettings.Current.UnlockedSkins`에 저장, 코드 체계 도입 전 이미 쓰던 스킨은 자동 잠금 해제 처리(`EnsureCurrentSkinUnlocked`). |
| `Converters.cs` | XAML 값 변환기(MaxConverter 등). |

---

## 10. 빌드 · 확장 시 반드시 알아야 할 것 (오류 예방)

- **환경**: .NET 10 preview SDK로 net8 WPF 빌드 중. **CLI `dotnet build`와 VS 빌드를 섞으면** obj 마크업 캐시가 어긋나 시작 시 크래시 가능 → 한 도구로만 빌드, 문제 시 **Rebuild**.
- **App.xaml에 `<Application.Resources>`를 되살리지 말 것** (2장 참조 — 크래시 원인, `App.OnStartup`에서 코드 병합 유지).
- XAML 수정 후 첫 빌드가 **`CS2001(.g.cs 없음)`** 이면 **한 번 더 빌드**. `dotnet clean`/`bin·obj` 수동삭제 지양(번들 도구 폴더 유실).
- **새 메뉴 추가 시**: XAML에 `panelXxx` + 네비버튼, 모든 `NavXxx_Click`에 `panelXxx.Visibility=Collapsed` 추가, PE 전용이면 `ApplyPeMode`에서 게이팅.
- **새 수집기 추가 시**: `IProviders.cs` 인터페이스 + WMI/Direct 구현 + `CollectorFactory` 분기 + `Models.cs` DTO.
- **별도 Window(다이얼로그)는 MainWindow 리소스(`AgingBtn`/`IconFont` 등)를 `StaticResource`로 못 씀** → 다이얼로그 자체 `Window.Resources`에 스타일 정의 또는 `DynamicResource` 사용(안 그러면 `StaticResourceExtension` 예외).
- 버전 변경 = `MainWindow.Updater.cs`의 `AppVersion` 한 곳(하단 표기 자동). `https://liu.lge.com/SmartBIOS/GAP/version.json`도 함께 올려야 업데이트 배지 동작(4.24부터 GitHub 아님). NT_WIN_Flash/yamlDB 데이터 버전은 별개로 `version_BIOS.json`.
- SAM/레지스트리 하이브 편집(`SamEditor`)은 **백업 모드(SeBackup/SeRestore + REG_OPTION_BACKUP_RESTORE)** 필수, 편집 전 자동 백업 필수.
- **Firebase 배포는 앱 빌드/GitHub·Vercel 배포와 완전히 별개**: `대시보드/database.rules.json`·`functions/`는 리포 루트 `firebase.json`을 통해 `firebase deploy --only database` / `--only functions` (Firebase CLI)로만 반영된다. 대시보드 정적 페이지(`대시보드/*.html`)는 GitHub→Vercel 자동배포. 앱(`gramAnalyzerPro.exe`)은 Visual Studio 빌드 후 zip을 `liu.lge.com`에 수동 업로드 — 세 경로가 서로를 대신하지 않는다.

---

## 부록 A. 핵심 호출 흐름 + 함수 시그니처 (심화)

> 여기부터는 "어느 파일에 무엇이 있는가"(위 1~10장)를 넘어, **실제 함수 시그니처와 런타임 호출 순서**를 담는다. 이어서 개발하는 사람이 특정 동작을 추적할 때 진입점부터 따라갈 수 있도록 한다.

### A-1. 시작 → 데이터 수집 → UI 렌더 흐름

```
App.OnStartup(StartupEventArgs)                 [App.xaml.cs:39]
  ├─ ApplyGlobalFont()                          [App.xaml.cs:62]
  ├─ 리소스 병합(코드): Themes/Dark.xaml + ItGgyu_BSOD 3팩 + IconFont
  │     ※ App.xaml에는 <Application.Resources>가 없음(크래시 회피, 2장)
  └─ MainWindow 생성/표시
        └─ MainWindow 로드 시:
             PCInfoCollector.CollectAll() ──▶ PCSnapshot           [PCInfoCollector.cs:22]
               └─ CollectorFactory.CreateXxxProvider() 로 각 provider 획득
                     └─ DetectPE()  [CollectorFactory.cs:25] 로 WMI vs Direct 분기
               (홈 탭 빠른 표시는 CollectHomeQuick() [PCInfoCollector.cs:52] 사용)
```

핵심 시그니처:

| 함수 | 시그니처 | 역할 |
|---|---|---|
| 진입 | `protected override void OnStartup(StartupEventArgs e)` | 리소스 코드-병합 + 전역 폰트 |
| 전수집 | `static PCSnapshot CollectAll()` | 모든 provider 순회 → 스냅샷 |
| 빠른수집 | `static PCSnapshot CollectHomeQuick()` | 홈 탭용 경량(디스크 `GetDisksLight()`) |
| 배터리 갱신 | `static void RefreshBatteryDynamic(BatteryInfo)` / `static void FillInhouseBatteryFromACPI(BatteryInfo, WMIConn.ACPIHelper)` | 주기적 동적 갱신 · 사내 ACPI 보정 |
| 환경분기 | `static bool DetectPE()` | PE면 Direct/IOCTL provider, 아니면 WMI provider |
| 팩토리 | `static ISystemInfoProvider CreateSystemProvider()` 외 Cpu/Memory/Gpu/Disk/Network/Battery 6종 | 인터페이스별 구현 선택 |

### A-2. 네비게이션(메뉴 전환) 흐름

각 `NavXxx_Click` 는 **모든 패널을 Collapsed 로 내린 뒤 자기 패널만 Visible** 로 만드는 동일 패턴. 새 메뉴 추가 시 **모든** Nav 핸들러에 `panelXxx.Visibility=Collapsed` 한 줄을 넣어야 한다(10장 규칙). PE 전용 메뉴는 `ApplyPeMode()` 에서 표시/숨김 게이팅.

예: `NavCleanSec_Click(object, RoutedEventArgs)` [MainWindow.CleanSec.cs:26] → 패널 표시 → 최초 진입 시 `RescanClean()`.

### A-3. SamEditor (오프라인 SAM 편집) — 전체 메서드 + 호출 흐름

파일: [SamEditor.cs](SamEditor.cs). 전부 `static`. PE에서 오프라인 하이브를 `reg load` 로 마운트해 편집한다. SAM 계정 값은 SYSTEM-only ACL 이므로 **백업 모드**(`SeBackupPrivilege`/`SeRestorePrivilege` + `REG_OPTION_BACKUP_RESTORE 0x04`)로 우회해야 읽힌다.

공개 API:

| 함수 | 시그니처 |
|---|---|
| 윈도우 열거 | `static List<WinInstall> EnumerateWindows()` |
| 비트락커 상태 | `static List<BitLockerInfo> GetBitLockerStatus()` |
| 계정 읽기 | `static List<SamAccount> ReadAccounts(string samPath, string systemRoot, out string error)` |
| 암호 제거 | `static bool BlankPassword(string samPath, int rid, Action<string> log)` |
| MS→로컬 전환 | `static bool ConvertMsaToLocal(string samPath, string systemRoot, int rid, Action<string> log)` |
| 활성화·잠금해제 | `static bool EnableUnlock(string samPath, int rid, Action<string> log)` |
| PIN 제거 | `static bool RemovePin(string systemRoot, Action<string> log)` |
| 백업 | `static string BackupHives(string samPath, Action<string> log)` |
| 복원 | `static bool RestoreHives(string samPath, string backupDir, Action<string> log)` |
| MS 이메일 매핑 | `static Dictionary<int,string> GetMsaEmails(string systemRoot, string machineSid, out List<string> orphans)` |

내부 헬퍼(발췌): `ReadMachineSid()`, `ParseSid(string, out uint,out uint,out uint)`, `GetAdminRids(uint,uint,uint)`, `DetectPins(string systemRoot, string machineSid)`, `FindRidBySid(string,string)`, `FindEmail(byte[])` / `FindEmailRange(byte[], out int,out int)` / `IsEmailChar(byte,byte)`, `ParseUserName(byte[])`, `HasNtHash(byte[])`, `LoadSoftware`/`UnloadSoftware`, `ReadEmail(string keyPath)`, `LocalRid(string sid,string machineSid)`, `RidFromSid`, `RemoveIdentityStore(...)`. 백업모드 interop: `OpenBackup(string)`(RegCreateKeyEx+0x04), `EnumSubKeys(IntPtr)`, `QueryValue(IntPtr,string)`, `QueryString(IntPtr,string)`, `EnablePriv(...)`(토큰 특권 조정), `RegLoad`/`RegUnload`.

**계정 읽기 흐름** `ReadAccounts`:
```
RegLoad(samPath)  → HKLM\GAP_SAM 마운트
EnablePriv(SeBackup/SeRestore)
ReadMachineSid()  → SAM\Domains\Account 의 V값 끝 12바이트 → S-1-5-21-a-b-c
GetAdminRids(a,b,c)                 (관리자 그룹 멤버 RID 집합)
DetectPins(systemRoot, machineSid)  (NGC 폴더 기반 PIN 보유 RID)
GetMsaEmails(systemRoot, machineSid, out orphans)   (SOFTWARE IdentityStore)
for each 사용자 키(SAM\Domains\Account\Users\<RID>):
   V값 파싱: ParseUserName / HasNtHash / (F값 0x38 ACB → Disabled 0x0001, Locked 0x0400)
   IsMsa 판정: V 내 '@' UTF-16 스캔(FindEmailRange) 또는 GetMsaEmails 매핑
   → SamAccount{ Name,Rid,Disabled,Locked,HasPassword,HasPin,IsMsa,Email,AccountGroup }
RegUnload()
```

**암호 제거 흐름** `BlankPassword`: RegLoad → 백업모드로 `Users\<RID>\V` 열기 → NT 해시 길이 필드(0xac) 0 세팅 + LM(0xa0) 0 → RegSetValueEx → RegUnload. (호출 전 다이얼로그가 `BackupHives` 자동 수행.)

**MS→로컬 전환 흐름** `ConvertMsaToLocal`: 내부적으로 `BlankPassword` 로 해시 제거 + IdentityStore/연결 정보 정리(`RemoveIdentityStore`) → 재부팅 시 로컬 빈 암호 계정으로 로그인.

**호출자**: 모두 [PasswordResetDialog.xaml.cs](PasswordResetDialog.xaml.cs) →
`LoadWindows()`→`EnumerateWindows`+`GetBitLockerStatus`, `LoadAccounts()`→`ReadAccounts`(정렬키 `Rank`), `BtnBlank_Click`→(MSA면 `ConvertMsaToLocal`, 아니면 `BlankPassword`), `BtnEnable_Click`→`EnableUnlock`, `BtnBackup/Restore`→`BackupHives`/`RestoreHives`. 다이얼로그 진입은 `MainWindow.DriverLoad.cs` 의 `BtnPwUnlock_Click`(PE 게이트).

> ⚠️ 미해결: 특정 빌드의 MSA 계정("A", naver.com)이 MS계정으로 인식 안 되는 케이스 존재. V 내 이메일이 없고 SOFTWARE IdentityStore RID 매칭도 실패하는 경우 → 진단 덤프 추가 또는 하이브 파일 직접 분석 필요(TODO).

### A-4. 보안 지우개 — SecurityPluginCatalog + MainWindow.CleanSec

스캔/삭제 엔진 [SecurityPluginCatalog.cs](SecurityPluginCatalog.cs) (전부 static):

| 함수 | 시그니처 |
|---|---|
| 스캔 | `static List<DetectedPlugin> Scan()` |
| 제거 명령 생성 | `static (string exe,string args) BuildUninstall(DetectedPlugin p)` |
| 잔여 정리 | `static void CleanupLeftover(IEnumerable<string> installLocations, Action<string> log)` |
| 고스트 존재확인/삭제 | `static bool RegistryEntryExists(DetectedPlugin p)` / `static bool DeleteRegistryEntry(DetectedPlugin p, Action<string> log)` |
| 설치일 해석 | `static string ResolveInstallDate(RegistryKey, string rawInstallDate, string installLocation)` |
| 매칭 | `static SecTarget Match(string displayName)` |

**스캔 흐름** `Scan()`: HKLM\...\Uninstall(64/32) + HKCU 순회 → 각 항목 DisplayName을 `Match()`(30+ 토큰: nprotect, touchen, ahnlab safe transaction, veraport, wizvera, inisafe, magicline, anysign, ipinside…)로 대조 → 매치 시 `DetectedPlugin{ Name,Category,Hive,InstallLocation,UninstallString,InstallDate }`. 설치일은 `ResolveInstallDate`(InstallDate 값 → 폴더 생성시각 → `RegQueryInfoKey` LastWriteTime 순 폴백).

**제거 명령** `BuildUninstall`→`ParseCommand`: MSI(`msiexec`)면 `/X{GUID} /qn`, Inno면 `/VERYSILENT`, NSIS면 `/S`.

**잔여 정리** `CleanupLeftover`: InstallLocation과 경계(`loc+"\\"`)로 매칭되는 서비스 `sc stop/delete`, `IsSafeFolder` 가드 통과한 폴더만 삭제.

UI/오케스트레이션 [MainWindow.CleanSec.cs](MainWindow.CleanSec.cs):
```
NavCleanSec_Click → 패널표시 → RescanClean()
RescanClean()               [if _cleanBusy return 가드]
  └─ SecurityPluginCatalog.Scan() → _cleanItems → RenderCleanList()
RenderCleanList()/SortCleanItems()  헤더클릭 정렬(CleanSort: Name/Cat/Hive/Date)
BtnCleanRemoveSelected/All_Click → RemoveCleanAsync(items, all)
RemoveCleanAsync():
  SetCleanBusy(true) → CreateRestorePoint() →
  각 항목: BuildUninstall 실행 → 2초 대기 → RegistryEntryExists면 DeleteRegistryEntry →
  CleanupLeftover → SetCleanBusy(false) → RescanClean()   (자동 새로고침)
```
> 자동 새로고침 버그 이력: `RescanClean` 의 `_cleanBusy` 가드 때문에 busy 중 호출이 무시됨 → **`SetCleanBusy(false)` 를 RescanClean 앞에서** 호출해 해결.

### A-5. PortInfoProvider (포트/디스플레이/오디오/SD 수집)

[PortInfoProvider.cs](PortInfoProvider.cs), static. 진입 `static List<PortInfo> Collect()` 가 4개 수집기를 합친다:
`CollectConnectedUsb(List<PortInfo>)`(SetupDi 열거 + `GetDevProp`/`GetDevPropDword`), `CollectDisplays()`(QueryDisplayConfig→`GetTargetName(LUID,uint)`), `CollectAudioJack(List<PortInfo>)`, `CollectMicroSd()`. 크기표기 `FormatSize(ulong)`.

### A-6. 롬라이팅 RomWriterPanel (SPI ROM R/W)

[RomWriterPanel.cs](RomWriterPanel.cs). CH341A/CH347 프로그래머 지원(칩별 25/45 계열 분기). 대표 공개 API:
`static int DetectDevice()`, `static string ReadChipId()`(→341/347 분기), `static byte[] ReadSpiChip(SpiChipInfo, Action<int,string> onProgress, string taskName="읽기")`, `static void EraseSpiChip(...)`, `static void WriteSpiChip(byte[], SpiChipInfo, Action<int,string>)`, `static bool VerifySpiChip(byte[] original, SpiChipInfo, Action<int,string>)`, `static List<SpiChipInfo> Load(string xmlPath)`(칩 정의 XML). 인스턴스 측: `Initialize(Window owner, …)`, `RefreshDevice()`, `InstallDriverCH341A()`/`InstallDriverCH347()`, `async void AutoDetect()`, `OpenFile()`/`bool OpenFilePath(string)`.
읽기/쓰기 진행률은 `onProgress(percent, task)` 콜백으로 UI에 전달. 25계열은 `StartSpiMode25/StopSpiMode25` + `WaitBusySpi25*`, 347은 `CH347Init` 기반.

### A-7. 전체마법사(FullCheck) 마법사 흐름

[MainWindow.FullCheck.cs](MainWindow.FullCheck.cs):
```
BtnFullCheck_Click → RunFullCheckAsync(bool fanSupported)      [:60 → :85]
  ShowFcBar()/UpdateFcBar(idx,total,name)  진행바
  순차 스텝(각각 int 반환 = PASS/FAIL/스킵):
     RunPanelStep(Action invokeHandler, string hint)  ← 기존 패널 재사용 스텝
     RunMicStep / RunSpeakerStep / RunLidStep(+AutoDetectLidAsync)
     RunWifiStep / RunDiskStep / RunBatteryStep / RunBluetoothStep
     RunFanStep  (IsFanSupportedModel() 로 지원 기종만)
     RunModalStepPixel / RunModalStepKeyboard  (모달 창 스텝)
  각 스텝 판정 표시: SetFcJudgeVisible/FullCheckPanelJudge(bool)
  HideFcBar() → ShowFullCheckReport()   (종합 리포트)
```
LID 스텝은 파일 생성이 아니라 **전원 알림(power notification)** 기반 자동 감지(`AutoDetectLidAsync`).

### A-8. 버전/업데이트 배지 흐름

[MainWindow.Updater.cs](MainWindow.Updater.cs): 단일 상수 `AppVersion`(현재 `"4.24"`)가 하단 `Ver x.xx` 표기 소스. `RunStartupVersionCheck()`(시작 시) → `RefreshVersionBadgeAsync()` 가 `https://liu.lge.com/SmartBIOS/GAP/version.json` 조회 → `IsNewerVersion(latest,current)` → `SetBadge(text,fg,bg,clickable,tooltip)`. 같은 호출에서 `UsageTracker.ReportRunAsync(employeeId, AppVersion)`도 fire-and-forget으로 함께 보낸다(프로세스당 1회, 실패해도 배지 로직엔 영향 없음). 실패 시 `_verChecked=false`로 두어 배지 클릭(`VerBadge_MouseDown`) 재시도. **버전 올릴 때 `version.json`도 서버에 함께 올려야** 배지가 동작(코드에서 내가 대신 못 올림). NT_WIN_Flash/yamlDB 데이터 버전(`version_BIOS.json`)은 완전히 별개 흐름 — 4-1장 `BiosDataUpdater` 참고.

### A-9. 사원번호 등록 · 검증 · 차단 흐름

[MainWindow.xaml.cs](MainWindow.xaml.cs)의 `Loaded` 핸들러가 시작 시 순서대로 처리한다:
```
UserProfileStore.IsCopiedToOtherDevice 확인   (볼륨 일련번호 불일치 = 다른 저장장치로 복사됨)
  → true면 ClearForNewDevice() + NoticeService.ResetReadNotices()
firstRun = !UserProfileStore.IsRegistered     (user.json 없음 = 최초 실행)
verified = firstRun || await VerifyEmployeeAsync()   (Firebase 사용자 목록 확인 — EmployeeDirectory 경유)
showEula = firstRun(구버전 아니면) 또는 !verified     (미등록/미확인이면 매번 EULA 재표시)
  → EULA 거부 시 Shutdown()
firstRun이면 RegisterEmployeeId() → EmployeeIdDialog → UserProfileStore.Save()
await EnforceBlockAsync()                      (BlockService.CheckAsync — 차단이면 안내 후 종료)
ApplyEmployeeIdToTitle()                        (제목표시줄 + 사용자 배지 + UpdateMemberOnlyButtons)
NoticeService.CheckAndShowNoticeAsync() → StartNoticeWatch()   (미읽음 팝업 1회 + 3분 주기 배지 갱신)
```
`UpdateMemberOnlyButtons()`가 타자대결·앱 개선 의견·알림 버튼의 활성/비활성을 `UserProfileStore.IsRegistered && _employeeVerified` 기준으로 일괄 제어한다(미등록/미확인이면 잠금 + 안내 툴팁).

---

_기준 버전: v4.24 · 이 문서는 코드 구조 인수인계용이며, 기능·서버주소·판정조건 등 상세는 [README.md](README.md) 참조._
