export interface BestPractice {
    id: string;
    description: string;
    recommendation: string;
    target: string;
    /** 우선순위 산정용 기본 점수. 진입점 위험도에 따라 배수가 곱해진다. */
    baseScore: number;
}

export const MendixRules: Record<string, BestPractice> = {
    // ── 로직(Logic) ──────────────────────────────────────────────
    LOOP_DB_RETRIEVE: {
        id: "L001",
        description: "루프 내부에서 데이터베이스 Retrieve를 수행하면 N+1 쿼리가 발생합니다.",
        recommendation:
            "루프 진입 전에 필요한 리스트를 한 번에 Retrieve하고, 루프 안에서는 'Find by expression'으로 메모리상에서 찾으세요.",
        target: "0건",
        baseScore: 40,
    },
    LOOP_COMMIT: {
        id: "L002",
        description: "루프 내부에서 Commit이 발생하면 반복 횟수만큼 트랜잭션이 발생합니다.",
        recommendation:
            "루프 안에서는 객체 값만 변경(Change, Commit=No)하고, 리스트에 담아 루프 종료 후 한 번에 Commit 하세요.",
        target: "0건",
        baseScore: 45,
    },
    HIGH_COMPLEXITY: {
        id: "L003",
        description: "마이크로플로우의 액션이 너무 많으면 가독성이 떨어지고 에러 추적이 어렵습니다.",
        recommendation:
            "기능별로 로직을 쪼개어 'Sub-Microflow'로 만드세요. 하나의 마이크로플로우는 하나의 책임만 가져야 합니다.",
        target: "25개 미만",
        baseScore: 15,
    },
    TOO_MANY_PARAMS: {
        id: "L004",
        description: "파라미터가 너무 많으면 해당 로직이 다른 엔티티에 과도하게 의존한다는 신호입니다.",
        recommendation:
            "파라미터들을 하나의 Wrapper Entity(Non-Persistable)로 묶어 전달하거나, 엔티티 구조를 단순화하세요.",
        target: "7개 미만",
        baseScore: 10,
    },
    NESTED_LOOP: {
        id: "L005",
        description: "중첩 루프는 데이터가 늘어날수록 실행 시간이 제곱으로 증가합니다.",
        recommendation:
            "안쪽 루프의 대상을 바깥 루프 진입 전에 Map 형태(리스트+Find)로 준비해 두고, 중첩을 단일 루프로 펴세요.",
        target: "0건",
        baseScore: 50,
    },
    ORPHAN_FLOW: {
        id: "L006",
        description:
            "어떤 진입점(페이지·스케줄·공개 서비스·워크플로우)에서도 도달할 수 없는 마이크로플로우입니다.",
        recommendation:
            "실제로 쓰이지 않는다면 삭제하세요. 죽은 코드는 리팩터링 때마다 비용을 발생시킵니다. Java 액션이나 문자열 기반 호출로만 쓰인다면 예외로 문서화하세요.",
        target: "0건",
        baseScore: 8,
    },
    NO_ROLLBACK: {
        id: "L007",
        description:
            "Custom 에러 처리가 롤백 없이 설정되어 있습니다. 실패 시 절반만 커밋된 데이터가 남습니다.",
        recommendation:
            "에러 처리를 'Rollback'으로 바꾸거나, Custom without rollback이 의도라면 보상 트랜잭션을 명시적으로 작성하세요.",
        target: "0건",
        baseScore: 30,
    },
    DUPLICATE_LOGIC: {
        id: "L008",
        description: "액션 구성과 순서가 동일한 마이크로플로우가 여러 개 존재합니다.",
        recommendation:
            "공통 부분을 Sub-Microflow로 추출하세요. 지금은 한 곳을 고치면 나머지도 같이 고쳐야 합니다.",
        target: "0건",
        baseScore: 5,
    },

    // ── 도메인(Domain) ───────────────────────────────────────────
    DATA_SPAGHETTI: {
        id: "D001",
        description: "엔티티 간 연관관계가 너무 많으면 데이터 동기화와 조회 성능에 악영향을 줍니다.",
        recommendation:
            "불필요한 Association을 제거하고, 상속(Generalization) 대신 구성(Composition)을 고려하세요.",
        target: "5개 미만",
        baseScore: 20,
    },
    NP_PERSISTABLE_ERROR: {
        id: "D002",
        description: "NP_(Non-Persistable) 접두사가 붙은 엔티티가 DB에 저장되도록 설정되어 있습니다.",
        recommendation:
            "Entity의 'Persistable' 속성을 'No'로 변경하거나, 접두사를 일반 엔티티 형식으로 바꾸세요.",
        target: "0건",
        baseScore: 25,
    },
    MISSING_INDEX: {
        id: "D003",
        description: "대량 데이터를 가진 엔티티에 인덱스가 없으면 조회 쿼리가 매우 느려집니다.",
        recommendation:
            "주로 검색 조건으로 사용되는 Attribute(ID, 날짜, 구분코드)에 Index를 추가하세요.",
        target: "필수 적용",
        baseScore: 15,
    },
    NO_ACCESS_RULE: {
        id: "D004",
        description:
            "Persistable 엔티티에 접근 규칙(Access Rule)이 하나도 없습니다. 보안이 켜지면 아무도 못 읽거나, 규칙 추가 시 의도치 않게 전면 개방됩니다.",
        recommendation:
            "이 엔티티를 읽고 쓰는 모듈 역할을 정하고 Access Rule을 명시하세요. 정말 내부 전용이라면 Non-Persistable인지 재검토하세요.",
        target: "0건",
        baseScore: 22,
    },
    UNCONSTRAINED_ACCESS: {
        id: "D005",
        description:
            "읽기 권한이 XPath 제약 없이 열려 있습니다. 해당 역할은 이 엔티티의 모든 행을 볼 수 있습니다.",
        recommendation:
            "테넌트·소유자·조직 단위로 걸러야 하는 데이터라면 Access Rule에 XPath constraint를 추가하세요.",
        target: "검토 필요",
        baseScore: 18,
    },
    HOT_ENTITY: {
        id: "D006",
        description:
            "매우 많은 마이크로플로우가 이 엔티티를 직접 조회·변경합니다. 스키마 변경 시 파급 반경이 큽니다.",
        recommendation:
            "이 엔티티에 대한 접근을 전용 Sub-Microflow(예: Get/Save 래퍼)로 모아 파급 반경을 줄이세요.",
        target: "검토 필요",
        baseScore: 12,
    },
    STRONG_COUPLING: {
        id: "D007",
        description: "모듈 간 엔티티 참조가 과도합니다. 순환 참조와 배포 단위 분리 실패로 이어집니다.",
        recommendation:
            "공유되는 엔티티들을 'Common' 또는 'Shared' 모듈로 이동시키는 것을 고려하세요.",
        target: "3건 미만",
        baseScore: 12,
    },

    // ── 페이지(Page) ─────────────────────────────────────────────
    NO_PAGE_TITLE: {
        id: "P001",
        description: "페이지 타이틀이 비어 있습니다.",
        recommendation: "사용자가 현재 어떤 화면에 있는지 알 수 있도록 Page Title을 입력하세요.",
        target: "0건",
        baseScore: 4,
    },
    PAGE_NO_ROLES: {
        id: "P002",
        description:
            "이 페이지에 허용된 모듈 역할이 지정되어 있지 않습니다. 보안 설정에 따라 접근 불가 또는 무제한 노출이 됩니다.",
        recommendation: "페이지의 'Visible for' 모듈 역할을 명시하세요.",
        target: "0건",
        baseScore: 20,
    },
};
