// src/selfcheck.ts
//
// 분석기가 `instanceof`로 참조하는 SDK 클래스가 실제로 존재하는지 확인한다.
//
// 왜 필요한가: mendixmodelsdk는 메타모델 변경 시 클래스를 **조용히 제거**한다.
// 예전 코드가 `microflows.LoopAction`을 참조하고 있었는데 이 SDK 버전에는 존재하지 않아
// `instanceof undefined`가 TypeError를 던졌고, 그게 try/catch에 삼켜지면서
// 루프·복잡도·파라미터 룰이 전부 0건으로 나왔다. 리포트는 "이슈 없음"처럼 보였다.
//
// 타입 검사로는 못 잡는다(값이 아니라 타입만 보므로). 런타임 확인이 유일한 방어선이다.

import { microflows, domainmodels, security } from "mendixmodelsdk";

const CLASSES: Record<string, unknown> = {
    "microflows.LoopedActivity": microflows.LoopedActivity,
    "microflows.ActionActivity": microflows.ActionActivity,
    "microflows.MicroflowParameterObject": microflows.MicroflowParameterObject,
    "microflows.MicroflowCallAction": microflows.MicroflowCallAction,
    "microflows.NanoflowCallAction": microflows.NanoflowCallAction,
    "microflows.JavaActionCallAction": microflows.JavaActionCallAction,
    "microflows.RetrieveAction": microflows.RetrieveAction,
    "microflows.DatabaseRetrieveSource": microflows.DatabaseRetrieveSource,
    "microflows.AssociationRetrieveSource": microflows.AssociationRetrieveSource,
    // L001이 "first인가 / 무엇을 반복하는가"를 판정하는 데 쓴다.
    // 사라지면 모든 루프 조회가 조용히 Error로 남는다 — 티가 안 나는 실패다.
    "microflows.ConstantRange": microflows.ConstantRange,
    "microflows.IterableList": microflows.IterableList,
    "microflows.CreateVariableAction": microflows.CreateVariableAction,
    // D003이 인덱스 현황을 읽는 데 쓴다.
    "domainmodels.Index": domainmodels.Index,
    "domainmodels.IndexedAttribute": domainmodels.IndexedAttribute,
    "microflows.CreateObjectAction": microflows.CreateObjectAction,
    "microflows.ChangeObjectAction": microflows.ChangeObjectAction,
    "microflows.CommitAction": microflows.CommitAction,
    "microflows.DeleteAction": microflows.DeleteAction,
    "domainmodels.NoGeneralization": domainmodels.NoGeneralization,
    // D005가 역할 등급을 판정하는 데 쓴다.
    "security.ProjectSecurity": security.ProjectSecurity,
    "security.UserRole": security.UserRole,
    "domainmodels.AccessRule": domainmodels.AccessRule,
    "domainmodels.MemberAccess": domainmodels.MemberAccess,
};

/**
 * 클래스가 아니라 **속성**을 참조하는 곳. 클래스 확인만으로는 못 막는다.
 *
 * 클래스가 사라지면 `instanceof undefined`가 TypeError를 던져 최소한 요란하게 죽지만,
 * 속성이 사라지면 `undefined`가 조용히 흘러간다. D005의 역할 등급 판정이 정확히 그렇다 —
 * `adminUserRoleName`이 `undefined`가 되면 관리자 역할을 못 찾고, 그러면 전 건이
 * "판정 불가"로 떨어지는데 리포트는 멀쩡해 보인다.
 *
 * SDK 생성 클래스는 프로토타입에 getter를 정의하므로 인스턴스 없이 확인할 수 있다.
 */
const PROPERTIES: Array<[label: string, cls: unknown, prop: string]> = [
    ["security.ProjectSecurity", security.ProjectSecurity, "securityLevel"],
    ["security.ProjectSecurity", security.ProjectSecurity, "userRoles"],
    ["security.ProjectSecurity", security.ProjectSecurity, "adminUserRoleName"],
    ["security.ProjectSecurity", security.ProjectSecurity, "enableGuestAccess"],
    ["security.ProjectSecurity", security.ProjectSecurity, "guestUserRoleName"],
    ["security.UserRole", security.UserRole, "moduleRolesQualifiedNames"],
    ["domainmodels.AccessRule", domainmodels.AccessRule, "moduleRolesQualifiedNames"],
    ["domainmodels.AccessRule", domainmodels.AccessRule, "xPathConstraint"],
    ["domainmodels.AccessRule", domainmodels.AccessRule, "defaultMemberAccessRights"],
    ["domainmodels.AccessRule", domainmodels.AccessRule, "memberAccesses"],
    ["domainmodels.AccessRule", domainmodels.AccessRule, "allowDelete"],
    ["domainmodels.MemberAccess", domainmodels.MemberAccess, "accessRights"],
];

const ENUM_VALUES: Record<string, { name: string } | undefined> = {
    "microflows.CommitEnum.No": microflows.CommitEnum?.No,
    "microflows.ErrorHandlingType.CustomWithoutRollBack":
        microflows.ErrorHandlingType?.CustomWithoutRollBack,
    "domainmodels.MemberAccessRights.None": domainmodels.MemberAccessRights?.None,
    // D005가 읽기/쓰기를 가르는 데 쓴다. 사라지면 전부 "읽기"로 뭉개진다.
    "domainmodels.MemberAccessRights.ReadOnly": domainmodels.MemberAccessRights?.ReadOnly,
    "domainmodels.MemberAccessRights.ReadWrite": domainmodels.MemberAccessRights?.ReadWrite,
    "security.SecurityLevel.CheckNothing": security.SecurityLevel?.CheckNothing,
};

export function runSelfCheck(): number {
    let missing = 0;

    for (const [name, value] of Object.entries(CLASSES)) {
        const ok = typeof value === "function";
        if (!ok) missing++;
        console.log(`${ok ? "  ✅" : "  ❌"} ${name}`);
    }

    for (const [name, value] of Object.entries(ENUM_VALUES)) {
        const ok = value !== undefined;
        if (!ok) missing++;
        console.log(`${ok ? "  ✅" : "  ❌"} ${name}${ok ? ` (= ${value!.name})` : ""}`);
    }

    for (const [label, cls, prop] of PROPERTIES) {
        const proto = (cls as { prototype?: object } | undefined)?.prototype;
        const ok = proto !== undefined && Object.getOwnPropertyDescriptor(proto, prop) !== undefined;
        if (!ok) missing++;
        console.log(`${ok ? "  ✅" : "  ❌"} ${label}.${prop}`);
    }

    const total =
        Object.keys(CLASSES).length + Object.keys(ENUM_VALUES).length + PROPERTIES.length;
    if (missing > 0) {
        console.error(
            `\n❌ SDK 참조 ${missing}건이 존재하지 않습니다.\n` +
                `   해당 룰은 조용히 죽습니다. SDK 버전 변경 사항을 확인하세요.`
        );
    } else {
        console.log(`\n✅ 분석기가 참조하는 SDK 심볼 ${total}개 전부 확인됨`);
    }
    return missing;
}

if (process.argv[1]?.endsWith("selfcheck.ts") || process.argv[1]?.endsWith("selfcheck.js")) {
    process.exit(runSelfCheck() === 0 ? 0 : 1);
}
