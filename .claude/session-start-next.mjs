// SessionStart 훅: NEXT.md를 세션 컨텍스트에 주입한다.
// 파일이 없거나 읽기 실패하면 조용히 아무것도 안 한다 (세션을 절대 막지 않음).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

try {
    const here = dirname(fileURLToPath(import.meta.url));
    const body = readFileSync(resolve(here, "..", "NEXT.md"), "utf8").trim();
    if (body) {
        process.stdout.write(
            JSON.stringify({
                hookSpecificOutput: {
                    hookEventName: "SessionStart",
                    additionalContext:
                        "이 프로젝트에는 이어서 할 작업이 정리된 NEXT.md가 있다. " +
                        "사용자가 무엇을 할지 물어보거나 작업을 이어가려 하면 이 내용을 기준으로 안내할 것. " +
                        "아래는 NEXT.md 전문이다.\n\n" +
                        "----- NEXT.md -----\n" +
                        body
                }
            })
        );
    }
} catch {
    // NEXT.md 없음 → 무시
}
