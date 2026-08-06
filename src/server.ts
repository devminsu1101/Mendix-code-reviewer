// src/server.ts
import express from 'express';
import { startReview } from './index.js';

const app = express();
app.use(express.json());

// Mendix 또는 GitHub Webhook 수신용 엔드포인트
app.post('/webhook/mendix', async (req, res) => {
    const { branch, commitId, author } = req.body;
    
    console.log(`\n🔔 [Webhook] 새 커밋 감지!`);
    console.log(`   > 브랜치: ${branch || 'main'}`);
    console.log(`   > 커밋: ${commitId || '최신'}`);
    console.log(`   > 작성자: ${author || '알 수 없음'}`);

    // 응답은 즉시 보냄 (Webhook 타임아웃 방지)
    res.status(202).json({ message: "리뷰가 시작되었습니다." });

    try {
        // 증분 리뷰는 스냅샷 diff 기반으로 별도 구현 예정(NEXT.md STEP 3/4).
        // 시간 기반 추측은 실제로 동작하지 않아 제거했다. 지금은 전수 리뷰.
        await startReview(branch);
    } catch (error) {
        console.error("❌ Webhook 리뷰 중 에러 발생:", error);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`
    -------------------------------------------
    🚀 Mendix Review Bot Server 가동 중!
    📍 Endpoint: http://localhost:${PORT}/webhook/mendix
    -------------------------------------------
    `);
});
