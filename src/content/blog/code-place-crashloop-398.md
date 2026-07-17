---
title: '운영 파드가 398번 재시작한 이유 - liveness probe와 이미지 릴리즈 스큐'
titleEn: 'Why a production pod restarted 398 times - a liveness probe vs image release skew'
description: '멀쩡히 살아 있는데 재시작 398회. kubectl logs → describe → replicaset → git → exec로 계층을 좁혀, 헬스체크 경로를 그 경로가 없는 이미지에 먼저 배포한 릴리즈 스큐를 찾아낸 진단 기록.'
descriptionEn: 'Restarting 398 times while the app booted fine. Narrowing from kubectl logs → describe → replicaset → git → exec to find a health-check path deployed before the image that served it.'
pubDate: 2026-05-20
tags: ['troubleshooting', 'infra', 'kubernetes']
project: 'code-place'
draft: false
---

> **TL;DR** - 운영 백엔드 파드가 재시작 398회를 기록했지만 앱 로그는 정상 기동이었습니다. startup probe가 `/api/health`에서 404를 받고 있었고, 배포된 이미지에는 아직 그 엔드포인트가 없었습니다. **헬스체크(매니페스트)를 그 경로를 제공하는 이미지보다 먼저 배포한 릴리즈 스큐**가 원인. 재시작 횟수는 `failureThreshold × period`와 산술적으로 정확히 맞아떨어졌습니다.

## 증상

운영 클러스터(`code-place-prod`)의 백엔드 파드가 두 갈래로 갈려 있었습니다.

```
NAME                       READY  STATUS    RESTARTS   AGE
backend-57b765dc95-xxxxx   0/1    Running   398        2d18h   # 크래시
backend-689df5f547-xxxxx   1/1    Running   0          16d     # 정상
```

`57b765dc95` 파드들이 `0/1`(NotReady)에 재시작 398회. 그런데 서비스 자체는 살아 있었습니다. 롤아웃이 어딘가에서 멈춘 채였습니다.

![k9s로 본 code-place-prod 파드들 - 재시작(RESTARTS) 수가 한눈에 드러난다](/images/code-place/k9s-crashloop.webp)

평소 운영 상태는 `k9s`로 훑어봅니다. RESTARTS 컬럼에 세 자리 숫자가 찍혀 있으면 뭔가 반복해서 죽고 있다는 뜻입니다.

## 진단 - 계층을 좁혀 간다

### ① 로그 - 앱은 정상 기동한다

```bash
kubectl -n code-place-prod logs backend-57b765dc95-xxxxx --previous --tail=100
```

gunicorn이 정상 기동하고 마이그레이션·픽스처 로드까지 성공한 뒤, 정확히 **10분 후** `SIGTERM`으로 exit 0. 앱이 스스로 죽는 게 아니라 **외부(kubelet)가 죽이고** 있었습니다.

### ② describe - probe가 404

```
Warning  Unhealthy  Startup probe failed: HTTP probe failed with statuscode: 404 (x23311)
Normal   Killing    Container backend failed startup probe, will be restarted (x398)
Startup: http-get http://:8080/api/health delay=0s period=10s #failure=60
```

startup probe가 `/api/health`에서 404. `failureThreshold=60 × period=10s = 600초 = 10분` - 로그의 "기동 후 정확히 10분 뒤 kill"과 일치합니다. 10분마다 죽으니 2일 18시간이면 약 398회. **숫자가 맞아떨어졌습니다.**

### ③ ReplicaSet 비교 - 같은 이미지인데?

```bash
kubectl -n code-place-prod get rs -o wide
```

크래시 나는 `57b765dc95`와 정상 `689df5f547`가 **동일 이미지**였습니다. 이미지 코드 차이가 아니었던 것입니다. 파드 템플릿을 diff 하니, `57b`는 liveness/readiness/startup probe(`/api/health`) 3종을 새로 추가했고 `689`에는 probe가 아예 없었습니다. 즉 `689`의 `1/1`은 "건강해서"가 아니라 **검사를 안 해서**였습니다.

### ④ git + exec - 이미지에 엔드포인트가 없다

```bash
git show <deployed-sha>:backend/conf/urls/oj.py   # /health 라우트 없음
kubectl exec deploy/backend -- \
  curl -s -o /dev/null -w "%{http_code}\n" http://localhost:8080/api/health
# → 404
```

현재 HEAD에는 `HealthCheckAPI`(204 반환) 라우트가 있지만, **배포된 이미지는 그보다 이전 버전**이라 `/api/health`가 존재하지 않았습니다.

## 근본 원인

**probe(매니페스트)를 그 경로를 제공하는 이미지보다 먼저 배포한 릴리즈 스큐.**

- 새 매니페스트가 probe를 추가 → 배포된 이미지엔 엔드포인트가 없음 → 항상 404 → startup 실패 → 10분마다 재시작.
- 새 RS가 Ready가 못 되니 롤아웃이 `maxUnavailable` 보호로 멈추고, probe가 없는 옛 RS가 트래픽을 받아 서비스는 유지됨(NotReady 파드는 Service 엔드포인트에서 제외).

## 해결

- **즉시**: probe 없는 이전 리비전으로 롤백, 또는
- **정공법**: `/api/health`를 포함한 새 이미지를 **먼저** 빌드·배포한 뒤 probe를 유지 (순서: 이미지 → probe).

## 교훈

- **readiness probe가 없는 배포는 "green"으로 위장한다.** 헬스체크 부재가 장애를 숨긴다.
- probe 경로 변경은 반드시 그 경로를 제공하는 이미지와 **같은 릴리즈로 묶어야** 한다.
- 재시작 횟수·주기를 probe 파라미터와 대조해 **원인을 산술적으로 검증**하면 추측을 없앨 수 있다.
