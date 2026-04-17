// src/analyzer/logic.ts
import { microflows, IModel } from "mendixmodelsdk";
import { ReviewIssue } from "./reporter.js";
import { MendixRules } from "./rules.js";

/**
 * 치명적 성능 저하 요소(Anti-patterns) 탐색
 */
function checkCriticalPerformance(activities: microflows.Activity[], currentMfName: string): ReviewIssue[] {
    const issues: ReviewIssue[] = [];
    for (const act of activities) {
        if (act instanceof microflows.ActionActivity) {
            const action = act.action;
            if (action instanceof microflows.RetrieveAction) {
                // 어떤 엔티티를 조회하는지 맥락 파악
                const entityName = action.retrieveSource instanceof microflows.DatabaseRetrieveSource 
                    ? action.retrieveSource.entityQualifiedName.split('.').pop() 
                    : "엔티티";

                issues.push({ 
                    category: 'Logic', 
                    location: currentMfName, 
                    message: `🔥 [성능 제약] 루프 내에서 '${entityName}' 엔티티를 DB 조회하고 있습니다.`, 
                    recommendation: `루프 진입 전에 '${entityName}' 리스트를 미리 Retrieve하고, 루프 안에서는 'Find by expression'으로 해당 객체를 찾으세요.`,
                    severity: 'Error' 
                });
            } else if (action instanceof microflows.CommitAction) {
                issues.push({ 
                    category: 'Logic', 
                    location: currentMfName, 
                    message: `🔥 [성능 제약] 루프 내에서 DB 저장(Commit)이 발생하고 있습니다.`, 
                    recommendation: `루프 안에서는 객체 값만 변경(Change)하고, 리스트에 담아 루프가 끝난 뒤 한 번에 Commit 하세요.`,
                    severity: 'Error' 
                });
            } else if (action instanceof microflows.LoopAction) {
                issues.push(...checkCriticalPerformance(action.loopActivities, currentMfName));
            }
        }
    }
    return issues;
}

/**
 * 마이크로플로우 핵심 분석
 */
function processMicroflow(mf: microflows.Microflow): ReviewIssue[] {
    const issues: ReviewIssue[] = [];
    
    // 1. 복잡도 분석 (액션 개수)
    const actionCount = mf.objectCollection.objects.filter(o => o instanceof microflows.ActionActivity).length;
    if (actionCount > 25) {
        issues.push({ 
            category: 'Logic', 
            location: mf.qualifiedName, 
            message: `⚠️ [복잡도 과부화] 액션이 ${actionCount}개로 너무 많습니다.`, 
            recommendation: MendixRules.HIGH_COMPLEXITY.recommendation,
            severity: 'Error' 
        });
    }

    // 2. 루프 내 성능 분석
    const topLevelObjects = mf.objectCollection.objects;
    const loops = topLevelObjects
        .filter(o => o instanceof microflows.ActionActivity && (o as microflows.ActionActivity).action instanceof microflows.LoopAction)
        .map(o => (o as microflows.ActionActivity).action as microflows.LoopAction);

    loops.forEach(loopAction => {
        issues.push(...checkCriticalPerformance(loopAction.loopActivities, mf.qualifiedName));
    });

    // 3. 파라미터 과부화 체크
    const params = mf.objectCollection.objects.filter(o => o instanceof microflows.MicroflowParameterObject);
    if (params.length > 7) {
        issues.push({ 
            category: 'Logic', 
            location: mf.qualifiedName, 
            message: `⚠️ [설계 결함] 파라미터가 ${params.length}개로 과도합니다.`, 
            recommendation: MendixRules.TOO_MANY_PARAMS.recommendation,
            severity: 'Warning' 
        });
    }

    return issues;
}

/**
 * 마이크로플로우 구조를 지문화(Fingerprint)하여 유사성 비교
 */
function getMfFingerprint(mf: microflows.Microflow): string {
    const actions = mf.objectCollection.objects
        .filter(o => o instanceof microflows.ActionActivity)
        .map(o => (o as any).action?.constructor.name || "Unknown")
        .sort()
        .join(",");
    
    const entities = mf.objectCollection.objects
        .filter(o => o instanceof microflows.MicroflowParameterObject)
        .map(o => (o as any).variableType?.entityQualifiedName || "Unknown")
        .sort()
        .join("|");

    return `${actions}#${entities}`;
}

export async function analyzeLogic(model: IModel, isDelta: boolean = false): Promise<ReviewIssue[]> {
    const ONE_HOUR = 60 * 60 * 1000;
    const now = Date.now();

    const allMfs = model.allMicroflows().filter(mf => {
        const mod = mf.qualifiedName.split(".")[0];
        const isSystem = mod === "System" || mod === "Administration";
        if (isSystem) return false;

        if (isDelta) {
            // Delta 모드: 최근 1시간 내 수정된 것만 포함
            // 참고: mf.containerAsFolder.structureTypeName 등으로 더 정교하게 필터 가능
            // 여기서는 단순 날짜 비교 (SDK의 unit 특성 활용)
            const lastModified = (mf as any).unit?.lastModifiedDate; 
            if (lastModified) {
                return (now - lastModified) < ONE_HOUR;
            }
            return true; // 날짜 정보 없으면 안전하게 포함
        }
        return true;
    });

    if (allMfs.length === 0) {
        console.log(`🔍 [Logic] 분석할 변경된 로직이 없습니다.`);
        return [];
    }

    console.log(`🔍 [Logic] ${isDelta ? "변경분" : "전체"} 분석 시작... (대상: ${allMfs.length}건)`);
    
    const allIssues: ReviewIssue[] = [];
    const fingerprintMap: Record<string, string[]> = {}; // { fingerprint: [mfNames] }
    const BATCH_SIZE = 10;

    for (let i = 0; i < allMfs.length; i += BATCH_SIZE) {
        const batch = allMfs.slice(i, i + BATCH_SIZE);
        const results = await Promise.all(batch.map(async (mfProxy) => {
            try {
                const loadedMf = await mfProxy.load();
                
                // 중복 체크용 지문 추출
                const fp = getMfFingerprint(loadedMf);
                if (fp.length > 10) { // 너무 짧은 로직은 제외
                    if (!fingerprintMap[fp]) fingerprintMap[fp] = [];
                    fingerprintMap[fp].push(loadedMf.qualifiedName);
                }

                return processMicroflow(loadedMf);
            } catch (err) {
                return [];
            }
        }));
        results.forEach(res => allIssues.push(...res));
        console.log(`   > 진행률: ${Math.min(i + BATCH_SIZE, allMfs.length)} / ${allMfs.length}`);
    }

    // 중복 로직 분석 결과 추가
    for (const fp in fingerprintMap) {
        const duplicates = fingerprintMap[fp];
        if (duplicates.length > 1) {
            allIssues.push({
                category: 'Logic',
                location: duplicates[0],
                message: `💡 [아키텍처 제안] 유사한 로직이 ${duplicates.length}개 발견되었습니다.`,
                recommendation: `다음 마이크로플로우들이 유사한 액션 구성을 가지고 있습니다: [${duplicates.slice(1).join(", ")}]. 이를 하나의 Sub-Microflow로 통합하여 유지보수성을 높이세요.`,
                severity: 'Warning'
            });
        }
    }

    console.log(`✅ 로직 분석 완료 (발견된 이슈: ${allIssues.length}건)`);
    return allIssues;
}
