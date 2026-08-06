// src/index.ts
import { getModel } from "./client.js";
import { buildGraph } from "./analyzer/graph.js";
import { analyzeLogic } from "./analyzer/logic.js";
import { analyzeDomain } from "./analyzer/domain.js";
import { analyzePage } from "./analyzer/page.js";
import { generateReport } from "./analyzer/reporter.js";
import { ReviewIssue } from "./analyzer/issue.js";
import { blameIssues, BlameResult } from "./analyzer/blame.js";

export async function startReview(requestedBranch?: string, withBlame = false) {
    const branchName = requestedBranch || process.env.MENDIX_BRANCH || "main";
    console.log(`\n🚀 [${branchName}] 브랜치 분석을 시작합니다...`);
    console.time("총 소요 시간");

    try {
        console.time("  ├ 모델 로딩");
        const { model, commitInfo } = await getModel(branchName);
        console.timeEnd("  ├ 모델 로딩");

        // 1. 관계 인덱스 먼저. 이후 분석은 전부 이 그래프 위에서 이뤄진다.
        console.time("  ├ 그래프 구축");
        const graph = await buildGraph(model);
        console.timeEnd("  ├ 그래프 구축");

        // 2. 분석 (그래프의 로드된 문서를 재사용하므로 중복 로딩이 없다)
        console.time("  └ 분석");
        const [logicIssues, domainIssues, pageIssues] = await Promise.all([
            analyzeLogic(graph),
            analyzeDomain(model, graph),
            analyzePage(model, graph),
        ]);
        console.timeEnd("  └ 분석");

        const allIssues: ReviewIssue[] = [...logicIssues, ...domainIssues, ...pageIssues];

        // 3. (선택) TOP 10의 도입 커밋 역추적.
        //    커밋당 모델을 새로 여는 작업이라 비싸다. 기본은 끄고 --blame일 때만 돈다.
        let blame: Map<string, BlameResult> | undefined;
        if (withBlame) {
            const top10 = [...allIssues]
                .sort((a, b) => b.score - a.score || a.location.localeCompare(b.location))
                .slice(0, 10);
            console.time("  └ blame");
            blame = await blameIssues(branchName, top10);
            console.timeEnd("  └ blame");
        }

        await generateReport(commitInfo, allIssues, graph, blame);
        console.log("\n✨ 리뷰 완료");
    } catch (error) {
        console.error("❌ 리뷰 도중 에러 발생:", error);
        process.exitCode = 1;
    } finally {
        console.timeEnd("총 소요 시간");
    }
}

// 직접 실행 시: npm run review -- <브랜치> [--blame]
if (process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js")) {
    const args = process.argv.slice(2);
    const withBlame = args.includes("--blame");
    const branch = args.find((a) => !a.startsWith("--"));
    startReview(branch, withBlame);
}
