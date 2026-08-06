// src/analyzer/domain.ts
import { IModel, domainmodels, security } from "mendixmodelsdk";
import { ReviewIssue } from "./issue.js";
import { MendixRules } from "./rules.js";
import { isPersistableEntity, ModelGraph } from "./graph.js";

const SYSTEM_MODULES = new Set(["System", "Administration"]);

/** 보안 검사는 프로젝트 보안 수준에 따라 의미가 달라진다. 먼저 읽어 둔다. */
async function readSecurityLevel(model: IModel): Promise<security.SecurityLevel | null> {
    for (const proxy of model.allProjectSecurities()) {
        try {
            const sec = await proxy.load();
            return sec.securityLevel;
        } catch {
            /* 무시 */
        }
    }
    return null;
}

/** graph.ts와 판정이 갈리면 D003과 L001이 서로 다른 얘기를 하게 된다. 한 곳에서 가져온다. */
const isPersistable = isPersistableEntity;

export async function analyzeDomain(model: IModel, graph: ModelGraph): Promise<ReviewIssue[]> {
    console.log("🔍 [Domain] 데이터 구조·보안·의존성 분석 시작...");

    const securityLevel = await readSecurityLevel(model);
    const securityIsOn = securityLevel !== security.SecurityLevel.CheckNothing;
    const securityNote = `프로젝트 보안 수준: ${securityLevel?.name ?? "확인 불가"}`;

    const issues: ReviewIssue[] = [];
    const dependencyMap: Record<string, Record<string, number>> = {};

    const add = (
        ruleKey: keyof typeof MendixRules,
        location: string,
        message: string,
        severity: "Warning" | "Error",
        evidence: string[],
        scoreOverride?: number,
        /** 룰 기본 권장문구가 이 상황에 안 맞을 때 덮어쓴다. */
        recommendationOverride?: string
    ) => {
        const rule = MendixRules[ruleKey];
        issues.push({
            category: ruleKey.includes("ACCESS") ? "Security" : "Domain",
            ruleId: rule.id,
            location,
            message,
            recommendation: recommendationOverride ?? rule.recommendation,
            severity,
            evidence,
            score: scoreOverride ?? rule.baseScore,
        });
    };

    for (const dmProxy of model.allDomainModels()) {
        const moduleName = dmProxy.containerAsModule.name;
        // 시스템 모듈과 마켓플레이스·테마 모듈은 지적 대상이 아니다.
        if (SYSTEM_MODULES.has(moduleName) || graph.excludedModules.has(moduleName)) continue;

        let dm: domainmodels.DomainModel;
        try {
            dm = await dmProxy.load();
        } catch (err) {
            console.error(`❌ [Domain] ${moduleName} 로드 실패: ${(err as Error).message}`);
            continue;
        }

        // 모듈 간 결합도
        for (const assoc of dm.associations) {
            try {
                const parentModule = assoc.parent.containerAsDomainModel.containerAsModule.name;
                const childModule = assoc.child.containerAsDomainModel.containerAsModule.name;
                if (parentModule === childModule) continue;
                dependencyMap[parentModule] ??= {};
                dependencyMap[parentModule][childModule] =
                    (dependencyMap[parentModule][childModule] || 0) + 1;
            } catch {
                /* 참조가 깨진 association은 건너뛴다 */
            }
        }

        for (const entity of dm.entities) {
            const qName = `${moduleName}.${entity.name}`;
            const usage = graph.entityUsage.get(qName);
            const touchCount =
                (usage?.readBy.size ?? 0) + (usage?.writtenBy.size ?? 0);
            const usageLine = usage
                ? `조회 ${usage.readBy.size}개 flow / 변경 ${usage.writtenBy.size}개 flow`
                : "이 엔티티를 직접 조회·변경하는 flow 없음";

            // D001 — 관계 과다
            const relatedCount = dm.associations.filter(
                (a) => a.parent?.name === entity.name || a.child?.name === entity.name
            ).length;
            if (relatedCount > 5) {
                add(
                    "DATA_SPAGHETTI",
                    qName,
                    `연관관계가 ${relatedCount}개입니다.`,
                    "Warning",
                    [usageLine]
                );
            }

            // D002 — NP_ 접두사인데 persistable
            if (entity.name.startsWith("NP_") && isPersistable(entity)) {
                add(
                    "NP_PERSISTABLE_ERROR",
                    qName,
                    `Non-Persistable 명명 규칙인데 Persistable로 설정되어 있습니다.`,
                    "Error",
                    [usageLine]
                );
            }

            // D003 — 조회 키 인덱스 누락
            //
            // 예전 기준은 "속성 20개 초과 + 인덱스 0개"라는 대리 지표였다. 그래서
            // (1) 비영속 엔티티까지 걸렸고 (2) **어느 속성에 걸라는 말을 못 했다.**
            // 이제 실제 XPath에서 뽑은 조회 키를 근거로 지목한다.
            const indexInfo = graph.entityIndexes.get(qName);
            const queryKeys = graph.entityQueryKeys.get(qName);
            if (isPersistable(entity) && queryKeys && queryKeys.size > 0) {
                // leftmost prefix: 복합 인덱스의 2번째 이후 속성은 단독 조회를 받쳐주지 않는다.
                const covered = indexInfo?.leadingAttrs ?? new Set<string>();
                const uncovered = [...queryKeys.entries()]
                    .filter(([attr]) => !covered.has(attr))
                    .sort(
                        (a, b) =>
                            b[1].inLoop - a[1].inLoop ||
                            b[1].hotFlows.size - a[1].hotFlows.size ||
                            b[1].total - a[1].total ||
                            a[0].localeCompare(b[0])
                    );

                if (uncovered.length > 0) {
                    const inLoop = uncovered.reduce((sum, [, u]) => sum + u.inLoop, 0);
                    const hotFlows = new Set(
                        uncovered.flatMap(([, u]) => [...u.hotFlows])
                    );
                    const orCombined = uncovered.some(([, u]) => u.orCombined);

                    const detail = uncovered
                        .slice(0, 6)
                        .map(([attr, u]) => {
                            const parts = [`${u.total}곳`];
                            if (u.inLoop > 0) parts.push(`루프 내 ${u.inLoop}곳`);
                            if (u.hotFlows.size > 0) parts.push(`무인/외부 ${u.hotFlows.size}곳`);
                            return `${attr}(${parts.join(", ")})`;
                        })
                        .join(", ");

                    const evidence = [
                        indexInfo && indexInfo.count > 0
                            ? `인덱스 ${indexInfo.count}개 있음 — 선두 속성: ${[...indexInfo.leadingAttrs].join(", ") || "(없음)"}`
                            : `이 엔티티에 인덱스 정의가 없습니다.`,
                        usageLine,
                    ];
                    if (inLoop > 0) {
                        evidence.push(
                            `루프 안에서 쓰이는 조회 키가 있습니다 — 인덱스 부재 비용이 반복 횟수만큼 곱해집니다. (L001 참조)`
                        );
                    }
                    if (hotFlows.size > 0) {
                        evidence.push(
                            `무인/외부 진입 경로 flow: ${[...hotFlows].slice(0, 3).join(", ")}`
                        );
                    }

                    add(
                        "MISSING_INDEX",
                        qName,
                        `조회 조건으로 쓰이는 속성 ${uncovered.length}개가 인덱스로 커버되지 않습니다: ${detail}${uncovered.length > 6 ? " 외" : ""}`,
                        // 루프 안이거나 무인/외부 경로면 비용이 반복·빈도만큼 곱해진다.
                        inLoop > 0 || hotFlows.size > 0 ? "Error" : "Warning",
                        evidence,
                        MendixRules.MISSING_INDEX.baseScore + inLoop * 5 + hotFlows.size * 3,
                        orCombined
                            ? "조회 조건이 `or`로 묶여 있습니다. 복합 인덱스는 `or`에 쓰이지 않으므로 " +
                                  "**각 속성에 단일 컬럼 인덱스를 따로** 만드세요. " +
                                  "String 속성은 Max length가 Unlimited면 인덱스를 걸 수 없습니다."
                            : "엔티티 Properties → Indexes 탭에서 위 속성에 인덱스를 추가하세요. " +
                                  "여러 속성이 항상 함께 조건에 쓰이면 선택도 높은 것을 앞에 둔 복합 인덱스가 낫습니다(leftmost prefix). " +
                                  "String 속성은 Max length가 Unlimited면 인덱스를 걸 수 없습니다."
                    );
                }
            }

            // D004/D005 — 접근 규칙 (보안이 켜져 있을 때만 의미 있음)
            if (securityIsOn && isPersistable(entity)) {
                if (entity.accessRules.length === 0) {
                    add(
                        "NO_ACCESS_RULE",
                        qName,
                        `Persistable 엔티티에 접근 규칙이 하나도 없습니다.`,
                        "Error",
                        [securityNote, usageLine]
                    );
                } else {
                    const openReads = entity.accessRules.filter(
                        (rule) =>
                            rule.defaultMemberAccessRights !== domainmodels.MemberAccessRights.None &&
                            (!rule.xPathConstraint || rule.xPathConstraint.trim() === "")
                    );
                    if (openReads.length > 0) {
                        const roles = openReads
                            .flatMap((r) => r.moduleRolesQualifiedNames ?? [])
                            .slice(0, 5);
                        add(
                            "UNCONSTRAINED_ACCESS",
                            qName,
                            `XPath 제약 없는 접근 규칙이 ${openReads.length}건 있습니다. 해당 역할은 전체 행을 봅니다.`,
                            "Warning",
                            [
                                securityNote,
                                roles.length > 0 ? `대상 역할: ${roles.join(", ")}` : "역할 미지정",
                                usageLine,
                            ]
                        );
                    }
                }
            }

            // D006 — 파급 반경이 큰 엔티티
            if (touchCount >= 15) {
                add(
                    "HOT_ENTITY",
                    qName,
                    `${touchCount}개 flow가 이 엔티티를 직접 다룹니다. 스키마 변경 시 파급 반경이 큽니다.`,
                    "Warning",
                    [
                        usageLine,
                        `주요 사용처: ${[...(usage?.readBy ?? [])].slice(0, 5).join(", ")}`,
                    ],
                    MendixRules.HOT_ENTITY.baseScore + Math.floor(touchCount / 5)
                );
            }
        }
    }

    // D007 — 모듈 간 강한 결합
    for (const sourceMod of Object.keys(dependencyMap)) {
        for (const [targetMod, count] of Object.entries(dependencyMap[sourceMod])) {
            if (count < 3) continue;
            add(
                "STRONG_COUPLING",
                `${sourceMod} → ${targetMod}`,
                `모듈 간 엔티티 참조가 ${count}건입니다.`,
                "Warning",
                [`'${sourceMod}'이(가) '${targetMod}'의 데이터 구조에 직접 의존합니다.`],
                MendixRules.STRONG_COUPLING.baseScore + count
            );
        }
    }

    console.log(`✅ [Domain] 완료 (이슈 ${issues.length}건)`);
    return issues;
}
