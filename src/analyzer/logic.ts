// src/analyzer/logic.ts
import { microflows } from "mendixmodelsdk";
import { ReviewIssue, scoreWithReach, describeReach } from "./issue.js";
import { MendixRules } from "./rules.js";
import { FlowNode, ModelGraph, walkObjects } from "./graph.js";

/** 루프 안에서 관측된 사실들 */
interface LoopFindings {
    retrievedEntities: string[];
    commitSites: string[];
    noRollbackSites: string[];
}

function scanFlowBody(node: FlowNode): LoopFindings {
    const found: LoopFindings = {
        retrievedEntities: [],
        commitSites: [],
        noRollbackSites: [],
    };

    walkObjects(node.doc.objectCollection, 0, (obj, loopDepth) => {
        if (obj instanceof microflows.LoopedActivity) {
            if (obj.errorHandlingType === microflows.ErrorHandlingType.CustomWithoutRollBack) {
                found.noRollbackSites.push("루프");
            }
            return;
        }

        if (!(obj instanceof microflows.ActionActivity)) return;
        const action = obj.action;
        if (!action) return;

        if (action.errorHandlingType === microflows.ErrorHandlingType.CustomWithoutRollBack) {
            found.noRollbackSites.push(obj.caption || action.constructor.name);
        }

        // 여기서부터는 루프 내부에서만 문제가 되는 항목
        if (loopDepth === 0) return;

        if (action instanceof microflows.RetrieveAction) {
            const source = action.retrieveSource;
            // 오탐 방지: DB Retrieve만 N+1을 만든다.
            // AssociationRetrieveSource는 이미 메모리에 있는 객체를 따라가는 것으로,
            // 권장사항이 시키는 바로 그 패턴이다. 여기서 잡으면 안 된다.
            if (source instanceof microflows.DatabaseRetrieveSource) {
                found.retrievedEntities.push(source.entityQualifiedName ?? "(알 수 없는 엔티티)");
            }
            return;
        }

        // 커밋 지점은 캡션 대신 **대상 변수·엔티티**로 적는다.
        // 자동 생성 캡션은 "Activity"로 나와서 리포트에 아무 정보도 주지 못한다.
        if (action instanceof microflows.CommitAction) {
            found.commitSites.push(`Commit(${action.commitVariableName || "?"})`);
            return;
        }

        if (action instanceof microflows.ChangeObjectAction) {
            if (action.commit !== microflows.CommitEnum.No) {
                found.commitSites.push(`Change(${action.changeVariableName || "?"}, Commit=Yes)`);
            }
            return;
        }

        if (action instanceof microflows.CreateObjectAction) {
            if (action.commit !== microflows.CommitEnum.No) {
                found.commitSites.push(
                    `Create(${action.entityQualifiedName ?? "?"}, Commit=Yes)`
                );
            }
        }
    });

    return found;
}

/**
 * 액션 타입의 **순서**와 참조 엔티티를 함께 지문화한다.
 *
 * 기존 구현은 타입명을 정렬해서 이어붙였기 때문에
 * Retrieve→Change→Commit 형태의 평범한 CRUD가 전부 같은 지문이 되어
 * "유사 로직" 경고가 폭발했다. 순서를 보존하고 엔티티를 섞으면
 * 실제로 복제된 로직만 남는다.
 */
function getFingerprint(node: FlowNode): string | null {
    if (node.actionCount < 6) return null; // 짧은 로직은 닮아 보이는 게 정상이다

    const sequence: string[] = [];
    walkObjects(node.doc.objectCollection, 0, (obj, loopDepth) => {
        if (obj instanceof microflows.ActionActivity && obj.action) {
            sequence.push(`${loopDepth}:${obj.action.constructor.name}`);
        }
    });

    const entities = [...node.reads, ...node.writes].sort().join("|");
    return `${sequence.join(">")}#${entities}#p${node.paramCount}`;
}

/** 룰 하나가 발동했다는 사실. 진입점 정보(점수·도달성)가 붙기 전 단계. */
export interface RuleHit {
    ruleKey: keyof typeof MendixRules;
    message: string;
    severity: "Warning" | "Error";
    evidence: string[];
}

/**
 * **문서 하나만으로** 판정 가능한 로직 룰들.
 *
 * 그래프에서 분리해 둔 이유: 과거 커밋 시점에 이 이슈가 있었는지 되물으려면
 * (blame) 전체 모델 그래프를 2분 30초에 걸쳐 다시 만들 수 없기 때문이다.
 * 해당 flow 하나만 로드해서 같은 판정을 재현할 수 있어야 한다.
 *
 * 그래프가 필요한 L006(고아)·L008(중복)은 여기 포함되지 않는다.
 */
export function detectFlowIssues(node: FlowNode, hotPath = false): RuleHit[] {
    const hits: RuleHit[] = [];
    const add = (
        ruleKey: keyof typeof MendixRules,
        message: string,
        severity: "Warning" | "Error",
        evidence: string[]
    ) => hits.push({ ruleKey, message, severity, evidence });

    const body = scanFlowBody(node);

    // L001 — 루프 내 DB 조회
    if (body.retrievedEntities.length > 0) {
        const unique = [...new Set(body.retrievedEntities)];
        add(
            "LOOP_DB_RETRIEVE",
            `루프 내에서 DB 조회가 ${body.retrievedEntities.length}회 발생합니다 (${unique.join(", ")}).`,
            "Error",
            [
                `대상 엔티티: ${unique.join(", ")}`,
                hotPath
                    ? "무인/외부 진입 경로에 있어 호출량을 통제할 수 없습니다."
                    : "사용자 조작으로만 실행됩니다.",
            ]
        );
    }

    // L002 — 루프 내 커밋
    if (body.commitSites.length > 0) {
        add(
            "LOOP_COMMIT",
            `루프 내에서 DB 커밋이 ${body.commitSites.length}회 발생합니다.`,
            "Error",
            [`커밋 지점: ${[...new Set(body.commitSites)].slice(0, 5).join(", ")}`]
        );
    }

    // L005 — 중첩 루프
    if (node.maxLoopDepth >= 2) {
        add(
            "NESTED_LOOP",
            `루프가 ${node.maxLoopDepth}단계로 중첩되어 있습니다.`,
            "Error",
            [
                body.retrievedEntities.length > 0
                    ? "중첩 루프 안에 DB 조회까지 있어 실행 시간이 곱으로 증가합니다."
                    : "데이터량 증가 시 실행 시간이 제곱으로 늘어납니다.",
            ]
        );
    }

    // L003 — 복잡도
    if (node.actionCount > 25) {
        add(
            "HIGH_COMPLEXITY",
            `액션이 ${node.actionCount}개입니다.`,
            hotPath ? "Error" : "Warning",
            [
                `호출하는 하위 flow ${node.calls.size}개 / Java 액션 ${node.javaCalls.size}개`,
                `읽는 엔티티 ${node.reads.size}개`,
            ]
        );
    }

    // L004 — 파라미터 과다
    if (node.paramCount > 7) {
        add("TOO_MANY_PARAMS", `파라미터가 ${node.paramCount}개입니다.`, "Warning", []);
    }

    // L007 — 롤백 없는 커스텀 에러 처리
    if (body.noRollbackSites.length > 0 && node.commits.size > 0) {
        add(
            "NO_ROLLBACK",
            `커밋이 있는데 롤백 없는 Custom 에러 처리가 ${body.noRollbackSites.length}곳 있습니다.`,
            "Error",
            [`대상: ${[...new Set(body.noRollbackSites)].slice(0, 5).join(", ")}`]
        );
    }

    return hits;
}

/** 룰 발동 사실에 진입점 맥락(근거·우선순위 점수)을 입혀 최종 이슈로 만든다. */
function analyzeFlow(node: FlowNode, graph: ModelGraph): ReviewIssue[] {
    const reach = graph.reach.get(node.qName);
    const reachLine = describeReach(reach);
    const hotPath =
        reach?.hottest?.kind === "ScheduledEvent" || reach?.hottest?.kind === "PublishedService";

    const toIssue = (hit: RuleHit): ReviewIssue => {
        const rule = MendixRules[hit.ruleKey];
        return {
            category: "Logic",
            ruleId: rule.id,
            location: node.qName,
            message: hit.message,
            recommendation: rule.recommendation,
            severity: hit.severity,
            evidence: [reachLine, ...hit.evidence],
            score: scoreWithReach(rule.baseScore, reach),
        };
    };

    const issues = detectFlowIssues(node, hotPath).map(toIssue);

    // L006 — 고아 flow. 그래프가 있어야만 판정 가능하므로 여기서 처리한다.
    if (!reach?.reachable && (graph.callers.get(node.qName)?.size ?? 0) === 0) {
        issues.push(
            toIssue({
                ruleKey: "ORPHAN_FLOW",
                message: `어떤 진입점에서도 도달할 수 없습니다.`,
                severity: "Warning",
                evidence: [`액션 ${node.actionCount}개 / 호출하는 하위 flow ${node.calls.size}개`],
            })
        );
    }

    return issues;
}

export async function analyzeLogic(graph: ModelGraph): Promise<ReviewIssue[]> {
    const targetCount = [...graph.flows.values()].filter((f) => f.reviewable).length;
    console.log(`🔍 [Logic] 분석 시작... (대상 flow: ${targetCount}건)`);

    const issues: ReviewIssue[] = [];
    const fingerprints = new Map<string, string[]>();

    for (const node of graph.flows.values()) {
        // 마켓플레이스·테마 모듈은 그래프에는 있지만 지적하지 않는다.
        if (!node.reviewable) continue;

        try {
            issues.push(...analyzeFlow(node, graph));
        } catch (err) {
            // 조용히 삼키면 "이슈 0건"이 통과처럼 보인다. 반드시 드러낸다.
            console.error(`❌ [Logic] ${node.qName} 분석 실패: ${(err as Error).message}`);
        }

        const fp = getFingerprint(node);
        if (fp) {
            if (!fingerprints.has(fp)) fingerprints.set(fp, []);
            fingerprints.get(fp)!.push(node.qName);
        }
    }

    // L008 — 중복 로직
    for (const group of fingerprints.values()) {
        if (group.length < 2) continue;
        const rule = MendixRules.DUPLICATE_LOGIC;
        issues.push({
            category: "Architecture",
            ruleId: rule.id,
            location: group[0],
            message: `액션 구성·순서·대상 엔티티가 동일한 flow가 ${group.length}개 있습니다.`,
            recommendation: rule.recommendation,
            severity: "Warning",
            evidence: [`동일 그룹: ${group.join(", ")}`],
            score: rule.baseScore + group.length,
        });
    }

    console.log(`✅ [Logic] 완료 (이슈 ${issues.length}건)`);
    return issues;
}
