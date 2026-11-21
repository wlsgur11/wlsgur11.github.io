// 사이트 모션 (GSAP + ScrollTrigger).
// 원칙: 콘텐츠는 마크업 그대로 보이는 게 기본. 숨김 초기상태는 CSS 가 아니라 여기서 gsap.set/from 으로만 만들고,
// reduced-motion 이면 아무것도 하지 않는다. transform/opacity 만 움직인다.
// ClientRouter 대응: astro:page-load 마다 init, astro:before-swap 에서 전부 되돌린다.
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';

gsap.registerPlugin(ScrollTrigger);

let mm: gsap.MatchMedia | null = null;

function teardown() {
	mm?.revert(); // matchMedia 안에서 만든 tween, set, ScrollTrigger 를 모두 되돌린다
	mm = null;
	ScrollTrigger.getAll().forEach((t) => t.kill());
}

function init() {
	teardown(); // 중복 초기화 방지
	mm = gsap.matchMedia();
	mm.add('(prefers-reduced-motion: no-preference)', () => {
		// 1. 히어로: 헤드라인, 서브텍스트, 연락처 순으로 등장 (읽는 순서 = 위계)
		const hero = gsap.utils.toArray<HTMLElement>('[data-hero]');
		if (hero.length) {
			gsap.from(hero, { autoAlpha: 0, y: 18, duration: 0.7, ease: 'power3.out', stagger: 0.09 });
		}

		// 2. 숫자 띠: 화면에 들어올 때 0 에서 실제 값까지 한 번 카운트업 (측정 서사).
		//    마크업에는 최종값이 그대로 있고, 끝나거나 되돌리면 원래 텍스트로 복원한다.
		//    data-count 는 표시값 그대로("51,070") 둔다. 세는 중에도 천 단위 쉼표를 붙인다.
		const nums = gsap.utils.toArray<HTMLElement>('[data-count]');
		const finals = nums.map((el) => el.textContent ?? '');
		nums.forEach((el, i) => {
			const raw = (el.dataset.count ?? '').replace(/,/g, '');
			const end = Number.parseFloat(raw);
			if (!Number.isFinite(end)) return;
			const decimals = (raw.split('.')[1] ?? '').length;
			const fmt = new Intl.NumberFormat('en-US', {
				minimumFractionDigits: decimals,
				maximumFractionDigits: decimals,
			});
			const o = { v: 0 };
			gsap.to(o, {
				v: end,
				duration: 1.3,
				ease: 'power2.out',
				scrollTrigger: { trigger: el.closest('[data-band]') ?? el, start: 'top bottom', once: true },
				onUpdate: () => {
					el.textContent = fmt.format(o.v);
				},
				onComplete: () => {
					el.textContent = finals[i];
				},
			});
		});

		// 3. 목록 행: 화면에 들어오는 묶음끼리 한 번만 살짝 올라온다 (순서).
		//    start 를 'bottom-=60' 으로 둬서 페이지 맨 끝 행도 반드시 트리거된다(푸터가 60px 보다 크다).
		const rows = gsap.utils.toArray<HTMLElement>('[data-reveal]');
		if (rows.length) {
			gsap.set(rows, { autoAlpha: 0, y: 16 });
			ScrollTrigger.batch(rows, {
				start: 'top bottom-=60',
				once: true,
				onEnter: (batch) =>
					gsap.to(batch, {
						autoAlpha: 1,
						y: 0,
						duration: 0.6,
						ease: 'power2.out',
						stagger: 0.06,
						overwrite: true,
					}),
			});
		}

		// 4. 글 상세: 맨 위 2px 읽기 진행 바 (피드백). 본문 구간에 scrub.
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

		return () => {
			nums.forEach((el, i) => {
				el.textContent = finals[i];
			});
		};
	});
}

document.addEventListener('astro:page-load', init);
document.addEventListener('astro:before-swap', teardown);
