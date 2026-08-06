// src/analyzer/graph.ts
//
// 모델 전체를 한 번 순회하며 "관계 인덱스"를 만든다.
// 개별 마이크로플로우를 고립시켜 보는 대신, 호출 그래프 / 엔티티 사용 / 진입점 도달성을
// 먼저 확보해야 리뷰가 "이거 크네요" 수준을 벗어난다.

import { IModel, microflows } from "mendixmodelsdk";

export type FlowKind = "Microflow" | "Nanoflow";

export type EntryKind =
    | "ScheduledEvent"
    | "PublishedService"
    | "EntityEvent"
    | "Workflow"
    | "Page"
    | "Navigation";

/** 진입 유형별 위험 가중치. 같은 결함도 어디서 실행되느냐에 따라 값이 다르다. */
export const ENTRY_WEIGHT: Record<EntryKind, number> = {
    ScheduledEvent: 10, // 무인·반복 실행. 사람이 못 본다.
    PublishedService: 8, // 외부 호출. 호출량을 우리가 통제 못 한다.
    EntityEvent: 7, // 해당 엔티티가 커밋될 때마다 실행. 호출처가 분산돼 추적이 어렵다.
    Workflow: 5,
    Page: 3,
    Navigation: 3,
};

export interface EntryPoint {
    kind: EntryKind;
    /** 사람이 읽을 진입 설명. 예: "스케줄 이벤트 SE_Sync (매 10분)" */
    label: string;
    /** 진입 대상 flow의 qualifiedName */
    target: string;
    weight: number;
}

export interface FlowNode {
    qName: string;
    kind: FlowKind;
    module: string;
    /**
     * 지적 대상인가. 마켓플레이스/테마 모듈은 false.
     * 그래프에는 남긴다 — 호출 관계가 정확해야 우리 코드의 도달성이 맞기 때문.
     * 다만 "이걸 고치세요"라고 말하지는 않는다. 남의 코드고 고칠 수도 없다.
     */
    reviewable: boolean;
    /** 이미 로드된 문서. 분석기들이 다시 load() 하지 않도록 공유한다. */
    doc: microflows.MicroflowBase;
    actionCount: number;
    paramCount: number;
    /** 중첩 루프 최대 깊이. 0 = 루프 없음 */
    maxLoopDepth: number;
    calls: Set<string>;
    javaCalls: Set<string>;
    reads: Set<string>;
    writes: Set<string>;
    commits: Set<string>;
}

export interface ReachInfo {
    reachable: boolean;
    entryKinds: Set<EntryKind>;
    /** 도달 가능한 진입점 중 가장 위험한 것 */
    hottest: EntryPoint | null;
    /** 진입점으로부터의 최소 호출 깊이 */
    depth: number;
}

export interface EntityUsage {
    readBy: Set<string>;
    writtenBy: Set<string>;
    committedBy: Set<string>;
}

export interface ModelGraph {
    flows: Map<string, FlowNode>;
    /** 역방향 간선: qName -> 이 flow를 호출하는 flow들 */
    callers: Map<string, Set<string>>;
    entryPoints: EntryPoint[];
    reach: Map<string, ReachInfo>;
    entityUsage: Map<string, EntityUsage>;
    /** 마켓플레이스·테마 모듈 이름. 지적 대상에서 제외되지만 그래프에는 남는다. */
    excludedModules: Set<string>;
    /** 지적 대상 모듈 이름 */
    reviewableModules: Set<string>;
}

/** 모듈이 리뷰 대상인지 판정. 마켓플레이스/테마 모듈은 우리가 고칠 수 있는 코드가 아니다. */
export function isReviewableModule(graph: ModelGraph, moduleName: string): boolean {
    return !graph.excludedModules.has(moduleName) && !SYSTEM_MODULES.has(moduleName);
}

const SYSTEM_MODULES = new Set(["System", "Administration"]);

function moduleOf(qName: string): string {
    return qName.split(".")[0];
}

function isUserModule(qName: string | null | undefined): boolean {
    if (!qName) return false;
    return !SYSTEM_MODULES.has(moduleOf(qName));
}

/**
 * 마이크로플로우 본문을 재귀 순회한다.
 *
 * 주의: 이 SDK 버전(4.110)에 `microflows.LoopAction`은 존재하지 않는다.
 * 루프는 ActionActivity가 감싼 액션이 아니라 `LoopedActivity`라는 독립 MicroflowObject다.
 * 루프 본문은 `LoopedActivity.objectCollection`에 들어 있다.
 */
export function walkObjects(
    coll: microflows.MicroflowObjectCollection,
    depth: number,
    visit: (obj: microflows.MicroflowObject, loopDepth: number) => void
): void {
    for (const obj of coll.objects) {
        visit(obj, depth);
        if (obj instanceof microflows.LoopedActivity) {
            walkObjects(obj.objectCollection, depth + 1, visit);
        }
    }
}

/** 액션 하나에서 그래프 간선(호출·엔티티 사용)을 뽑아 노드에 기록한다. */
function recordAction(node: FlowNode, action: microflows.MicroflowAction): void {
    if (action instanceof microflows.MicroflowCallAction) {
        const target = action.microflowCall?.microflowQualifiedName;
        if (target) node.calls.add(target);
        return;
    }

    if (action instanceof microflows.NanoflowCallAction) {
        const target = action.nanoflowCall?.nanoflowQualifiedName;
        if (target) node.calls.add(target);
        return;
    }

    if (action instanceof microflows.JavaActionCallAction) {
        const target = action.javaActionQualifiedName;
        if (target) node.javaCalls.add(target);
        return;
    }

    if (action instanceof microflows.RetrieveAction) {
        const source = action.retrieveSource;
        if (source instanceof microflows.DatabaseRetrieveSource) {
            const entity = source.entityQualifiedName;
            if (entity) node.reads.add(entity);
        }
        // AssociationRetrieveSource는 DB 조회가 아니라 메모리상 탐색이므로
        // 성능 관점의 read로 세지 않는다.
        return;
    }

    if (action instanceof microflows.CreateObjectAction) {
        const entity = action.entityQualifiedName;
        if (entity) node.writes.add(entity);
        if (action.commit !== microflows.CommitEnum.No && entity) node.commits.add(entity);
        return;
    }

    if (action instanceof microflows.ChangeObjectAction) {
        // ChangeObjectAction은 변경 대상 엔티티를 변수명으로만 들고 있어
        // 정확한 엔티티 해석이 어렵다. 커밋 여부만 기록한다.
        if (action.commit !== microflows.CommitEnum.No) node.commits.add("(변수)");
        return;
    }

    if (action instanceof microflows.CommitAction) {
        node.commits.add("(변수)");
        return;
    }

    if (action instanceof microflows.DeleteAction) {
        node.writes.add("(변수)");
    }
}

/** 로드된 flow 문서 하나를 FlowNode로 변환한다. */
export function buildNode(
    doc: microflows.MicroflowBase,
    kind: FlowKind,
    excludedModules: Set<string>
): FlowNode {
    const qName = doc.qualifiedName ?? "(unnamed)";
    const node: FlowNode = {
        qName,
        kind,
        module: moduleOf(qName),
        reviewable: !excludedModules.has(moduleOf(qName)),
        doc,
        actionCount: 0,
        paramCount: 0,
        maxLoopDepth: 0,
        calls: new Set(),
        javaCalls: new Set(),
        reads: new Set(),
        writes: new Set(),
        commits: new Set(),
    };

    walkObjects(doc.objectCollection, 0, (obj, loopDepth) => {
        if (loopDepth > node.maxLoopDepth) node.maxLoopDepth = loopDepth;

        if (obj instanceof microflows.MicroflowParameterObject) {
            node.paramCount++;
            return;
        }

        if (obj instanceof microflows.ActionActivity) {
            node.actionCount++;
            const action = obj.action;
            if (action) recordAction(node, action);
        }
    });

    // 동시성 에러 처리용 마이크로플로우도 호출 간선이다.
    // 빠뜨리면 이 용도로만 쓰이는 flow가 고아로 오판된다.
    if (doc instanceof microflows.Microflow) {
        const onError = doc.concurrencyErrorMicroflowQualifiedName;
        if (onError) node.calls.add(onError);
    }

    return node;
}

/**
 * 문서를 통째로 traverse하며 참조된 마이크로플로우/나노플로우 이름을 긁는다.
 * 페이지 위젯 트리처럼 구조가 깊고 버전마다 바뀌는 곳은 타입별 분기보다 이쪽이 안전하다.
 */
function collectFlowRefs(root: { traverse(visit: (s: any) => void): void }): Set<string> {
    const found = new Set<string>();
    root.traverse((structure: any) => {
        for (const prop of ["microflowQualifiedName", "nanoflowQualifiedName"]) {
            try {
                const value = structure?.[prop];
                if (typeof value === "string" && value.length > 0) found.add(value);
            } catch {
                // 부분 로드된 구조에서 게터가 실패할 수 있다. 무시.
            }
        }
    });
    return found;
}

async function collectEntryPoints(model: IModel): Promise<EntryPoint[]> {
    const entries: EntryPoint[] = [];

    // 1. 스케줄 이벤트 — 가장 위험한 진입점. 무인으로 반복 실행된다.
    for (const seProxy of model.allScheduledEvents()) {
        try {
            const se = await seProxy.load();
            const target = se.microflowQualifiedName;
            if (!target || !isUserModule(target)) continue;
            const cadence = `${se.interval} ${se.intervalType?.name ?? ""}`.trim();
            entries.push({
                kind: "ScheduledEvent",
                label: `스케줄 ${se.name} (${cadence}${se.enabled ? "" : ", 비활성"})`,
                target,
                weight: se.enabled ? ENTRY_WEIGHT.ScheduledEvent : 1,
            });
        } catch {
            /* 개별 문서 실패는 건너뛴다 */
        }
    }

    // 2. 엔티티 이벤트 핸들러 — 해당 엔티티가 커밋/삭제될 때마다 실행된다.
    //    호출처가 코드 어디에도 안 보이기 때문에, 빠뜨리면 멀쩡한 flow가 "고아"로 오판된다.
    for (const dmProxy of model.allDomainModels()) {
        try {
            const dm = await dmProxy.load();
            const moduleName = dm.containerAsModule.name;
            if (SYSTEM_MODULES.has(moduleName)) continue;
            for (const entity of dm.entities) {
                for (const handler of entity.eventHandlers) {
                    const target = handler.microflowQualifiedName;
                    if (!target || !isUserModule(target)) continue;
                    entries.push({
                        kind: "EntityEvent",
                        label: `엔티티 이벤트 ${moduleName}.${entity.name} (${handler.moment?.name ?? ""} ${handler.event?.name ?? ""})`.replace(
                            /\s+/g,
                            " "
                        ),
                        target,
                        weight: ENTRY_WEIGHT.EntityEvent,
                    });
                }
            }
        } catch {
            /* 무시 */
        }
    }

    // 3. 문서 유형별 일괄 수집.
    //    페이지만 훑으면 스니펫·레이아웃·네이티브 페이지·메뉴에서만 호출되는 flow가
    //    전부 고아로 잡힌다. 실제로 그렇게 나왔다.
    const documentSources: Array<{ proxies: any[]; kind: EntryKind; label: string }> = [
        {
            proxies: [...model.allPublishedRestServices(), ...model.allPublishedODataServices()],
            kind: "PublishedService",
            label: "공개 서비스",
        },
        { proxies: model.allWorkflows(), kind: "Workflow", label: "워크플로우" },
        { proxies: model.allNavigationDocuments(), kind: "Navigation", label: "네비게이션" },
        { proxies: model.allMenuDocuments(), kind: "Navigation", label: "메뉴" },
        { proxies: model.allSnippets(), kind: "Page", label: "스니펫" },
        { proxies: model.allLayouts(), kind: "Page", label: "레이아웃" },
        { proxies: model.allNativePages(), kind: "Page", label: "네이티브 페이지" },
        { proxies: model.allBuildingBlocks(), kind: "Page", label: "빌딩블록" },
    ];

    for (const { proxies, kind, label } of documentSources) {
        for (const proxy of proxies) {
            try {
                const doc = await proxy.load();
                for (const target of collectFlowRefs(doc as any)) {
                    if (!isUserModule(target)) continue;
                    entries.push({
                        kind,
                        label: `${label} ${doc.qualifiedName ?? doc.name ?? ""}`.trim(),
                        target,
                        weight: ENTRY_WEIGHT[kind],
                    });
                }
            } catch {
                /* 개별 문서 실패는 건너뛴다 */
            }
        }
    }

    return entries;
}

/** 진입점에서 호출 그래프를 따라 BFS하여 도달성과 위험 가중치를 전파한다. */
function computeReach(
    flows: Map<string, FlowNode>,
    entryPoints: EntryPoint[]
): Map<string, ReachInfo> {
    const reach = new Map<string, ReachInfo>();
    for (const qName of flows.keys()) {
        reach.set(qName, {
            reachable: false,
            entryKinds: new Set(),
            hottest: null,
            depth: Infinity,
        });
    }

    for (const entry of entryPoints) {
        // 진입점마다 별도 BFS. 같은 flow가 여러 진입점에서 도달되면
        // 가장 위험한 진입점과 가장 짧은 깊이를 남긴다.
        const queue: Array<[string, number]> = [[entry.target, 0]];
        const seen = new Set<string>([entry.target]);

        while (queue.length > 0) {
            const [qName, depth] = queue.shift()!;
            const info = reach.get(qName);
            if (!info) continue; // 모델에 없는 flow(시스템 모듈 등)

            info.reachable = true;
            info.entryKinds.add(entry.kind);
            if (depth < info.depth) info.depth = depth;
            if (!info.hottest || entry.weight > info.hottest.weight) {
                info.hottest = entry;
            }

            const node = flows.get(qName);
            if (!node) continue;
            for (const callee of node.calls) {
                if (seen.has(callee)) continue;
                seen.add(callee);
                queue.push([callee, depth + 1]);
            }
        }
    }

    return reach;
}

function computeEntityUsage(flows: Map<string, FlowNode>): Map<string, EntityUsage> {
    const usage = new Map<string, EntityUsage>();
    const ensure = (entity: string): EntityUsage => {
        let u = usage.get(entity);
        if (!u) {
            u = { readBy: new Set(), writtenBy: new Set(), committedBy: new Set() };
            usage.set(entity, u);
        }
        return u;
    };

    for (const node of flows.values()) {
        for (const e of node.reads) ensure(e).readBy.add(node.qName);
        for (const e of node.writes) ensure(e).writtenBy.add(node.qName);
        for (const e of node.commits) ensure(e).committedBy.add(node.qName);
    }
    usage.delete("(변수)");
    return usage;
}

export async function buildGraph(model: IModel): Promise<ModelGraph> {
    console.log("🧭 [Graph] 모델 관계 인덱스 구축 시작...");

    // 마켓플레이스·테마 모듈 식별. 우리가 고칠 수 있는 코드가 아니므로 지적하지 않는다.
    const excludedModules = new Set<string>();
    const reviewableModules = new Set<string>();
    for (const mod of model.allModules()) {
        try {
            // IModule은 load() 없이 속성을 직접 노출한다.
            // isThemeModule은 메타모델 9.3.0에서 도입되어 구버전에선 undefined일 수 있다.
            if (SYSTEM_MODULES.has(mod.name)) continue;
            if (mod.fromAppStore || mod.isThemeModule) excludedModules.add(mod.name);
            else reviewableModules.add(mod.name);
        } catch {
            /* 판정 실패 시 리뷰 대상으로 둔다 — 조용히 빠뜨리는 것보다 낫다 */
        }
    }
    console.log(
        `   > 모듈 ${reviewableModules.size}개 리뷰 대상 / ${excludedModules.size}개 제외 (마켓플레이스·테마)`
    );

    const flowProxies: Array<{ proxy: any; kind: FlowKind }> = [
        ...model.allMicroflows().map((p) => ({ proxy: p, kind: "Microflow" as FlowKind })),
        ...model.allNanoflows().map((p) => ({ proxy: p, kind: "Nanoflow" as FlowKind })),
    ].filter(({ proxy }) => isUserModule(proxy.qualifiedName));

    const flows = new Map<string, FlowNode>();
    const failures: string[] = [];
    const BATCH_SIZE = 10;

    for (let i = 0; i < flowProxies.length; i += BATCH_SIZE) {
        const batch = flowProxies.slice(i, i + BATCH_SIZE);
        const nodes = await Promise.all(
            batch.map(async ({ proxy, kind }) => {
                try {
                    const doc = await proxy.load();
                    return buildNode(doc, kind, excludedModules);
                } catch (err) {
                    // 조용히 삼키지 않는다. 삼키면 "이슈 0건"이 성공처럼 보인다.
                    failures.push(`${proxy.qualifiedName}: ${(err as Error).message}`);
                    return null;
                }
            })
        );
        for (const node of nodes) {
            if (node) flows.set(node.qName, node);
        }
        console.log(
            `   > flow 로딩 ${Math.min(i + BATCH_SIZE, flowProxies.length)} / ${flowProxies.length}`
        );
    }

    if (failures.length > 0) {
        console.warn(`⚠️ [Graph] flow ${failures.length}건 로드 실패:`);
        for (const f of failures.slice(0, 5)) console.warn(`     - ${f}`);
        if (failures.length > 5) console.warn(`     ... 외 ${failures.length - 5}건`);
    }

    // 역방향 간선
    const callers = new Map<string, Set<string>>();
    for (const node of flows.values()) {
        for (const callee of node.calls) {
            if (!callers.has(callee)) callers.set(callee, new Set());
            callers.get(callee)!.add(node.qName);
        }
    }

    // 페이지에서의 호출도 진입점으로 잡는다 (가장 수가 많아 별도 처리)
    const entryPoints = await collectEntryPoints(model);
    const pageProxies = model.allPages().filter((p) => isUserModule(p.qualifiedName));
    for (let i = 0; i < pageProxies.length; i += BATCH_SIZE) {
        const batch = pageProxies.slice(i, i + BATCH_SIZE);
        await Promise.all(
            batch.map(async (proxy) => {
                try {
                    const page = await proxy.load();
                    for (const target of collectFlowRefs(page as any)) {
                        if (!isUserModule(target)) continue;
                        entryPoints.push({
                            kind: "Page",
                            label: `페이지 ${page.qualifiedName}`,
                            target,
                            weight: ENTRY_WEIGHT.Page,
                        });
                    }
                } catch {
                    /* 페이지 로드 실패는 page.ts에서 별도 보고 */
                }
            })
        );
    }

    const reach = computeReach(flows, entryPoints);
    const entityUsage = computeEntityUsage(flows);

    const reviewableFlows = [...flows.values()].filter((f) => f.reviewable);
    const reachableCount = reviewableFlows.filter((f) => reach.get(f.qName)?.reachable).length;
    console.log(
        `✅ [Graph] flow ${flows.size}개 (리뷰 대상 ${reviewableFlows.length}개) / ` +
            `진입점 ${entryPoints.length}개 / ` +
            `도달 가능 ${reachableCount}개 (고아 ${reviewableFlows.length - reachableCount}개)`
    );

    return { flows, callers, entryPoints, reach, entityUsage, excludedModules, reviewableModules };
}
