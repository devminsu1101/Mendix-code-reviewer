// src/analyzer/page.ts
import { pages, IModel } from "mendixmodelsdk";
import { ReviewIssue } from "./reporter.js";

/**
 * 개별 페이지 분석 로직
 */
function processPage(page: pages.Page): ReviewIssue[] {
    const issues: ReviewIssue[] = [];
    const moduleName = page.qualifiedName.split('.')[0];
    const location = `${moduleName}.${page.name}`;

    // 1. 페이지 타이틀 검사 (사용자 경험 핵심)
    if (!page.title || (page.title.items && page.title.items.length === 0)) {
        issues.push({ 
            category: 'Page', 
            location, 
            message: `⚠️ [디자인 결함] 페이지 타이틀이 설정되지 않았습니다.`, 
            recommendation: "사용자가 현재 어떤 화면에 있는지 알 수 있도록 Page Title을 입력하세요.",
            severity: 'Warning' 
        });
    }

    return issues;
}

export async function analyzePage(model: IModel): Promise<ReviewIssue[]> {
    const allPages = model.allPages().filter(p => {
        const mod = p.qualifiedName.split(".")[0];
        return mod !== "System" && mod !== "Administration";
    });

    console.log(`🔍 [Page] ${allPages.length}개의 페이지 분석 시작 (병렬 처리)...`);
    
    const allIssues: ReviewIssue[] = [];
    const BATCH_SIZE = 10;

    for (let i = 0; i < allPages.length; i += BATCH_SIZE) {
        const batch = allPages.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(batch.map(async (pageProxy) => {
            try {
                const loadedPage = await pageProxy.load();
                return processPage(loadedPage);
            } catch (err) {
                console.error(`❌ ${pageProxy.qualifiedName} 로드 실패`);
                return [];
            }
        }));
        results.forEach(res => allIssues.push(...res));
        console.log(`   > 진행률: ${Math.min(i + BATCH_SIZE, allPages.length)} / ${allPages.length}`);
    }

    console.log(`✅ 페이지 분석 완료 (발견된 이슈: ${allIssues.length}건)`);
    return allIssues;
}
