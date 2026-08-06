// src/analyzer/domain.ts
import { IModel, domainmodels, security } from "mendixmodelsdk";
import { ReviewIssue } from "./issue.js";
import { MendixRules } from "./rules.js";
import { ModelGraph } from "./graph.js";

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

function isPersistable(entity: domainmodels.Entity): boolean {
    const gen = entity.generalization;
    if (gen instanceof domainmodels.NoGeneralization) return gen.persistable;
    // 상속 엔티티는 부모의 persistable을 따른다. 여기서는 판단하지 않는다.
    return true;
}

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
        scoreOverride?: number
    ) => {
        const rule = MendixRules[ruleKey];
        issues.push({
            category: ruleKey.includes("ACCESS") ? "Security" : "Domain",
            ruleId: rule.id,
            location,
            message,
            recommendation: rule.recommendation,
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

            // D003 — 인덱스 누락
            if (entity.attributes.length > 20 && entity.indexes.length === 0) {
                add(
                    "MISSING_INDEX",
                    qName,
                    `속성 ${entity.attributes.length}개인 대형 엔티티에 인덱스가 없습니다.`,
                    "Warning",
                    [usageLine]
                );
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
