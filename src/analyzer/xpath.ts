// src/analyzer/xpath.ts
//
// Retrieve의 XPath 제약에서 "조회 키"를 뽑는다.
//
// 왜 필요한가: 인덱스를 걸어야 할 속성이 어디에 적혀 있는지는 XPath밖에 없다.
// D003이 지금까지 "속성 20개 넘는데 인덱스 없음"이라는 대리 지표를 쓴 이유가 이것이었고,
// 그래서 "어느 속성에 걸어라"를 말하지 못했다.
//
// 모델 접근이 필요 없는 순수 함수로 분리한다. 자격증명 없이 테스트할 수 있어야
// 파서 회귀를 즉시 잡을 수 있다.

export type TopLevelOperator = "and" | "or" | "single" | "none";

export interface XPathKeys {
    /** 이 엔티티에 바로 인덱스를 걸 수 있는 속성. 연관을 타지 않는 것만. */
    directAttrs: string[];
    /** 연관을 경유한 경로(Module.Assoc/Module.Entity/Attr). 이 엔티티 인덱스로는 못 푼다. */
    traversedPaths: string[];
    /**
     * 최상위 결합 연산자.
     *
     * `or`이면 복합 인덱스가 쓰이지 않는다. 각 조건이 독립적으로 인덱스를 타야 하므로
     * 단일 컬럼 인덱스를 따로 만들어야 한다. 이 구분이 권장문구를 가른다.
     */
    topLevelOperator: TopLevelOperator;
    /** XPath가 참조하는 변수명($ 제외). 루프 이터레이터 참조 여부 판정에 쓴다. */
    referencedVariables: string[];
}

export const EMPTY_KEYS: XPathKeys = {
    directAttrs: [],
    traversedPaths: [],
    topLevelOperator: "none",
    referencedVariables: [],
};

/** 속성명으로 인정할 형태. Mendix 속성명에는 `.`도 `/`도 들어가지 않는다. */
const DIRECT_ATTR = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** 연관 경유 경로. 최소 한 번은 `/`를 탄다. */
const PATH_LIKE = /^[A-Za-z_][A-Za-z0-9_.]*(\/[A-Za-z_][A-Za-z0-9_.]*)+$/;

/** 좌변으로 볼 수 없는 것들 — 시스템 속성이거나 인덱스 대상이 아니다. */
const NOT_INDEXABLE = new Set(["id", "ID", "Id"]);

/** 첫 인자가 속성인 XPath 함수들. */
const ATTR_FIRST_ARG_FUNCS = /\b(?:contains|starts-with|ends-with|string-length|length)\s*\(\s*([A-Za-z_][A-Za-z0-9_./]*)/gi;

function uniq(values: string[]): string[] {
    return [...new Set(values)];
}

/**
 * 문자열 리터럴과 `[%Token%]`을 마스킹한다.
 *
 * 안에 `=`·`/`·`and`가 들어 있어 마스킹하지 않으면 파서가 깨진다.
 * 예: `[CreatedDate > '[%BeginOfCurrentDay%]' and Status = 'a and b']`
 */
function maskLiterals(xpath: string): string {
    return xpath
        .replace(/\[%[^\]]*%\]/g, "@")
        .replace(/'[^']*'/g, "@")
        .replace(/"[^"]*"/g, "@");
}

/**
 * 최상위 결합 연산자를 찾는다.
 *
 * 제약 전체가 `[...]`로 감싸여 있어 "깊이 0"이 존재하지 않을 수 있으므로,
 * and/or가 등장한 최소 깊이를 최상위로 본다.
 */
function detectTopLevelOperator(masked: string, hasComparison: boolean): TopLevelOperator {
    let depth = 0;
    let minDepth = Infinity;
    const atMinDepth: string[] = [];

    const pattern = /[[\]()]|\b(and|or)\b/gi;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(masked)) !== null) {
        const token = match[0];
        if (token === "[" || token === "(") {
            depth++;
            continue;
        }
        if (token === "]" || token === ")") {
            depth--;
            continue;
        }
        const keyword = token.toLowerCase();
        if (depth < minDepth) {
            minDepth = depth;
            atMinDepth.length = 0;
        }
        if (depth === minDepth) atMinDepth.push(keyword);
    }

    if (atMinDepth.includes("or")) return "or";
    if (atMinDepth.includes("and")) return "and";
    return hasComparison ? "single" : "none";
}

/** 비교식 좌변을 조각에서 뽑는다. 값을 좌변에 쓴 경우(`'a' = Attr`)는 버린다. */
function leftOperandOf(fragment: string): string | null {
    const match = fragment.match(/^([^<>=!]+?)\s*(?:<=|>=|!=|=|<|>)/);
    if (!match) return null;
    const lhs = match[1].trim();
    if (!lhs || lhs.includes("$") || lhs.includes("@")) return null;
    return lhs;
}

export function parseXPathKeys(xpath: string | null | undefined): XPathKeys {
    if (!xpath || !xpath.trim()) return { ...EMPTY_KEYS };

    const referencedVariables = uniq(
        [...xpath.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1])
    );

    const masked = maskLiterals(xpath);

    const candidates: string[] = [];

    // 1) 함수 형태 — `contains(Attr, ...)`. 아래 조각 분해로는 안 잡힌다.
    //    `(`가 구분자라 인자가 비교식 없는 조각으로 떨어져 나가기 때문.
    for (const m of masked.matchAll(ATTR_FIRST_ARG_FUNCS)) {
        candidates.push(m[1]);
    }

    // 2) 비교식 — 불리언·구조 구분자로 조각낸 뒤 각 조각의 좌변을 본다.
    const fragments = masked.split(/\band\b|\bor\b|\bnot\b|[()[\],]/gi);
    for (const fragment of fragments) {
        const lhs = leftOperandOf(fragment);
        if (lhs) candidates.push(lhs);
    }

    const directAttrs: string[] = [];
    const traversedPaths: string[] = [];
    for (const raw of candidates) {
        const value = raw.replace(/^\/+/, "").trim();
        if (!value) continue;
        if (DIRECT_ATTR.test(value)) {
            if (!NOT_INDEXABLE.has(value)) directAttrs.push(value);
        } else if (PATH_LIKE.test(value)) {
            traversedPaths.push(value);
        }
        // 그 밖의 형태(숫자·연산자 잔여물)는 버린다. 조용히 버려도 되는 이유는
        // 여기서 놓친 키는 "인덱스 후보 누락"이지 오탐이 아니기 때문이다.
    }

    return {
        directAttrs: uniq(directAttrs),
        traversedPaths: uniq(traversedPaths),
        topLevelOperator: detectTopLevelOperator(masked, candidates.length > 0),
        referencedVariables,
    };
}
