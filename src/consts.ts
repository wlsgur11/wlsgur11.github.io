// 사이트 전역 데이터. 어디서든 import 해서 사용.

export const SITE_TITLE = '문진혁 · Moon Jin Hyeok';
export const SITE_DESCRIPTION =
	'백엔드·인프라 개발자 문진혁. 실서비스 운영, 부하 테스트, 장애 진단 기록.';

export const PROFILE = {
	name: '문진혁',
	nameEn: 'Moon Jin Hyeok',
	role: 'Backend / Infra Engineer',
	tagline:
		'실서비스를 직접 굴리며 배웁니다. 증상이 아니라 근본 원인을, 감이 아니라 실측으로.',
	email: 'octopus121@naver.com',
	github: 'https://github.com/wlsgur11',
	githubHandle: 'wlsgur11',
	instagram: 'https://www.instagram.com/wlsgur_11/',
	instagramHandle: 'wlsgur_11',
};

// 블로그 글이 속한 프로젝트 표시명 (frontmatter project slug → 라벨)
export const PROJECT_LABELS: Record<string, string> = {
	'code-place': 'Code Place',
	'pnu-modu': 'PNU-Modu',
	pnuaicms: 'PNUAICMS',
	simlog: 'SimLog',
};

export const NAV = [
	{ href: '/', label: 'Home' },
	{ href: '/projects', label: 'Projects' },
	{ href: '/blog', label: 'Blog' },
];
