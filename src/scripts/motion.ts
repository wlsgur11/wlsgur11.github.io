// 사이트 모션 (GSAP + ScrollTrigger). 웹 이력서형이라 두 가지뿐이다.
// 1. 페이지에 들어올 때 본문([data-enter])이 아주 살짝 나타난다 (뷰 전환 애니메이션을 끈 대신).
// 2. 글 상세 맨 위 2px 읽기 진행 바.
// 숨김 초기상태는 CSS 가 아니라 gsap.from 으로만 만든다(스크립트가 없으면 그대로 보인다).
// reduced-motion 이면 아무것도 하지 않는다. transform/opacity 만 움직인다.
// ClientRouter 대응: astro:page-load 마다 init, astro:before-swap 에서 전부 되돌린다.
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

let mm: gsap.MatchMedia | null = null;

function teardown() {
	mm?.revert(); // matchMedia 안에서 만든 tween 과 ScrollTrigger 를 모두 되돌린다
	mm = null;
}

function init() {
	teardown(); // 중복 초기화 방지
	mm = gsap.matchMedia();
	mm.add('(prefers-reduced-motion: no-preference)', () => {
		const enter = document.querySelector<HTMLElement>('[data-enter]');
		if (enter) {
			gsap.from(enter, { autoAlpha: 0, y: 6, duration: 0.45, ease: 'power2.out', clearProps: 'all' });
		}

		const bar = document.querySelector<HTMLElement>('[data-read-progress]');
		const article = document.querySelector<HTMLElement>('[data-article]');
		if (bar && article) {
			gsap.fromTo(
				bar,
				{ scaleX: 0 },
				{
					scaleX: 1,
					ease: 'none',
					scrollTrigger: { trigger: article, start: 'top top', end: 'bottom bottom', scrub: 0.3 },
				},
			);
		}
	});
}

document.addEventListener('astro:page-load', init);
document.addEventListener('astro:before-swap', teardown);
