# 🛠 Mendix Code Reviewer 포팅 및 운영 매뉴얼

새 환경에 설치하거나, **다른 Mendix 앱에 붙일 때** 보는 문서입니다.
도구가 무엇을 하는지·왜 그렇게 만들었는지는 [`README.md`](./README.md)를 보세요.

> 최종 확인: 2026-08-12 (코드 기준으로 재작성)

---

## 1. 요구 사항

| 항목 | 요구 사항 |
| :--- | :--- |
| Node.js | **v18 이상** (개발·검증 환경은 v24.14) |
| 패키지 매니저 | npm (개발 환경 v11) |
| Mendix 계정 | 대상 앱에 접근 가능한 **Personal Access Token** |
| 메모리 | 여유 RAM 4GB 이상 권장 (flow 400개 규모 기준) |
| 네트워크 | Mendix Team Server API 접근 (사내 프록시 환경이면 확인 필요) |

TypeScript는 빌드 없이 `tsx`로 직접 실행합니다(ESM/NodeNext). 별도 컴파일 단계가 없습니다.

---

## 2. 설치

```bash
git clone <repository-url>
cd Mendix-code-reviewer
npm install
```

`.env`를 프로젝트 루트에 만들고 (다음 절), 아래 순서로 점검하면 문제를 빨리 찾을 수 있습니다.

```bash
npm run selfcheck          # ① SDK 심볼이 살아 있는가 (자격증명 불필요, 수 초)
npm test                   # ② 파서·이분탐색·리포터 회귀 (자격증명 불필요, 수 초)
npm run review -- main     # ③ 실제 분석 (자격증명 필요, 수 분)
```

①②는 **네트워크도 토큰도 없이** 돕니다. 여기서 실패하면 환경 문제이지 권한 문제가 아닙니다.

---

## 3. 환경 변수 (`.env`)

```env
# ── 필수 ──────────────────────────────────────────────
MENDIX_TOKEN=your_mendix_personal_access_token
MENDIX_APP_ID=your_app_uuid

# ── 선택 ──────────────────────────────────────────────
MENDIX_BRANCH=main
MENDIX_APP_NAME=RamsesKR
GEMINI_API_KEY=your_gemini_api_key
MENDIX_SPRINTR_HOST=sprintr.home.mendix.com
PORT=3000
```

| 변수 | 필수 | 설명 |
| :--- | :---: | :--- |
| `MENDIX_TOKEN` | ✅ | Mendix Developer Portal → 개인 설정 → **API Tokens**에서 발급 |
| `MENDIX_APP_ID` | ✅ | App → Settings → General의 **UUID** |
| `MENDIX_BRANCH` | | 브랜치를 인자로 안 줬을 때의 기본값. 미설정 시 `main` |
| `MENDIX_APP_NAME` | | **리포트 폴더 이름**에 쓰입니다. 미설정 시 App UUID가 폴더명이 됩니다 |
| `GEMINI_API_KEY` | | `npm run guide`에만 필요합니다. 없으면 그 명령만 실패합니다 |
| `MENDIX_SPRINTR_HOST` | | 리포트의 커밋 링크 도메인. 미설정 시 `sprintr.home.mendix.com` |
| `PORT` | | `npm run server` 포트. 미설정 시 `3000` |

> ⚠️ **값에 따옴표·세미콜론을 넣지 마세요.** 과거에 `.env` 값의 `"`와 `;`가 그대로 토큰에 섞여 인증이 실패한 적이 있습니다.
>
> ⚠️ **`.env`를 OneDrive·Dropbox 등 동기화 폴더에 두지 마세요.** `.gitignore`에 있어도 동기화 서비스는 git과 무관하게 클라우드로 올립니다. 이미 올라갔다면 **토큰을 재발급**하는 것이 가장 확실한 정리입니다.

---

## 4. 실행 모드

### 4-1. 품질 감사 — `npm run review`

브랜치 전체를 훑어 결함을 찾고 Markdown 리포트를 생성합니다.

```bash
npm run review                      # .env의 MENDIX_BRANCH
npm run review -- minsu-clean       # 브랜치 지정
npm run review -- minsu-clean --blame   # + 상위 10건의 도입 커밋 역추적
```

- 인자 순서는 자유입니다. `--`로 시작하지 않는 첫 인자를 브랜치로 봅니다.
- 소요: flow 400개 규모에서 **수 분**. 대부분이 Working Copy 생성 + 모델 로딩입니다.
- `--blame`은 **커밋 조회 1회당 약 33초**, 최대 40회까지 조회합니다. 붙이면 훨씬 오래 걸립니다.

### 4-2. AI 온보딩 가이드 — `npm run guide`

```bash
npm run guide                # 기본 브랜치
npm run guide -- minsu-clean # 브랜치 지정
```

`GEMINI_API_KEY`가 필요합니다. 결과는 `reports/Onboarding/`에 저장됩니다.

### 4-3. 자기 검증 — `npm run selfcheck` / `npm test`

```bash
npm run selfcheck   # 분석기가 참조하는 SDK 심볼 21개 존재 확인 (실패 시 exit 1)
npm test            # selfcheck + blame · xpath · reporter 회귀 테스트
```

**SDK를 올린 직후에는 반드시 `npm run selfcheck`를 먼저 도세요.** `mendixmodelsdk`는 메타모델 변경 시 클래스를 조용히 제거하는데, 그러면 해당 규칙이 예외를 던지고 그 예외가 삼켜져 **"이슈 0건"처럼 보입니다.**

### 4-4. 웹훅 서버 — `npm run server` 🧪 실험 단계

```bash
npm run server
curl -X POST http://localhost:3000/webhook/mendix \
     -H "Content-Type: application/json" \
     -d '{"branch":"main"}'
```

- 요청 본문: `{ "branch": "main", "commitId": "...", "author": "..." }` — 현재 실제로 쓰는 값은 `branch`뿐입니다.
- 즉시 `202 Accepted`를 반환하고(웹훅 타임아웃 방지) 백그라운드에서 분석합니다.
- **현재는 전수 리뷰를 그대로 돌립니다(수 분).** 커밋 단위 알림 용도로는 아직 적합하지 않습니다.

> 예전 문서에 있던 "최근 1시간 내 수정분만 분석하는 Delta 모드"는 **제거되었습니다.** 시간 기반 추측이 실제로 동작하지 않았습니다. 증분 분석은 스냅샷 diff 방식으로 재설계 중이며 계획은 [`NEXT.md`](./NEXT.md)에 있습니다.

---

## 5. 산출물

| 명령 | 경로 |
| :--- | :--- |
| `review` | `reports/<앱이름>/<브랜치>/YYYYMMDD_HHMM_rev<커밋ID>.md` |
| `guide` | `reports/Onboarding/Master_Onboarding_Guide_<ISO타임스탬프>.md` |

- `<앱이름>`은 `MENDIX_APP_NAME`이고, 미설정 시 App UUID입니다.
- `reports/`는 `.gitignore`에 있습니다. 공유하려면 파일을 따로 복사하세요.
- 리포트는 **해당 커밋의 변경분이 아니라 그 시점 브랜치 전체 상태**입니다. 문서 상단에도 명시됩니다.

---

## 6. 다른 앱에 붙일 때 조정할 지점

`MENDIX_APP_ID`만 바꿔도 돌아가지만, 아래는 **우리 팀 기준**이 박혀 있어 대상 프로젝트에 맞게 확인해야 합니다.

### 6-1. 팀 컨벤션이 들어간 규칙

| 위치 | 내용 | 다른 팀이면 |
| :--- | :--- | :--- |
| `rules.ts` — `NP_PERSISTABLE_ERROR` (D002) | `NP_` 접두사 = Non-Persistable이라는 **명명 규칙** | 접두사가 다르면 `domain.ts`의 `startsWith("NP_")` 수정 |
| `graph.ts` — `SYSTEM_MODULES` | `System`, `Administration`을 분석 대상에서 제외 | 사내 공통 모듈이 있으면 추가 |
| `graph.ts` — 마켓플레이스 판정 | `fromAppStore` / `isThemeModule`로 자동 제외 | 보통 그대로 두면 됩니다 |

### 6-2. 임계값

| 파일 | 상수/조건 | 현재 값 | 의미 |
| :--- | :--- | ---: | :--- |
| `logic.ts` | 액션 수 (L003) | `> 25` | 로직 복잡도 경고 기준 |
| `logic.ts` | 파라미터 수 (L004) | `> 7` | 파라미터 과다 기준 |
| `logic.ts` | 중첩 깊이 (L005) | `>= 2` | 중첩 루프 판정 |
| `logic.ts` | 지문 최소 액션 수 (L008) | `< 6` 무시 | 짧은 로직은 닮아 보이는 게 정상 |
| `domain.ts` | 연관관계 수 (D001) | `> 5` | 관계 과다 기준 |
| `domain.ts` | 사용 flow 수 (D006) | `>= 15` | 파급 반경 큰 엔티티 기준 |
| `domain.ts` | 모듈 간 참조 (D007) | `>= 3` | 강한 결합 기준 |
| `graph.ts` | `ENTRY_WEIGHT` | 10 / 8 / 7 / 5 / 3 | 진입 유형별 위험 가중치 |
| `graph.ts` | `BATCH_SIZE` | `10` | flow 병렬 로딩 배치 크기 |
| `blame.ts` | `maxLookups` | `40` | 커밋 조회 상한 (33초 × 40 ≈ 22분) |
| `blame.ts` | `fetchCommits(maxPages)` | `20` | 최대 2,000커밋까지 이력 조회 |
| `reporter.ts` | `FOCUS_LIMIT` | `2` | 규칙당 근거까지 펼칠 건수 |
| `reporter.ts` | `TABLE_THRESHOLD` | `3` | 이하면 표 없이 전부 펼침 |

> 임계값을 바꾸면 `npm test`의 리포터 테스트가 기대값과 어긋날 수 있습니다. 테스트가 깨지면 **기대값을 함께 갱신**하세요.

### 6-3. 규칙을 새로 추가할 때

1. `rules.ts`에 항목 추가 — `id` · `name` · `description` · `recommendation` · `target` · `baseScore` · `focusAxis`
2. 판정 로직을 `logic.ts` / `domain.ts` / `page.ts` 중 알맞은 곳에 추가
3. `instanceof`로 새 SDK 클래스를 쓴다면 **`selfcheck.ts`의 목록에도 추가** (안 하면 조용히 죽습니다)
4. `--blame` 대상으로 삼으려면 **문서 하나만으로 재현 가능**해야 합니다. 그래프가 필요하면 `blame.ts`의 `GRAPH_DEPENDENT`에 등록해 "역추적 불가"로 표시되게 하세요

---

## 7. 문제 해결

<details>
<summary><b>403 Forbidden — 권한이 부족합니다</b></summary>

토큰이 만료되었거나, 해당 App에 대한 접근 권한이 없습니다.

1. [Mendix Developer Portal](https://home.mendix.com)에서 토큰 유효성 확인
2. 해당 App의 팀 멤버로 등록되어 있는지 확인
3. `MENDIX_APP_ID`가 정확한 UUID인지 확인 (앱 이름이 아닙니다)

</details>

<details>
<summary><b>메모리 부족 (JavaScript heap out of memory)</b></summary>

`package.json`의 `NODE_OPTIONS=--max-old-space-size=8192` 값을 올리세요. 물리 RAM보다 크게 잡으면 오히려 느려집니다.

모델이 아주 크면 `graph.ts`의 `BATCH_SIZE`를 낮추는 것도 방법입니다(동시 로딩 문서 수 감소).

</details>

<details>
<summary><b>selfcheck에서 ❌가 뜬다</b></summary>

`mendixmodelsdk` 버전이 바뀌면서 클래스가 제거·개명된 경우입니다. **그 규칙은 지금 죽어 있습니다.**

1. SDK 릴리스 노트에서 해당 심볼의 변경 내역 확인
2. `analyzer/` 쪽 참조를 새 이름으로 수정
3. `selfcheck.ts`의 목록도 함께 수정

이 체크가 없으면 `instanceof undefined` → TypeError → `try/catch`에 삼켜짐 → **"이슈 0건" 리포트**로 이어집니다. 실제로 겪었던 실패입니다.

</details>

<details>
<summary><b>이슈가 0건으로 나온다 / 특정 규칙만 안 잡힌다</b></summary>

먼저 조용한 실패를 의심하세요.

1. `npm run selfcheck` — SDK 심볼 확인
2. 콘솔에 `⚠️ flow N건 로드 실패` 경고가 있었는지 확인
3. `npm test` — 파서가 빈 결과를 돌려주고 있지는 않은지
4. 모듈이 마켓플레이스/테마로 잘못 분류되지는 않았는지 (리포트 "제외된 모듈" 목록 확인)

</details>

<details>
<summary><b>실행이 너무 느리다</b></summary>

대부분은 `createTemporaryWorkingCopy`(Team Server에서 작업 카피 생성)와 모델 로딩입니다. 코드 최적화로 줄일 수 있는 구간이 아닙니다.

- `--blame`을 뺐는지 확인하세요. 커밋 조회 1회당 33초입니다.
- 분석 자체는 이미 병렬(도메인/로직/페이지 동시, flow 10개 배치)입니다.

</details>

<details>
<summary><b>SDK를 업데이트하고 싶다</b></summary>

```bash
npm install mendixmodelsdk@latest mendixplatformsdk@latest
npm run selfcheck    # ← 반드시 바로 실행
npm test
```

Mendix 새 버전의 기능을 분석하려면 SDK 업데이트가 필요하지만, 메타모델 변경으로 기존 규칙이 죽을 수 있습니다. 업데이트 직후 `selfcheck`가 유일한 조기 경보입니다.

</details>

---

## 8. 운영 팁

- **토큰은 개인 자산입니다.** 공용 서버에 올릴 때는 전용 계정/토큰을 따로 발급하고, 유출 시 재발급이 가장 싼 대응입니다.
- **`reports/`는 git에 올라가지 않습니다.** 팀에 공유할 땐 파일을 따로 전달하세요. 리포트에는 flow·엔티티 이름 등 내부 구조가 그대로 들어갑니다.
- **정기 실행은 아직 권장하지 않습니다.** 자동 게시가 공개 지적으로 읽히면 도구가 팀에서 살아남지 못합니다. 배포 정책에 대한 판단은 [`NEXT.md`](./NEXT.md)에 정리되어 있습니다.
- **이어서 개발할 때는 [`NEXT.md`](./NEXT.md)가 기준입니다.** 진행 상황 표가 문서 맨 위에 있습니다.
- [`docs/archive/`](./docs/archive/)의 문서는 **참고용이지 기준이 아닙니다.** 2026년 4월 시점 기록이라 현재 코드와 다릅니다.
