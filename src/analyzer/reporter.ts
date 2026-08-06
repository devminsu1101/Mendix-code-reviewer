import * as fs from "fs";
import * as path from "path";
import { ReviewIssue } from "./issue.js";
import { ModelGraph } from "./graph.js";
import { MendixRules } from "./rules.js";
import { BlameResult, issueKey, summarizeCommitOrigin } from "./blame.js";

export type { ReviewIssue } from "./issue.js";

export interface CommitInfo {
    appName: string;
    branch: string;
    author: string;
    date: Date;
    revId: string;
    message: string;
    appId: string;
}

/** ruleId → 규칙 메타. 문자열 매칭 대신 ID로 집계하기 위한 역인덱스. */
const RULE_BY_ID = new Map(Object.values(MendixRules).map((r) => [r.id, r]));

function moduleOf(location: string): string {
    return location.split(/[.\s]/)[0] || "(기타)";
}

function escapePipes(text: string): string {
    return text.replace(/\|/g, "\\|");
}

/** blame 결과 한 건을 사람이 읽을 한 줄로. */
function renderBlame(result: BlameResult | undefined): string | null {
    if (!result) return null;
    switch (result.status) {
        case "found":
        case "from-start": {
            const c = result.commit!;
            const date = c.date.substring(0, 10);
            const msg = c.message.replace(/\s+/g, " ").substring(0, 120);
            const origin = summarizeCommitOrigin(c.message);

            if (result.status === "from-start") {
                return (
                    `**도입 시점:** 조회 가능한 이력의 첫 커밋(${date})부터 이미 존재 — ` +
                    `실제 도입은 그 이전이거나 다른 브랜치. 이 브랜치에서는 특정 불가`
                );
            }

            let line = `**최초 등장:** ${c.author} · ${date} · \`${c.id.substring(0, 8)}\` — "${msg}"`;
            if (origin.isMerge) {
                // 머지 커밋에 찍혔다는 것은 "이 사람이 작성했다"가 아니라
                // "이 사람이 가져왔다"는 뜻이다. 그대로 두면 책임소재를 오독하게 된다.
                line +=
                    `\n    - ⚠️ **머지 커밋입니다.** 위 이름은 머지한 사람이지 작성자가 아닐 수 있습니다.` +
                    (origin.sourceBranch
                        ? ` 실제 작성은 \`${origin.sourceBranch}\` 브랜치에서 확인하세요.`
                        : ` 소스 브랜치에서 확인이 필요합니다.`);
            }
            return line;
        }
        case "unsupported":
            return `**도입 시점:** 추적 불가 (${result.note})`;
        case "error":
            return `**도입 시점:** 미확정 (조회 상한 도달)`;
    }
}

function renderTopIssues(
    issues: ReviewIssue[],
    limit: number,
    blame?: Map<string, BlameResult>
): string {
    const top = issues.slice(0, limit);
    if (top.length === 0) return "발견된 이슈가 없습니다.\n";

    let out = "";
    top.forEach((issue, idx) => {
        const badge = issue.severity === "Error" ? "🔴" : "⚠️";
        out += `### ${idx + 1}. ${badge} \`${issue.location}\` — ${issue.message}\n\n`;
        out += `- **규칙:** ${issue.ruleId} · **우선순위 점수:** ${issue.score}\n`;
        const blameLine = renderBlame(blame?.get(issueKey(issue)));
        if (blameLine) out += `- ${blameLine}\n`;
        if (issue.evidence?.length) {
            out += `- **근거:**\n`;
            for (const e of issue.evidence) out += `    - ${e}\n`;
        }
        if (issue.recommendation) out += `- **조치:** ${issue.recommendation}\n`;
        out += `\n`;
    });
    return out;
}

function renderRuleSummary(issues: ReviewIssue[]): string {
    const counts = new Map<string, number>();
    for (const i of issues) counts.set(i.ruleId, (counts.get(i.ruleId) ?? 0) + 1);

    const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    let out = `| 규칙 | 내용 | 목표 | 발견 |\n| :--- | :--- | :--- | ---: |\n`;
    for (const [ruleId, count] of rows) {
        const rule = RULE_BY_ID.get(ruleId);
        out += `| \`${ruleId}\` | ${escapePipes(rule?.description ?? "-")} | ${rule?.target ?? "-"} | ${count}건 |\n`;
    }
    return out;
}

function renderModuleHealth(issues: ReviewIssue[], graph: ModelGraph): string {
    const stats = new Map<string, { errors: number; warnings: number; score: number; flows: number }>();
    const ensure = (m: string) => {
        let s = stats.get(m);
        if (!s) {
            s = { errors: 0, warnings: 0, score: 0, flows: 0 };
            stats.set(m, s);
        }
        return s;
    };

    for (const node of graph.flows.values()) ensure(node.module).flows++;
    for (const issue of issues) {
        const s = ensure(moduleOf(issue.location));
        if (issue.severity === "Error") s.errors++;
        else s.warnings++;
        s.score += issue.score;
    }

    const rows = [...stats.entries()].sort((a, b) => b[1].score - a[1].score);
    let out = `| 모듈 | flow 수 | 🔴 Error | ⚠️ Warning | 누적 점수 |\n| :--- | ---: | ---: | ---: | ---: |\n`;
    for (const [mod, s] of rows) {
        if (s.errors === 0 && s.warnings === 0 && s.flows === 0) continue;
        out += `| ${mod} | ${s.flows} | ${s.errors} | ${s.warnings} | ${s.score} |\n`;
    }
    return out;
}

function renderEntryPointProfile(graph: ModelGraph): string {
    const byKind = new Map<string, number>();
    for (const e of graph.entryPoints) byKind.set(e.kind, (byKind.get(e.kind) ?? 0) + 1);

    const reviewable = [...graph.flows.values()].filter((f) => f.reviewable);
    const reachable = reviewable.filter((f) => graph.reach.get(f.qName)?.reachable).length;
    const orphans = reviewable.length - reachable;

    let out = `- **리뷰 대상 flow ${reviewable.length}개** (전체 ${graph.flows.size}개) — 도달 가능 ${reachable}개 / 고아 ${orphans}개\n`;
    if (graph.excludedModules.size > 0) {
        out += `- **제외된 모듈 ${graph.excludedModules.size}개** (마켓플레이스·테마, 수정 대상 아님): ${[...graph.excludedModules].sort().join(", ")}\n`;
    }
    out += `- **진입점 ${graph.entryPoints.length}개** — `;
    out += [...byKind.entries()].map(([k, v]) => `${k} ${v}`).join(", ") || "없음";
    out += `\n`;

    const scheduled = graph.entryPoints.filter((e) => e.kind === "ScheduledEvent");
    if (scheduled.length > 0) {
        out += `- **무인 실행 경로:** ${scheduled.map((e) => e.label).join(" · ")}\n`;
    }
    return out;
}

export async function generateReport(
    commitInfo: CommitInfo,
    issues: ReviewIssue[],
    graph: ModelGraph,
    blame?: Map<string, BlameResult>
) {
    const safeAppName = commitInfo.appName || "UnknownApp";
    const safeBranchName = commitInfo.branch || "main";
    const reportDir = path.join(process.cwd(), "reports", safeAppName, safeBranchName);
    fs.mkdirSync(reportDir, { recursive: true });

    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, "0");
    const timestamp =
        `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_` +
        `${pad(now.getHours())}${pad(now.getMinutes())}`;
    const filePath = path.join(reportDir, `${timestamp}_rev${commitInfo.revId}.md`);

    // 점수 내림차순. 동점이면 안정적인 순서를 위해 location으로 tie-break.
    const sorted = [...issues].sort(
        (a, b) => b.score - a.score || a.location.localeCompare(b.location)
    );

    const errors = sorted.filter((i) => i.severity === "Error");
    const warnings = sorted.filter((i) => i.severity === "Warning");

    // ruleId 기반 집계 — 메시지 문자열 매칭에 의존하지 않는다.
    const countByRule = (id: string) => sorted.filter((i) => i.ruleId === id).length;
    const loopDbCount = countByRule("L001") + countByRule("L002");
    const complexityCount = countByRule("L003");
    const nestedLoopCount = countByRule("L005");
    const securityCount = sorted.filter((i) => i.category === "Security").length;

    const tenantHost = process.env.MENDIX_SPRINTR_HOST || "sprintr.home.mendix.com";
    const commitUrl = `https://${tenantHost}/link/app/${commitInfo.appId}/vcs/revision/${commitInfo.revId}`;

    let content = `# 🤖 Mendix Architecture & Performance Report\n\n`;

    content += `## 📌 대상\n`;
    content += `- **App:** ${safeAppName}\n`;
    content += `- **Branch:** \`${commitInfo.branch}\`\n`;
    content += `- **Commit:** [${commitInfo.revId.substring(0, 8)}](${commitUrl}) — ${escapePipes(commitInfo.message)}\n`;
    content += `- **Author:** ${commitInfo.author}\n`;
    content += `- **분석 시각:** ${now.toLocaleString()}\n\n`;

    content += `## 🗺️ 모델 구성\n`;
    content += renderEntryPointProfile(graph);
    content += `\n`;

    content += `## 🎯 KPI\n`;
    content += `| 지표 | 목표 | 상태 | 결과 |\n| :--- | :--- | :--- | :--- |\n`;
    content += `| 치명적 오류 | 0건 | ${errors.length === 0 ? "✅ Pass" : "❌ Fail"} | ${errors.length}건 |\n`;
    content += `| 루프 내 DB 작업 (L001/L002) | 0건 | ${loopDbCount === 0 ? "✅ Pass" : "❌ Fail"} | ${loopDbCount}건 |\n`;
    content += `| 중첩 루프 (L005) | 0건 | ${nestedLoopCount === 0 ? "✅ Pass" : "❌ Fail"} | ${nestedLoopCount}건 |\n`;
    content += `| 로직 복잡도 (L003) | 25 액션 미만 | ${complexityCount === 0 ? "✅ Pass" : "⚠️ Warning"} | ${complexityCount}건 |\n`;
    content += `| 보안 설정 결함 | 0건 | ${securityCount === 0 ? "✅ Pass" : "❌ Fail"} | ${securityCount}건 |\n\n`;

    content += `## 🔥 지금 고쳐야 할 것 (우선순위 TOP 10)\n\n`;
    content += `점수는 *결함 심각도 × 실행 경로 위험도*입니다. `;
    content += `무인으로 반복 실행되거나 외부에서 호출되는 경로에 있는 결함이 위로 올라옵니다.\n\n`;
    if (blame) {
        content += `> **도입 커밋**은 과거 커밋의 모델을 열어 같은 룰을 재검사하는 이분 탐색으로 특정했습니다. `;
        content += `머지 커밋으로 찍힌 경우 실제 작성은 소스 브랜치에서 이뤄졌을 수 있습니다.\n\n`;
    }
    content += renderTopIssues(sorted, 10, blame);

    content += `## 📋 규칙별 집계\n\n`;
    content += renderRuleSummary(sorted);
    content += `\n`;

    content += `## 🏢 모듈별 건강도\n\n`;
    content += renderModuleHealth(sorted, graph);
    content += `\n`;

    content += `## 📎 부록 — 전체 이슈 (${sorted.length}건)\n\n`;
    if (sorted.length === 0) {
        content += `발견된 이슈가 없습니다.\n`;
    } else {
        content += `| 점수 | 규칙 | 분류 | 위치 | 내용 | 심각도 |\n`;
        content += `| ---: | :--- | :--- | :--- | :--- | :--- |\n`;
        for (const i of sorted) {
            content += `| ${i.score} | \`${i.ruleId}\` | ${i.category} | \`${i.location}\` | ${escapePipes(i.message)} | ${i.severity === "Error" ? "🔴" : "⚠️"} |\n`;
        }
    }

    content += `\n---\n*Generated by Mendix Code Reviewer*\n`;

    fs.writeFileSync(filePath, content, "utf8");

    // 콘솔에도 요약을 남긴다 — 파일을 열지 않아도 값이 보여야 한다.
    console.log(`\n${"─".repeat(60)}`);
    console.log(`📊 이슈 ${sorted.length}건 (🔴 ${errors.length} / ⚠️ ${warnings.length})`);
    if (sorted.length > 0) {
        console.log(`\n   우선순위 TOP 5:`);
        for (const i of sorted.slice(0, 5)) {
            console.log(`   [${String(i.score).padStart(3)}] ${i.ruleId} ${i.location}`);
            console.log(`         ${i.message}`);
        }
    }
    console.log(`${"─".repeat(60)}`);
    console.log(`📄 보고서: ${filePath}`);

    return filePath;
}
