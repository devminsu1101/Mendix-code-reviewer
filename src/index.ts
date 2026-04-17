// src/index.ts
import { getModel } from "./client.js";
import { analyzeLogic } from "./analyzer/logic.js";
import { analyzeDomain } from "./analyzer/domain.js";
import { analyzePage } from "./analyzer/page.js";
import { generateReport, ReviewIssue } from "./analyzer/reporter.js";

async function startReview() {
    const branchName = process.env.MENDIX_BRANCH || "main";
    console.log(`\n🚀 [${branchName}] 브랜치 분석을 시작합니다...`);
    console.log("🤖 Mendix Code Review Bot 가동!!!");
    console.time("소요 시간");

    try {
        const { model, commitInfo } = await getModel();

        // 분석 결과 수집
        const allIssues: ReviewIssue[] = [];

        // 1. 도메인 분석
        const domainIssues = await analyzeDomain(model);
        allIssues.push(...domainIssues);

        // 2. 로직 분석
        const logicIssues = await analyzeLogic(model);
        allIssues.push(...logicIssues);

        // 3. 페이지 분석
        const pageIssues = await analyzePage(model);
        allIssues.push(...pageIssues);

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

startReview();
