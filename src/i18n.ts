// 최소 i18n. ko 기본(루트), en은 /en 프리픽스.

export type Lang = 'ko' | 'en';
export const defaultLang: Lang = 'ko';
export const languages: Record<Lang, string> = { ko: '한국어', en: 'EN' };

export const ui = {
	ko: {
		role: 'Backend / Infra Engineer',
		tagline: '실서비스를 직접 굴리며 배웁니다. 증상이 아니라 근본 원인을, 감이 아니라 실측으로.',
		projects: 'Projects',
		writing: 'Writing',
		viewAll: '전체 보기 →',
		viewDetail: '자세히 보기 →',
		projectsTitle: 'Projects',
		projectsSubtitle: '실서비스로 운영했거나 규모 있는 프로젝트를 깊게 정리합니다.',
		majorActivities: '주요 활동',
		majorProjects: '주요 프로젝트',
		moreProjects: '추가 프로젝트',
		aboutTitle: 'About',
		koreanNotice: '',
	},
	en: {
		role: 'Backend / Infra Engineer',
		tagline:
			'I learn by running real services in production. Root cause over symptom, measurement over guesswork.',
		projects: 'Projects',
		writing: 'Writing',
		viewAll: 'View all →',
		viewDetail: 'Read more →',
		projectsTitle: 'Projects',
		projectsSubtitle: 'In-depth write-ups of production services and larger projects.',
		majorActivities: 'Featured activity',
		majorProjects: 'Featured projects',
		moreProjects: 'More projects',
		aboutTitle: 'About',
		koreanNotice: 'This article is written in Korean.',
	},
} as const;

export function getLang(url: URL): Lang {
	return url.pathname.startsWith('/en') ? 'en' : 'ko';
}

export function useTranslations(lang: Lang) {
	return (key: keyof (typeof ui)['ko']) => ui[lang][key] || ui.ko[key];
}

// ko 경로에 lang 프리픽스를 붙인다. ('/about' -> '/en/about', lang=ko면 그대로)
export function localize(path: string, lang: Lang): string {
	if (lang === 'ko') return path;
	return '/en' + (path === '/' ? '' : path);
}

// 현재 경로의 반대 언어 경로 (언어 토글용)
export function togglePath(pathname: string): string {
	if (pathname.startsWith('/en')) {
		const rest = pathname.slice(3);
		return rest === '' ? '/' : rest;
	}
	return '/en' + (pathname === '/' ? '' : pathname);
}
