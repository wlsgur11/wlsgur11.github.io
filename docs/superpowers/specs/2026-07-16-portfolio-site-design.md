# 포트폴리오 + 블로그 사이트 설계

> 작성일: 2026-07-16 / 개발자: 문진혁 (GitHub `wlsgur11`)
> 참고 사이트: https://jun0.dev (미니멀, 타이포 중심, GitHub Pages)

## 1. 목표

- 백엔드·인프라 중심의 **깊이 있는** 프로젝트 케이스스터디 + 기술 블로그를 담는 개인 사이트.
- 장기 프로젝트. 콘텐츠를 계속 쌓아간다. 자소서가 아니라 **포트폴리오/블로그**용이라 상세할수록 좋다.
- 정식 문체(존중체). 한국어 우선, 영어 나중.

## 2. 기술 스택

| 항목 | 선택 | 이유 |
|---|---|---|
| 프레임워크 | **Astro** (공식 blog 스타터 기반) | 마크다운/MDX 콘텐츠 최적, 빠름, GitHub Pages 친화. 스타터에 content collections·RSS·sitemap 내장 → 추가 의존성 최소화 |
| 콘텐츠 | Markdown/MDX + Content Collections | 프로젝트 상세는 MDX(컴포넌트 삽입), 블로그는 MD |
| i18n | Astro 내장 라우팅. `defaultLocale: ko`, `locales: [ko, en]`, ko는 루트 | 초반 한글만 작성, 영어는 파일 추가로 확장 |
| 스타일 | 미니멀 커스텀 CSS + 다크모드 | jun0.dev 느낌. 프레임워크/UI 라이브러리 안 씀 |
| 배포 | GitHub Actions (`withastro/action`) → GitHub Pages | 자동 배포 |
| 저장소 | `wlsgur11.github.io` (유저 사이트, 루트 서빙) | 커스텀 도메인 연결 쉬움 |
| 도메인 | 커스텀 도메인 (`public/CNAME`) | 나중에 구입·연결. 그전엔 `wlsgur11.github.io` |
| PDF | 인쇄최적화 `/portfolio` 페이지 → 브라우저 인쇄 | 별도 파이프라인 없음. 콘텐츠 재사용 |

## 3. 사이트 구조

```
/                 홈: 히어로 + 한 줄 소개 + 대표 프로젝트 3 + 최근 글
/projects         프로젝트 목록
  /projects/code-place    OJ 플랫폼 (백엔드·인프라 깊이) ★대표
  /projects/pnuaicms      AI기업 관리 통합 시스템 (실무 운영중)
  /projects/pnu-modu      서버리스 협업 CMS
/blog             블로그 목록 (태그: troubleshooting / retrospective / learning)
  /blog/[slug]
/about            소개: 경력, 학력, 자격증, 수상, 스킬, 연락처
/portfolio        인쇄최적화 통합 뷰 (PDF 출력용)
```

## 4. 콘텐츠 모델

### 4-1. projects 컬렉션 (MDX)
frontmatter: `title, slug, role, period, stack[], summary, links{repo,live}, featured, order, cover`
본문 구조(표준): **개요 → 아키텍처 → 핵심 성과(문제→진단→원인→해결→결과) → 회고**

### 4-2. blog 컬렉션 (MD/MDX)
frontmatter: `title, slug, date, tags[], project?, summary, cover, draft`
문제해결 포스트 표준: **TL;DR → 배경/재현 → 진단 타임라인 → 근본 원인 → 해결 → 재발 방지 → 교훈**

## 5. code-place 콘텐츠 (이번 세션 우선, 인프라 중심)

소스: 사용자 제공 포트폴리오 초안 + Notion export 10건 + 로컬 `C:\code-place` 소스 + AI 부하테스트 정리 문서.

### 프로젝트 페이지 `projects/code-place`
- 개요: 부산대 기초컴퓨터프로그래밍 실서비스 OJ. QingdaoU OJ 기반. 8인 팀, 3인 개발팀 리딩. 인프라+백엔드 주력.
- 아키텍처: 서비스/인프라 2개 다이어그램 (README github asset 임베드 또는 재작성 mermaid).
- 스택: Django 3.2→5.2 · DRF · Vue2 · PostgreSQL · Redis · K3s · Longhorn · Harbor · kube-vip · Traefik · GitHub Actions · 자체 vLLM(Qwen3.5-9B, RTX 5090).

### 블로그 포스트(code-place 시드)
1. **AI 조교 부하테스트 전 과정** (대표작, 시리즈 가능)
   - 기획(3초 목표, 온프레미스/치팅방지) → Ollama codellama 베이스라인(동접 2~3) → Modelfile 최적화(95%지연 73s→2.3s, 동접 12) → 한계탐색(PARALLEL 8vs16) → 실사용 입력 검증(500토큰서 12.1s 붕괴) → vLLM 전환(30명 2.89s/50명 3.4s 실패 0, 캐시 95%+) → K3s 배포 장애(Longhorn/multipathd, 5분 DB다운, VLLM_PORT 환경변수 충돌) → 프롬프트 품질 개선.
   - 실측 수치·Locust 그래프·GPU 스샷 다수 보유.
2. **운영 백엔드 크래시루프(재시작 398회) 진단** — probe/이미지 릴리즈 스큐. logs→describe→rs→git→exec 계층 진단. `패치_전.png` 보유.
3. **CI 매니페스트 자동커밋 race condition** — concurrency 직렬화 + idempotent 재적용. (mermaid gitGraph)
4. (백로그) GitOps "소스≠배포" 규명, 로컬 개발환경 트러블슈팅 모음.

## 6. 순서

1. **[이번] 사이트 기반 스캐폴드 + 배포 파이프라인** (Astro blog 스타터 → 커스터마이즈, GH Actions, CNAME 준비)
2. **[이번] code-place 프로젝트 페이지 + 블로그 포스트 1~3** (인프라 중심, 스크린샷 반영)
3. PNUAICMS 케이스스터디 (public repo 분석 + 통합시스템 비전)
4. PNU-Modu 케이스스터디 (자소서 분석 md 활용)
5. about 페이지, /portfolio 인쇄 뷰
6. 영어판, 나머지 블로그 이관

## 7. 결정된 것 / 미결

- 결정: Astro, 한/영, 커스텀 도메인(나중), 큰 프로젝트 3개, 인프라 강조, 정식 문체.
- 미결: 실제 도메인 문자열, 라이브 UI/인프라 대시보드 스크린샷 일부(§ 스크린샷 요청 참고).
