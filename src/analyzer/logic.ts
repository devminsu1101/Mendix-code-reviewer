// src/analyzer/logic.ts
import { microflows } from "mendixmodelsdk";
import { ReviewIssue, scoreWithReach, describeReach } from "./issue.js";
import { MendixRules } from "./rules.js";
import { FlowNode, ModelGraph, walkObjects } from "./graph.js";
import { XPathKeys, EMPTY_KEYS, parseXPathKeys } from "./xpath.js";

/**
 * 변수가 어디서 왔는가. 루프 반복 횟수에 상한이 있는지를 이걸로 판정한다.
 *
 * `db`는 DB에서 긁어온 리스트 — 행이 늘면 반복도 늘어난다. 상한이 없다.
 * `memory`/`param`은 이미 메모리에 있는 것(연관 탐색 결과, 수신 payload, 파라미터) —
 * 반복 횟수가 입력 크기로 묶인다.
 */
export type VarOrigin = "db" | "memory" | "param" | "unknown";

/** 루프 안에서 발견된 DB 조회 하나. */
interface LoopRetrieve {
    entity: string;
    /** Range가 First(단건)인가. 쿼리 횟수는 안 줄지만 전송·객체화 비용은 준다. */
    singleObject: boolean;
    xPath: string;
    keys: XPathKeys;
    /** XPath가 감싼 루프의 이터레이터를 참조하는가 = 반복마다 조건이 바뀌는 키 조회인가 */
    usesIterator: boolean;
    loopDepth: number;
    /** 감싼 루프가 무엇을 반복하는가 */
    loopSourceVar: string | null;
    loopSourceOrigin: VarOrigin;
}

/** 루프 안에서 관측된 사실들 */
interface LoopFindings {
    loopRetrieves: LoopRetrieve[];
    commitSites: string[];
    noRollbackSites: string[];
    /**
     * 변수 출처를 하나라도 해석했는가.
     *
     * `RetrieveAction.outputVariableName`이 이 SDK에서 빈 문자열을 준다면 출처 맵이
     * 통째로 비어 모든 판정이 조용히 `unknown`으로 떨어진다. 버그 #0과 같은 실패 모드라
     * 명시적으로 들고 다닌다.
     */
    originsResolved: boolean;
}

/** 액션이 만들어내는 변수명. 액션 종류마다 프로퍼티 이름이 달라 한 곳에서 흡수한다. */
function producedVariable(action: microflows.MicroflowAction): string | null {
    const raw =
        (action as unknown as { outputVariableName?: unknown }).outputVariableName ??
        (action as unknown as { variableName?: unknown }).variableName;
    return typeof raw === "string" && raw.length > 0 ? raw : null;
}

/** flow 전체를 훑어 변수 출처 맵을 만든다. 루프 반복 상한 판정의 기반. */
function buildVariableOrigins(node: FlowNode): Map<string, VarOrigin> {
    const origins = new Map<string, VarOrigin>();

    walkObjects(node.doc.objectCollection, 0, (obj) => {
        if (obj instanceof microflows.MicroflowParameterObject) {
            if (obj.name) origins.set(obj.name, "param");
            return;
        }
        if (!(obj instanceof microflows.ActionActivity)) return;
        const action = obj.action;
        if (!action) return;

        const varName = producedVariable(action);
        if (!varName) return;

        if (action instanceof microflows.RetrieveAction) {
            const source = action.retrieveSource;
            if (source instanceof microflows.DatabaseRetrieveSource) origins.set(varName, "db");
            else if (source instanceof microflows.AssociationRetrieveSource)
                origins.set(varName, "memory");
            else origins.set(varName, "unknown");
            return;
        }

        if (action instanceof microflows.CreateVariableAction) {
            origins.set(varName, "memory");
            return;
        }

        // Java 액션·리스트 오퍼레이션 등은 출처를 단정할 수 없다.
        // 모르면 등급을 내리지 않는다(fail closed).
        origins.set(varName, "unknown");
    });

    return origins;
}

/** 루프가 무엇을 반복하는지. IterableList가 아니면(While 루프) 상한을 알 수 없다. */
function describeLoopSource(
    loop: microflows.LoopedActivity | undefined,
    origins: Map<string, VarOrigin>
): { variable: string | null; origin: VarOrigin; iterator: string | null } {
    const source = loop?.loopSource;
    if (source instanceof microflows.IterableList) {
        const variable = source.listVariableName || null;
        return {
            variable,
            origin: (variable && origins.get(variable)) || "unknown",
            iterator: source.variableName || null,
        };
    }
    return { variable: null, origin: "unknown", iterator: null };
}

function scanFlowBody(node: FlowNode): LoopFindings {
    const origins = buildVariableOrigins(node);
    const found: LoopFindings = {
        loopRetrieves: [],
        commitSites: [],
        noRollbackSites: [],
        originsResolved: origins.size > 0,
    };

    walkObjects(node.doc.objectCollection, 0, (obj, loopDepth, loopStack) => {
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
                const xPath = source.xPathConstraint ?? "";
                const keys = xPath ? parseXPathKeys(xPath) : { ...EMPTY_KEYS };
                const innermost = loopStack[loopStack.length - 1];
                const loopSource = describeLoopSource(innermost, origins);

                // 감싼 루프들의 이터레이터 중 하나라도 XPath가 참조하면
                // "반복마다 조건이 바뀌는 키 조회"다.
                const iterators = loopStack
                    .map((l) => describeLoopSource(l, origins).iterator)
                    .filter((v): v is string => !!v);

                found.loopRetrieves.push({
                    entity: source.entityQualifiedName ?? "(알 수 없는 엔티티)",
                    singleObject:
                        source.range instanceof microflows.ConstantRange &&
                        source.range.singleObject,
                    xPath,
                    keys,
                    usesIterator: iterators.some((v) => keys.referencedVariables.includes(v)),
                    loopDepth,
                    loopSourceVar: loopSource.variable,
                    loopSourceOrigin: loopSource.origin,
                });
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
    /**
     * 결함 심각도 보정. 같은 룰이라도 실제 위험이 다를 때 쓴다.
     *
     * severity만 낮추면 점수는 그대로라 리포트 상단에 그대로 남는다
     * (score = baseScore × 진입점 가중치). 순위를 실제로 움직이려면 여기를 건드려야 한다.
     */
    scoreMultiplier?: number;
    /** 룰 기본 권장문구가 이 상황에 안 맞을 때 덮어쓴다. */
    recommendation?: string;
    /** 이 flow가 조회 조건으로 쓴 속성. 엔티티 qName -> 속성명. 인덱스 교차 참조용. */
    queryKeys?: Map<string, string[]>;
}

const ORIGIN_LABEL: Record<VarOrigin, string> = {
    db: "DB 조회 결과",
    memory: "메모리상 리스트(연관 탐색·변수 생성)",
    param: "마이크로플로우 파라미터",
    unknown: "출처 불명",
};

/**
 * L001을 만든다.
 *
 * 핵심 판정은 하나다 — **반복 횟수에 상한이 있는가.**
 *
 * `first`(SingleObject)는 판정에 들어가되 단독으로는 면죄부가 아니다.
 * N+1은 가져오는 행 수가 아니라 왕복 횟수 문제라서, `first`가 줄이는 것은
 * 결과 전송·객체화 비용뿐이고 쿼리 횟수는 반복 횟수 그대로다.
 *
 * 반면 반복 대상이 DB 리스트가 아니라 수신 payload나 파라미터에서 온 메모리 리스트라면
 * 반복 횟수가 **입력 크기로 묶인다.** 테이블이 커져도 안 늘어난다. 성격이 다르므로
 * 이 경우에만 등급을 내린다.
 */
function buildLoopRetrieveHit(body: LoopFindings, hotPath: boolean): RuleHit {
    const retrieves = body.loopRetrieves;
    const entities = [...new Set(retrieves.map((r) => r.entity))];

    const isBounded = (r: LoopRetrieve) =>
        r.singleObject &&
        r.usesIterator &&
        r.loopDepth === 1 &&
        (r.loopSourceOrigin === "memory" || r.loopSourceOrigin === "param");

    // 출처 해석 자체가 실패했다면 등급을 내리지 않는다(fail closed).
    const bounded = body.originsResolved && retrieves.every(isBounded);

    const evidence: string[] = [`대상 엔티티: ${entities.join(", ")}`];

    const ranges = new Set(retrieves.map((r) => (r.singleObject ? "First(단건)" : "All(목록)")));
    evidence.push(`Range: ${[...ranges].join(", ")} — 쿼리 횟수는 Range와 무관하게 반복 횟수만큼`);

    const keys = [...new Set(retrieves.flatMap((r) => r.keys.directAttrs))];
    if (keys.length > 0) {
        const ops = new Set(retrieves.map((r) => r.keys.topLevelOperator));
        const opNote = ops.has("or") ? " (or 조건)" : ops.has("and") ? " (and 조건)" : "";
        evidence.push(`조회 키: ${keys.join(", ")}${opNote}`);
    }
    const traversed = [...new Set(retrieves.flatMap((r) => r.keys.traversedPaths))];
    if (traversed.length > 0) evidence.push(`연관 경유 조건: ${traversed.join(", ")}`);

    // 루프가 여럿일 수 있으므로 변수명과 출처는 **같은 조회에서** 뽑는다.
    // 따로 뽑으면 A 루프의 변수명에 B 루프의 출처가 붙는다.
    const sample = retrieves.find((r) => !isBounded(r)) ?? retrieves[0];
    const sourceVar = sample.loopSourceVar;
    evidence.push(
        bounded
            ? `반복 대상: $${sourceVar} — ${ORIGIN_LABEL[sample.loopSourceOrigin]}이므로 반복 횟수가 입력 크기로 묶입니다.`
            : `반복 대상: ${sourceVar ? `$${sourceVar} — ` : ""}${ORIGIN_LABEL[sample.loopSourceOrigin]}. 반복 횟수 상한을 확인할 수 없습니다.`
    );

    if (!body.originsResolved) {
        evidence.push(
            "⚠️ 변수 출처를 하나도 해석하지 못했습니다(SDK 프로퍼티 확인 필요). 안전하게 Error로 둡니다."
        );
    }

    evidence.push(
        hotPath
            ? "무인/외부 진입 경로에 있어 호출량을 통제할 수 없습니다."
            : "사용자 조작으로만 실행됩니다."
    );

    const queryKeys = new Map<string, string[]>();
    for (const r of retrieves) {
        if (r.keys.directAttrs.length === 0) continue;
        queryKeys.set(r.entity, [
            ...new Set([...(queryKeys.get(r.entity) ?? []), ...r.keys.directAttrs]),
        ]);
    }

    return {
        ruleKey: "LOOP_DB_RETRIEVE",
        // "N회 발생"이 아니라 "액션 N개"다. 이 숫자는 정적 개수이지 실행 횟수가 아닌데,
        // 예전 문구는 "한 번뿐이네"로 읽혀서 정반대의 인상을 줬다.
        message:
            `루프 안에 DB 조회 액션이 ${retrieves.length}개 있습니다 (반복마다 실행). ` +
            `대상: ${entities.join(", ")}.`,
        severity: bounded ? "Warning" : "Error",
        evidence,
        scoreMultiplier: bounded ? 0.5 : 1,
        recommendation: bounded
            ? "반복 횟수가 입력 크기로 묶여 있어 구조 변경보다 조회 키 인덱스가 우선입니다. " +
              "배치 크기가 커질 수 있다면, 수신 키 집합으로 XPath를 조립해 루프 전에 1회 조회하고 " +
              "루프 안에서는 'Find by expression'으로 찾으세요."
            : undefined,
        queryKeys: queryKeys.size > 0 ? queryKeys : undefined,
    };
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
        evidence: string[],
        extra: Partial<RuleHit> = {}
    ) => hits.push({ ruleKey, message, severity, evidence, ...extra });

    const body = scanFlowBody(node);

    // L001 — 루프 내 DB 조회
    if (body.loopRetrieves.length > 0) {
        hits.push(buildLoopRetrieveHit(body, hotPath));
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
                body.loopRetrieves.length > 0
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

/**
 * 조회 키가 인덱스로 커버되는지 확인해 근거 한 줄을 만든다.
 *
 * L001과 D003을 연결하는 지점이다. 루프 안 조회의 실제 비용은
 * "몇 번 왕복하느냐" 곱하기 "한 번에 얼마나 탐색하느냐"인데,
 * 후자는 인덱스 유무로 결정되고 그 사실은 도메인 모델에만 있다.
 *
 * `detectFlowIssues`는 문서 하나로 재현 가능해야 하므로(blame 계약) 여기서만 붙인다.
 */
export function describeIndexCoverage(
    hit: Pick<RuleHit, "queryKeys">,
    graph: Pick<ModelGraph, "entityIndexes">
): string[] {
    if (!hit.queryKeys) return [];
    const lines: string[] = [];

    for (const [entity, attrs] of hit.queryKeys) {
        const info = graph.entityIndexes.get(entity);
        if (!info) continue;
        if (info.count === 0) {
            lines.push(
                `인덱스: ${entity}에 인덱스 정의가 없습니다 — 조회 키 ${attrs.join(", ")}가 매 반복 풀스캔입니다. (D003 참조)`
            );
            continue;
        }
        const uncovered = attrs.filter((a) => !info.leadingAttrs.has(a));
        if (uncovered.length > 0) {
            lines.push(
                `인덱스: ${entity}에 인덱스 ${info.count}개가 있으나 조회 키 ${uncovered.join(", ")}는 ` +
                    `선두 속성으로 커버되지 않습니다(leftmost prefix). (D003 참조)`
            );
        } else {
            lines.push(`인덱스: 조회 키 ${attrs.join(", ")}는 인덱스로 커버됩니다.`);
        }
    }

    return lines;
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
            recommendation: hit.recommendation ?? rule.recommendation,
            severity: hit.severity,
            evidence: [reachLine, ...hit.evidence, ...describeIndexCoverage(hit, graph)],
            score: scoreWithReach(rule.baseScore * (hit.scoreMultiplier ?? 1), reach),
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
