// src/analyzer/page.ts
import { pages, IModel, security } from "mendixmodelsdk";
import { ReviewIssue } from "./issue.js";
import { MendixRules } from "./rules.js";
import { ModelGraph } from "./graph.js";

const SYSTEM_MODULES = new Set(["System", "Administration"]);

/**
 * **페이지 하나만으로** 판정 가능한 룰들. blame이 과거 커밋에서 재현할 수 있도록 분리해 둔다.
 */
export function detectPageIssues(page: pages.Page, securityIsOn: boolean): PageRuleHit[] {
    const hits: PageRuleHit[] = [];

    // P001 — 타이틀 누락
    // Text는 언어별 Translation 목록을 들고 있다. 번역이 없거나 전부 공백이면 타이틀이 없는 것.
    const titleIsEmpty =
        !page.title ||
        page.title.translations.length === 0 ||
        page.title.translations.every((t) => !t.text || t.text.trim() === "");
    if (titleIsEmpty) {
        hits.push({
            ruleKey: "NO_PAGE_TITLE",
            category: "Page",
            message: `페이지 타이틀이 비어 있습니다.`,
            severity: "Warning",
            evidence: [],
        });
    }

    // P002 — 접근 역할 미지정 (보안이 켜져 있을 때만 의미 있음)
    if (securityIsOn && page.allowedRoles.length === 0) {
        hits.push({
            ruleKey: "PAGE_NO_ROLES",
            category: "Security",
            message: `허용된 모듈 역할이 지정되지 않았습니다.`,
            severity: "Error",
            evidence: ["보안이 켜진 상태에서 역할 미지정 페이지는 접근 정책이 불명확합니다."],
        });
    }

    return hits;
}

export interface PageRuleHit {
    ruleKey: keyof typeof MendixRules;
    category: "Page" | "Security";
    message: string;
    severity: "Warning" | "Error";
    evidence: string[];
}

function processPage(page: pages.Page, securityIsOn: boolean): ReviewIssue[] {
    const location = page.qualifiedName ?? page.name;
    return detectPageIssues(page, securityIsOn).map((hit) => {
        const rule = MendixRules[hit.ruleKey];
        return {
            category: hit.category,
            ruleId: rule.id,
            location,
            message: hit.message,
            recommendation: rule.recommendation,
            severity: hit.severity,
            evidence: hit.evidence.length > 0 ? hit.evidence : undefined,
            score: rule.baseScore,
        };
    });
}

async function readSecurityIsOn(model: IModel): Promise<boolean> {
    for (const proxy of model.allProjectSecurities()) {
        try {
            const sec = await proxy.load();
            return sec.securityLevel !== security.SecurityLevel.CheckNothing;
        } catch {
            /* 무시 */
        }
    }
    return false;
}

export async function analyzePage(model: IModel, graph: ModelGraph): Promise<ReviewIssue[]> {
    const securityIsOn = await readSecurityIsOn(model);

    const allPages = model.allPages().filter((p) => {
        const mod = (p.qualifiedName ?? "").split(".")[0];
        return !SYSTEM_MODULES.has(mod) && !graph.excludedModules.has(mod);
    });

    console.log(`🔍 [Page] 분석 시작... (대상: ${allPages.length}건)`);

    const issues: ReviewIssue[] = [];
    const failures: string[] = [];
    const BATCH_SIZE = 10;

    for (let i = 0; i < allPages.length; i += BATCH_SIZE) {
        const batch = allPages.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(
            batch.map(async (proxy) => {
                try {
                    return processPage(await proxy.load(), securityIsOn);
                } catch (err) {
                    failures.push(`${proxy.qualifiedName}: ${(err as Error).message}`);
                    return [];
                }
            })
        );
        for (const res of results) issues.push(...res);
    }

    if (failures.length > 0) {
        console.warn(`⚠️ [Page] ${failures.length}건 로드 실패 (첫 3건):`);
        for (const f of failures.slice(0, 3)) console.warn(`     - ${f}`);
    }

    console.log(`✅ [Page] 완료 (이슈 ${issues.length}건)`);
    return issues;
}
