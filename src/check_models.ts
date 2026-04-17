
import { GoogleGenerativeAI } from "@google/generative-ai";
import { config } from "dotenv";
config();

async function listModels() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        console.error("❌ GEMINI_API_KEY가 없습니다.");
        return;
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    try {
        // @google/generative-ai 라이브러리에서 모델 목록을 가져오는 방식은 
        // 클라이언트에서 직접 지원하지 않을 수 있어 API를 직접 찌르거나 
        // 지원되는 모델명을 추측해야 합니다.
        // 대신, 가장 일반적인 모델들을 하나씩 테스트해보고 되는 것을 찾습니다.
        
        const modelsToTest = [
            "gemini-2.5-flash",
            "gemini-2.5-flash-lite",
            "gemini-3-flash", 
            "gemini-3.1-flash-lite",
        ];
        console.log("🔍 사용 가능한 모델 테스트 중...");

        for (const modelName of modelsToTest) {
            try {
                const model = genAI.getGenerativeModel({ model: modelName });
                await model.generateContent("test");
                console.log(`✅ [${modelName}] 모델 사용 가능!`);
            } catch (err: any) {
                console.log(`❌ [${modelName}] 사용 불가 (${err.message.substring(0, 50)}...)`);
            }
        }
    } catch (error) {
        console.error("에러 발생:", error);
    }
}

listModels();
