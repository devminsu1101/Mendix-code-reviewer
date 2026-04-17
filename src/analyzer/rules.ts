export interface BestPractice {
    id: string;
    description: string;
    recommendation: string;
    target: string;
}

export const MendixRules: Record<string, BestPractice> = {
    // 로직(Logic) 관련 규칙
    LOOP_DB_OPERATION: {
        id: "L001",
        description: "루프 내부에서 데이터베이스 작업(Retrieve/Commit)을 수행하면 성능이 기하급수적으로 저하됩니다.",
        recommendation: "루프 진입 전 'Retrieve'를 수행하여 List 변수를 만들고, 루프 안에서는 'Find/Filter' 작업을 수행하세요. 저장은 루프 종료 후 'Commit' 한 번으로 처리하세요.",
        target: "0건"
    },
    HIGH_COMPLEXITY: {
        id: "L002",
        description: "마이크로플로우의 액션이 너무 많으면 가독성이 떨어지고 에러 추적이 어렵습니다.",
        recommendation: "기능별로 로직을 쪼개어 'Sub-Microflow'로 만드세요. 하나의 마이크로플로우는 하나의 책임만 가져야 합니다.",
        target: "20개 미만"
    },
    TOO_MANY_PARAMS: {
        id: "L003",
        description: "파라미터가 너무 많으면 해당 로직이 다른 엔티티에 과도하게 의존하고 있다는 신호입니다.",
        recommendation: "파라미터들을 하나의 'Wrapper Entity'(Non-Persistable)로 묶어서 전달하거나, 엔티티 구조를 단순화하세요.",
        target: "5개 미만"
    },

    // 도메인(Domain) 관련 규칙
    DATA_SPAGHETTI: {
        id: "D001",
        description: "엔티티 간 연관관계가 너무 많으면 데이터 동기화와 조회 성능에 악영향을 줍니다.",
        recommendation: "불필요한 Association을 제거하고, GUID를 저장하거나 상속(Generalization) 대신 구성(Composition)을 사용해 보세요.",
        target: "5개 미만"
    },
    NP_PERSISTABLE_ERROR: {
        id: "D002",
        description: "NP_(Non-Persistable) 접두사가 붙은 엔티티가 DB에 저장되도록 설정되어 있습니다.",
        recommendation: "Entity의 'Persistable' 속성을 'No'로 변경하거나, 접두사를 일반적인 엔티티 형식으로 바꾸세요.",
        target: "0건"
    },
    MISSING_INDEX: {
        id: "D003",
        description: "대량의 데이터를 가진 엔티티에 인덱스가 없으면 조회 쿼리가 매우 느려집니다.",
        recommendation: "주로 검색 조건으로 사용되는 Attribute(예: ID, 날짜, 구분코드)에 'Index'를 추가하세요.",
        target: "필수 적용"
    }
};
