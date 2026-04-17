# 🛠 Mendix Code Reviewer 포팅 및 운영 매뉴얼

이 문서는 Mendix Code Reviewer 시스템을 새로운 환경에 설치, 구성 및 실행하기 위한 가이드입니다.

## 1. 요구 사항 (Prerequisites)
- **Node.js:** v18.0.0 이상 (v24.x 권장)
- **Package Manager:** npm (또는 yarn)
- **Mendix 계정:** Mendix Platform API에 접근 가능한 **Personal Access Token** 필요
- **메모리:** 모델 분석을 위해 최소 4GB 이상의 여유 RAM 권장

## 2. 설치 및 구성 (Setup)

### 1) 저장소 복제 및 패키지 설치
```bash
git clone <repository-url>
cd Mendix-code-reviewer
npm install
```

### 2) 환경 변수 설정 (`.env`)
프로젝트 루트에 `.env` 파일을 생성하고 아래 정보를 입력합니다.
```env
MENDIX_TOKEN=your_mendix_platform_token
MENDIX_APP_ID=your_app_uuid
MENDIX_BRANCH=main
PORT=3000
```
* `MENDIX_TOKEN`: Mendix Sprintr -> 개인 설정 -> API Tokens에서 발급
* `MENDIX_APP_ID`: Mendix App의 Settings -> General에서 확인 가능 (UUID 형식)

## 3. 실행 모드 (Execution Modes)

### 모드 A: 전체 분석 (Full Audit)
프로젝트 전체의 아키텍처와 기술 부채를 전수 조사할 때 사용합니다.
```bash
npm run review
```
- **특징:** 모든 모듈(System 제외)의 도메인, 로직, 페이지를 분석합니다.
- **결과물:** `./reports/앱이름/브랜치/` 경로에 마크다운 리포트 생성.

### 모드 B: 웹훅 서버 (Webhook Server)
커밋 발생 시 자동으로 변경된 부분만 즉시 리뷰할 때 사용합니다.
```bash
npm run server
```
- **특징:** 3000번 포트에서 대기하며, 요청 수신 시 **최근 1시간 내 수정된 요소**만 필터링하여 분석(Delta 모드).
- **Endpoint:** `POST http://<server-ip>:3000/webhook/mendix`

## 4. 웹훅 연동 가이드 (Webhook Integration)

### 1) 웹훅 요청 데이터 구조 (JSON)
서버로 아래와 같은 형식의 POST 요청을 보내면 분석이 트리거됩니다.
```json
{
  "branch": "main",
  "commitId": "rev_12345",
  "author": "Developer Name"
}
```

### 2) 테스트 방법 (curl)
```bash
curl -X POST http://localhost:3000/webhook/mendix \
     -H "Content-Type: application/json" \
     -d '{"branch": "main", "commitId": "test_rev", "author": "Tester"}'
```

## 5. 결과 확인 (Reports)
모든 분석 결과는 `reports/` 디렉토리에 마크다운(`.md`) 파일로 저장됩니다.
- **파일명 규칙:** `YYYYMMDD_HHMM_rev<CommitID>.md`
- **리포트 포함 내용:** 치명적 성능 결함(루프 내 DB 작업), 로직 복잡도, 도메인 설계 오류 등.

## 6. 유지보수 및 팁
- **메모리 부족 에러 발생 시:** `package.json`의 `NODE_OPTIONS`에서 `--max-old-space-size` 값을 조정하십시오 (현재 8GB 설정됨).
- **분석 범위 조정:** `src/analyzer/logic.ts`의 `ONE_HOUR` 상수를 변경하여 Delta 분석 대상 시간 범위를 조정할 수 있습니다.
- **SDK 업데이트:** Mendix의 새 버전 기능 분석이 필요할 경우 `mendixmodelsdk`와 `mendixplatformsdk`를 업데이트하십시오.
