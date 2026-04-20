
import { GoogleGenerativeAI } from "@google/generative-ai";
import { IModel, domainmodels, navigation, security, microflows } from "mendixmodelsdk";
import fs from "fs/promises";
import path from "path";

/**
 * Mendix 모델에서 비즈니스 맥락, 사용자 흐름 및 기술 구조를 통합적으로 추출합니다.
 */
async function extractMetadata(model: IModel) {
    console.log("📊 프로젝트 마스터 분석 시작 (User Flow & Business Context)...");

    const modules = model.allModules().filter(m => !["System", "Administration", "UnitTesting", "Atlas_Core", "Atlas_Web_Content"].includes(m.name));
    
    // 1. 유저 역할 및 페이지 접근 권한 분석 (페르소나 정의용)
    const allSecurities = model.allProjectSecurities();
    let userRoles: any[] = [];
    if (allSecurities.length > 0) {
        try {
            const projectSecurity = await allSecurities[0].load();
            userRoles = projectSecurity.userRoles.map(r => ({
                name: r.name,
                description: r.description
            }));
        } catch (e) { console.log("⚠️ 보안 정보 추출 실패"); }
    }

    // 2. 네비게이션 분석 (시스템 진입점 및 유저 플로우 파악)
    const navDocs = model.allNavigationDocuments();
    let entryPoints: any[] = [];
    if (navDocs.length > 0) {
        try {
            const nav = await navDocs[0].load();
            nav.profiles.forEach(profile => {
                if (profile.homePage) {
                    entryPoints.push({
                        profile: profile.name,
                        homePage: profile.homePage.qualifiedName,
                        menuItems: profile.menuItemCollection?.items.slice(0, 5).map(item => item.caption) || []
                    });
                }
            });
        } catch (e) { console.log("⚠️ 네비게이션 분석 실패"); }
    }

    // 3. 엔티티 관계 및 모듈 의존성 (기존 로직 고도화)
    const entityRelationships: any[] = [];
    const moduleDependencyMap: Record<string, Set<string>> = {};
    const moduleStats: Record<string, { internalRel: number, externalRel: number, entities: string[] }> = {};

    modules.forEach(m => {
        moduleStats[m.name] = { internalRel: 0, externalRel: 0, entities: m.domainModel.entities.map(e => e.name) };

        m.domainModel.associations.forEach(assoc => {
            if (assoc.parent && assoc.child) {
                const parentModule = (assoc.parent.container as domainmodels.DomainModel).containerAsModule.name;
                const childModule = (assoc.child.container as domainmodels.DomainModel).containerAsModule.name;
                const isInternal = parentModule === childModule;

                entityRelationships.push({
                    from: `${parentModule}.${assoc.parent.name}`,
                    to: `${childModule}.${assoc.child.name}`,
                    type: isInternal ? "Internal" : "External",
                    label: assoc.name
                });

                if (isInternal) moduleStats[m.name].internalRel++;
                else {
                    moduleStats[m.name].externalRel++;
                    if (!moduleDependencyMap[parentModule]) moduleDependencyMap[parentModule] = new Set();
                    moduleDependencyMap[parentModule].add(childModule);
                }
            }
        });

        // 상속 관계
        m.domainModel.entities.forEach(entity => {
            if (entity.generalization && (entity.generalization as any).generalization) {
                const parentEntity = (entity.generalization as any).generalization;
                const parentModule = (parentEntity.container as domainmodels.DomainModel).containerAsModule.name;
                entityRelationships.push({
                    from: `${m.name}.${entity.name}`,
                    to: `${parentModule}.${parentEntity.name}`,
                    type: "Inheritance",
                    label: "is-a"
                });
            }
        });
    });

    // 4. 로직 분석 (마이크로플로우 명명 패턴 및 주요 액션 샘플링)
    const allDocs = model.allDocuments();
    const moduleAnalysis = modules.map(m => {
        const moduleDocs = allDocs.filter(doc => {
            const parts = doc.qualifiedName.split(".");
            return parts.length > 0 && parts[0] === m.name;
        });

        return {
            name: m.name,
            stats: moduleStats[m.name],
            structureSample: moduleDocs.slice(0, 15).map(d => ({
                name: d.name,
                qName: d.qualifiedName,
                type: d.constructor.name
            }))
        };
    });

    return {
        userRoles,
        entryPoints,
        moduleAnalysis,
        entityRelationships: entityRelationships.slice(0, 60), // AI 인지 한계 고려
        moduleDependencies: Object.fromEntries(Object.entries(moduleDependencyMap).map(([k, v]) => [k, Array.from(v)]))
    };
}

/**
 * 통합 마스터 온보딩 가이드를 생성합니다.
 */
export async function generateAIGuide(model: IModel, appName: string) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("❌ GEMINI_API_KEY가 없습니다.");

    const metadata = await extractMetadata(model);
    const genAI = new GoogleGenerativeAI(apiKey);
    
    const modelCandidates = ["gemini-2.5-flash", "gemini-3-flash"];

    const prompt = `
        너는 10년 차 Mendix 전문 시니어 개발자이자 기술 리드야. 
        신입 개발자가 3일 안에 실무에 투입될 수 있도록, 비즈니스 맥락과 코드의 연결고리를 짚어주는 **[통합 마스터 온보딩 가이드]**를 작성해줘.

        [분석된 프로젝트 원재료]
        1. **사용자 페르소나**: ${JSON.stringify(metadata.userRoles)}
        2. **시스템 진입점(Navigation)**: ${JSON.stringify(metadata.entryPoints)}
        3. **비즈니스 모듈 구조**: ${JSON.stringify(metadata.moduleAnalysis)}
        4. **데이터 관계망(ER-Map)**: ${JSON.stringify(metadata.entityRelationships)}
        5. **모듈 간 의존성**: ${JSON.stringify(metadata.moduleDependencies)}

        [가이드 구성 요구사항 - 다음 순서를 엄격히 지킬 것]

        ### 1단계: 비즈니스 지도 - "우리가 해결하는 문제"
        - 단순히 엔티티 나열이 아니라, **사용자 페르소나**와 **네비게이션 메뉴**를 결합해서 설명해줘.
        - "고객이 견적을 요청하면 -> 운영자가 확정하고 -> 창고에서 출고된다"는 식의 **데이터 생애주기 파이프라인**을 한 문장으로 정의해줘.

        ### 2단계: 시스템 지도 - "코드의 뼈대와 흐름"
        - **데이터의 심장**: 관계망에서 교량 역할을 하는 핵심 엔티티를 짚어주고, 왜 그 엔티티가 비즈니스의 중심인지 설명해줘.
        - **의존성 흐름**: 모듈 간 의존 관계를 바탕으로 "상위 도메인"과 "하위 유틸리티/API 모듈"을 구분해서 아키텍처를 그려줘.
        - **추적 가이드**: "사용자가 특정 버튼을 눌렀을 때(Entry Point) 어떤 모듈의 로직이 실행되는지" 예시 시나리오를 하나 만들어줘.

        ### 3단계: 실무 치트시트 - "내일 당장 코딩할 때"
        - **명명 규칙 & 폴더링**: 분석된 'structureSample'을 바탕으로 우리 팀의 명명 패턴(ACT, DS, SUB 등)과 문서 관리 규칙을 표로 정리해줘.
        - **가드레일**: Mendix 성능 최적화(루프 내 Retrieve 금지 등)와 이 프로젝트에서 특히 조심해야 할 '위험 엔티티'를 경고해줘.

        ### 4단계: 3일 완성 생존 로드맵 - "Actionable Mission"
        - **Day 1 (탐험)**: 특정 페이지와 마이크로플로우를 직접 열어보고 데이터 흐름을 추적해보는 미션.
        - **Day 2 (분석)**: 핵심 엔티티(\`ShipmentCase\` 등)의 연관 관계가 실제 화면에 어떻게 뿌려지는지 파악하는 미션.
        - **Day 3 (응용)**: 작은 유효성 검사 로직을 추가해보거나 UI 스니펫을 분석해보는 미션.

        [톤앤매너]
        - 시니어 개발자가 직접 옆에서 가르쳐주는 듯한 친절하고 전문적인 말투.
        - "추측건대"라는 말보다는 데이터에 기반한 "이런 구조이므로 ~인 것이 확실하다"는 확신 있는 어조.
        - 모든 내용은 한국어로, Markdown 형식을 최대한 활용.
    `;

    for (const modelName of modelCandidates) {
        try {
            console.log(`🤖 [${modelName}] 모델로 통합 마스터 가이드 생성 중...`);
            const aiModel = genAI.getGenerativeModel({ model: modelName });
            const result = await aiModel.generateContent(prompt);
            const text = result.response.text();

            const reportDir = path.join(process.cwd(), "reports", "Onboarding");
            await fs.mkdir(reportDir, { recursive: true });
            const fileName = `Master_Onboarding_Guide_${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
            const filePath = path.join(reportDir, fileName);
            await fs.writeFile(filePath, text, "utf8");

            return text;
        } catch (error: any) {
            console.log(`❌ [${modelName}] 시도 실패 (다음 모델로 전환)`);
        }
    }
    throw new Error("❌ 가이드 생성에 실패했습니다.");
}
