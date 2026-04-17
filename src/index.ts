// src/index.ts
import { getModel } from "./client.js";
import { analyzeLogic } from "./analyzer/logic.js";
import { analyzeDomain } from "./analyzer/domain.js";
import { analyzePage } from "./analyzer/page.js";
import { generateReport, ReviewIssue } from "./analyzer/reporter.js";

export async function startReview(requestedBranch?: string, isDelta: boolean = false) {
    const branchName = requestedBranch || process.env.MENDIX_BRANCH || "main";
    console.log(`\n🚀 [${branchName}] 브랜치 분석을 시작합니다... (모드: ${isDelta ? "Delta" : "Full Audit"})`);
    console.log("🤖 Mendix Code Review Bot 가동!!!");
    console.time("소요 시간");

    try {
        const { model, commitInfo } = await getModel(branchName);

        // 분석 결과 수집 및 병렬 실행
        console.log(`\n🔍 분석(${isDelta ? "변경된 요소만" : "전체"})을 시작합니다...`);
        
        const [domainIssues, logicIssues, pageIssues] = await Promise.all([
            analyzeDomain(model, isDelta),
            analyzeLogic(model, isDelta),
            analyzePage(model, isDelta)
        ]);

        const allIssues: ReviewIssue[] = [...domainIssues, ...logicIssues, ...pageIssues];

        // 4. 리포트 생성
        console.log("\n📊 분석 결과 취합 및 보고서 생성 중...");
        await generateReport(commitInfo, allIssues);

        console.log("\n✨ 모든 코드 리뷰가 성공적으로 끝났습니다!");
    } catch (error) {
        console.error("❌ 리뷰 도중 치명적 에러 발생:", error);
    } finally {
        console.timeEnd("소요 시간");
    }
}

// 직접 실행 시 (npm run review)
if (process.argv[1]?.endsWith('index.ts') || process.argv[1]?.endsWith('index.js')) {
    startReview();
}
