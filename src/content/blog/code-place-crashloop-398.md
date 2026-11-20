---
title: '운영 파드가 398번 재시작한 이유 - liveness probe와 이미지 릴리즈 스큐'
titleEn: 'Why a production pod restarted 398 times - a liveness probe vs image release skew'
description: '멀쩡히 살아 있는데 재시작 398회. kubectl logs → describe → replicaset → git → exec로 계층을 좁혀, 헬스체크 경로를 그 경로가 없는 이미지에 먼저 배포한 릴리즈 스큐를 찾아냈다. 스큐를 만든 건 이미지 빌드만 건너뛴 CI였다.'
descriptionEn: 'Restarting 398 times while the app booted fine. Narrowing from kubectl logs → describe → replicaset → git → exec to find a health-check path deployed before the image that served it, and the CI run that skipped the image build but still shipped the manifest.'
pubDate: 2026-06-11
updatedDate: 2026-11-20
tags: ['troubleshooting', 'infra', 'kubernetes']
project: 'code-place'
draft: false
---

> 운영 백엔드 파드가 재시작 398회를 기록했지만 앱 로그는 정상 기동이었다. startup probe가 `/api/health`에서 404를 받고 있었고, 배포된 이미지에는 아직 그 엔드포인트가 없었다. 헬스체크(매니페스트)를 그 경로를 제공하는 이미지보다 먼저 배포한 릴리즈 스큐가 원인이었다. 재시작 횟수는 `failureThreshold × period`와 산술적으로 맞아떨어졌다.

## 증상

운영 클러스터(`code-place-prod`)의 백엔드 파드가 두 갈래로 갈려 있었다.

```
NAME                       READY  STATUS    RESTARTS   AGE
backend-57b765dc95-xxxxx   0/1    Running   398        2d18h   # 크래시
backend-689df5f547-xxxxx   1/1    Running   0          16d     # 정상
```

`57b765dc95` 파드들이 `0/1`(NotReady)에 재시작 398회. 그런데 서비스 자체는 살아 있었다. 롤아웃이 어딘가에서 멈춘 채였다.

![k9s로 본 code-place-prod 파드들 - 재시작(RESTARTS) 수가 한눈에 드러난다](/images/code-place/k9s-crashloop.webp)

평소 운영 상태는 `k9s`로 훑어본다. RESTARTS 컬럼에 세 자리 숫자가 찍혀 있으면 뭔가 반복해서 죽고 있다는 뜻이다.

## 진단 - 계층을 좁혀 간다

### 로그 - 앱은 정상 기동한다

```bash
kubectl -n code-place-prod logs backend-57b765dc95-xxxxx --previous --tail=100
```

gunicorn이 정상 기동하고 마이그레이션, 픽스처 로드까지 성공한 뒤, 정확히 10분 후 `SIGTERM`으로 exit 0. 앱이 스스로 죽는 게 아니라 외부(kubelet)가 죽이고 있었다.

### describe - probe가 404

```
Warning  Unhealthy  Startup probe failed: HTTP probe failed with statuscode: 404 (x23311)
Normal   Killing    Container backend failed startup probe, will be restarted (x398)
Startup: http-get http://:8080/api/health delay=0s period=10s #failure=60
```

startup probe가 `/api/health`에서 404를 받았다. `failureThreshold=60 × period=10s = 600초 = 10분`이니, 로그에서 본 "기동 후 정확히 10분 뒤 kill"과 일치한다. 10분마다 죽으면 2일 18시간 동안 약 398회. 재시작 횟수가 이 계산과 맞았다.

### ReplicaSet 비교 - 같은 이미지인데?

```bash
kubectl -n code-place-prod get rs -o wide
```

크래시 나는 `57b765dc95`와 정상 `689df5f547`가 동일 이미지였다. 이미지 코드 차이가 아니었던 것이다. 파드 템플릿을 diff 하니, `57b`는 liveness/readiness/startup probe(`/api/health`) 3종을 새로 추가했고 `689`에는 probe가 아예 없었다. 즉 `689`의 `1/1`은 건강해서가 아니라 검사를 안 해서였다.

### git + exec - 이미지에 엔드포인트가 없다

```bash
git show <deployed-sha>:backend/conf/urls/oj.py   # /health 라우트 없음
kubectl exec deploy/backend -- \
  curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/api/health
# → 404
```

현재 HEAD에는 `HealthCheckAPI`(204 반환) 라우트가 있지만, 배포된 이미지는 그보다 이전 버전이라 `/api/health`가 존재하지 않았다.

## 근본 원인

probe(매니페스트)를 그 경로를 제공하는 이미지보다 먼저 배포한 릴리즈 스큐였다.

새 매니페스트가 probe를 추가했는데 배포된 이미지엔 엔드포인트가 없으니, probe는 항상 404를 받고 startup이 실패해 10분마다 재시작됐다. 새 RS가 Ready가 되지 못하니 롤아웃은 `maxUnavailable` 보호에 걸려 멈췄고, probe가 없는 옛 RS가 트래픽을 받아 서비스는 유지됐다(NotReady 파드는 Service 엔드포인트에서 빠진다).

### 왜 이미지만 따라오지 못했나

이상한 점이 하나 남았다. probe와 `/api/health` 라우트는 팀원이 6월 4일 develop에 같은 커밋으로 넣은 것이었다. 같은 커밋에 들어 있던 둘이 운영에서는 갈라져 있었다.

GitHub Actions 기록을 보면 이유가 나온다. 6월 8일 15시 51분에 release-3.1.0을 main에 머지했다(이 PR은 내가 머지했다). 운영 배포 워크플로는 첫 잡의 `Extract version from merge commit message` 단계에서 실패했고, 그 뒤의 백엔드 이미지 빌드와 운영 매니페스트 태그 갱신은 전부 건너뛰어졌다. 그런데 probe가 들어간 `kubernetes/base/backend/deployment.yaml`은 이미 main에 머지된 상태였다. 클러스터는 main의 매니페스트를 따라가므로 probe는 운영에 반영됐고, 백엔드 이미지 태그는 5월 26일 3.0.0 그대로였다. 두 ReplicaSet의 나이도 이 시각과 맞는다. 정상 `689`가 16일이면 5월 26일, 크래시 `57b`가 2일 18시간이면 6월 8일 오후에 만들어졌다.

다음 날 나간 3.1.1도 이걸 풀지 못했다. 이번엔 워크플로가 끝까지 돌았지만, 변경 감지 잡이 "백엔드 코드는 바뀌지 않았다"고 판정해 백엔드 이미지 빌드를 다시 건너뛰었다. 운영 태그 갱신 커밋은 프론트엔드 태그 한 줄만 바꿨다. 변경 감지는 백엔드 코드가 바뀌었는지만 봤고, 운영에 떠 있는 백엔드 이미지가 지금 매니페스트를 감당하는지는 보지 않았다.

## 해결

발견한 시점에 당장 할 수 있는 건 probe 없는 이전 리비전으로 롤백하는 것이었다. 정공법은 `/api/health`를 포함한 새 이미지를 먼저 빌드, 배포한 뒤 probe를 유지하는 것이다. 순서는 이미지가 먼저, probe가 나중이다.

실제로 스큐가 풀린 건 6월 18일 3.1.2 릴리스였다. 이 릴리스에는 백엔드 변경이 있어 백엔드 이미지가 새로 빌드됐고, 운영 매니페스트의 백엔드 태그가 `/api/health`를 가진 이미지로 바뀌었다. 발견 직후에 롤백을 했는지는 남은 기록으로 확인하지 못했다. 그사이에도 옛 ReplicaSet이 트래픽을 받고 있어 사이트는 내려가지 않았다.

## 교훈

readiness probe가 없는 배포는 정상처럼 보인다. 이번에 멀쩡해 보이던 `689`도 실은 검사를 안 받고 있었을 뿐이다. 헬스체크가 없으면 장애가 숨는다.

probe 경로를 바꾸는 변경은 그 경로를 제공하는 이미지와 같은 릴리즈로 묶어야 한다. 그런데 이번엔 같은 커밋에 묶여 있었는데도 갈라졌다. 매니페스트는 머지되는 순간 반영되고 이미지는 CI가 성공해야 따라오는 구조에서는, CI가 중간에 실패하거나 빌드를 건너뛰는 순간 둘이 어긋난다. 배포 워크플로가 실패하면 무엇이 반영됐고 무엇이 빠졌는지를 그 자리에서 확인해야 한다. 그리고 재시작 횟수와 주기를 probe 파라미터와 대조해 보면, 원인을 추측이 아니라 산술로 확인할 수 있다.
