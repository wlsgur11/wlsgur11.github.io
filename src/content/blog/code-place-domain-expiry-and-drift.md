---
title: '도메인 만료를 계기로 드러난 저장소와 클러스터 간 구성 드리프트 분석'
titleEn: 'Configuration Drift between Repository and Cluster, Exposed by a Domain Expiry'
description: '릴리즈를 하려다 두 달치 브랜치 충돌을 만났고, 그 와중에 도메인이 만료돼 CI와 인증 서버가 함께 멈췄다. 이틀에 걸쳐 도메인을 이전하고, 저장소와 서버가 어긋나 있던 자리들을 하나씩 맞춘 기록.'
descriptionEn: 'A release attempt ran into two months of branch conflicts, then the domain expired and took CI and the auth server down with it. Two days of migrating the domain and reconciling every place where the repo and the running cluster had drifted apart.'
pubDate: 2026-09-03
tags: ['troubleshooting', 'infra', 'kubernetes', 'ci-cd', 'learning']
project: 'code-place'
draft: false
---

릴리즈 하나 올리려던 날이었다. PR을 열었더니 충돌이 났고, 충돌을 풀었더니 CI가 죽었고, CI를 살렸더니 도메인이 만료돼 있었다. 도메인을 옮기고 나니 이번엔 배포 명령이 운영 DB 설정을 건드리려 했다. 배포를 마치고 파드 목록을 봤더니 DB 복제본 하나가 하루 넘게 죽어 있었다.

하나씩 따로 보면 별개의 사건인데, 이틀 동안 겪고 나니 대부분 같은 뿌리였다. 저장소에 적혀 있는 것과 실제로 돌아가는 것이 달라져 있었다.

## 요약

나중에 팀에 넘길 때 이 부분만 읽어도 되게 적어둔다.

`main`에만 생긴 수정을 `develop`으로 다시 가져오는 백머지를 계속 빠뜨려서, 두 브랜치가 두 달 동안 59커밋만큼 벌어져 있었다. 쿠버네티스 매니페스트는 급할 때마다 서버만 손대고 저장소를 안 고쳐서, 저장소대로 맞추라는 명령이 오히려 잘 돌던 걸 망가뜨릴 수 있는 상태였다. 그리고 서브도메인 여섯 개(이미지 저장소, 개발 서버, 인증 서버, 모니터링 등)를 매달아 쓰던 `code-place-dev.site`가 만료되면서 여섯 개가 동시에 끊겼다.

이틀 동안 충돌 9개를 풀어 브랜치를 손실 없이 합쳤고, 도메인을 새 주소로 옮겼고, 릴리즈 3.1.6을 무중단으로 배포했다. 하루 넘게 죽어 있던 DB 복제본을 되살렸고, 저장소와 실제 서버를 맞춰 배포 명령을 그냥 써도 되게 만들었다. 아래는 각각을 어떻게 했는지다.

## 1일차 - 릴리즈하려다 충돌부터 만났다

`release-3.1.6` 브랜치에서 `main`으로 PR을 열었더니 충돌이 떠 있었다. 처음엔 누가 같은 파일을 동시에 고쳤나 싶었다. 아니었다.

```
main에만: 59  develop에만: 23
공통 조상: 2026-07-02
```

두 브랜치가 두 달째 갈라져 있었다. `main`에만 59커밋이 쌓여 있다는 게 이상했다. `main`은 릴리즈 결과만 들어가는 곳인데.

여기서 백머지라는 걸 처음 제대로 이해했다. 릴리즈 브랜치를 `main`에 합치면, 그 `main`을 다시 `develop`으로 되돌려 합쳐야 한다. 그래야 다음 릴리즈 때 두 브랜치가 같은 지점에서 출발한다. 그걸 안 했다. 게다가 CI가 배포할 때마다 이미지 태그를 `main`에 직접 커밋하고 있어서, 릴리즈 한 번마다 격차가 자동으로 벌어지고 있었다.

CI가 자기 저장소에 커밋하는 구조는 전에도 말썽을 낸 적이 있다. `develop` 쪽 태그 갱신 잡에는 `concurrency`가 없어서, PR을 1분 안에 여러 개 머지하면 잡들이 병렬로 떠 같은 파일의 같은 줄(이미지 태그)을 push하려 했다. 각 잡이 태그를 로컬에 커밋한 뒤 `git pull --rebase`를 하는 순서라 첫 잡만 성공하고 나머지는 rebase 충돌로 줄줄이 실패했다. 태그 지정은 병합이 아니라 덮어쓰기라서, 잡을 직렬화하고 최신 브랜치를 받아(fetch, reset) 그 위에 태그를 다시 쓰는 재시도 방식이면 충돌 자체가 생기지 않는다. 이 잡에는 나중에 팀원 PR(#844)로 `concurrency` 직렬화와, 자기 커밋이 매니페스트에 적힌 태그보다 최신일 때만 덮어쓰는 조건이 들어갔다.

### 왜 34덩어리나 났나

충돌 파일이 9개였는데 `prometheus-rules.yaml` 하나에만 충돌 덩어리가 34개였다. 손으로 하나씩 보다가는 실수하기 딱 좋아 보였다.

원인을 따라가 보니 하나로 모였다. `#634 관측성 개선(#754)`이라는 같은 작업이 양쪽 브랜치에 다른 해시로 들어가 있었다.

| 브랜치 | 해시 | 날짜 |
| --- | --- | --- |
| main | `db76996b` | 2026-08-10 |
| develop | `64453105` | 2026-08-10 |

같은 날, 같은 내용, 다른 해시. cherry-pick으로 각각 붙인 흔적이다. Git은 커밋을 해시로 구분한다. 내용이 똑같아도 해시가 다르면 남남으로 본다. 공통 조상인 7월 2일에는 둘 다 없으니, Git 입장에선 "양쪽이 각자 이 파일을 새로 만들었다"가 된다. 거기에 `develop`이 그 위로 `#761`, `#762`를 더 얹었으니 충돌 덩어리가 34개까지 늘어난 것이다.

### 읽지 않고 판단하는 법

34덩어리를 눈으로 보는 대신 가설을 하나 세웠다.

> `main`의 파일 내용이 `develop`의 `#754` 시점 내용과 똑같다면, `develop`은 `main` + 개선분이다. 그러면 `develop` 쪽을 고르면 잃는 게 없다.

Git은 파일마다 blob 해시를 갖고 있어서, 파일을 열지 않고 해시만 비교하면 같은지 다른지 알 수 있다. 8개 파일 전부 일치했다.

```
_index.md                                동일 → develop이 상위집합
alertmanager-config.yaml                 동일 → develop이 상위집합
grafana-dashboard-monitoring-stack.yaml  동일 → develop이 상위집합
```

가설이 증명됐다. 34덩어리를 한 줄도 읽지 않고 `develop` 쪽 채택이 정답이라는 근거가 생겼다.

```bash
git checkout --ours -- kubernetes/monitoring/ kubernetes/overlays/dev/kustomization.yaml
```

`--ours`가 헷갈리기 쉬운데, 브랜치 이름이 아니라 지금 내가 서 있는 쪽을 뜻한다. 머지 중일 때와 리베이스 중일 때 가리키는 게 뒤집힌다. 근거 없이 쓰면 안 되는 명령이다. 우리는 위 검증이 있었으니 일괄 적용할 수 있었다.

### 진짜 안 날아갔는지 세어봤다

안전하다는 말만으로는 불안해서 파일 단위로 대조했다.

| 항목 | 결과 |
| --- | --- |
| develop 파일 수 | 811개 → 머지 결과 811개 (삭제 0) |
| develop과 다른 파일 | 4개 |
| develop 고유 작업 7개의 파일 손실 | 0개 |

다른 4개도 전부 `main`이 가져온 것이었다. 운영 이미지 태그 하나, 나머지 셋은 prettier 재정렬 같은 포매팅. `ContestCommunity.vue` 826줄도, 백엔드 커뮤니티 코드도 그대로 남았다.

머지가 무섭게 느껴졌던 건 덮어쓰기 같아서였는데, 실제로는 양쪽 이력을 다 두고 합류 지점 하나를 얹는 것이다. 작업이 날아가는 건 `git reset --hard` 같은 다른 명령이거나, 충돌 해소할 때 사람이 잘못 고르는 경우다. 관리해야 할 건 그 하나뿐이었다.

## 그 와중에 CI가 죽었다

충돌을 풀고 릴리즈로 넘어가려는데 GitHub Actions가 실패했다.

```
Error response from daemon: Get "https://***/v2/":
dial tcp: lookup *** on 127.0.0.53:53: no such host
```

이미지 빌드가 아니라 이름을 못 찾는 에러였다. 확인해보니 도메인 자체가 사라져 있었다.

```
harbor.code-place-dev.site  →  NXDOMAIN
code-place-dev.site         →  NXDOMAIN
code.pusan.ac.kr            →  정상
```

서브도메인만이 아니라 최상위 도메인이 통째로 안 풀렸다. Google DNS로 교차 확인해도 같았다. 도메인이 만료된 것이다.

### 생각보다 범위가 넓었다

CI만 멈춘 줄 알았는데 아니었다. 저장소에서 이 도메인을 찾아보니 75곳이었고, 서브도메인이 여섯 개였다.

| 서브도메인 | 용도 |
| --- | --- |
| `harbor` | 컨테이너 이미지 저장소 |
| `k3s` | 개발 서버 프론트엔드 |
| `hub-auth` | 운영 인증 서버 |
| `hub-auth-dev` | 개발 인증 서버 |
| `monitoring` | Grafana |
| `longhorn` | 스토리지 대시보드 |

`hub-auth`가 운영 오버레이에 있었다. 즉 CI 문제가 아니라 운영 인증 연동이 이미 끊긴 상태였다. 패밀리사이트에서 호출하는 스크립트에 이 주소가 하드코딩돼 있기도 했다.

그리고 배포 매니페스트를 보니 dev의 backend와 frontend가 `imagePullPolicy: Always`였다. 배포하면 매번 이미지 저장소에 붙으러 간다. 도메인이 죽었으니 그 순간 파드가 못 뜬다. 겉으로는 멀쩡해 보였지만 파드가 재시작되면 그때 터지는 상태였다.

### Harbor가 어디 있는지도 몰랐다

새 도메인 `code-place-dev.kr`을 사고 DNS를 붙인 뒤 Harbor에 접속해봤다.

```
HTTP/2 404
content-length: 19
```

`content-length: 19`가 힌트였다. `404 page not found`가 정확히 19바이트다. Harbor 응답이 아니라 Traefik 기본 404였다. 요청은 클러스터까지 갔는데 매칭되는 라우터가 없다는 뜻.

```bash
kubectl get ingress -A
```

Harbor가 클러스터 안에 있었다. `harbor` 네임스페이스에 파드 7개, Helm으로 설치돼 있었고, Ingress의 host가 아직 옛 도메인이었다. 저장소의 `kubernetes/` 어디에도 harbor 매니페스트가 없어서 별도 장비인 줄 알았는데 아니었다.

바꿀 값은 두 개뿐이었다.

```yaml
externalURL: https://harbor.code-place-dev.kr
expose:
  ingress:
    hosts:
      core: harbor.code-place-dev.kr
```

`externalURL`이 중요하다. Docker가 push할 때 Harbor가 이 주소로 리다이렉트를 돌려주기 때문에, 안 바꾸면 로그인은 되는데 실제 전송에서 옛 주소로 가서 실패한다.

인증서는 걱정했던 것보다 쉬웠다. Traefik이 Let’s Encrypt로 자동 발급하도록 설정돼 있어서, Ingress의 host만 바꾸면 알아서 새 인증서를 받았다.

```
subject=CN = harbor.code-place-dev.kr
issuer=C = US, O = Let’s Encrypt, CN = YR2
```

### 이미지를 다시 올릴 필요는 없었다

처음엔 호스트명이 바뀌었으니 이미지 태그도 다 바뀌는 것 아닌가, 전부 다시 push해야 하나 생각했다. 틀린 생각이었다.

Harbor는 이미지를 `프로젝트/저장소:태그`로 보관한다. 호스트명은 접속 주소일 뿐이다. 같은 인스턴스면 새 주소로 그대로 받아진다.

```bash
sudo docker pull harbor.code-place-dev.kr/code-place-prod/backend:57563df8...-prod
Status: Downloaded newer image
```

단계 하나가 통째로 사라졌다.

한 가지 함정은 있었다. 저장소 치환할 때 `--include="*.yaml"` 식으로 확장자를 나열했는데 `.py` 파일 하나가 빠졌다. 확장자를 지정하는 검색은 이런 식으로 조용히 빠뜨린다. `git grep -l`로 확장자 무관하게 다시 훑어서 찾았다.

## 릴리즈 3.1.6

도메인이 복구되고 QA도 통과해서 PR을 머지하려는데, 여기서 알게 된 게 있다.

`ci2production-and-release.yml`이 릴리즈인지 아닌지를 커밋 메시지 패턴으로 판정한다.

```bash
if [[ "$commit_message" =~ ^Merge\ pull\ request.*from.*release- ]]; then
```

그리고 거기서 버전 번호까지 뽑는다. `release-3.1.6`에서 `3.1.6`을 꺼내 GitHub Release 태그로 쓴다.

즉 Squash로 머지하면 이 패턴이 깨져서 운영 이미지 빌드도, 릴리즈 생성도 전부 안 돈다. PR 제목은 아무 상관이 없다. 브랜치 이름이 전부다. feature에서 develop으로 갈 때는 squash가 팀 관례인데 release에서 main으로 갈 때만 merge commit이어야 한다는 걸 이때 알았다.

### CI가 절반만 성공했다

머지하고 CI를 봤더니 backend push가 실패해 있었다.

```
ERROR: failed to push .../backend:9c73aa0f...-prod: unknown: blob upload invalid
```

디스크가 찼나 싶어 확인했는데 30%밖에 안 썼다. Harbor core 로그를 보니 이런 게 있었다.

```
http: proxy error: readfrom tcp ...:5000: unexpected EOF
```

업로드 중에 연결이 끊긴 것이다. 원인을 더 파기 전에 재실행부터 해봤더니 그냥 성공했다. 일시적인 문제였던 것 같다. 다만 harbor ingress에 붙은 어노테이션이 전부 nginx용인데 실제 ingressClass는 traefik이라 body-size나 타임아웃 설정이 사실상 안 걸려 있는 상태였다. 관련 있을 수 있어 메모만 남겼다.

여기서 배운 게 하나 더 있다. backend push가 실패한 사이 frontend는 성공해서, `main`의 이미지 태그가 이렇게 섞여 있었다.

```
backend  : 57563df8...  ← 3.1.5 (실패해서 그대로)
frontend : 9c73aa0f...  ← 3.1.6
```

이 상태로 배포했으면 프론트만 새 버전이고 백엔드는 옛 버전이 된다. 대회 질문 커뮤니티 UI가 없는 API를 호출했을 것이다. 배포 전에 태그를 눈으로 확인하는 습관이 왜 필요한지 알게 됐다.

### 배포 명령이 무서워진 순간

CI가 다 끝나고 `kubectl apply -k`를 치기 전에 `kubectl diff -k`로 뭐가 바뀔지 먼저 봤다. 그런데 출력이 이상하게 짧았다.

```
The PersistentVolumeClaim "vllm-hf-cache" is invalid:
spec.resources.requests.storage: Forbidden: field can not be less than status.capacity
```

`kubectl diff`는 검증 에러가 나면 거기서 멈춘다. 나머지 변경을 안 보여준다. 처음엔 이 에러 하나만 있는 줄 알았다. PVC와 CNPG Cluster를 걸러낸 렌더링본으로 다시 보니 그 뒤에 이런 게 있었다.

```
-        - "32768"
+        - "4096"
```

vLLM의 `--max-model-len`이었다. 배포본은 32768인데 저장소에는 4096으로 적혀 있었다. 그냥 적용했으면 AI 조교의 컨텍스트 한도가 8배 줄어들 뻔했다. 힌트 요청 컨텍스트가 실측 약 3천 토큰이고 사용자 코드는 8천 자까지 허용되니 4096은 부족하다. 게다가 vLLM이 재시작되면서 35B 모델을 다시 로딩해야 한다.

운영 postgres에도 비슷한 게 있었다. 저장소에는 메모리 상한 2Gi가 적혀 있는데 실제로는 제한이 없었고, 실사용량이 1.2Gi였다. 적용했으면 여유가 40%뿐인 상한이 걸리는 셈이다.

결국 이번 배포는 `kubectl kustomize`로 렌더링한 뒤 문제 리소스를 빼고 `apply -f`로 진행했다. 정석이 아닌 우회였다. 다음 날 이걸 정리하기로 했다.

배포 자체는 무중단으로 끝났다. backend 6개가 순차 교체되고, DB 마이그레이션도 파드 기동 시 자동 실행됐다.

```
[X] 0004_post_visibility
```

## 배포하고 나서야 본 것

파드 목록을 훑다가 이걸 발견했다.

```
postgres-10   0/1   CrashLoopBackOff   116 (22s ago)   9h
```

운영 DB 복제본 하나가 9시간째 116번 재시작 중이었다. `instances=3 ready=2`. primary는 멀쩡해서 서비스에는 지장이 없었지만 이중화가 깨진 상태였다.

전에 WAL 폭주로 디스크가 찬 적이 있어서 그건가 싶었는데, 로그를 보니 다른 얘기였다.

```
FATAL: requested timeline 14 is not a child of this server's history
DETAIL: Latest checkpoint is at 10A/75000028 on timeline 13, but in the history of
        the requested timeline, the server forked off from that timeline at 10A/7314CF38.
```

타임라인 분기였다. 과거에 failover가 일어나면서 `postgres-11`이 새 primary가 됐고, 그때 타임라인 13에서 14가 갈라졌다. 갈라진 지점은 `10A/7314CF38`. 그런데 `postgres-10`은 그보다 약 32MB 앞선 `10A/75000028`까지 이미 WAL을 적용해버린 상태였다.

즉 타임라인 13에만 존재하고 14에는 없는 기록을 갖고 있다. 그래서 새 primary를 따라갈 수 없다. PostgreSQL이 데이터 정합성을 지키려고 기동을 거부하는 것이고, 이건 정상 동작이다.

이 데이터는 살릴 수 없다. CNPG의 표준 절차는 복제본을 처음부터 다시 만드는 것이다.

```bash
kubectl delete pvc postgres-10 -n code-place-prod --wait=false
kubectl delete pod postgres-10 -n code-place-prod
```

CNPG가 알아서 새 인스턴스를 만들고 primary에서 basebackup을 받았다. 번호는 재사용하지 않아서 `postgres-13`으로 올라왔다.

```
instances=3 ready=3 phase=Cluster in healthy state
ConsistentSystemID=True  Ready=True  ContinuousArchiving=True
```

하루 넘게 깨져 있던 이중화가 복구됐다. 배포 후에 파드 목록을 한 번 훑지 않았으면 더 오래 몰랐을 것이다.

## 2일차 - 배포 명령을 정상으로 만들기

전날 우회했던 걸 정리하는 날이었다. 목표는 하나였다. `kubectl diff -k`가 빈 출력이 되게 만들기. 그러면 저장소와 클러스터가 일치한다는 뜻이고, 배포 명령을 그냥 써도 된다.

어긋난 것들을 정리하면 이랬다.

| 항목 | 실제 운영 | 저장소 |
| --- | --- | --- |
| vLLM `--max-model-len` | 32768 | 4096 |
| vLLM PVC, postgres 크기 | 50Gi | 30Gi |
| prod postgres `resources` | 제한 없음 | 512Mi / 2Gi |
| prod postgres `primaryUpdateStrategy` | `supervised` | `unsupervised` |
| dev postgres `instances` | 2 | 3 |

전부 급할 때 서버만 고치고 저장소를 안 고친 흔적이다.

방향을 정하는 데 원칙이 하나 필요했다. 실제로 잘 돌고 있는 쪽을 정본으로 삼는다. vLLM 32768은 4096으로는 부족해서 누군가 올린 것일 테고, postgres에 메모리 제한이 없는 것도 지금 문제없이 돌고 있다. 검증 안 된 변경을 이 기회에 밀어 넣을 이유가 없었다.

storageClass 하나만 다르게 처리했다. `#761`이 CNPG 전용 storageClass로 바꾸려 한 건 의도가 분명한 설계였다. 다만 적용하면 어떻게 되는지 몰라서 먼저 시험해봤다.

```bash
kubectl apply -f /tmp/pg-test.yaml --dry-run=server
cluster.postgresql.cnpg.io/postgres configured (server dry run)
```

`--dry-run=server`는 API 서버가 검증만 하고 버린다. 아무것도 안 바뀐다. 결과는 수용이었다. 즉 크기만 고치면 storageClass 변경이 실제로 적용된다는 뜻이다. 기존 PVC는 자동 이관되지 않아 클래스가 혼재하게 되므로, 이건 마이그레이션 계획이 필요한 별도 작업이라고 보고 저장소를 `longhorn`으로 되돌리면서 주석에 이유를 남겼다.

### CRD는 패치 방식이 다르다

prod postgres에서 `resources`를 제거해야 했는데, 평소 쓰던 strategic merge 패치로는 필드가 안 지워진다. CNPG Cluster는 CRD라서 kustomize가 구조를 모른다. JSON6902 패치를 써야 했다.

```yaml
- op: remove
  path: /spec/resources
- op: replace
  path: /spec/primaryUpdateStrategy
  value: supervised
```

`kustomization.yaml`에는 `path`와 함께 `target`으로 어떤 리소스인지 명시한다.

```yaml
- path: postgres-cluster-patch.yaml
  target:
    group: postgresql.cnpg.io
    version: v1
    kind: Cluster
    name: postgres
```

dev에도 같은 방식으로 `instances: 2`와 `resources` 제거를 넣었다. dev 실사용량은 111에서 182Mi 사이라 2Gi 상한도 여유가 컸지만, prod와 방침이 갈리면 나중에 헷갈릴 것 같아 맞췄다. 리소스 제한은 두 환경 같은 기준으로 따로 정하는 게 맞다고 봤다.

마지막으로 vLLM args 순서 차이가 남았다. 값은 같고 순서만 달랐다. 기능 차이는 없지만 쿠버네티스는 배열이 다르면 다른 스펙으로 보고 파드를 재시작한다. 사용량이 적은 시간에 한 번 적용했다.

```bash
kubectl apply -k kubernetes/overlays/prod
kubectl rollout status deploy/vllm -n code-place-prod --timeout=1800s
```

```
id: nvidia/Qwen3.6-35B-A3B-NVFP4 max_model_len: 32768
```

값은 유지됐고, 그 뒤로 `kubectl diff -k`는 빈 출력이 됐다. dev도 같았다.

## 남는 것

이틀 동안 사건이 다섯 개였는데 정리하고 보니 대부분 한 가지에서 나왔다. 급할 때 서버를 직접 고치고 저장소에 반영하지 않는 것. 백머지를 빠뜨린 것도, 매니페스트가 어긋난 것도 결국 같은 얘기다. 그때는 빠르지만 다음 사람이 `apply` 한 줄 칠 때 비용을 대신 낸다.

도메인 만료는 성격이 다르긴 한데, 서브도메인 여섯 개를 도메인 하나에 매달아 둔 구조가 피해를 키웠다. CI, 개발 서버, 운영 인증, 모니터링이 동시에 나갔다. 만료 알림 하나 걸어두는 게 제일 싸고 효과 큰 대비책일 것 같다.

기술적으로 기억해둘 것 몇 가지.

`kubectl diff -k`는 검증 에러가 나면 중간에 멈춘다. 잘린 출력만 보고 판단하면 안 된다. 실제로 이것 때문에 postgres 변경을 못 볼 뻔했다.

`--dry-run=server`는 위험한 변경을 미리 재보는 데 좋다. 운영 DB에 뭔가 적용하기 전에 이걸 먼저 쳐볼 것.

Git 충돌은 덩어리 수에 압도되기 쉬운데, 읽기 전에 어느 쪽이 상위집합인지를 blob 해시로 먼저 확인하면 34덩어리도 근거 있는 한 줄로 끝난다. 손으로 34개를 봤으면 실수가 안 났다고 장담 못 한다.

남은 과제는 따로 적어뒀다. postgres 리소스 제한 기준을 dev와 prod 같이 정하는 것, Harbor에 읽기 전용 robot 계정을 만들어 pull 계정을 분리하는 것, `#761`이나 `#762`처럼 저장소에만 있고 클러스터에 반영 안 된 helm 설정을 맞추는 것. 릴리즈 후 백머지를 자동화하는 워크플로도 초안까지는 만들었는데 이번엔 넣지 않기로 했다.

이전에 쓴 [Replication Slot에 의한 WAL 누적과 PostgreSQL 클러스터 장애](/blog/code-place-cnpg-wal-data-loss/)와 [헬스 체크 Probe와 이미지 릴리스 스큐에 의한 반복 재시작](/blog/code-place-crashloop-398/)도 결국 같은 계열이다. 코드만 봐서는 안 보이고, 실제로 돌아가는 것과 적혀 있는 것을 나란히 놓고 봐야 보이는 문제들.
