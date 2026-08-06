// src/analyzer/blame.ts
//
// "이 이슈는 언제, 누가 만들었나"를 역추적한다.
//
// Mendix 모델은 바이너리라 git diff가 안 되고, Team Server API에도 파일 단위 diff가 없다.
// 따라서 "그 시점에 이 이슈가 있었나?"를 직접 물어보는 수밖에 없다 —
// 과거 커밋의 모델을 열어 같은 룰을 다시 돌린다.
//
// 커밋 하나를 여는 데 약 33초가 든다. 그래서 두 가지를 한다:
//  1) 이슈별로 따로 탐색하지 않고, **한 번 연 모델에서 전체 이슈를 동시에 판정**한다.
//  2) 선형 스캔이 아니라 **이분 탐색**으로 후보 커밋을 좁힌다. 107커밋이면 이슈당 약 7회.
// 두 최적화가 겹쳐서 10건 기준 20~30회 조회로 끝난다.

import { IModel, microflows, pages } from "mendixmodelsdk";
import { getApp, getModelAtCommit } from "../client.js";
import { ReviewIssue } from "./issue.js";
import { buildNode } from "./graph.js";
import { detectFlowIssues } from "./logic.js";
import { detectPageIssues } from "./page.js";
import { MendixRules } from "./rules.js";

export interface CommitMeta {
    id: string;
    author: string;
    date: string;
    message: string;
}

export type BlameStatus =
    | "found" // 도입 커밋을 특정함
    | "from-start" // 조회 가능한 이력 전체에 걸쳐 존재 (그 이전에 도입)
    | "unsupported" // 문서 단위로 재판정할 수 없는 룰
    | "error";

export interface BlameResult {
    issueKey: string;
    status: BlameStatus;
    commit: CommitMeta | null;
    note?: string;
}

/** 그래프 전체가 있어야 판정되는 룰들. 문서 하나만 열어서는 되짚을 수 없다. */
const GRAPH_DEPENDENT = new Set([
    MendixRules.ORPHAN_FLOW.id, // L006 — 전체 호출 그래프 필요
    MendixRules.DUPLICATE_LOGIC.id, // L008 — 전체 flow 비교 필요
    MendixRules.HOT_ENTITY.id, // D006 — 전체 엔티티 사용처 필요
    MendixRules.STRONG_COUPLING.id, // D007 — 전체 모듈 의존성 필요
]);

/** 도메인 룰은 아직 문서 단위 재판정을 구현하지 않았다. */
const DOMAIN_RULE_PREFIX = "D";

export function issueKey(issue: ReviewIssue): string {
    return `${issue.ruleId}@${issue.location}`;
}

/**
 * 커밋 메시지에서 "이게 머지인가, 그렇다면 어느 브랜치에서 왔나"를 읽어낸다.
 *
 * 필요한 이유: Team Server API의 ICommit에는 부모 커밋 정보가 없다.
 * 그래서 머지 여부를 구조적으로 알 수 없고 메시지로 추정할 수밖에 없다.
 * 이걸 구분하지 않으면 "머지한 사람"이 "만든 사람"으로 리포트에 찍힌다.
 */
export function summarizeCommitOrigin(message: string): {
    isMerge: boolean;
    sourceBranch: string | null;
} {
    const isMerge = /\bmerge\b|머지/i.test(message);
    if (!isMerge) return { isMerge: false, sourceBranch: null };

    // "Merge commit from_donggyun-clean" / "Merge commit / donggyun -> wonjin"
    // / "Merge branch 'x' into y" 같은 형태에서 출처를 뽑는다.
    const patterns = [
        /from[_\s]+([A-Za-z0-9._\-\/]+)/i,
        /branch\s+'([^']+)'/i,
        /([A-Za-z0-9._\-\/]+)\s*->\s*[A-Za-z0-9._\-\/]+/,
    ];
    for (const re of patterns) {
        const m = message.match(re);
        if (m?.[1]) return { isMerge: true, sourceBranch: m[1] };
    }
    return { isMerge: true, sourceBranch: null };
}

function canBlame(issue: ReviewIssue): { ok: boolean; reason?: string } {
    if (GRAPH_DEPENDENT.has(issue.ruleId)) {
        return { ok: false, reason: "전체 그래프가 필요한 룰이라 문서 단위 역추적 불가" };
    }
    if (issue.ruleId.startsWith(DOMAIN_RULE_PREFIX)) {
        return { ok: false, reason: "도메인 룰 역추적 미구현" };
    }
    return { ok: true };
}

/**
 * 주어진 시점의 모델에서 이 이슈가 존재하는지 판정한다.
 * 문서 자체가 없으면(아직 안 만들어졌으면) false.
 */
async function issueExistsAt(model: IModel, issue: ReviewIssue): Promise<boolean> {
    if (issue.category === "Page" || issue.ruleId.startsWith("P")) {
        const proxy = model.allPages().find((p) => p.qualifiedName === issue.location);
        if (!proxy) return false;
        const page = await proxy.load();
        // 보안 수준은 이 판정에 영향을 주므로 그 시점 값을 읽는다.
        let securityIsOn = false;
        for (const s of model.allProjectSecurities()) {
            try {
                const sec = await s.load();
                securityIsOn = `${sec.securityLevel?.name}` !== "CheckNothing";
                break;
            } catch {
                /* 무시 */
            }
        }
        return detectPageIssues(page, securityIsOn).some(
            (hit) => MendixRules[hit.ruleKey].id === issue.ruleId
        );
    }

    // Logic 룰 — 마이크로플로우/나노플로우 하나만 로드해 재판정
    const mfProxy = model.allMicroflows().find((m) => m.qualifiedName === issue.location);
    const nfProxy = mfProxy
        ? null
        : model.allNanoflows().find((n) => n.qualifiedName === issue.location);
    const proxy = mfProxy ?? nfProxy;
    if (!proxy) return false; // 그 시점엔 이 flow가 아직 없었다

    const doc = (await proxy.load()) as microflows.MicroflowBase;
    const node = buildNode(doc, mfProxy ? "Microflow" : "Nanoflow", new Set());
    return detectFlowIssues(node).some((hit) => MendixRules[hit.ruleKey].id === issue.ruleId);
}

/** 브랜치의 전체 커밋 이력을 오래된 것 → 최신 순으로 가져온다. */
async function fetchCommits(branch: string, maxPages = 20): Promise<CommitMeta[]> {
    const { app } = getApp();
    const repo = app.getRepository();
    const items: any[] = [];
    let cursor: string | undefined;

    for (let page = 0; page < maxPages; page++) {
        const res: any = await repo.getBranchCommits(branch, { limit: 100, cursor } as any);
        items.push(...res.items);
        cursor = res.cursors?.after;
        if (!cursor || res.items.length === 0) break;
    }

    // API는 최신순으로 준다. 이분 탐색을 위해 뒤집는다.
    return items
        .map((c) => ({
            id: c.id,
            author: c.author?.name || c.author?.email || "Unknown",
            date: c.date ?? "",
            message: (c.message ?? "").trim() || "(메시지 없음)",
        }))
        .reverse();
}

/**
 * TOP N 이슈의 도입 커밋을 배치 이분 탐색으로 찾는다.
 *
 * @param maxLookups 모델 조회 횟수 상한. 넘으면 남은 이슈는 미확정으로 남기고 그 사실을 보고한다.
 */
export async function blameIssues(
    branch: string,
    issues: ReviewIssue[],
    maxLookups = 40
): Promise<Map<string, BlameResult>> {
    const results = new Map<string, BlameResult>();

    // 역추적 불가한 룰은 먼저 걸러낸다 — 조용히 빠뜨리지 않는다.
    const targets: ReviewIssue[] = [];
    for (const issue of issues) {
        const check = canBlame(issue);
        if (check.ok) targets.push(issue);
        else
            results.set(issueKey(issue), {
                issueKey: issueKey(issue),
                status: "unsupported",
                commit: null,
                note: check.reason,
            });
    }

    if (targets.length === 0) {
        console.log("🔎 [Blame] 역추적 가능한 이슈가 없습니다.");
        return results;
    }

    console.log(`🔎 [Blame] 커밋 이력 조회 중...`);
    const commits = await fetchCommits(branch);
    if (commits.length === 0) {
        console.warn("⚠️ [Blame] 커밋 이력을 가져오지 못했습니다.");
        return results;
    }
    console.log(
        `🔎 [Blame] 커밋 ${commits.length}개 대상, 이슈 ${targets.length}건 이분 탐색 시작 ` +
            `(조회 1회당 약 33초, 최대 ${maxLookups}회)`
    );

    const found = await bisectIntroduction(
        targets,
        issueKey,
        commits.length,
        async (index, group) => {
            const c = commits[index];
            console.log(
                `   > ${c.date.substring(0, 10)} ${c.id.substring(0, 8)} ` +
                    `(${c.author}) — ${group.length}건 판정 중...`
            );
            const present = new Set<string>();
            try {
                const model = await getModelAtCommit(branch, c.id);
                for (const issue of group) {
                    try {
                        if (await issueExistsAt(model, issue)) present.add(issueKey(issue));
                    } catch {
                        /* 개별 판정 실패는 "없음"으로 간주 */
                    }
                }
            } catch (err) {
                console.warn(`     ⚠️ 모델 오픈 실패: ${(err as Error).message}`);
                // 실패한 커밋을 "전부 존재함"으로 두면 탐색이 과거로 쏠려
                // 엉뚱한 사람에게 귀속된다. 빈 집합을 돌려 더 최신 쪽으로 좁힌다.
            }
            return present;
        },
        maxLookups
    );

    for (const target of targets) {
        const key = issueKey(target);
        const r = found.get(key)!;
        results.set(key, {
            issueKey: key,
            status: r.status,
            commit: r.index === null ? null : commits[r.index],
        });
    }

    const unresolved = [...results.values()].filter((r) => r.status === "error").length;
    if (unresolved > 0) {
        console.warn(
            `⚠️ [Blame] 조회 상한(${maxLookups}회)에 도달해 ${unresolved}건은 특정하지 못했습니다.`
        );
    }
    console.log(`✅ [Blame] 완료`);
    return results;
}

/**
 * 배치 이분 탐색. 각 항목이 **최초로 존재하게 된 커밋 인덱스**를 찾는다.
 *
 * 순수 로직으로 분리해 둔 이유: 잘못 짜면 엉뚱한 커밋에 귀속되는데,
 * 실제 API로 검증하려면 매번 20분이 든다. 콜백을 주입해 즉시 테스트할 수 있어야 한다.
 *
 * 불변식: commits[hi]에는 group의 항목이 존재하고, commits[lo]에는 없다.
 *         lo = -1은 "이력 시작 이전" = 아무것도 없던 시점.
 *
 * @param evaluate (index, group) => 그 시점에 존재하는 항목들의 key 집합
 */
export async function bisectIntroduction<T>(
    items: T[],
    keyOf: (item: T) => string,
    commitCount: number,
    evaluate: (index: number, group: T[]) => Promise<Set<string>>,
    maxLookups = 40
): Promise<Map<string, { index: number | null; status: BlameStatus; lookups: number }>> {
    const out = new Map<string, { index: number | null; status: BlameStatus; lookups: number }>();
    let lookups = 0;
    let exhausted = false;

    const finalize = (group: T[], index: number | null, status: BlameStatus) => {
        for (const item of group) out.set(keyOf(item), { index, status, lookups });
    };

    const bisect = async (group: T[], lo: number, hi: number): Promise<void> => {
        if (group.length === 0) return;
        if (exhausted) return finalize(group, null, "error");
        if (hi - lo <= 1) {
            // commits[hi]가 도입 시점. lo가 -1이고 hi가 0이면 이력 첫 커밋부터 존재한 것.
            return finalize(group, hi, lo === -1 && hi === 0 ? "from-start" : "found");
        }
        if (lookups >= maxLookups) {
            exhausted = true;
            return finalize(group, null, "error");
        }

        const mid = Math.floor((lo + hi) / 2);
        lookups++;
        const present = await evaluate(mid, group);
        const inLeft = group.filter((i) => present.has(keyOf(i)));
        const inRight = group.filter((i) => !present.has(keyOf(i)));

        await bisect(inLeft, lo, mid);
        await bisect(inRight, mid, hi);
    };

    await bisect(items, -1, commitCount - 1);
    return out;
}
