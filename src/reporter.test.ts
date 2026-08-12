// src/reporter.test.ts
//
// 규칙별 리포트 렌더링 검증. 모델도 자격증명도 필요 없다.
//
// 왜 테스트가 있나: 규칙별 섹션의 표는 **열이 규칙마다 다르다**(L002는 커밋 지점/반복 상한,
// L006은 액션 수/종류, P002는 아무것도 없음). 열 개수가 헤더·구분선·본문에서 하나라도
// 어긋나면 마크다운 표가 통째로 깨지는데, 깨진 표는 "이슈가 없다"처럼 보인다.
// 리포트가 조용히 거짓말하는 실패 모드라 자동으로 막아 둔다.
import { ReviewIssue } from "./analyzer/issue.js";
import {
    renderRuleSection,
    renderComposite,
    renderIndexPlan,
    renderModuleHealth,
    renderRuleScoreboard,
    renderCleanRule,
    catalogRuleIds,
} from "./analyzer/reporter.js";
import { boundLabel, worstBound } from "./analyzer/logic.js";

let failures = 0;
const assert = (cond: boolean, msg: string) => {
    console.log(`  ${cond ? "✅" : "❌"} ${msg}`);
    if (!cond) failures++;
};

// ── 픽스처 ────────────────────────────────────────────────────────────

function fakeGraph(
    flows: [qName: string, module: string, entryKind: string | null][],
    entityQueryKeys: Map<string, Map<string, any>> = new Map()
): any {
    const flowMap = new Map<string, any>();
    const reach = new Map<string, any>();
    for (const [qName, module, kind] of flows) {
        flowMap.set(qName, { qName, module, kind: "Microflow", reviewable: true });
        reach.set(qName, {
            reachable: kind !== null,
            entryKinds: new Set(kind ? [kind] : []),
            hottest: kind ? { kind, label: kind, weight: 3, target: qName } : null,
            depth: 0,
        });
    }
    const entityIndexes = new Map<string, any>();
    for (const entity of entityQueryKeys.keys()) {
        entityIndexes.set(entity, {
            count: 0,
            indexedAttrs: new Set(),
            leadingAttrs: new Set(),
            persistable: true,
        });
    }
    return {
        flows: flowMap,
        reach,
        callers: new Map(),
        entryPoints: [],
        entityUsage: new Map(),
        entityIndexes,
        entityQueryKeys,
        excludedModules: new Map(),
        reviewableModules: new Set(),
    };
}

function issue(over: Partial<ReviewIssue> & { ruleId: string; location: string }): ReviewIssue {
    return {
        category: "Logic",
        message: "테스트 메시지",
        severity: "Error",
        score: 50,
        ...over,
    } as ReviewIssue;
}

function usage(total: number, inLoop: number, hot: number, orCombined = false) {
    return {
        total,
        inLoop,
        flows: new Set<string>(),
        hotFlows: new Set(Array.from({ length: hot }, (_, i) => `f${i}`)),
        orCombined,
    };
}

/** 마크다운 표의 각 줄이 같은 칸 수를 갖는지. 깨진 표를 잡는 핵심 검사. */
function tableColumnCounts(markdown: string): number[][] {
    const tables: number[][] = [];
    let current: number[] | null = null;
    for (const line of markdown.split("\n")) {
        if (line.startsWith("|")) {
            // 앞뒤 파이프를 제외한 칸 수. 이스케이프된 \| 는 칸 구분이 아니다.
            const cells = line.replace(/\\\|/g, "").split("|").length - 2;
            if (!current) {
                current = [];
                tables.push(current);
            }
            current.push(cells);
        } else if (line.trim() === "" && current) {
            current = null;
        }
    }
    return tables;
}

const allEqual = (nums: number[]) => nums.every((n) => n === nums[0]);

// ── 1. 사실 열이 있는 규칙 ────────────────────────────────────────────
console.log("\n🧪 규칙별 섹션 — 사실 열이 있는 규칙(L002)\n");
{
    const graph = fakeGraph([
        ["A.Mig", "A", "Navigation"],
        ["A.Save", "A", "Page"],
        ["B.Reset", "B", "Page"],
        ["B.Sync", "B", "ScheduledEvent"],
    ]);
    const issues: ReviewIssue[] = [
        issue({ ruleId: "L002", location: "A.Mig", facts: { "커밋 지점": "9", "반복 상한": "없음(DB 리스트)" }, focusRank: 109 }),
        issue({ ruleId: "L002", location: "A.Save", facts: { "커밋 지점": "1", "반복 상한": "없음(DB 리스트)" }, focusRank: 101 }),
        issue({ ruleId: "L002", location: "B.Reset", facts: { "커밋 지점": "1", "반복 상한": "입력 크기" }, focusRank: 1 }),
        issue({ ruleId: "L002", location: "B.Sync", facts: { "커밋 지점": "1", "반복 상한": "확인 불가" }, focusRank: 1 }),
    ];
    const out = renderRuleSection("L002", issues, graph);

    const tables = tableColumnCounts(out);
    assert(tables.length === 1, "표가 하나 나온다");
    assert(allEqual(tables[0]), `표의 모든 줄이 같은 칸 수 (실제: ${tables[0]})`);
    assert(tables[0][0] === 5, `열은 위치 + 사실 2개 + 진입 + 점수 = 5개 (실제: ${tables[0][0]})`);
    assert(out.includes("| 위치 | 커밋 지점 | 반복 상한 | 진입 | 점수 |"), "사실 키가 열 이름이 된다");
    assert(out.split("\n").filter((l) => l.startsWith("|")).length === 6, "헤더+구분선+4행");
    assert(out.includes("반복 상한이 없는 것 먼저"), "규칙의 정렬 축을 밝힌다");
    // 제목만 보고 무슨 규칙인지 알 수 있어야 한다. ID만으로는 매번 본문을 읽어야 한다.
    assert(out.startsWith("### 🔴 [L002] 루프 내 커밋 — 4건"), "제목에 ID와 규칙 이름을 함께 쓴다");
    assert(
        out.indexOf("**🔴 `A.Mig`**") < out.indexOf("**🔴 `A.Save`**"),
        "focusRank 높은 것이 먼저 볼 것에 온다"
    );
    assert(!out.includes("**🔴 `B.Reset`**"), "focus 밖의 건은 근거를 펼치지 않는다");
    assert(out.includes("`B.Reset`"), "focus 밖의 건도 표에는 들어간다");
    // 조치 문구는 규칙 헤더에 한 번만. 실측 리포트에서 TOP 10 안에 8번 반복됐던 문제.
    const recCount = out.split("리스트에 담아 루프 종료 후 한 번에 Commit").length - 1;
    assert(recCount === 1, `조치 문구는 섹션당 한 번만 (실제 ${recCount}번)`);
}

// ── 2. 사실 열이 아예 없는 규칙 ───────────────────────────────────────
console.log("\n🧪 규칙별 섹션 — 사실 열이 없는 규칙(P002)\n");
{
    const graph = fakeGraph([]);
    const issues: ReviewIssue[] = ["P.a", "P.b", "P.c", "P.d"].map((loc) =>
        issue({ ruleId: "P002", location: loc, category: "Security" })
    );
    const out = renderRuleSection("P002", issues, graph);

    const tables = tableColumnCounts(out);
    assert(tables.length === 1, "표가 하나 나온다");
    assert(allEqual(tables[0]), `사실이 없어도 칸 수가 일정하다 (실제: ${tables[0]})`);
    assert(tables[0][0] === 3, `열은 위치 + 진입 + 점수 = 3개 (실제: ${tables[0][0]})`);
    assert(out.includes("| 위치 | 진입 | 점수 |"), "빈 사실 키가 빈 열을 만들지 않는다");
    // 페이지는 flow가 아니라 reach가 없다. 표가 깨지면 안 된다.
    assert(out.includes("| - | 50 |"), "reach 없는 위치는 진입이 '-'");
}

// ── 3. 사실 키가 건마다 다를 때 ───────────────────────────────────────
console.log("\n🧪 규칙별 섹션 — 건마다 사실 키가 다를 때\n");
{
    const graph = fakeGraph([["X.a", "X", "Page"]]);
    const issues: ReviewIssue[] = [
        issue({ ruleId: "L003", location: "X.a", facts: { "액션 수": "36" } }),
        issue({ ruleId: "L003", location: "X.b", facts: { "액션 수": "30", "하위 flow": "2" } }),
        issue({ ruleId: "L003", location: "X.c", facts: { 엔티티: "5" } }),
        issue({ ruleId: "L003", location: "X.d" }),
    ];
    const out = renderRuleSection("L003", issues, graph);

    const tables = tableColumnCounts(out);
    assert(allEqual(tables[0]), `키가 제각각이어도 칸 수가 일정하다 (실제: ${tables[0]})`);
    assert(tables[0][0] === 6, `열은 위치 + 사실 합집합 3개 + 진입 + 점수 = 6개 (실제: ${tables[0][0]})`);
    assert(out.includes("| 위치 | 액션 수 | 하위 flow | 엔티티 | 진입 | 점수 |"), "사실 키의 합집합이 열이 된다");
    assert(out.includes("| 🔴 `X.d` | - | - | - | - | 50 |"), "없는 사실은 '-'로 채운다");
}

// ── 4. 건수가 적으면 표를 만들지 않는다 ───────────────────────────────
console.log("\n🧪 규칙별 섹션 — 건수가 적을 때\n");
{
    const graph = fakeGraph([["Y.a", "Y", "Page"]]);
    const out = renderRuleSection(
        "L005",
        [issue({ ruleId: "L005", location: "Y.a", facts: { "중첩 깊이": "3단" } })],
        graph
    );
    assert(tableColumnCounts(out).length === 0, "1건이면 표를 만들지 않는다");
    assert(out.includes("**🔴 `Y.a`**"), "대신 근거를 펼친다");
    assert(!out.includes("먼저 볼 것"), "고를 게 없으면 '먼저 볼 것'도 없다");
}

// ── 5. 표에만 실린 건의 예외 조치 ─────────────────────────────────────
console.log("\n🧪 규칙별 섹션 — 표에만 실린 건의 조치가 다를 때\n");
{
    const graph = fakeGraph([]);
    const issues: ReviewIssue[] = ["a", "b", "c", "d"].map((n, idx) =>
        issue({
            ruleId: "L002",
            location: `Z.${n}`,
            focusRank: 10 - idx,
            recommendation: idx === 3 ? "이 건만 다른 조치" : undefined,
        })
    );
    const out = renderRuleSection("L002", issues, graph);
    assert(out.includes("일부 건은 조치가 다릅니다"), "표에만 실린 예외 조치를 알린다");
    assert(out.includes("`Z.d` — 이 건만 다른 조치"), "어느 건인지 지목한다");
}

// ── 6. 여러 규칙에 동시에 걸린 곳 ─────────────────────────────────────
console.log("\n🧪 여러 규칙에 동시에 걸린 곳\n");
{
    const graph = fakeGraph([
        ["A.Mig", "A", "Navigation"],
        ["A.Solo", "A", "Page"],
    ]);
    const issues: ReviewIssue[] = [
        issue({ ruleId: "L005", location: "A.Mig", score: 65 }),
        issue({ ruleId: "L002", location: "A.Mig", score: 59 }),
        issue({ ruleId: "L001", location: "A.Mig", score: 52 }),
        // 같은 규칙이 같은 위치에 두 번 — 이건 "복합"이 아니다.
        issue({ ruleId: "L002", location: "A.Solo", score: 59 }),
        issue({ ruleId: "L002", location: "A.Solo", score: 59 }),
    ];
    const out = renderComposite(issues, graph);
    assert(out.includes("[L001] + [L002] + [L005]"), "걸린 규칙을 모두 나열한다");
    assert(out.includes("| 176 |"), "점수를 합산한다 (65+59+52)");
    assert(!out.includes("A.Solo"), "같은 규칙이 두 번 걸린 것은 복합이 아니다");
    assert(allEqual(tableColumnCounts(out)[0]), "표 칸 수가 일정하다");
}
{
    const out = renderComposite([issue({ ruleId: "L002", location: "A.a" })], fakeGraph([]));
    assert(out.includes("여러 규칙에 동시에 걸린 곳은 없습니다"), "없으면 빈 표 대신 문장을 낸다");
}

// ── 7. 인덱스 섹션 하한 ───────────────────────────────────────────────
console.log("\n🧪 인덱스 섹션 — 조회 1회짜리를 걷어낸다\n");
{
    const keys = new Map<string, Map<string, any>>([
        [
            "M.Hot",
            new Map([
                ["inLoopAttr", usage(3, 3, 0, true)],
                ["hotAttr", usage(3, 0, 2, true)],
                ["twiceAttr", usage(2, 0, 0)],
                ["onceAttr", usage(1, 0, 0)],
            ]),
        ],
        ["M.Cold", new Map([["onlyOnce", usage(1, 0, 0)]])],
    ]);
    const graph = fakeGraph([], keys);
    const issues: ReviewIssue[] = [
        issue({ ruleId: "D003", location: "M.Hot", focusRank: 300 }),
        issue({ ruleId: "D003", location: "M.Cold", focusRank: 1 }),
    ];
    const out = renderIndexPlan(issues, graph);

    assert(out.includes("`inLoopAttr`"), "루프 안에서 쓰이는 키는 올린다");
    assert(out.includes("`hotAttr`"), "무인/외부에서 쓰이는 키는 올린다");
    assert(out.includes("`twiceAttr`"), "조회 2회 이상인 키는 올린다");
    assert(!out.includes("| `onceAttr` |"), "조회 1회·루프 밖 키는 표에서 뺀다");
    assert(out.includes("우선순위에서 제외했습니다: `onceAttr`"), "뺀 키를 밝힌다");
    assert(!out.includes("### `M.Cold`"), "전부 1회짜리인 엔티티는 섹션을 만들지 않는다");
    assert(out.includes("`M.Cold` (1개)"), "생략한 엔티티를 밝힌다");
    for (const t of tableColumnCounts(out)) assert(allEqual(t), `표 칸 수가 일정하다 (${t})`);
}

// ── 8. 모듈별 건강도 — 규모 보정 ──────────────────────────────────────
console.log("\n🧪 모듈별 건강도 — flow당 점수로 정렬\n");
{
    // 큰 모듈이 누적 점수는 높지만 밀도는 낮은 상황. 실측(ShipmentTracking vs Warehouse)과 같은 모양.
    const flows: [string, string, string | null][] = [];
    for (let i = 0; i < 50; i++) flows.push([`Big.f${i}`, "Big", "Page"]);
    for (let i = 0; i < 5; i++) flows.push([`Small.f${i}`, "Small", "Page"]);
    const graph = fakeGraph(flows);

    const issues: ReviewIssue[] = [
        ...Array.from({ length: 10 }, (_, i) => issue({ ruleId: "L002", location: `Big.f${i}`, score: 50 })),
        ...Array.from({ length: 3 }, (_, i) => issue({ ruleId: "L002", location: `Small.f${i}`, score: 50 })),
    ];
    const out = renderModuleHealth(issues, graph);

    assert(out.includes("flow당"), "flow당 열이 있다");
    assert(out.indexOf("| Small |") < out.indexOf("| Big |"), "누적 점수(500>150)가 아니라 밀도(30>10) 순");
    assert(out.includes("| Small | 5 | 3 | 0 | 150 | 30.0 |"), "밀도를 소수 한 자리로");
    assert(allEqual(tableColumnCounts(out)[0]), "표 칸 수가 일정하다");
}

// ── 9. 반복 상한 판정 ─────────────────────────────────────────────────
console.log("\n🧪 반복 상한 판정 — L001·L002가 공유하는 축\n");
{
    assert(boundLabel("param", 1, true) === "입력 크기", "파라미터에서 온 리스트는 입력 크기로 묶인다");
    assert(boundLabel("memory", 1, true) === "입력 크기", "메모리 리스트도 마찬가지");
    assert(boundLabel("db", 1, true) === "없음(DB 리스트)", "DB 조회 결과를 돌면 상한이 없다");
    assert(boundLabel("param", 2, true) === "없음(중첩)", "중첩되면 입력 크기여도 곱해진다");
    // fail closed — 모르면 "상한 있음"으로 봐주지 않는다. 봐주면 진짜 병목이 조용히 내려간다.
    assert(boundLabel("unknown", 1, true) === "확인 불가", "출처 불명은 단정하지 않는다");
    assert(boundLabel("param", 1, false) === "확인 불가", "출처 해석 자체가 실패하면 단정하지 않는다");

    assert(worstBound(["입력 크기", "없음(DB 리스트)"]) === "없음(DB 리스트)", "하나라도 상한이 없으면 그게 이 flow의 성격");
    assert(worstBound(["입력 크기", "확인 불가"]) === "확인 불가", "상한 없음이 없으면 확인 불가가 우선");
    assert(worstBound(["입력 크기", "입력 크기"]) === "입력 크기", "전부 묶여 있으면 묶여 있는 것");
    assert(worstBound([]) === "확인 불가", "판정할 게 없으면 확인 불가");
}

// ── 10. 규칙 전량 점검 ────────────────────────────────────────────────
//
// 0건 규칙이 리포트에서 빠지면, 읽는 사람은 "위반이 없어서"인지 "룰이 죽어서 탐지를
// 못 한 것"인지 구분할 수 없다. 버그 #0(instanceof undefined가 삼켜져 전 룰이 0건)이
// 정확히 그렇게 숨었다. 카탈로그 전량이 항상 출력되는지 자동으로 확인한다.
console.log("\n🧪 규칙 전량 점검 — 0건도 반드시 나온다\n");
{
    const ids = catalogRuleIds();
    assert(ids.length === 17, `카탈로그가 17종 (실제: ${ids.length})`);
    assert(ids[0] === "D001" && ids[ids.length - 1] === "P002", "ID 순으로 정렬된다");

    const byRule = new Map<string, ReviewIssue[]>([
        ["L002", [issue({ ruleId: "L002", location: "A.Mig", score: 59 })]],
        [
            "D005",
            [issue({ ruleId: "D005", location: "A.Acc", severity: "Warning", score: 18 })],
        ],
    ]);
    const board = renderRuleScoreboard(ids, byRule);

    const tables = tableColumnCounts(board);
    assert(tables.length === 1, "점검 현황이 표 하나로 나온다");
    assert(allEqual(tables[0]), `표의 모든 줄이 같은 칸 수 (실제: ${[...new Set(tables[0])]})`);
    assert(tables[0].length === 17 + 2, `헤더+구분선+17행 (실제: ${tables[0].length})`);
    for (const id of ids) assert(board.includes(`[${id}]`), `${id}이(가) 표에 있다`);

    assert(/\| \[L002\] \|.*\| 1 \| 1 \| 59 \| 🔴 조치 필요 \|/.test(board), "위반 있는 규칙은 건수·최고 점수를 보여준다");
    assert(/\| \[L001\] \|.*\| 0 \| - \| - \| ✅ 위반 없음 \|/.test(board), "0건 규칙은 위반 없음으로 표기된다");
    // D005는 목표가 "검토 필요"라 0건이어도 Pass라고 단정하지 않는다. KPI와 같은 판단.
    assert(/\| \[D005\] \|.*\| ℹ️ 검토 필요 \|/.test(board), "판정 규칙이 아닌 것은 Pass라고 말하지 않는다");
    assert(/\| \[D006\] \|.*\| 0 \| - \| - \| ✅ 해당 없음 \|/.test(board), "검토형 규칙의 0건은 '해당 없음'");

    const clean = renderCleanRule("L001");
    assert(clean.startsWith("### ✅ [L001] 루프 내 DB 조회 (N+1) — 0건"), "0건 섹션 제목도 ID·이름을 함께 쓴다");
    assert(clean.includes("걸린 곳이 없습니다"), "0건 섹션이 무엇을 뜻하는지 밝힌다");
    assert(tableColumnCounts(clean).length === 0, "0건 섹션은 빈 표를 만들지 않는다");
}

// ── 11. D005 — 열이 5개로 가장 많은 규칙 ──────────────────────────────
//
// D005는 사실 열이 5개(열린 대상·허용·열린 규칙·사용 flow·역할)로 규칙 중 가장 많고,
// 역할 이름에 `|`가 섞일 여지도 있다. 열이 어긋나면 54건짜리 표가 통째로 깨지는데
// 깨진 표는 "이슈가 없다"처럼 보인다.
console.log("\n🧪 규칙별 섹션 — 열이 가장 많은 규칙(D005)\n");
{
    const graph = fakeGraph([]);
    const facts = (tier: string, grant: string, open: string, flows: string, roles: string) => ({
        "열린 대상": tier,
        허용: grant,
        "열린 규칙": open,
        "사용 flow": flows,
        역할: roles,
    });
    const issues: ReviewIssue[] = [
        issue({ ruleId: "D005", location: "LoginAsset.Account", severity: "Error", score: 35, focusRank: 31330, facts: facts("익명", "읽기+쓰기", "2", "33", "LoginAsset.Anonymous, LoginAsset.User") }),
        issue({ ruleId: "D005", location: "ShipmentTracking.ShipmentCase", severity: "Warning", score: 18, focusRank: 20190, facts: facts("일반 사용자", "읽기", "1", "19", "ShipmentTracking.User") }),
        issue({ ruleId: "D005", location: "LoginAsset.OrganizationUnit", severity: "Warning", score: 9, focusRank: 10121, facts: facts("관리자 전용", "읽기", "1", "12", "LoginAsset.Administrator") }),
        issue({ ruleId: "D005", location: "Warehouse.Warehouse", severity: "Warning", score: 18, focusRank: 20091, facts: facts("판정 불가", "읽기", "1", "9", "미지정") }),
    ];
    const out = renderRuleSection("D005", issues, graph);

    const tables = tableColumnCounts(out);
    assert(tables.length === 1, "표가 하나 나온다");
    assert(allEqual(tables[0]), `표의 모든 줄이 같은 칸 수 (실제: ${[...new Set(tables[0])]})`);
    assert(tables[0][0] === 8, `열은 위치 + 사실 5개 + 진입 + 점수 = 8개 (실제: ${tables[0][0]})`);
    assert(
        out.includes("| 위치 | 열린 대상 | 허용 | 열린 규칙 | 사실 flow | 진입 | 점수 |") === false,
        "열 이름이 사실 키와 정확히 일치한다(오타 감지용 음성 검사)"
    );
    assert(out.includes("| 위치 | 열린 대상 | 허용 | 열린 규칙 | 사용 flow | 역할 | 진입 | 점수 |"), "사실 키가 열 이름이 된다");
    // 등급이 정렬을 지배해야 한다. 익명 건이 관리자 전용 건보다 위에 있어야 의미가 있다.
    assert(
        out.indexOf("LoginAsset.Account") < out.indexOf("LoginAsset.OrganizationUnit"),
        "익명 노출이 관리자 전용보다 먼저 온다"
    );
    assert(out.includes("열린 대상 등급(익명 → 일반 → 관리자 전용)"), "규칙의 정렬 축을 밝힌다");
}

console.log(failures === 0 ? "\n✅ 전부 통과" : `\n❌ ${failures}건 실패`);
process.exit(failures === 0 ? 0 : 1);
