
import { getModel } from "./client.js";
import { generateAIGuide } from "./analyzer/onboarding_ai.js";

async function runOnboarding() {
    const requestedBranch = process.argv[2]; // 브랜치명을 인자로 받을 수 있음
    
    console.log("🚀 Mendix AI Onboarding 가이드 생성을 시작합니다...");
    console.time("소요 시간");

    try {
        const { model, commitInfo } = await getModel(requestedBranch);
        
        const guideText = await generateAIGuide(model, commitInfo.appName);
        
        console.log("\n====================================================");
        console.log("📄 생성된 가이드 요약:");
        console.log(guideText.substring(0, 500) + "...");
        console.log("\n====================================================");
        
    } catch (error) {
        console.error("❌ 가이드 생성 중 에러 발생:", error);
    } finally {
        console.timeEnd("소요 시간");
        process.exit(0);
    }
}

runOnboarding();
