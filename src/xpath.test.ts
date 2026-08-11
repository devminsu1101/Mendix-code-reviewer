// src/xpath.test.ts
//
// XPath 조회 키 파서 검증. 모델도 자격증명도 필요 없다.
//
// 왜 테스트가 있나: 이 파서가 조용히 빈 배열을 돌려주면 D003은 "지적할 게 없다"로
// 통과해 버린다. 버그 #0(`instanceof undefined`)과 같은 실패 모드다 —
// 리포트는 멀쩡해 보이는데 룰이 죽어 있는 상태.
import { parseXPathKeys } from "./analyzer/xpath.js";
import { describeIndexCoverage } from "./analyzer/logic.js";

let failures = 0;
const assert = (cond: boolean, msg: string) => {
    console.log(`  ${cond ? "✅" : "❌"} ${msg}`);
    if (!cond) failures++;
};

const sameSet = (got: string[], want: string[]) =>
    got.length === want.length && want.every((w) => got.includes(w));

function check(
    name: string,
    xpath: string,
    want: {
        direct?: string[];
        traversed?: string[];
        op?: string;
        vars?: string[];
    }
) {
    const keys = parseXPathKeys(xpath);
    const parts: string[] = [];
    let ok = true;

    if (want.direct !== undefined) {
        const good = sameSet(keys.directAttrs, want.direct);
        if (!good) parts.push(`direct: 기대 [${want.direct}] 실제 [${keys.directAttrs}]`);
        ok &&= good;
    }
    if (want.traversed !== undefined) {
        const good = sameSet(keys.traversedPaths, want.traversed);
        if (!good) parts.push(`traversed: 기대 [${want.traversed}] 실제 [${keys.traversedPaths}]`);
        ok &&= good;
    }
    if (want.op !== undefined) {
        const good = keys.topLevelOperator === want.op;
        if (!good) parts.push(`op: 기대 ${want.op} 실제 ${keys.topLevelOperator}`);
        ok &&= good;
    }
    if (want.vars !== undefined) {
        const good = sameSet(keys.referencedVariables, want.vars);
        if (!good) parts.push(`vars: 기대 [${want.vars}] 실제 [${keys.referencedVariables}]`);
        ok &&= good;
    }

    assert(ok, name + (ok ? "" : ` — ${parts.join(" / ")}`));
}

console.log("🧪 XPath 조회 키 파서\n");

// 이번 작업의 출발점이 된 실제 XPath (common.VAL_IF_SABIS_002_AIR).
// `or`로 묶여 있다는 사실이 "복합 인덱스로는 못 푼다"는 권장문구를 만든다.
check(
    "실제 케이스 — or 결합 2개 키 + 이터레이터 참조",
    "[HouseAwbNo_AIR = $IteratorAirShipmentCase/HouseBlNo or BookingNo = $IteratorAirShipmentCase/BookingNo]",
    {
        direct: ["HouseAwbNo_AIR", "BookingNo"],
        traversed: [],
        op: "or",
        vars: ["IteratorAirShipmentCase"],
    }
);

check("단일 조건", "[BookingNo = $Iter/BookingNo]", {
    direct: ["BookingNo"],
    op: "single",
    vars: ["Iter"],
});

check("and 결합", "[Status = 'Open' and CreatedDate > $Since]", {
    direct: ["Status", "CreatedDate"],
    op: "and",
    vars: ["Since"],
});

check("연관 경유는 직접 인덱스 대상이 아니다", "[Sales.Order_Customer/Sales.Customer/Name = $n]", {
    direct: [],
    traversed: ["Sales.Order_Customer/Sales.Customer/Name"],
    op: "single",
});

check("직접 속성과 연관 경유 혼재", "[Code = 'A' and Mod.Assoc/Mod.E/Name = $n]", {
    direct: ["Code"],
    traversed: ["Mod.Assoc/Mod.E/Name"],
    op: "and",
});

// 토큰 안에 `]`와 `%`가 들어 있어 마스킹하지 않으면 파서가 깨진다.
check("날짜 토큰 마스킹", "[CreatedDate > '[%BeginOfCurrentDay%]' and Status = 'x']", {
    direct: ["CreatedDate", "Status"],
    op: "and",
});

// 리터럴 안의 `and`가 결합 연산자로 오인되면 안 된다.
check("리터럴 안의 and는 연산자가 아니다", "[Name = 'black and white']", {
    direct: ["Name"],
    op: "single",
});

check("contains 함수의 첫 인자", "[contains(Name, $search)]", {
    direct: ["Name"],
    op: "single",
    vars: ["search"],
});

check("not() 안의 비교", "[not(Status = 'Closed')]", {
    direct: ["Status"],
});

check("괄호 중첩 — 최상위가 and면 and", "[A = 1 and (B = 2 or C = 3)]", {
    direct: ["A", "B", "C"],
    op: "and",
});

check("괄호 중첩 — 최상위가 or면 or", "[(A = 1 and B = 2) or C = 3]", {
    direct: ["A", "B", "C"],
    op: "or",
});

check("연속 술어", "[A = 1][B = 2]", { direct: ["A", "B"] });

check("id는 인덱스 대상이 아니다", "[id = $obj]", { direct: [], op: "single" });

check("빈 제약", "", { direct: [], traversed: [], op: "none", vars: [] });

check("제약 없음(null)", null as unknown as string, { direct: [], op: "none" });

check("비교 없는 제약", "[%CurrentUser%]", { direct: [], op: "none" });

// ── 인덱스 교차 참조 ──────────────────────────────────────────
//
// 이 근거 줄은 evidence로만 나가는데 evidence는 TOP 10에만 렌더링된다.
// 실제 리포트에서 눈으로 확인하려면 L001이 TOP 10에 들어야 하는데,
// 현재 모델에서는 L002가 상단을 채워 한 번도 출력되지 않았다.
// 순수 함수이므로 모델 없이 여기서 직접 검증한다.

console.log("\n🧪 인덱스 교차 참조\n");

const entity = "ShipmentTracking.ShipmentCase";
const graphWith = (count: number, leading: string[], indexed: string[] = leading) => ({
    entityIndexes: new Map([
        [
            entity,
            {
                count,
                indexedAttrs: new Set(indexed),
                leadingAttrs: new Set(leading),
                persistable: true,
            },
        ],
    ]),
});
const hit = { queryKeys: new Map([[entity, ["HouseAwbNo_AIR", "BookingNo"]]]) };

{
    const lines = describeIndexCoverage(hit, graphWith(0, []));
    assert(
        lines.length === 1 &&
            lines[0].includes("인덱스 정의가 없습니다") &&
            lines[0].includes("HouseAwbNo_AIR") &&
            lines[0].includes("D003"),
        `인덱스 0개 → 풀스캔 경고 + 조회 키 + D003 참조`
    );
}

{
    // 복합 인덱스 (BookingNo, X): leftmost prefix상 BookingNo만 단독 조회를 받쳐준다.
    const lines = describeIndexCoverage(hit, graphWith(1, ["BookingNo"], ["BookingNo", "X"]));
    assert(
        lines.length === 1 &&
            lines[0].includes("HouseAwbNo_AIR") &&
            !lines[0].includes("BookingNo,") &&
            lines[0].includes("leftmost prefix"),
        `선두 속성만 커버로 인정 — 미커버 키만 지목`
    );
}

{
    const lines = describeIndexCoverage(hit, graphWith(2, ["HouseAwbNo_AIR", "BookingNo"]));
    assert(
        lines.length === 1 && lines[0].includes("커버됩니다"),
        `전부 커버되면 그 사실을 적는다`
    );
}

{
    assert(
        describeIndexCoverage({ queryKeys: undefined }, graphWith(0, [])).length === 0,
        `조회 키가 없으면 아무 줄도 만들지 않는다`
    );
    assert(
        describeIndexCoverage(hit, { entityIndexes: new Map() }).length === 0,
        `엔티티 정보가 없으면 추측하지 않는다`
    );
}

console.log(
    failures === 0
        ? `\n✅ 전부 통과`
        : `\n❌ ${failures}건 실패 — 조회 키 추출/인덱스 교차 참조가 깨졌습니다.`
);
process.exit(failures === 0 ? 0 : 1);
