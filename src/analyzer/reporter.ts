import * as fs from "fs";
import * as path from "path";
import { ReviewIssue } from "./issue.js";
import { ModelGraph } from "./graph.js";
import { MendixRules, BestPractice } from "./rules.js";
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

/** 규칙 하나 안에서 근거까지 펼쳐 보여줄 건수. 나머지는 표로만 낸다. */
const FOCUS_LIMIT = 2;
/** 이 건수 이하면 표를 만들지 않고 전부 펼친다. 표가 오히려 정보를 줄인다. */
const TABLE_THRESHOLD = 3;

function moduleOf(location: string): string {
    return location.split(/[.\s]/)[0] || "(기타)";
}

function escapePipes(text: string): string {
    return text.replace(/\|/g, "\\|");
}

function badgeOf(issue: ReviewIssue): string {
    return issue.severity === "Error" ? "🔴" : "⚠️";
}

/**
 * 진입 경로를 표 한 칸에 들어갈 길이로.
 *
 * `describeReach`의 긴 문장은 근거 줄에 쓰고, 표에는 유형만 쓴다.
 * 엔티티·모듈처럼 flow가 아닌 위치는 reach 자체가 없으므로 `-`.
 */
function entryLabel(location: string, graph: ModelGraph): string {
    const reach = graph.reach.get(location);
    if (!reach) return "-";
    if (!reach.reachable) return "고아";
    return reach.hottest?.kind ?? "-";
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

/** 이슈 하나를 근거까지 펼친 블록으로. */
function renderIssueDetail(
    issue: ReviewIssue,
    rule: BestPractice | undefined,
    blame?: Map<string, BlameResult>
): string {
    let out = `**${badgeOf(issue)} \`${issue.location}\`** — ${issue.message}\n\n`;

    const blameLine = renderBlame(blame?.get(issueKey(issue)));
    if (blameLine) out += `- ${blameLine}\n`;
    for (const e of issue.evidence ?? []) out += `- ${e}\n`;

    // 룰 기본 문구를 덮어쓴 건만 개별 표기한다. 같은 문구를 규칙 헤더와 두 번 쓰지 않는다.
    if (issue.recommendation && issue.recommendation !== rule?.recommendation) {
        out += `- **이 건의 조치:** ${issue.recommendation}\n`;
    }
    out += `- 우선순위 점수 ${issue.score}\n\n`;
    return out;
}

/**
 * 규칙 하나를 한 섹션으로.
 *
 * 이 구조가 기존 "전체 TOP 10 + 부록 전체표"를 대체한다. 바꾼 이유:
 *
 * 1. 고치는 작업의 단위가 규칙이다. L002 9건은 같은 패턴을 9번 적용하는 한 덩어리 작업인데,
 *    점수순으로 섞어 놓으면 컨텍스트 전환이 9번 일어난다.
 * 2. 조치 문구가 규칙당 한 번만 나온다. 실측 리포트에서 같은 문장이 TOP 10 안에 8번 찍혔다.
 * 3. 점수순 전체 정렬은 `baseScore`가 진입 가중치를 압도해서
 *    사실상 "규칙 기본점수순"으로 붕괴한다(L002 9건 중 6건이 59점 동점).
 *    규칙 안에서만 정렬하면 그 붕괴가 순위를 왜곡하지 않는다.
 */
export function renderRuleSection(
    ruleId: string,
    issues: ReviewIssue[],
    graph: ModelGraph,
    blame?: Map<string, BlameResult>
): string {
    const rule = RULE_BY_ID.get(ruleId);
    const errors = issues.filter((i) => i.severity === "Error").length;
    const badge = errors > 0 ? "🔴" : "⚠️";

    let out = `### ${badge} ${ruleId} · ${rule?.name ?? "(알 수 없는 규칙)"} — ${issues.length}건`;
    if (errors > 0 && errors < issues.length) out += ` (🔴 ${errors} / ⚠️ ${issues.length - errors})`;
    out += `\n\n`;
    out += `${rule?.description ?? "-"}\n\n`;
    out += `▸ **조치:** ${rule?.recommendation ?? "-"}\n`;
    out += `▸ **목표:** ${rule?.target ?? "-"}\n\n`;

    if (issues.length <= TABLE_THRESHOLD) {
        for (const issue of issues) out += renderIssueDetail(issue, rule, blame);
        return out;
    }

    // 정렬 축을 밝힌다. "여기가 제일 느립니다"라고 단정하지 않기 위한 장치다 —
    // 정적 분석은 데이터 규모도 호출 빈도도 모르므로 병목을 단정할 수 없다.
    // 축을 알려주면 읽는 사람이 "이건 일회성 마이그레이션이라 괜찮다"로 기각할 수 있다.
    out += `**먼저 볼 것**`;
    if (rule?.focusAxis) out += ` — 이 규칙 안에서는 *${rule.focusAxis}* 순으로 봅니다.`;
    out += `\n\n`;

    const focus = issues.slice(0, FOCUS_LIMIT);
    for (const issue of focus) out += renderIssueDetail(issue, rule, blame);

    // 표 열 = 위치 + 규칙별 사실(먼저 등장한 순서) + 진입 + 점수
    const factKeys: string[] = [];
    for (const i of issues) {
        for (const k of Object.keys(i.facts ?? {})) if (!factKeys.includes(k)) factKeys.push(k);
    }

    out += `**전체 ${issues.length}건**\n\n`;
    out += `| 위치 | ${factKeys.join(" | ")}${factKeys.length ? " | " : ""}진입 | 점수 |\n`;
    out += `| :--- | ${factKeys.map(() => ":--- ").join("| ")}${factKeys.length ? "| " : ""}:--- | ---: |\n`;
    for (const i of issues) {
        const cells = factKeys.map((k) => escapePipes(i.facts?.[k] ?? "-"));
        out += `| ${badgeOf(i)} \`${i.location}\` | ${cells.join(" | ")}${cells.length ? " | " : ""}${entryLabel(i.location, graph)} | ${i.score} |\n`;
    }
    out += `\n`;

    // 표에만 실린 건 중 조치가 기본과 다른 것들. 표에서는 그 정보가 사라지므로 따로 적는다.
    const exceptions = new Map<string, string[]>();
    for (const i of issues.slice(FOCUS_LIMIT)) {
        if (!i.recommendation || i.recommendation === rule?.recommendation) continue;
        if (!exceptions.has(i.recommendation)) exceptions.set(i.recommendation, []);
        exceptions.get(i.recommendation)!.push(i.location);
    }
    if (exceptions.size > 0) {
        out += `> **일부 건은 조치가 다릅니다**\n`;
        for (const [rec, locs] of exceptions) {
            out += `> - ${locs.map((l) => `\`${l}\``).join(", ")} — ${rec}\n`;
        }
        out += `\n`;
    }

    return out;
}

/**
 * 여러 규칙에 동시에 걸린 위치.
 *
 * 기존 TOP 10을 대체한다. 실측 리포트에서 TOP 10의 1·6위가 같은 flow였고 2·7위도 같은 flow였는데,
 * 그건 중복 표기가 아니라 **신호였다** — 결함이 겹친 flow가 실제로 제일 위험하다.
 * 규칙별 섹션으로 흩어놓으면 이 정보가 사라지므로 여기서 한 번 모은다.
 */
export function renderComposite(issues: ReviewIssue[], graph: ModelGraph): string {
    const byLocation = new Map<string, ReviewIssue[]>();
    for (const i of issues) {
        if (!byLocation.has(i.location)) byLocation.set(i.location, []);
        byLocation.get(i.location)!.push(i);
    }

    const rows = [...byLocation.entries()]
        .map(([location, group]) => ({
            location,
            rules: [...new Set(group.map((i) => i.ruleId))].sort(),
            total: group.reduce((sum, i) => sum + i.score, 0),
            hasError: group.some((i) => i.severity === "Error"),
        }))
        .filter((r) => r.rules.length >= 2)
        .sort((a, b) => b.rules.length - a.rules.length || b.total - a.total)
        .slice(0, 10);

    if (rows.length === 0) return `여러 규칙에 동시에 걸린 곳은 없습니다.\n`;

    let out =
        `한 곳이 여러 규칙에 걸렸다는 것은 결함이 겹쳤다는 뜻입니다. ` +
        `개별 점수는 낮아도 손대는 순서로는 여기가 먼저입니다.\n\n`;
    out += `| 위치 | 걸린 규칙 | 합산 점수 | 진입 |\n| :--- | :--- | ---: | :--- |\n`;
    for (const r of rows) {
        out += `| ${r.hasError ? "🔴" : "⚠️"} \`${r.location}\` | ${r.rules.join(" + ")} | ${r.total} | ${entryLabel(r.location, graph)} |\n`;
    }
    return out;
}

/**
 * 인덱스가 필요한 속성을 엔티티별로 모아 **작업 지시서 형태**로 낸다.
 *
 * D003이 지적한 엔티티만 대상으로 한다. 룰과 다른 얘기를 하면 리포트가 신뢰를 잃는다.
 *
 * 조회 1회짜리 속성까지 전부 나열하면 이 섹션 하나가 리포트의 34%를 먹는다(실측).
 * 그러면 정말 손대야 할 `Account.UserID`(조회 13회)가 `WarehouseManagement.Name`(1회)에 묻힌다.
 * 그래서 아래 기준을 통과한 것만 표로 내고, 나머지는 한 줄로 접는다.
 */
export function renderIndexPlan(issues: ReviewIssue[], graph: ModelGraph): string {
    const flagged = issues
        .filter((i) => i.ruleId === "D003")
        .sort((a, b) => (b.focusRank ?? 0) - (a.focusRank ?? 0) || b.score - a.score);

    if (flagged.length === 0) return `인덱스가 필요한 조회 키가 발견되지 않았습니다.\n`;

    let out =
        `XPath 조회 조건에 실제로 쓰이는데 인덱스로 커버되지 않는 속성입니다. ` +
        `Studio Pro에서 엔티티 **Properties → Indexes** 탭에 추가하세요.\n\n` +
        `> String 속성은 **Max length가 Unlimited면 인덱스를 걸 수 없습니다.** 길이를 먼저 지정해야 합니다.\n` +
        `> 인덱스는 insert/update마다 갱신 비용이 붙습니다. 아래 목록은 후보이지 전량 적용 대상이 아닙니다.\n\n`;

    const deferred: string[] = [];

    for (const issue of flagged) {
        const info = graph.entityIndexes.get(issue.location);
        const keys = graph.entityQueryKeys.get(issue.location);
        if (!keys) continue;

        const covered = info?.leadingAttrs ?? new Set<string>();
        const uncovered = [...keys.entries()]
            .filter(([attr]) => !covered.has(attr))
            .sort(
                (a, b) =>
                    b[1].inLoop - a[1].inLoop ||
                    b[1].hotFlows.size - a[1].hotFlows.size ||
                    b[1].total - a[1].total ||
                    a[0].localeCompare(b[0])
            );
        if (uncovered.length === 0) continue;

        // 반복·무인 경로에서 쓰이거나 조회처가 여럿인 것만 작업 지시로 올린다.
        const worth = uncovered.filter(
            ([, u]) => u.inLoop > 0 || u.hotFlows.size > 0 || u.total >= 2
        );
        const minor = uncovered.filter((e) => !worth.includes(e));

        if (worth.length === 0) {
            deferred.push(`\`${issue.location}\` (${uncovered.length}개)`);
            continue;
        }

        const indexState =
            info && info.count > 0
                ? `기존 인덱스 ${info.count}개 (선두 속성: ${[...info.leadingAttrs].join(", ") || "없음"})`
                : `기존 인덱스 없음`;

        out += `### \`${issue.location}\` — ${indexState}\n\n`;
        out += `| 속성 | 조회 | 루프 내 | 무인/외부 |\n| :--- | ---: | ---: | ---: |\n`;
        for (const [attr, usage] of worth) {
            out += `| \`${attr}\` | ${usage.total} | ${usage.inLoop || "-"} | ${usage.hotFlows.size || "-"} |\n`;
        }
        out += `\n`;

        if (minor.length > 0) {
            out += `> 조회 1회·루프 밖 속성 ${minor.length}개는 우선순위에서 제외했습니다: ${minor.map(([a]) => `\`${a}\``).join(", ")}\n\n`;
        }

        const orCombined = worth.some(([, u]) => u.orCombined);
        // 속성이 하나뿐인데 "복합 인덱스를 고려하라"고 하면 말이 안 된다.
        const note =
            worth.length === 1
                ? "이 속성에 단일 컬럼 인덱스를 추가하세요."
                : orCombined
                  ? "조회 조건이 `or`로 묶여 있습니다. **복합 인덱스는 `or`에 쓰이지 않으므로 각 속성에 단일 컬럼 인덱스를 따로** 만드세요."
                  : "여러 속성이 항상 함께 조건에 쓰인다면 선택도 높은 것을 앞에 둔 복합 인덱스가 낫습니다(leftmost prefix).";
        out += `> ${note}\n\n`;
    }

    if (deferred.length > 0) {
        out += `**조회 1회·루프 밖만 있는 엔티티 ${deferred.length}곳은 생략했습니다** — ${deferred.join(", ")}. `;
        out += `D003 섹션에 전량 실려 있습니다.\n\n`;
    }

    return out;
}

/**
 * 모듈별 건강도.
 *
 * 누적 점수만 쓰면 **큰 모듈이 항상 나쁘게 나온다**(실측: ShipmentTracking 817점/flow 55 vs
 * Warehouse 745점/flow 86 — 절대값은 앞서지만 밀도는 14.9 대 8.7). 그래서 flow당 점수로 정렬한다.
 */
export function renderModuleHealth(issues: ReviewIssue[], graph: ModelGraph): string {
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

    const density = (s: { score: number; flows: number }) => s.score / Math.max(s.flows, 1);
    const rows = [...stats.entries()]
        .filter(([, s]) => s.errors > 0 || s.warnings > 0 || s.flows > 0)
        .sort((a, b) => density(b[1]) - density(a[1]) || b[1].score - a[1].score);

    let out = `**flow당 점수** 순입니다. 누적 점수만 보면 규모가 큰 모듈이 항상 위로 올라옵니다.\n\n`;
    out += `| 모듈 | flow 수 | 🔴 Error | ⚠️ Warning | 누적 점수 | flow당 |\n`;
    out += `| :--- | ---: | ---: | ---: | ---: | ---: |\n`;
    for (const [mod, s] of rows) {
        out += `| ${mod} | ${s.flows} | ${s.errors} | ${s.warnings} | ${s.score} | ${density(s).toFixed(1)} |\n`;
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

    const errors = issues.filter((i) => i.severity === "Error");
    const warnings = issues.filter((i) => i.severity === "Warning");

    // ruleId 기반 집계 — 메시지 문자열 매칭에 의존하지 않는다.
    const countByRule = (id: string) => issues.filter((i) => i.ruleId === id).length;
    const loopDbCount = countByRule("L001") + countByRule("L002");
    const complexityCount = countByRule("L003");
    const nestedLoopCount = countByRule("L005");
    // D005는 룰 정의상 목표가 "검토 필요"다. 0건 목표에 섞으면 리포트가 스스로를 반박한다.
    const missingRuleCount = countByRule("D004") + countByRule("P002");
    const unconstrainedCount = countByRule("D005");

    const tenantHost = process.env.MENDIX_SPRINTR_HOST || "sprintr.home.mendix.com";
    const commitUrl = `https://${tenantHost}/link/app/${commitInfo.appId}/vcs/revision/${commitInfo.revId}`;

    let content = `# 🤖 Mendix Architecture & Performance Report\n\n`;

    content += `## 📌 대상\n`;
    content += `- **App:** ${safeAppName}\n`;
    content += `- **Branch:** \`${commitInfo.branch}\`\n`;
    // 이 리포트는 브랜치 **전체**의 스냅샷이지 이 커밋의 리뷰가 아니다.
    // 예전처럼 커밋 메시지와 Author를 헤더에 박아두면 아래 이슈들이 그 사람의 것으로 읽힌다.
    content += `- **분석 기준 리비전:** [${commitInfo.revId.substring(0, 8)}](${commitUrl}) — ${escapePipes(commitInfo.message)}\n`;
    content += `- **분석 시각:** ${now.toLocaleString()}\n`;
    content += `- 이 리포트는 위 리비전 시점의 **브랜치 전체** 상태입니다. 해당 커밋이 만든 변경만 본 것이 아닙니다.\n\n`;

    content += `## 🗺️ 모델 구성\n`;
    content += renderEntryPointProfile(graph);
    content += `\n`;

    content += `## 🎯 KPI\n`;
    content += `| 지표 | 목표 | 상태 | 결과 |\n| :--- | :--- | :--- | :--- |\n`;
    content += `| 치명적 오류 | 0건 | ${errors.length === 0 ? "✅ Pass" : "❌ Fail"} | ${errors.length}건 |\n`;
    content += `| 루프 내 DB 작업 (L001/L002) | 0건 | ${loopDbCount === 0 ? "✅ Pass" : "❌ Fail"} | ${loopDbCount}건 |\n`;
    content += `| 중첩 루프 (L005) | 0건 | ${nestedLoopCount === 0 ? "✅ Pass" : "❌ Fail"} | ${nestedLoopCount}건 |\n`;
    content += `| 로직 복잡도 (L003) | 25 액션 미만 | ${complexityCount === 0 ? "✅ Pass" : "⚠️ Warning"} | ${complexityCount}건 |\n`;
    content += `| 접근 규칙 누락 (D004/P002) | 0건 | ${missingRuleCount === 0 ? "✅ Pass" : "❌ Fail"} | ${missingRuleCount}건 |\n`;
    content += `| 무제약 접근 (D005) | 검토 필요 | ${unconstrainedCount === 0 ? "✅ 해당 없음" : "ℹ️ 검토"} | ${unconstrainedCount}건 |\n\n`;

    content += `## ⚠️ 여러 규칙에 동시에 걸린 곳\n\n`;
    content += renderComposite(issues, graph);
    content += `\n`;

    // 규칙 섹션 순서: 그 규칙의 최고 점수 → 건수.
    // 규칙 안에서는 focusRank(규칙별 비용 축) → 점수 → 위치.
    const byRule = new Map<string, ReviewIssue[]>();
    for (const i of issues) {
        if (!byRule.has(i.ruleId)) byRule.set(i.ruleId, []);
        byRule.get(i.ruleId)!.push(i);
    }
    for (const group of byRule.values()) {
        group.sort(
            (a, b) =>
                (b.focusRank ?? 0) - (a.focusRank ?? 0) ||
                b.score - a.score ||
                a.location.localeCompare(b.location)
        );
    }
    const ruleOrder = [...byRule.entries()].sort((a, b) => {
        const maxA = Math.max(...a[1].map((i) => i.score));
        const maxB = Math.max(...b[1].map((i) => i.score));
        return maxB - maxA || b[1].length - a[1].length || a[0].localeCompare(b[0]);
    });

    content += `## 📋 규칙별 상세 (전체 ${issues.length}건)\n\n`;
    if (ruleOrder.length === 0) {
        content += `발견된 이슈가 없습니다.\n\n`;
    } else {
        content += `규칙 순서는 *그 규칙에서 나온 최고 점수*입니다. 각 규칙 안의 순서는 섹션마다 밝혀 둡니다.\n\n`;
        for (const [ruleId, group] of ruleOrder) {
            content += renderRuleSection(ruleId, group, graph, blame);
            content += `\n`;
        }
    }

    content += `## 🔑 인덱스가 필요한 속성\n\n`;
    content += renderIndexPlan(issues, graph);
    content += `\n`;

    content += `## 🏢 모듈별 건강도\n\n`;
    content += renderModuleHealth(issues, graph);

    content += `\n---\n*Generated by Mendix Code Reviewer*\n`;

    fs.writeFileSync(filePath, content, "utf8");

    // 콘솔에도 요약을 남긴다 — 파일을 열지 않아도 값이 보여야 한다.
    console.log(`\n${"─".repeat(60)}`);
    console.log(`📊 이슈 ${issues.length}건 (🔴 ${errors.length} / ⚠️ ${warnings.length})`);
    if (ruleOrder.length > 0) {
        console.log(`\n   규칙별:`);
        for (const [ruleId, group] of ruleOrder) {
            const errs = group.filter((i) => i.severity === "Error").length;
            const name = RULE_BY_ID.get(ruleId)?.name ?? "";
            console.log(
                `   ${ruleId.padEnd(5)} ${name.padEnd(22)} ${String(group.length).padStart(3)}건` +
                    (errs > 0 ? ` (🔴 ${errs})` : "") +
                    `  ← ${group[0].location}`
            );
        }
    }
    console.log(`${"─".repeat(60)}`);
    console.log(`📄 보고서: ${filePath}`);

    return filePath;
}
