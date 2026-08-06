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
    "microflows.CreateObjectAction": microflows.CreateObjectAction,
    "microflows.ChangeObjectAction": microflows.ChangeObjectAction,
    "microflows.CommitAction": microflows.CommitAction,
    "microflows.DeleteAction": microflows.DeleteAction,
    "domainmodels.NoGeneralization": domainmodels.NoGeneralization,
};

const ENUM_VALUES: Record<string, { name: string } | undefined> = {
    "microflows.CommitEnum.No": microflows.CommitEnum?.No,
    "microflows.ErrorHandlingType.CustomWithoutRollBack":
        microflows.ErrorHandlingType?.CustomWithoutRollBack,
    "domainmodels.MemberAccessRights.None": domainmodels.MemberAccessRights?.None,
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

    if (missing > 0) {
        console.error(
            `\n❌ SDK 참조 ${missing}건이 존재하지 않습니다.\n` +
                `   해당 룰은 조용히 죽습니다. SDK 버전 변경 사항을 확인하세요.`
        );
    } else {
        console.log(`\n✅ 분석기가 참조하는 SDK 심볼 ${Object.keys(CLASSES).length + Object.keys(ENUM_VALUES).length}개 전부 확인됨`);
    }
    return missing;
}

if (process.argv[1]?.endsWith("selfcheck.ts") || process.argv[1]?.endsWith("selfcheck.js")) {
    process.exit(runSelfCheck() === 0 ? 0 : 1);
}
