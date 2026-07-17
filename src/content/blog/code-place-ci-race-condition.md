---
title: 'CI가 자기 레포에 커밋할 때의 레이스 컨디션 - concurrency 직렬화'
titleEn: 'When CI commits to its own repo - a race fixed with concurrency serialization'
description: 'PR을 연달아 머지하니 이미지 태그를 매니페스트에 자동 커밋하는 잡이 rebase 충돌로 줄줄이 실패했다. concurrency 직렬화와 merge 아닌 idempotent 재적용으로 해결한 기록.'
descriptionEn: 'Merging PRs back-to-back made the image-tag auto-commit job fail on rebase conflicts. Fixed with concurrency serialization and idempotent reapply instead of merge.'
pubDate: 2026-05-28
tags: ['troubleshooting', 'infra', 'ci-cd']
project: 'code-place'
draft: false
---

> **TL;DR** - GitHub Actions가 빌드한 이미지 태그를 kustomization 매니페스트에 자동 커밋하는데, PR을 1분 안에 여러 개 머지하면 잡들이 같은 파일 같은 줄을 동시에 push하다 rebase 충돌로 실패했습니다. **`concurrency`로 직렬화**하고, `git pull --rebase` 대신 **idempotent 재적용(fetch → reset → 태그 덮어쓰기 → push 재시도)**으로 바꿔 해결했습니다.

## 파이프라인 구조

```
push(develop)
  → detect-changes-by-component   (paths-filter: backend / frontend / hub-auth)
  → ci-{component}-dev            Docker build & push,  tag = ${github.sha}-dev
                                  (변경된 컴포넌트만)
  → update-dev-manifest           yq로 kustomization.yaml의 newTag 갱신
                                  → commit "[skip ci]"
                                  → git pull --rebase
                                  → push
```

태그 갱신 스텝이 컴포넌트별 조건부(`if: needs.ci-*-dev.result == 'success'`)라, 바뀌지 않은 컴포넌트를 없는 SHA로 가리켜 ImagePull 에러를 내는 일은 막혀 있었습니다. 이 부분은 잘 설계돼 있었습니다.

## 증상

PR 여러 개를 1분 내에 연달아 머지하자, **첫 PR만 성공하고 나머지 `update-dev-manifest`가 전부 실패**했습니다.

```
CONFLICT (content): Merge conflict in kubernetes/overlays/dev/kustomization.yaml
error: could not apply ... ci: Update dev image tags ...
Error: Process completed with exit code 1
```

## 근본 원인

- 이 잡에 `concurrency` 설정이 없어 여러 실행이 **병렬**로 떴습니다.
- 각 잡이 "태그를 로컬 커밋 → `git pull --rebase`" 순서인데, 앞선 잡이 **같은 파일 같은 줄(이미지 태그)**을 이미 push한 상태라 rebase 시 충돌합니다. 첫 잡만 develop이 움직이지 않아 성공하고, 나머지는 줄줄이 실패했습니다.

## 해결

### 1. 직렬화

```yaml
concurrency:
  group: update-dev-manifest-${{ github.ref_name }}
  cancel-in-progress: false
```

### 2. merge 대신 idempotent 재적용

태그 지정은 "병합"이 아니라 "덮어쓰기"이므로, 최신을 받아 그 위에 다시 쓰면 충돌 자체가 사라집니다.

```bash
for i in 1 2 3 4 5; do
  git fetch origin "$BRANCH"
  git reset --hard "origin/$BRANCH"
  yq -i '(.images[]|select(.name=="backend").newTag)="'"$SHA"'-dev"' \
    kubernetes/overlays/dev/kustomization.yaml
  # frontend / hub-auth 동일
  git add kubernetes/overlays/dev/kustomization.yaml
  git diff --cached --quiet && exit 0          # 바뀐 게 없으면 성공 종료
  git commit -m "ci: update dev image tags [skip ci]"
  git push origin "$BRANCH" && exit 0
done
exit 1
```

## 교훈

동시성 제어가 없는 "CI가 레포에 자동 커밋하는" 패턴은 **머지 빈도가 오르면 반드시 깨집니다.** 공유 파일을 갱신하는 작업은 직렬화하거나, 병합이 아닌 **idempotent 재적용**으로 설계해야 합니다.
