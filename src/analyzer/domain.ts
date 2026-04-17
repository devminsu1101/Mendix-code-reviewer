// src/analyzer/domain.ts
import { IModel, domainmodels } from "mendixmodelsdk";
import { ReviewIssue } from "./reporter.js";
import { MendixRules } from "./rules.js";

export async function analyzeDomain(model: IModel): Promise<ReviewIssue[]> {
    console.log("🔍 [Domain] 데이터 구조 및 모듈 간 의존성 분석 시작...");
    const domainModels = model.allDomainModels();
    const issues: ReviewIssue[] = [];
    
    // 모듈 간 참조 맵 (SourceModule -> TargetModule -> Count)
    const dependencyMap: Record<string, Record<string, number>> = {};

    for (const dmProxy of domainModels) {
        const moduleName = dmProxy.containerAsModule.name;
        if (moduleName === "System" || moduleName === "Administration") continue;

        const dm = await dmProxy.load();
        
        // 모듈 간 의존성 파악 (Cross-Module Association)
        dm.associations.forEach(assoc => {
            const parentModule = assoc.parent.containerAsDomainModel.containerAsModule.name;
            const childModule = assoc.child.containerAsDomainModel.containerAsModule.name;

            if (parentModule !== childModule) {
                if (!dependencyMap[parentModule]) dependencyMap[parentModule] = {};
                dependencyMap[parentModule][childModule] = (dependencyMap[parentModule][childModule] || 0) + 1;
            }
        });

        // 엔티티 개별 분석
        const BATCH_SIZE = 20;
        const entities = dm.entities;

        for (let i = 0; i < entities.length; i += BATCH_SIZE) {
            const batch = entities.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(async (entityProxy) => {
                try {
                    const entity = await entityProxy.load();
                    const location = `${moduleName}.${entity.name}`;

                    // 1. 데이터 결합도 분석 (Association 과다 체크)
                    const associations = dm.associations.filter(assoc => 
                        (assoc.parent && assoc.parent.name === entity.name) || 
                        (assoc.child && assoc.child.name === entity.name)
                    );
                    
                    if (associations.length > 5) {
                        issues.push({ 
                            category: 'Domain', 
                            location, 
                            message: `⚠️ [데이터 스파게티] 엔티티 관계가 ${associations.length}개로 너무 복잡하게 얽혀 있습니다.`, 
                            recommendation: MendixRules.DATA_SPAGHETTI.recommendation,
                            severity: 'Error' 
                        });
                    }

                    // 2. 비정상적 Persistence 체크
                    if (entity.name.startsWith("NP_")) {
                        const gen = entity.generalization;
                        if (gen instanceof domainmodels.NoGeneralization && gen.persistable) {
                            issues.push({ 
                                category: 'Domain', 
                                location, 
                                message: `🔥 [설정 오류] Non-Persistable 엔티티가 Persistable로 설정되어 있습니다.`, 
                                recommendation: MendixRules.NP_PERSISTABLE_ERROR.recommendation,
                                severity: 'Error' 
                            });
                        }
                    }

                    // 3. 인덱스 누락 체크
                    if (entity.attributes.length > 20 && entity.indexes.length === 0) {
                        issues.push({ 
                            category: 'Domain', 
                            location, 
                            message: `💡 [성능 최적화] 속성이 많은 대형 엔티티에 인덱스가 없습니다.`, 
                            recommendation: MendixRules.MISSING_INDEX.recommendation,
                            severity: 'Warning' 
                        });
                    }
                } catch (err) {
                    // 에러 무시
                }
            }));
        }
    }

    // 모듈 의존성 분석 결과 정리 및 제안 생성
    for (const sourceMod in dependencyMap) {
        for (const targetMod in dependencyMap[sourceMod]) {
            const count = dependencyMap[sourceMod][targetMod];
            if (count >= 3) { // 3개 이상의 엔티티를 다른 모듈에서 참조할 때
                issues.push({
                    category: 'Domain',
                    location: `${sourceMod} -> ${targetMod}`,
                    message: `🏗️ [아키텍처 제안] 모듈 간 강한 결합(Strong Coupling) 발견 (${count}건의 참조)`,
                    recommendation: `'${sourceMod}' 모듈이 '${targetMod}' 모듈의 데이터를 과도하게 참조하고 있습니다. 순환 참조 위험을 방지하기 위해 해당 엔티티들을 'Common' 또는 'Shared' 모듈로 이동시키는 것을 고려하세요.`,
                    severity: 'Warning'
                });
            }
        }
    }

    console.log(`✅ 도메인 분석 완료 (발견된 이슈: ${issues.length}건)`);
    return issues;
}
