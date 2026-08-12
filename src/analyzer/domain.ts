// src/analyzer/domain.ts
import { IModel, domainmodels, security } from "mendixmodelsdk";
import { ReviewIssue } from "./issue.js";
import { MendixRules } from "./rules.js";
import { isPersistableEntity, ModelGraph } from "./graph.js";

const SYSTEM_MODULES = new Set(["System", "Administration"]);

// ── 접근 규칙 판정 (D005) ─────────────────────────────────────────────
//
// D005의 핵심은 건수가 아니라 **순서**다. 실측 161건 리포트에서 54건이 전부 18점으로
// 평평했는데, 그 안에는 `LoginAsset.Account`가 익명 역할에 전체 열람을 준 건과
// `LoginAsset.OrganizationUnit`이 관리자 역할에만 열린 건이 같은 점수로 섞여 있었다.
// 앞은 사고고 뒤는 대개 의도다. 둘을 가르지 못하면 54건을 다 읽어야 사고를 찾는다.

/** 이 접근 규칙이 누구에게 열려 있는가. */
export type AccessTier = "guest" | "general" | "adminOnly" | "unknown";

/**
 * 역할 등급 판정의 근거.
 *
 * 역할 **이름**으로 추측하지 않는다. "Administrator"라는 모듈 역할이 실제로 관리자
 * 사용자 역할에 묶여 있는지는 ProjectSecurity가 답을 갖고 있고, 이름 규칙은 앱마다 다르다.
 * 이름 매칭으로 짜면 다른 앱에 붙이는 순간 조용히 틀린다.
 */
export interface RoleTiers {
    /** 관리자 사용자 역할에 묶인 모듈 역할 qName */
    admin: Set<string>;
    /** 익명(게스트) 사용자 역할에 묶인 모듈 역할 qName. 게스트 접근이 꺼져 있으면 비어 있다. */
    guest: Set<string>;
    /** 등급 판정의 근거를 실제로 읽었는가. 못 읽었으면 등급을 낮추지 않는다. */
    resolved: boolean;
}

/**
 * 이 규칙이 열려 있는 대상의 등급. 가장 위험한 쪽으로 판정한다.
 *
 * **fail closed** — 근거를 못 읽었거나 역할이 비어 있으면 `unknown`이고,
 * `unknown`은 점수를 깎지 않는다. 모르면 봐주지 않는 것이 이 도구의 일관된 원칙이다.
 */
export function classifyAccessTier(roleQNames: string[], tiers: RoleTiers): AccessTier {
    if (!tiers.resolved || roleQNames.length === 0) return "unknown";
    if (roleQNames.some((r) => tiers.guest.has(r))) return "guest";
    if (roleQNames.every((r) => tiers.admin.has(r))) return "adminOnly";
    return "general";
}

export type AccessRights = "None" | "ReadOnly" | "ReadWrite";

/**
 * 이 규칙이 실제로 무엇을 허용하는가.
 *
 * 기존 구현은 `defaultMemberAccessRights !== None`만 봤는데, 그러면 **기본값은 None이면서
 * 개별 속성(memberAccesses)에만 권한을 준 규칙**을 통째로 놓친다. 그런 규칙도 XPath 제약이
 * 없으면 똑같이 전체 행이 열린 것이다.
 */
export function accessGrant(input: {
    defaultRights: AccessRights;
    memberRights: AccessRights[];
    allowDelete: boolean;
}): { grants: boolean; writes: boolean; label: string } {
    const all = [input.defaultRights, ...input.memberRights];
    const grants = all.some((r) => r !== "None");
    const canWrite = all.some((r) => r === "ReadWrite");
    const parts: string[] = [];
    if (grants) parts.push("읽기");
    if (canWrite) parts.push("쓰기");
    // 삭제는 기존 행 전체가 대상이라 무제약일 때 읽기보다 무겁다.
    if (input.allowDelete) parts.push("삭제");
    return {
        grants: grants || input.allowDelete,
        writes: canWrite || input.allowDelete,
        label: parts.join("+") || "없음",
    };
}

/**
 * 등급이 severity를 정한다. 쓰기 허용 여부는 **점수와 순서만** 움직인다.
 *
 * 처음엔 "일반 사용자 + 쓰기"도 Error로 잡았는데, 실측(RamsesKR minsu-clean)에서
 * **59건 전부가 `읽기+쓰기+삭제`**여서 전건이 🔴가 됐다. 이 앱은 접근 규칙에 삭제 권한을
 * 폭넓게 주고 있어서, 쓰기 여부가 이 코드베이스에서는 아무것도 가르지 못한다.
 * 전건이 같은 등급이면 등급이 아니다 — 읽는 사람이 59건을 다시 다 읽어야 한다.
 *
 * 익명 노출만 Error로 남긴다. 그건 7건이고, 실제로 조치가 필요한 것이다.
 */
export function accessSeverity(tier: AccessTier): "Warning" | "Error" {
    return tier === "guest" ? "Error" : "Warning";
}

/** 등급별 위험 배수의 기준값. general을 1.0으로 두고 상대화한다. */
const TIER_WEIGHT: Record<AccessTier, number> = {
    guest: 3, // 비로그인 사용자가 전체 행을 본다. 사고일 가능성이 높다.
    general: 2, // 로그인한 일반 사용자가 전체 행을 본다.
    unknown: 2, // 판정 근거를 못 읽었다 — general과 같게 두고 낮추지 않는다.
    adminOnly: 1, // 관리자 역할에만 열렸다. 의도된 설정일 가능성이 높다.
};

const TIER_LABEL: Record<AccessTier, string> = {
    guest: "익명",
    general: "일반 사용자",
    adminOnly: "관리자 전용",
    unknown: "판정 불가",
};

/** SDK enum을 값 비교 가능한 문자열로. `.name`에 의존하지 않는다. */
function rightsOf(r: domainmodels.MemberAccessRights | null | undefined): AccessRights {
    if (r === domainmodels.MemberAccessRights.ReadWrite) return "ReadWrite";
    if (r === domainmodels.MemberAccessRights.ReadOnly) return "ReadOnly";
    return "None";
}

interface SecurityContext {
    level: security.SecurityLevel | null;
    tiers: RoleTiers;
}

/** 보안 검사는 프로젝트 보안 수준에 따라 의미가 달라진다. 역할 등급과 함께 먼저 읽어 둔다. */
async function readSecurityContext(model: IModel): Promise<SecurityContext> {
    const ctx: SecurityContext = {
        level: null,
        tiers: { admin: new Set(), guest: new Set(), resolved: false },
    };
    for (const proxy of model.allProjectSecurities()) {
        try {
            const sec = await proxy.load();
            ctx.level = sec.securityLevel;

            const byName = new Map(sec.userRoles.map((r) => [r.name, r]));
            const admin = byName.get(sec.adminUserRoleName);
            for (const q of admin?.moduleRolesQualifiedNames ?? []) ctx.tiers.admin.add(q);

            const guest = sec.enableGuestAccess ? byName.get(sec.guestUserRoleName) : undefined;
            for (const q of guest?.moduleRolesQualifiedNames ?? []) ctx.tiers.guest.add(q);

            // 관리자 역할을 못 찾았거나, 게스트를 켜 놓고 그 역할을 못 찾았으면
            // 등급 판정의 근거가 불완전하다. 그 경우 등급으로 점수를 깎지 않는다.
            ctx.tiers.resolved =
                admin !== undefined && (!sec.enableGuestAccess || guest !== undefined);
            if (!ctx.tiers.resolved) {
                console.log(
                    `⚠️ [Domain] 역할 등급 판정 근거 부족 (관리자 역할 '${sec.adminUserRoleName}' 확인 실패) — D005 등급을 낮추지 않습니다.`
                );
            }
            return ctx;
        } catch {
            /* 무시 */
        }
    }
    return ctx;
}

/** graph.ts와 판정이 갈리면 D003과 L001이 서로 다른 얘기를 하게 된다. 한 곳에서 가져온다. */
const isPersistable = isPersistableEntity;

export async function analyzeDomain(model: IModel, graph: ModelGraph): Promise<ReviewIssue[]> {
    console.log("🔍 [Domain] 데이터 구조·보안·의존성 분석 시작...");

    const { level: securityLevel, tiers } = await readSecurityContext(model);
    const securityIsOn = securityLevel !== security.SecurityLevel.CheckNothing;
    const securityNote = `프로젝트 보안 수준: ${securityLevel?.name ?? "확인 불가"}`;

    const issues: ReviewIssue[] = [];
    const dependencyMap: Record<string, Record<string, number>> = {};

    /** 위치 인자가 많아져 뜻을 잃었다. 선택 항목은 이름으로 받는다. */
    interface AddOptions {
        score?: number;
        /** 룰 기본 권장문구가 이 상황에 안 맞을 때 덮어쓴다. */
        recommendation?: string;
        /** 규칙별 표의 열. @see ReviewIssue.facts */
        facts?: Record<string, string>;
        /** 같은 규칙 안에서의 정렬 키. @see ReviewIssue.focusRank */
        focusRank?: number;
    }

    const add = (
        ruleKey: keyof typeof MendixRules,
        location: string,
        message: string,
        severity: "Warning" | "Error",
        evidence: string[],
        opts: AddOptions = {}
    ) => {
        const rule = MendixRules[ruleKey];
        issues.push({
            category: ruleKey.includes("ACCESS") ? "Security" : "Domain",
            ruleId: rule.id,
            location,
            message,
            recommendation: opts.recommendation ?? rule.recommendation,
            severity,
            evidence,
            score: opts.score ?? rule.baseScore,
            facts: opts.facts,
            focusRank: opts.focusRank,
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
                    [usageLine],
                    {
                        facts: {
                            연관관계: String(relatedCount),
                            "사용 flow": String(touchCount),
                        },
                        focusRank: relatedCount * 10 + touchCount,
                    }
                );
            }

            // D002 — NP_ 접두사인데 persistable
            if (entity.name.startsWith("NP_") && isPersistable(entity)) {
                add(
                    "NP_PERSISTABLE_ERROR",
                    qName,
                    `Non-Persistable 명명 규칙인데 Persistable로 설정되어 있습니다.`,
                    "Error",
                    [usageLine],
                    {
                        facts: { "사용 flow": String(touchCount) },
                        focusRank: touchCount,
                    }
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
                        {
                            score:
                                MendixRules.MISSING_INDEX.baseScore +
                                inLoop * 5 +
                                hotFlows.size * 3,
                            recommendation: orCombined
                                ? "조회 조건이 `or`로 묶여 있습니다. 복합 인덱스는 `or`에 쓰이지 않으므로 " +
                                  "**각 속성에 단일 컬럼 인덱스를 따로** 만드세요. " +
                                  "String 속성은 Max length가 Unlimited면 인덱스를 걸 수 없습니다."
                                : "엔티티 Properties → Indexes 탭에서 위 속성에 인덱스를 추가하세요. " +
                                  "여러 속성이 항상 함께 조건에 쓰이면 선택도 높은 것을 앞에 둔 복합 인덱스가 낫습니다(leftmost prefix). " +
                                  "String 속성은 Max length가 Unlimited면 인덱스를 걸 수 없습니다.",
                            facts: {
                                "미커버 속성": String(uncovered.length),
                                "루프 내": inLoop > 0 ? String(inLoop) : "-",
                                "무인/외부": hotFlows.size > 0 ? String(hotFlows.size) : "-",
                                "기존 인덱스": String(indexInfo?.count ?? 0),
                            },
                            focusRank: inLoop * 100 + hotFlows.size * 10 + uncovered.length,
                        }
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
                        [securityNote, usageLine],
                        {
                            facts: { "사용 flow": String(touchCount) },
                            focusRank: touchCount,
                        }
                    );
                } else {
                    // XPath 제약이 없는 규칙 = 그 역할이 이 엔티티의 전체 행을 본다.
                    const open = entity.accessRules
                        .filter((r) => !r.xPathConstraint || r.xPathConstraint.trim() === "")
                        .map((r) => {
                            const roleQNames = r.moduleRolesQualifiedNames ?? [];
                            return {
                                roleQNames,
                                tier: classifyAccessTier(roleQNames, tiers),
                                grant: accessGrant({
                                    defaultRights: rightsOf(r.defaultMemberAccessRights),
                                    memberRights: r.memberAccesses.map((m) =>
                                        rightsOf(m.accessRights)
                                    ),
                                    allowDelete: r.allowDelete,
                                }),
                            };
                        })
                        .filter((r) => r.grant.grants);

                    if (open.length > 0) {
                        // 엔티티당 이슈는 하나다. 여러 규칙이 열려 있으면 **가장 위험한 쪽**이
                        // 이 엔티티의 성격이다. 평균이나 다수결로 뭉개면 사고가 묻힌다.
                        const worst = open.reduce((a, b) =>
                            TIER_WEIGHT[b.tier] > TIER_WEIGHT[a.tier] ||
                            (TIER_WEIGHT[b.tier] === TIER_WEIGHT[a.tier] &&
                                b.grant.writes &&
                                !a.grant.writes)
                                ? b
                                : a
                        );
                        const writes = open.some((r) => r.grant.writes);
                        const roles = [...new Set(open.flatMap((r) => r.roleQNames))];

                        const severity = accessSeverity(worst.tier);

                        const evidence = [
                            securityNote,
                            `열린 대상: ${TIER_LABEL[worst.tier]} — ${roles.join(", ") || "역할 미지정"}`,
                            `허용 범위: ${worst.grant.label}`,
                            usageLine,
                        ];
                        if (worst.tier === "unknown") {
                            evidence.push(
                                tiers.resolved
                                    ? "⚠️ 이 규칙에 모듈 역할이 지정되어 있지 않아 대상을 특정하지 못했습니다. 등급을 낮추지 않습니다."
                                    : "⚠️ 프로젝트 보안에서 관리자·게스트 역할을 읽지 못해 등급을 판정하지 못했습니다. 등급을 낮추지 않습니다."
                            );
                        }

                        add(
                            "UNCONSTRAINED_ACCESS",
                            qName,
                            worst.tier === "guest"
                                ? `비로그인(익명) 사용자가 이 엔티티의 전체 행을 봅니다. (무제약 규칙 ${open.length}건)`
                                : worst.tier === "adminOnly"
                                  ? `관리자 역할만 전체 행을 봅니다. 의도된 설정이면 기각하세요. (무제약 규칙 ${open.length}건)`
                                  : `XPath 제약 없는 접근 규칙이 ${open.length}건 있습니다. 해당 역할은 전체 행을 봅니다.`,
                            severity,
                            evidence,
                            {
                                score:
                                    Math.round(
                                        (MendixRules.UNCONSTRAINED_ACCESS.baseScore *
                                            TIER_WEIGHT[worst.tier]) /
                                            TIER_WEIGHT.general
                                    ) + (writes ? 8 : 0),
                                recommendation:
                                    worst.tier === "guest"
                                        ? "익명 접근에 전체 행이 열려 있습니다. 공개해도 되는 데이터가 맞는지 먼저 확인하고, 아니라면 XPath 제약을 추가하거나 익명 역할에서 이 규칙을 빼세요."
                                        : worst.tier === "adminOnly"
                                          ? "관리자 전용이라면 대개 의도된 설정입니다. 의도가 맞다면 Access Rule의 Documentation에 이유를 적어 두세요 — 다음 리뷰에서 같은 건을 다시 검토하지 않게 됩니다."
                                          : undefined,
                                facts: {
                                    "열린 대상": TIER_LABEL[worst.tier],
                                    허용: worst.grant.label,
                                    "열린 규칙": String(open.length),
                                    "사용 flow": String(touchCount),
                                    역할: roles.slice(0, 5).join(", ") || "미지정",
                                },
                                // 등급이 먼저, 그다음 쓰기 여부, 그다음 노출 반경.
                                focusRank:
                                    TIER_WEIGHT[worst.tier] * 10000 +
                                    (writes ? 1000 : 0) +
                                    touchCount * 10 +
                                    open.length,
                            }
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
                    {
                        score: MendixRules.HOT_ENTITY.baseScore + Math.floor(touchCount / 5),
                        facts: {
                            "사용 flow": String(touchCount),
                            조회: String(usage?.readBy.size ?? 0),
                            변경: String(usage?.writtenBy.size ?? 0),
                        },
                        focusRank: touchCount,
                    }
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
                {
                    score: MendixRules.STRONG_COUPLING.baseScore + count,
                    facts: { 참조: String(count) },
                    focusRank: count,
                }
            );
        }
    }

    console.log(`✅ [Domain] 완료 (이슈 ${issues.length}건)`);
    return issues;
}
