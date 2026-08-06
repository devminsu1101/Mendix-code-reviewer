// src/blame.test.ts
//
// blame 이분 탐색의 정확성 검증. 합성 이력으로 돌리므로 자격증명도 네트워크도 필요 없다.
//
// 왜 테스트가 있나: 이 로직이 틀리면 **엉뚱한 사람에게 책임이 찍힌다.**
// 그리고 실제 API로 확인하려면 한 번에 20분이 든다. 여기서 먼저 걸러야 한다.
import { bisectIntroduction, summarizeCommitOrigin } from "./analyzer/blame.js";

let failures = 0;
const assert = (cond: boolean, msg: string) => {
    console.log(`  ${cond ? "✅" : "❌"} ${msg}`);
    if (!cond) failures++;
};

/**
 * 합성 시나리오: 커밋 N개, 각 이슈는 truth[key] 번째 커밋에서 도입되어 이후 계속 존재.
 * bisect가 정확히 그 인덱스를 찾아내는지 확인한다.
 */
async function runCase(name: string, commitCount: number, truth: Record<string, number>) {
    const items = Object.keys(truth);
    let evaluations = 0;
    const evaluated: number[] = [];

    const result = await bisectIntroduction(
        items,
        (k) => k,
        commitCount,
        async (index, group) => {
            evaluations++;
            evaluated.push(index);
            // 그 시점에 존재하는 것 = 도입 인덱스가 index 이하인 것
            return new Set(group.filter((k) => truth[k] <= index));
        },
        100
    );

    let allCorrect = true;
    for (const [key, expected] of Object.entries(truth)) {
        const got = result.get(key);
        const expectedStatus = expected === 0 ? "from-start" : "found";
        if (got?.index !== expected || got?.status !== expectedStatus) {
            allCorrect = false;
            console.log(
                `     ✗ ${key}: 기대 index=${expected}/${expectedStatus}, 실제 index=${got?.index}/${got?.status}`
            );
        }
    }
    assert(allCorrect, `${name} — 도입 커밋 정확 (조회 ${evaluations}회, 커밋 ${commitCount}개)`);
    // 탐색 범위를 벗어난 인덱스를 조회하지 않았는지
    assert(
        evaluated.every((i) => i >= 0 && i < commitCount),
        `${name} — 조회 인덱스가 유효 범위 내`
    );
    return evaluations;
}

console.log("── bisect 정확성 ──");

// 1. 실제 상황과 동일: 107커밋, 10개 이슈가 각기 다른 시점에 도입
await runCase("서로 다른 시점 10건", 107, {
    a: 3, b: 17, c: 42, d: 42, e: 58, f: 71, g: 88, h: 95, i: 100, j: 106,
});

// 2. 전부 같은 커밋에서 도입 (같은 사람이 한 번에 만든 경우)
const sameCommitLookups = await runCase("동일 커밋 10건", 107, {
    a: 55, b: 55, c: 55, d: 55, e: 55, f: 55, g: 55, h: 55, i: 55, j: 55,
});
assert(
    sameCommitLookups <= 8,
    `동일 커밋이면 조회가 log2(107)≈7회 수준으로 수렴 (실제 ${sameCommitLookups}회)`
);

// 3. 경계: 첫 커밋부터 존재 / 마지막 커밋에서 도입
await runCase("경계값", 107, { first: 0, last: 106 });

// 4. 커밋이 1개뿐
await runCase("커밋 1개", 1, { only: 0 });

// 5. 커밋 2개
await runCase("커밋 2개", 2, { old: 0, recent: 1 });

console.log("\n── 조회 상한 동작 ──");
{
    const truth: Record<string, number> = {};
    for (let i = 0; i < 20; i++) truth[`x${i}`] = i * 5;
    let evaluations = 0;
    const result = await bisectIntroduction(
        Object.keys(truth),
        (k) => k,
        107,
        async (index, group) => {
            evaluations++;
            return new Set(group.filter((k) => truth[k] <= index));
        },
        5 // 일부러 낮게
    );
    assert(evaluations <= 5, `상한(5회)을 넘겨 조회하지 않음 (실제 ${evaluations}회)`);
    const errored = [...result.values()].filter((r) => r.status === "error").length;
    assert(errored > 0, `상한 도달 시 미확정 건이 error로 표시됨 (${errored}건)`);
    assert(
        result.size === Object.keys(truth).length,
        `상한에 걸려도 모든 항목이 결과에 남음 (조용히 사라지지 않음)`
    );
}

console.log("\n── 모델 오픈 실패 시 오귀속 방지 ──");
{
    // 특정 커밋 조회가 실패해 빈 집합을 돌려주는 상황.
    // 실제 도입 시점보다 **과거로** 귀속되면 안 된다 (엉뚱한 사람이 찍힘).
    const truth = { a: 50 };
    const failIndex = 53;
    const result = await bisectIntroduction(
        ["a"],
        (k) => k,
        107,
        async (index, group) => {
            if (index === failIndex) return new Set<string>(); // 조회 실패 시뮬레이션
            return new Set(group.filter((k) => truth[k as keyof typeof truth] <= index));
        },
        100
    );
    const got = result.get("a")!;
    assert(
        got.index !== null && got.index >= truth.a,
        `조회 실패가 있어도 실제 도입 시점보다 과거로 귀속되지 않음 (기대 ≥${truth.a}, 실제 ${got.index})`
    );
}

console.log("\n── 머지 커밋 판별 (실제 이 저장소의 메시지들) ──");
{
    const cases: Array<[string, boolean, string | null]> = [
        ["Merge commit", true, null],
        ["Merge commit from_donggyun-clean", true, "donggyun-clean"],
        ["Merge commit / donggyun -> wonjin", true, "donggyun"],
        ["Merge branch 'feature/x' into main", true, "feature/x"],
        ["Fix. 라우팅 로직 예외처리", false, null],
        ["002 로직  수정", false, null],
    ];
    for (const [msg, expectMerge, expectBranch] of cases) {
        const got = summarizeCommitOrigin(msg);
        assert(
            got.isMerge === expectMerge && got.sourceBranch === expectBranch,
            `"${msg}" → merge=${got.isMerge}, branch=${got.sourceBranch ?? "null"}`
        );
    }
}

console.log(`\n${failures === 0 ? "✅ 전부 통과" : `❌ ${failures}건 실패`}`);
process.exit(failures === 0 ? 0 : 1);
