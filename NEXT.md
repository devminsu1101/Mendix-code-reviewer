# 다음 작업 가이드 (작성 2026-07-23)

3개월 만에 다시 잡는 프로젝트라, 재조사 없이 바로 이어갈 수 있게 정리함.
마지막 활동: 2026-04-20 (온보딩 가이드 생성) / `PROJECT_STATUS.md`는 04-17 기준.

---

## 0. 왜 다시 잡는가

RamsesKR는 모델이 전부 바이너리(`.mpr` = SQLite, `mprcontents/**/*.mxunit`)라 **`git diff`로 변경 내용을 볼 수 없다.** 그래서 "무엇이 바뀌었는지"를 아는 유일한 경로가 커밋 메시지인데, 실측해보니 사람 커밋의 상당수가 `수정` / `commit` 수준이라 추적이 불가능하다.

→ **사람의 기록에 의존하지 말고, 모델에서 직접 뽑아내자**가 이 도구의 목적.

부수 효과로, 팀에 코드 리뷰 프로세스가 없는 상태도 일부 메울 수 있다.

---

## 1. 오늘 확정된 것

- **접근 방식**: Mendix Platform SDK(Team Server) 기준. **push된 것만** 보이므로 용도는 *사후 파악*으로 확정. 머지 전 사전 감지는 범위 밖.
- **MVP 범위**: 웹훅 / Teams 연동은 **보류**. 온디맨드로 나 혼자 받아보는 형태로 먼저 완성한다.
  - 이유: 머지마다 룰 위반이 팀 채널에 자동 게시되면 공개 지적으로 읽힌다. 도구가 살아남지 못한다. 개인 도구로 가치를 검증한 뒤에 판단.
- **기존 코드는 유지, 기능을 옆에 추가**한다. `review`(전수 감사)와 `brief`(변경 브리핑)는 목적·주기·독자가 달라서 한 함수에 `isDelta` 플래그로 욱여넣으면 안 된다. 지금 `domain.ts`의 delta 분기가 빈 블록으로 남은 게 그 증거.

| | `npm run review` (기존) | `npm run brief` (신규) |
|---|---|---|
| 질문 | 이 브랜치가 건강한가 | 지난번 이후 뭐가 바뀌었나 |
| 기준 | 규칙 카탈로그 | 직전 스냅샷 |
| 주기 | 가끔, 전수 | 자주, 증분 |
| 결과 | 지적 목록 | 변경 목록 |

---

## 2. 내일 순서

### STEP 0. 자격증명 정리 (먼저)
- [ ] Mendix PAT 폐기 후 재발급 — [Developer Portal](https://home.mendix.com)
- [ ] Gemini API 키 재발급
- [ ] 프로젝트를 OneDrive 밖으로 이동 (예: `C:\dev\mendix-code-reviewer`)
- [ ] 새 위치에서 `.env` 재작성 → `npm install` 재확인

> `.env`가 OneDrive 동기화 폴더에 있어서 이미 클라우드에 올라갔다. `.gitignore`엔 있지만 OneDrive는 git과 무관하게 동기화하고, 삭제해도 버전 기록·휴지통에 남는다. 노출 범위는 본인 계정 + 테넌트 관리자 수준이라 과한 걱정은 불필요하지만, **키 재발급이 제일 싸고 확실한 정리.** 새 키를 새 위치에 넣으면 유출된 값은 죽은 문자열이 된다.

### STEP 1. 현재 기준선 측정
- [ ] `npm run review` 1회 실행
- [ ] **`createTemporaryWorkingCopy` 소요 시간을 따로 측정** ← 중요
- [ ] 리포트 확인: 이슈 몇 건 나오는지, 오탐 비율 어느 정도인지

> `PROJECT_STATUS.md:17`의 "17초"는 신뢰하지 말 것. 웹훅 시뮬레이션 = Delta 모드 = "최근 1시간 내 수정분"인데, 당시 대상이 0건이었을 가능성이 크다. 즉 17초는 working copy 생성 + 모델 오픈 시간이고 실제 분석은 거의 안 한 값일 수 있다.
>
> **이 측정값이 설계를 가른다.** working copy 생성이 1분을 넘으면 "필요할 때 툭 돌린다"가 성립하지 않으므로, 스냅샷 캐싱을 더 공격적으로 가져가야 한다.

### STEP 2. 즉시 고칠 것 (작고 효과 큼)
- [ ] **`index.ts:41-43`** — `startReview()`에 인자를 안 넘기고 있음. `startReview(process.argv[2])`로 바꾸면 `npm run review -- <브랜치>`로 실행 가능. `.env` 매번 고칠 필요 없어짐.
- [ ] **`reporter.ts:61`** — `i.message.includes('루프 내 DB')`인데 `logic.ts`가 실제로 넣는 문자열은 `루프 내에서 ... DB 조회하고 있습니다`. **부분문자열이 존재하지 않아 KPI가 항상 0건 / ✅ Pass로 찍힌다.** 리포트가 거짓말하는 상태.
- [ ] **`logic.ts:14-26`** — `if (action instanceof RetrieveAction)` 안에서 `DatabaseRetrieveSource` 체크를 **이름 고를 때만** 쓰고 이슈는 무조건 push. 메모리상 association retrieve(= 권장사항이 시키는 바로 그 패턴)도 Critical Error로 잡힌다. 소스 타입으로 게이트할 것.

### STEP 3. `brief` 기능 신규 구현 (본 작업)

```
src/
  client.ts            ← 그대로 재사용 (인증·모델 로딩)
  analyzer/            ← 그대로 (룰 검사)
  snapshot/
    extract.ts         모델 → 정규화 인벤토리
    store.ts           snapshots/<app>/<branch>/<revId>.json 저장·조회
    diff.ts            스냅샷 비교
    report.ts          변경 브리핑 출력
  brief.ts             새 진입점
```

`npm run brief -- <브랜치>` 흐름:
1. 기존 `getModel(branch)` 호출
2. 인벤토리 추출 → 현재 스냅샷
3. `snapshots/`에서 직전 것 로드 (**없으면 기준선만 저장하고 종료**)
4. diff → 신규 / 삭제 / 변경
5. 출력

**스냅샷에 담을 것**
- Microflow / Nanoflow: `qName` → 액션 수, 액션 타입 목록, 파라미터, 반환 타입, 호출하는 Sub 목록
- Entity: `qName` → 속성(이름+타입), 연관, persistable 여부, generalization
- Association: 이름, parent/child
- Enum: `qName` → 값 목록
- Page: `qName` → 타이틀, 레이아웃, 위젯 수
- Navigation: 메뉴 항목

**출력 형태 (목표)**
```
[신규] Microflow   LoginAsset.ACT_OrganizationUnit_Save
[신규] Enum        LoginAsset.Enum_Position (사원, 대리, 과장, 차장, 부장, 상무, 전무)
[변경] Entity      LoginAsset.CustomerCompany
         + BusinessRegistrationNumber (String)
         + HeadBusinessNumber (String)
[변경] Microflow   Shipment.ACT_ShipmentPDFDdwnload  (액션 12 → 15)
[삭제] Nanoflow    ...
```

**설계 포인트**
- 스냅샷을 로컬에 쌓기 때문에 working copy를 두 번 만들 필요가 없다. 빠르고 API도 덜 쓴다.
- `--since=<revId>` 옵션은 저장된 파일만 골라 읽으면 되므로 나중에 쉽게 추가된다.
- 비교 기준이 커밋 경계가 아니라 **내가 마지막으로 실행한 시점**이다. 상대가 커밋을 어떻게 쪼개든, 메시지를 뭐라고 쓰든 영향받지 않는다. 이게 이 방식의 핵심 이점.

### STEP 4. 델타 리뷰 완성
- [ ] STEP 3의 diff 결과(변경된 객체 목록)를 기존 `analyzer/`에 태운다
- [ ] 이러면 원래 하려던 증분 리뷰가 **시간 기반 추측이 아니라 실제 변경 목록 기반**으로 완성됨
- [ ] 완성 후 `domain.ts` / `logic.ts`의 기존 `isDelta` 분기는 제거 (STEP 5 참조)

---

## 3. 알려진 버그

> 2026-07-31 갱신. 1~7번은 리뷰 깊이 개선 작업(아래 §7)에서 처리됨.

| # | 위치 | 내용 | 상태 |
|---|---|---|---|
| 0 | `logic.ts:64` (구) | **`microflows.LoopAction`은 이 SDK(4.110)에 존재하지 않음.** `instanceof undefined`가 TypeError를 던지고 그게 try/catch에 삼켜져 **모든 마이크로플로우가 이슈 0건 반환**. 루프·복잡도·파라미터 룰 전부 죽어 있었음 | ✅ 해결 (`LoopedActivity` 기반 재작성) |
| 1 | `reporter.ts:61` (구) | `includes('루프 내 DB')`가 절대 매치 안 됨 → KPI 항상 0건/Pass | ✅ 해결 (ruleId 기반 집계) |
| 2 | `logic.ts:14-26` (구) | RetrieveAction 무조건 Error push. association retrieve 오탐 | ✅ 해결 (`DatabaseRetrieveSource`로 게이트) |
| 3 | `domain.ts:18-22` (구) | `if (isDelta) { }` 빈 블록 | ✅ 제거 (isDelta 분기 자체를 삭제) |
| 4 | `logic.ts:118` (구) | `(mf as any).unit?.lastModifiedDate` 시간 기반 델타 — 실제로는 항상 전건 통과 | ✅ 제거 (스냅샷 diff 기반으로 STEP 3/4에서 재구현 예정) |
| 5 | `logic.ts:89-103` (구) | 지문이 액션 *타입명 정렬*만 사용 → CRUD가 전부 동일 지문 | ✅ 해결 (순서 보존 + 엔티티 + 최소 6액션) |
| 6 | `reporter.ts:44` (구) | 커밋 URL 테넌트 하드코딩 | ✅ 해결 (`MENDIX_SPRINTR_HOST` env, 기본 `sprintr.home.mendix.com`) — **실제 테넌트 확인 필요** |
| 7 | `reporter.ts:80` (구) | 정렬 comparator 불안정 | ✅ 해결 (점수 → location tie-break) |
| 8 | `onboarding_ai.ts` | 데이터는 `slice(0,60)` / `slice(0,15)`로 **잘라서** 주면서 프롬프트(`:164`)는 *"확신 있는 어조"* 요구 → 환각 유도 구조. **고치기 전엔 온보딩 문서 배포 금지** | ❌ 미해결 |
| 9 | `client.ts:50` (구) | `app.name` — Platform SDK의 `App`에 `name`이 없음. 리포트가 항상 `reports/UnknownApp/`에 쌓이던 원인 | ✅ 해결 (`MENDIX_APP_NAME` env, 없으면 appId) |
| 10 | `onboarding_ai.ts` | `tsc --noEmit` 기준 타입 오류 5건 (`homePage`, `menuItemCollection` 미존재 등). `tsx`는 타입검사를 안 해서 실행은 되지만 런타임에 `undefined`일 가능성 | ❌ 미해결 (8번과 함께 처리) |

---

## 4. 아직 안 정한 것

- `.env`의 `MENDIX_BRANCH`를 기본값으로만 남기고 CLI 인자를 우선할지 (STEP 2에서 자연스럽게 결정될 듯)
- 스냅샷 보관 정책 — 무한히 쌓을지, N개만 유지할지
- `brief` 출력을 파일로도 남길지, 콘솔만 할지
- 웹훅/Teams 재개 시점 — 개인 도구로 가치 검증한 뒤 판단

---

## 5. 참고

- **온보딩 생성기는 지금 가치가 큼.** 이 프로젝트는 문서화되지 않고 사람 머릿속에만 있는 지식의 비중이 높은 상태다. 디자인 시스템(`themesource/designasset`, 87개 중 65개)이 담당자 퇴사 후 인수자 없이 남아 있고, 모델 전반도 기록이 얇다. 다만 **버그 #8을 먼저 고칠 것.**
- RamsesKR 모델은 4월 이후 많이 바뀌었다 (조직도 관리 기능만으로 유닛 24개 신규 + 도메인 모델 변경). 4월에 뽑아둔 `reports/Onboarding/*.md` 3건은 현재 기준으로 낡았다.
- 바이너리 `.mxunit`에서 문자열 긁는 우회 방식도 가능하지만, **SDK 방식이 상위 호환이므로 불필요.**

---

## 6. 리뷰 깊이 개선 (2026-07-31 완료분)

`npm run review` 결과가 피상적이던 원인은 룰 튜닝이 아니라 구조였음. 세 가지를 바꿈.

**(1) 그래프 인덱스 — `src/analyzer/graph.ts` (신규)**
모델을 한 번 순회해 관계를 먼저 만든다. 이후 모든 분석이 이 위에서 돌아간다.
- `callGraph` / `callers` — 누가 누구를 부르는가
- `entryPoints` — 스케줄 이벤트 / 공개 REST·OData / 워크플로우 / 페이지 / 네비게이션
- `reach` — 진입점에서 BFS. 도달성 + 진입 유형 + 최소 깊이
- `entityUsage` — 엔티티별 조회/변경 flow 목록

**(2) 흐름 인식 룰 — `logic.ts` 재작성, `rules.ts` 확장 (6개 → 18개)**
L001 루프 내 DB조회 / L002 루프 내 커밋 / L003 복잡도 / L004 파라미터 / L005 중첩루프 /
L006 고아 flow / L007 롤백 없는 에러처리 / L008 중복로직 /
D001~D003 기존 + D004 접근규칙 없음 / D005 XPath 없는 접근 / D006 파급 반경 큰 엔티티 / D007 모듈 결합 /
P001 타이틀 / P002 역할 미지정

**(3) 우선순위 리포트 — `issue.ts` (신규) + `reporter.ts` 재작성**
점수 = 결함 심각도 × 진입 경로 위험도. 스케줄 이벤트(×2.0) > 공개 서비스(×1.8) > 페이지(×1.3) > 고아(×0.3).
리포트가 "모델 구성 → KPI → **지금 고쳐야 할 것 TOP 10(근거 포함)** → 규칙별 집계 → 모듈별 건강도 → 전체 부록" 구조로 바뀜.

**(4) `npm run selfcheck` (신규)**
분석기가 `instanceof`로 쓰는 SDK 심볼 18개가 실재하는지 런타임 확인. 버그 #0 재발 방지용.
**SDK 버전 올릴 때 반드시 먼저 실행할 것.**

### 실측 (2026-07-31, `minsu-clean`, rev 7a99e756)

**STEP 1의 소요 시간 질문 답:**

| 구간 | 시간 |
|---|---|
| working copy 생성 + 모델 오픈 | **35초** |
| 그래프 구축 (flow 407개 로딩) | **2분 30초** ← 병목 |
| 분석 (룰 검사 전체) | **0.5초** |
| **합계** | **약 3분** |

→ `PROJECT_STATUS.md:17`의 "17초"는 역시 실제 분석을 안 한 값이었음.
→ working copy는 35초로 1분 미만. "필요할 때 툭 돌린다"는 성립함.
→ 다만 **병목은 flow 로딩(2분 30초)**이므로, `brief`는 스냅샷 캐싱이 반드시 필요.

**오탐을 걷어낸 과정 (223건 → 155건):**
1. 진입점 수집 누락 — 엔티티 이벤트 핸들러 / 스니펫 / 레이아웃 / 네이티브 페이지 / 메뉴 / 빌딩블록 / 동시성 에러 MF가 빠져 있어 멀쩡한 flow가 고아로 오판됨 (고아 86 → 61)
2. 마켓플레이스·테마 모듈 11개(`AmazonS3Connector`, `Atlas_*`, `CommunityCommons` 등)를 지적 대상에서 제외. **그래프에는 남겨서** 호출 관계 정확도는 유지 (고아 61 → 38, 전체 211 → 155)

**현재 규칙별 분포 (155건)**
`D005` 54 · `L006` 38 · `D003` 18 · `L002` 9 · `L003` 9 · `P002` 7 · `L008` 6 · `L001` 4 · `D004` 3 · `D001` 3 · `L005` 2 · `D006` 2

**(5) 도입 커밋 역추적 — `src/analyzer/blame.ts` (신규, 2026-07-31)**

`npm run review -- --blame` 으로 **TOP 10에만** 작성자·시점·커밋 메시지를 붙인다.

- Team Server API에 파일 단위 diff가 없어서, 과거 커밋의 모델을 열어 같은 룰을 재검사하는 수밖에 없음
- 커밋 하나 여는 데 33초 → **배치 이분 탐색**으로 줄임. 한 번 연 모델에서 10건을 동시 판정
- 실측: 107커밋 / 10건 → **조회 7회, 4분 18초** (이슈들이 같은 시기에 몰려서). 전체 실행 7분 44초
- 룰 탐지를 `detectFlowIssues` / `detectPageIssues`로 분리해 문서 하나만으로 재현 가능하게 만듦
- **그래프 의존 룰(L006·L008·D006·D007)과 도메인 룰(D***)은 역추적 미지원** — 리포트에 사유를 명시함
- `npm test` → bisect 정확성 + 머지 판별 검증 (자격증명 불필요, 1초). **오귀속은 사람에게 잘못된 책임을 지우므로 반드시 테스트 통과 후 사용**

**⚠️ 머지 커밋 문제 (실측에서 드러남)**
TOP 10 중 대부분이 `65088cbc "Merge commit"` (JEONG DONG GYUN, 2026-07-07)에 찍혔다.
이건 **머지한 사람**이지 작성자가 아니다. 이 브랜치는 머지 커밋 비중이 높아서, blame이 자주 여기 걸린다.
리포트에 경고 문구와 소스 브랜치명(추출 가능한 경우)을 함께 출력하도록 했지만, **정확한 작성자를 알려면 소스 브랜치를 직접 봐야 한다.**

### 아직 안 한 것
- [ ] **`D005`(XPath 없는 접근 규칙) 54건이 전체의 35%** — 관리자 역할에 의도적으로 전체 열람을 준 경우가 섞여 있을 것. 역할별로 걸러내거나 점수를 더 낮출지 판단 필요
- [ ] **`DesignAsset`이 테마 모듈로 자동 제외됨** — 우리 모듈인데 빠졌다. §5에서 중요하다고 적어둔 그 모듈. 리뷰 대상에 넣을지 결정할 것 (`graph.ts`의 `isThemeModule` 조건)
- [ ] 남은 고아 38건 표본 검증 — `Adjustment.TEST`, `common.ACT_FormatPhoneNumber` 등은 진짜 죽은 코드로 보이나, Java 액션에서 문자열로 호출되는 건 탐지 불가
- [ ] `MENDIX_SPRINTR_HOST` 실제 테넌트 값 확인 (현재 기본값 `sprintr.home.mendix.com`)
- [ ] `MENDIX_APP_NAME`을 `.env`에 넣기 — 지금은 리포트 폴더가 appId(UUID)로 생성됨
- [ ] **머지 커밋 귀속 개선** — `ICommit`에 부모 정보가 없어 구조적으로 머지 판별이 불가. 소스 브랜치(`donggyun-clean` 등)를 대상으로 blame을 한 번 더 돌리면 실제 작성자까지 내려갈 수 있음
- [ ] 도메인 룰(D***) 역추적 구현 — 지금은 TOP 10에 안 올라와서 미구현. `domain.ts`도 `detectEntityIssues`로 분리하면 됨
- [ ] Layer 3 (LLM 요약·묶기·순서 제안) — 탐지는 결정론적 코드에 두고, LLM은 확정된 사실만 받아 설명·우선순위만 담당

---

## 7. L001·D003 개정 (2026-08-06 완료분)

> 상세: **[`RULE_L001_D003.md`](./RULE_L001_D003.md)**

`VAL_IF_SABIS_002_AIR`가 L001 🔴 1위로 올라온 걸 실제 모델과 대조하다 나온 작업.

- **L001** — `first`(SingleObject)·루프 소스·XPath를 읽어 **반복 횟수에 상한이 있는지**로 등급을 가른다. payload 리스트를 도는 단건 키조회는 Warning(×0.5). 9건 중 4건 하향, 5건은 Error 유지.
  - 메시지 수정: "DB 조회가 1회 발생" → "루프 안에 DB 조회 액션이 1개 (반복마다 실행)". 기존 문구의 `1`은 실행 횟수가 아니라 액션 개수였는데 "한 번뿐이네"로 읽혔다.
- **D003** — `속성 20개 초과` 대리 지표를 버리고 실제 XPath 조회 키를 지목한다. leftmost prefix 반영. 비영속 엔티티 제외. 18건 → 16건, 내용 전면 교체.
- **신규** `src/analyzer/xpath.ts` — XPath 조회 키 파서. 순수 함수라 자격증명 없이 테스트(`npm test`에 16케이스 추가).
- **리포트 신규 섹션** `🔑 인덱스가 필요한 속성` — 엔티티별 작업 지시서 형태.

**이 모델에는 인덱스 정의가 0개다.** (`mprcontents` 전수 조사 확인) 그래서 D003이 지목하는 속성이 곧 실제 작업 목록이다.

### 여기서 새로 드러난 것
- [ ] **도메인 룰(D***)이 진입점 배수를 안 탄다** — 로직 룰은 `scoreWithReach`로 `baseScore × 진입점 가중치`를 타는데 `domain.ts`는 점수를 직접 계산한다. 그래서 D003이 구조적으로 L002 같은 룰에 밀린다. 신규 섹션으로 우회했으나 근본 해결은 아님
- [ ] 페이지 데이터소스의 XPath는 아직 수집 대상이 아님 (마이크로플로우 Retrieve만)

---

## 8. 내일 첫 마디로 쓸 것

> NEXT.md 보고 이어서 하자. STEP 0부터.

Claude Code에 이렇게 던지면 이 파일 읽고 바로 이어감.
