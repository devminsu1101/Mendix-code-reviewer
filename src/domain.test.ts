// src/domain.test.ts
//
// D005(XPath 제약 없는 접근)의 판정 로직 검증. 모델도 자격증명도 필요 없다.
//
// 왜 테스트가 있나: D005는 실측 161건 리포트에서 54건이 **전부 18점으로 평평**했다.
// 그 안에 `LoginAsset.Account`가 익명 역할에 전체 열람을 준 건(사고)과
// `LoginAsset.OrganizationUnit`이 관리자 역할에만 열린 건(대개 의도)이 같은 점수로 섞여
// 있었다. 등급을 잘못 매기면 사고가 54건 속에 묻히거나, 반대로 의도된 설정이 🔴로 떠서
// 리포트 전체의 신뢰가 깎인다. 어느 쪽이든 조용히 나빠지므로 자동으로 막는다.
import {
    classifyAccessTier,
    accessGrant,
    accessSeverity,
    RoleTiers,
} from "./analyzer/domain.js";

let failures = 0;
const assert = (cond: boolean, msg: string) => {
    console.log(`  ${cond ? "✅" : "❌"} ${msg}`);
    if (!cond) failures++;
};

const tiers = (over: Partial<RoleTiers> = {}): RoleTiers => ({
    admin: new Set(["M.Administrator", "M.RamsesAdmin"]),
    guest: new Set(["M.Anonymous"]),
    resolved: true,
    ...over,
});

// ── 1. 역할 등급 ──────────────────────────────────────────────────────
console.log("\n🧪 D005 역할 등급 — 누구에게 열려 있는가\n");
{
    assert(
        classifyAccessTier(["M.Anonymous", "M.Administrator"], tiers()) === "guest",
        "익명 역할이 하나라도 있으면 익명 (가장 위험한 쪽으로)"
    );
    assert(
        classifyAccessTier(["M.Administrator", "M.RamsesAdmin"], tiers()) === "adminOnly",
        "전부 관리자 역할이면 관리자 전용"
    );
    assert(
        classifyAccessTier(["M.Administrator", "M.User"], tiers()) === "general",
        "관리자가 아닌 역할이 섞이면 일반 사용자"
    );
    assert(classifyAccessTier(["M.User"], tiers()) === "general", "일반 역할만 있으면 일반");

    // fail closed — 모르면 봐주지 않는다. 봐주면 진짜 노출이 조용히 내려간다.
    assert(
        classifyAccessTier([], tiers()) === "unknown",
        "역할이 지정되지 않았으면 단정하지 않는다"
    );
    assert(
        classifyAccessTier(["M.Administrator"], tiers({ resolved: false })) === "unknown",
        "등급 근거를 못 읽었으면 관리자 전용이어도 낮추지 않는다"
    );

    // 게스트 접근이 꺼진 앱에서는 guest 집합이 비어 있다. 익명 판정이 나오면 안 된다.
    assert(
        classifyAccessTier(["M.Anonymous"], tiers({ guest: new Set() })) === "general",
        "게스트 접근이 꺼져 있으면 이름이 Anonymous여도 익명으로 보지 않는다"
    );
}

// ── 2. 허용 범위 ──────────────────────────────────────────────────────
console.log("\n🧪 D005 허용 범위 — 무엇을 허용하는가\n");
{
    const g = (
        defaultRights: "None" | "ReadOnly" | "ReadWrite",
        memberRights: Array<"None" | "ReadOnly" | "ReadWrite"> = [],
        allowDelete = false
    ) => accessGrant({ defaultRights, memberRights, allowDelete });

    assert(g("ReadOnly").grants && !g("ReadOnly").writes, "ReadOnly는 읽기만");
    assert(g("ReadOnly").label === "읽기", "라벨: 읽기");
    assert(g("ReadWrite").writes && g("ReadWrite").label === "읽기+쓰기", "ReadWrite는 쓰기 포함");

    // 기존 구현이 놓치던 경우. 기본값이 None이어도 개별 속성에 권한이 있으면 전체 행이 열린다.
    assert(g("None", ["ReadOnly"]).grants, "기본값 None + 속성 단위 읽기도 열린 것이다");
    assert(g("None", ["ReadWrite"]).writes, "기본값 None + 속성 단위 쓰기도 쓰기다");

    assert(!g("None").grants, "아무 권한도 없으면 열린 것이 아니다");
    assert(!g("None", ["None", "None"]).grants, "속성 전부 None이면 열린 것이 아니다");

    // 삭제는 기존 행 전체가 대상이라 무제약일 때 읽기보다 무겁다.
    assert(g("None", [], true).grants && g("None", [], true).writes, "삭제 허용만으로도 쓰기다");
    assert(g("ReadWrite", [], true).label === "읽기+쓰기+삭제", "라벨에 삭제가 붙는다");
    assert(g("ReadOnly", [], true).label === "읽기+삭제", "읽기+삭제 조합");
}

// ── 3. severity ───────────────────────────────────────────────────────
//
// 실측에서 실제로 틀렸던 지점이다. 처음엔 "일반 사용자 + 쓰기"도 Error로 잡았는데,
// RamsesKR minsu-clean에서 **59건 전부가 `읽기+쓰기+삭제`**여서 전건이 🔴가 됐다.
// 전건이 같은 등급이면 등급이 아니다 — 읽는 사람이 59건을 다시 다 읽어야 한다.
console.log("\n🧪 D005 severity — 등급이 정하고, 쓰기는 순서만 움직인다\n");
{
    assert(accessSeverity("guest") === "Error", "익명 노출은 조치 대상");
    assert(accessSeverity("general") === "Warning", "일반 사용자 노출은 검토 대상");
    assert(accessSeverity("adminOnly") === "Warning", "관리자 전용은 검토 대상");
    assert(accessSeverity("unknown") === "Warning", "판정 불가는 Error로 올리지 않는다");
}

console.log(failures === 0 ? "\n✅ 전부 통과" : `\n❌ ${failures}건 실패`);
process.exit(failures === 0 ? 0 : 1);
