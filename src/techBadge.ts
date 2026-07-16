// 기술 이름 -> [배경 브랜드색, 글자색]. shields.io 스타일 브랜드 컬러 배지.
// 라벨에 버전이 붙어도(예: "Django 3.2→5.2") 키가 포함되면 매칭. 긴 키 우선.
const COLORS: Record<string, [string, string]> = {
	'spring boot': ['#6DB33F', '#fff'],
	'github actions': ['#2088FF', '#fff'],
	javascript: ['#F7DF1E', '#111'],
	typescript: ['#3178C6', '#fff'],
	kubernetes: ['#326CE5', '#fff'],
	docusaurus: ['#3ECC5F', '#111'],
	postgres: ['#4169E1', '#fff'],
	supabase: ['#3FCF8E', '#111'],
	fastapi: ['#009688', '#fff'],
	longhorn: ['#5F259F', '#fff'],
	flutter: ['#02569B', '#fff'],
	python: ['#3776AB', '#fff'],
	django: ['#0C4B33', '#fff'],
	sqlite: ['#003B57', '#fff'],
	prisma: ['#2D3748', '#fff'],
	ollama: ['#111111', '#fff'],
	docker: ['#1D63ED', '#fff'],
	harbor: ['#60B932', '#fff'],
	github: ['#181717', '#fff'],
	redis: ['#FF4438', '#fff'],
	mysql: ['#4479A1', '#fff'],
	react: ['#087EA4', '#fff'],
	java: ['#E76F00', '#fff'],
	node: ['#5FA04E', '#fff'],
	next: ['#111111', '#fff'],
	vllm: ['#30A2FF', '#fff'],
	dart: ['#0175C2', '#fff'],
	drf: ['#A30000', '#fff'],
	vue: ['#42B883', '#fff'],
	mdx: ['#1B1F24', '#fff'],
};

const KEYS = Object.keys(COLORS).sort((a, b) => b.length - a.length);

// 매칭되면 inline style 문자열, 없으면 '' (기본 pill 스타일 유지)
export function techBadgeStyle(label: string): string {
	const l = label.toLowerCase();
	for (const k of KEYS) {
		if (l.includes(k)) {
			const [bg, fg] = COLORS[k];
			return `background:${bg};color:${fg};border-color:transparent`;
		}
	}
	return '';
}
