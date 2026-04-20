# 🛠 Libuv Assertion Error 수정 계획 (Assertion failed: !(handle->flags & UV_HANDLE_CLOSING))

## 1. 이슈 개요
- **현상**: `npm run guide` 실행 시 가이드 생성은 성공하나, 프로세스 종료 단계에서 `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` 에러 발생.
- **환경**: Windows 10/11, Node.js (tsx), Mendix Platform SDK.
- **발생 위치**: `src\win\async.c` (Libuv 윈도우 비동기 처리 라이브러리).

## 2. 원인 분석
1. **강제 종료 (`process.exit(0)`)**: `src/onboarding.ts`의 `finally` 블록에서 `process.exit(0)`을 호출하여 이벤트 루프의 비동기 작업이 완료되기 전에 프로세스를 강제로 중단시킴.
2. **미폐쇄된 SDK 핸들**: `MendixPlatformClient`를 통해 열린 `model` 객체가 서버와의 연결(Socket/Timer)을 유지하고 있음. 이를 닫지 않은 상태에서 프로세스가 종료되려고 할 때 윈도우의 비동기 핸들 관리 로직과 충돌 발생.
3. **OS 특성**: 해당 에러는 특히 Windows 환경의 Node.js에서 비정상적인 리소스 정리 시 발생하는 전형적인 이슈임.

## 3. 해결 계획 (To-Do)

### A. 리소스 정리 로직 추가 (`src/onboarding.ts`)
- `model` 객체를 `try` 블록 외부에서 선언하여 `finally` 블록에서 접근 가능하도록 변경.
- 작업 완료 후 `model.close()`를 명시적으로 호출하여 SDK 내부 핸들을 해제.

### B. 강제 종료 코드 제거
- `process.exit(0)` 코드를 제거하여 Node.js가 비동기 리소스 정리를 완료하고 스스로 종료(Graceful Shutdown)되도록 유도.

### C. 예상 수정 코드 구조
```typescript
// src/onboarding.ts 수정 방향
async function runOnboarding() {
    let model; // 전역/상위 스코프 선언
    try {
        const { model: loadedModel, commitInfo } = await getModel(requestedBranch);
        model = loadedModel;
        // ... 작업 수행
    } catch (error) {
        console.error(error);
    } finally {
        if (model) {
            await model.close(); // 명시적 리소스 해제
            console.log("🔒 모델 연결을 안전하게 닫았습니다.");
        }
        console.timeEnd("소요 시간");
        // process.exit(0); <- 제거
    }
}
```

## 4. 검증 방법
1. `npm run guide` 재실행.
2. 가이드 생성 완료 후 에러 메시지 없이 터미널 프롬프트로 정상 복귀하는지 확인.
