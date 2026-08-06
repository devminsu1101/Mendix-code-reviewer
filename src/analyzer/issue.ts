// src/analyzer/issue.ts
import { ReachInfo } from "./graph.js";

export interface ReviewIssue {
    category: "Domain" | "Logic" | "Page" | "Security" | "Architecture";
    /** rules.ts의 규칙 ID (L001 등). 리포트에서 규칙별로 묶는 데 쓴다. */
    ruleId: string;
    location: string;
    message: string;
    recommendation?: string;
    severity: "Warning" | "Error";
    /**
     * 왜 이게 이 위치에서 문제인지 뒷받침하는 **관측된 사실**만 담는다.
     * 추측·해석은 넣지 않는다. 리포트 신뢰도가 여기서 갈린다.
     */
    evidence?: string[];
    /** 우선순위 점수. 높을수록 먼저 고쳐야 한다. */
    score: number;
}

/**
 * 결함 자체의 심각도(baseScore)에 "어디서 실행되는가"를 곱한다.
 *
 * 같은 N+1 쿼리라도 10분마다 도는 스케줄 이벤트 안에 있는 것과
 * 아무도 호출하지 않는 마이크로플로우 안에 있는 것은 값이 다르다.
 * 이 배수가 리포트를 평평한 목록에서 우선순위 목록으로 바꾼다.
 */
export function scoreWithReach(baseScore: number, reach?: ReachInfo): number {
    if (!reach || !reach.reachable) return Math.round(baseScore * 0.3);
    const entryWeight = reach.hottest?.weight ?? 3;

    // 깊이 감쇠는 **약하게만** 건다.
    // 스케줄 이벤트에서 4단계 아래에 있는 flow도 실행 빈도는 진입점과 똑같다.
    // 깊이가 줄이는 것은 위험도가 아니라 "이 flow에 책임을 묻기 쉬운 정도"뿐이므로,
    // 동점 정리 수준으로만 반영하고 진입점 가중치를 뒤집지 못하게 하한을 둔다.
    const depthDecay = Math.max(0.7, 1 / (1 + reach.depth * 0.05));
    return Math.round(baseScore * (1 + entryWeight / 10) * depthDecay);
}

/** 진입 경로를 사람이 읽을 한 줄로. evidence에 넣는다. */
export function describeReach(reach?: ReachInfo): string {
    if (!reach || !reach.reachable) return "진입점에서 도달 불가 (호출하는 곳 없음)";
    const via = reach.hottest ? reach.hottest.label : "알 수 없음";
    const depth = reach.depth === 0 ? "직접 호출" : `${reach.depth}단계 아래`;
    const kinds = [...reach.entryKinds].join(", ");
    return `진입: ${via} → ${depth} (진입 유형: ${kinds})`;
}
