
import { GoogleGenerativeAI } from "@google/generative-ai";
import { IModel } from "mendixmodelsdk";
import fs from "fs/promises";
import path from "path";

/**
 * Mendix 모델에서 AI 분석을 위한 핵심 메타데이터를 추출합니다.
 */
async function extractMetadata(model: IModel) {
    console.log("📊 프로젝트 내부 구조 정밀 분석 중...");

    // 1. 보안/유저 역할
    const allSecurities = model.allProjectSecurities();
    let roles: any[] = [];
    if (allSecurities.length > 0) {
        try {
            const security = await allSecurities[0].load();
            roles = security.userRoles.map(r => ({ name: r.name, desc: r.description }));
        } catch (e) { console.log("⚠️ 보안 정보 로드 실패"); }
    }

    // 2. 전체 모듈 및 엔티티 관계도 (상세 추출)
    const modules = model.allModules()
        .filter(m => !["System", "Administration", "UnitTesting"].includes(m.name))
        .map(m => ({
            name: m.name,
            entities: m.domainModel.entities.map(e => ({
                name: e.name,
                associationCount: m.domainModel.associations.filter(a => 
                    (a.parent && a.parent.name === e.name) || (a.child && a.child.name === e.name)
                ).length,
                attributes: e.attributes.length
            }))
        }));

    // 3. 컨벤션 파악을 위한 마이크로플로우/페이지 전체 리스트
    const mfSamples = model.allMicroflows().map(mf => mf.qualifiedName);
    const pageSamples = model.allPages().map(p => p.qualifiedName);

    // 4. 네비게이션 진입점
    let homePage = "Unknown";
    try {
        const navDocs = (model as any).allNavigationDocuments?.() || [];
        if (navDocs.length > 0) {
            const nav = await navDocs[0].load();
            if (nav.profiles && nav.profiles.length > 0) {
                homePage = nav.profiles[0].homePage?.qualifiedName || "Unknown";
            }
        }
    } catch (e) { console.log("⚠️ 네비게이션 로드 실패"); }

    return { roles, homePage, modules, conventions: { microflows: mfSamples, pages: pageSamples } };
}

/**
 * Gemini 최신 모델을 사용하여 정밀 온보딩 가이드를 생성합니다.
 */
export async function generateAIGuide(model: IModel, appName: string) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("❌ GEMINI_API_KEY가 없습니다.");

    const metadata = await extractMetadata(model);
    const genAI = new GoogleGenerativeAI(apiKey);
    
    // 사용자님이 확인하신 실제 작동 모델 리스트
    const modelCandidates = [
        "gemini-2.5-flash",
        "gemini-2.5-flash-lite",
        "gemini-3-flash", 
        // "gemini-3.1-flash-lite",
    ];

    const prompt = `
        너는 10년 차 Mendix 전문 시니어 개발자이자 기술 리드야. 
        우리 팀에 새로 합류한 신입 개발자를 위해, 아래 제공된 **실제 프로젝트 메타데이터**를 바탕으로 아주 상세하고 전문적인 '온보딩 가이드'를 작성해줘.

        [분석 대상 프로젝트 정보]
        - 애플리케이션 이름: ${appName || "RamsesKR (Logistics System)"}
        - 시작 페이지 (Home): ${metadata.homePage}
        - 유저 역할 및 권한: ${JSON.stringify(metadata.roles)}
        - 전체 모듈 구조 및 엔티티 복잡도: ${JSON.stringify(metadata.modules)}
        - 마이크로플로우/페이지 명명 패턴: ${JSON.stringify(metadata.conventions)}

        [가이드 작성 요구사항 - 매우 상세하게 작성할 것]
        1. **서론**: 팀 리더로서 아주 따뜻하고 든든하게 환영 인사를 건네줘.
        2. **비즈니스 도메인 해석**: 추출된 모듈명(예: Shipment, Quotation, Warehouse 등)과 엔티티들을 보고, 이 앱이 정확히 어떤 비즈니스 프로세스를 처리하는 앱인지 시니어의 통찰력을 담아 설명해줘.
        3. **데이터 구조 마스터하기**: 
           - 'associationCount'가 가장 높은 엔티티를 찾아 "이것이 우리 앱의 핵심(Heart)이다"라고 강조해줘.
           - 해당 엔티티를 수정할 때 어떤 사이드 이펙트를 조심해야 하는지 기술적으로 조언해줘.
        4. **우리 팀의 약속 (Convention)**:
           - 제공된 마이크로플로우와 페이지 샘플을 분석해서 'ACT_', 'DS_', 'SUB_', 'NP_' 등 접두어별 의미와 사용 규칙을 정리해줘.
           - 파일 경로 구조(Module > Folder > Document)에 대해서도 언급해줘.
        5. **학습 로드맵 추천**: 신입 개발자가 어떤 모듈의 도메인 모델부터 열어봐야 할지, 어떤 마이크로플로우를 먼저 분석하면 흐름 파악이 빠를지 구체적으로 1단계, 2단계로 나누어 추천해줘.
        6. **시니어의 꿀팁**: Mendix 개발 시 성능 최적화(Retrieve 관리 등)나 협업 시 주의사항을 우리 프로젝트 맥락에 맞춰서 말해줘.
        7. **결론**: 신입의 성장을 응원하는 메시지로 마무리해줘.

        [주의사항] 
        - 모든 내용은 한국어로 작성해줘. 
        - Markdown 서식을 활용하여 가독성 있게 작성할 것 (표, 불렛포인트, 코드 블럭 활용).
        - 데이터에 없는 내용은 지어내지 말고, 데이터에 기반한 '추론'임을 밝히며 설명할 것.
    `;

    for (const modelName of modelCandidates) {
        try {
            console.log(`🤖 [${modelName}] 모델로 정밀 가이드 생성 시도 중...`);
            const aiModel = genAI.getGenerativeModel({ model: modelName });
            
            const result = await aiModel.generateContent(prompt);
            const text = result.response.text();

            const reportDir = path.join(process.cwd(), "reports", "Onboarding");
            await fs.mkdir(reportDir, { recursive: true });
            const fileName = `Onboarding_Guide_Full_${new Date().toISOString().replace(/[:.]/g, "-")}.md`;
            const filePath = path.join(reportDir, fileName);
            await fs.writeFile(filePath, text, "utf8");

            console.log(`\n✨ 정밀 온보딩 가이드 생성 성공! [사용 모델: ${modelName}]`);
            console.log(`📍 저장 경로: ${filePath}`);
            return text;

        } catch (error: any) {
            console.log(`❌ [${modelName}] 시도 실패 (다음 모델로 전환)`);
        }
    }

    throw new Error("❌ 모든 최신 모델 호출에 실패했습니다.");
}
