// src/client.ts
import { config } from 'dotenv';
config({ override: true });
import { MendixPlatformClient, setPlatformConfig } from "mendixplatformsdk";

/** 인증 설정 후 App 객체를 돌려준다. getModel과 blame이 공유한다. */
export function getApp() {
    const token = process.env.MENDIX_TOKEN;
    const appId = process.env.MENDIX_APP_ID;
    if (!token || !appId) {
        throw new Error("❌ .env 파일에 MENDIX_TOKEN 또는 MENDIX_APP_ID가 없습니다!");
    }
    setPlatformConfig({ mendixToken: token });
    return { app: new MendixPlatformClient().getApp(appId), appId };
}

/**
 * 특정 커밋 시점의 모델을 연다. blame(귀속 추적)에서 과거로 거슬러 갈 때 쓴다.
 * 진행 로그를 찍지 않는다 — 수십 번 호출되므로 콘솔이 묻힌다.
 */
export async function getModelAtCommit(branchName: string, commitId: string) {
    const { app } = getApp();
    const workingCopy = await app.createTemporaryWorkingCopy(branchName, { commitId });
    return await workingCopy.openModel();
}

export async function getModel(requestedBranch?: string) {
    const token = process.env.MENDIX_TOKEN;
    const appId = process.env.MENDIX_APP_ID;
    const branchName = requestedBranch || process.env.MENDIX_BRANCH || "main";

    if (!token || !appId) {
        throw new Error("❌ .env 파일에 MENDIX_TOKEN 또는 MENDIX_APP_ID가 없습니다!");
    }

    setPlatformConfig({ mendixToken: token });
    const client = new MendixPlatformClient();
    
    console.log(`🔗 멘딕스 서버 접속 시도 중... (App ID: ${appId})`);
    const app = client.getApp(appId);
    
    try {
        const repository = app.getRepository();
        
        // 1. 커밋 정보 가져오기 (v5+)
        console.log(`📜 브랜치 [${branchName}]의 최신 커밋 정보를 가져오는 중...`);
        const commitsResponse = await repository.getBranchCommits(branchName);
        const latestCommit = commitsResponse.items[0];

        if (!latestCommit) {
            throw new Error(`❌ 브랜치 [${branchName}]에서 커밋 기록을 찾을 수 없습니다.`);
        }

        const authorName = latestCommit.author?.name || latestCommit.author?.email || "Unknown User";
        const commitDate = latestCommit.date ? new Date(latestCommit.date) : new Date();
        
        // 2. Temporary Working Copy 생성
        // 로그를 확인해보니 현재 SDK 버전은 문자열을 직접 받는 것으로 보입니다.
        console.log(`🌿 브랜치 [${branchName}] 기반으로 Temporary Working Copy 생성 중...`);
        const workingCopy = await app.createTemporaryWorkingCopy(branchName);
        console.log(`✅ Working Copy 생성 완료! (ID: ${workingCopy.workingCopyId})`);
        
        // 3. 모델 오픈
        console.log("📂 모델 데이터를 로드하는 중...");
        const model = await workingCopy.openModel();
        console.log("🚀 모델 로딩 성공! 분석을 시작합니다.");
        
        return {
            model,
            commitInfo: {
                // Platform SDK의 App에는 name이 없다(appId만 있음).
                // 리포트 폴더가 매번 "UnknownApp"이 되던 원인. 이름을 쓰려면 .env에 지정한다.
                appName: process.env.MENDIX_APP_NAME || appId,
                branch: branchName,
                author: authorName,
                date: commitDate,
                revId: latestCommit.id,
                message: latestCommit.message || "(No message)",
                appId: appId
            }
        };
    } catch (error: any) {
        if (error.responseStatus === 403) {
            throw new Error(`❌ 403 Forbidden: 권한이 부족합니다. 토큰 유효성 및 해당 앱(${appId})에 대한 API 접근 권한을 확인하세요.`);
        } else if (error.responseData) {
            throw new Error(`❌ 멘딕스 서버 에러: ${error.responseData}`);
        }
        throw error;
    }
}
