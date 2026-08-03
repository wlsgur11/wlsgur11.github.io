---
title: '로그인만 안 됐다 - DNS는 되는데 나가지 못한 컨테이너'
titleEn: 'Only login was broken - a container that resolved DNS but could not get out'
description: '구글 로그인만 "server configuration" 에러로 막혔다. 원인은 콜백 등록이 아니라 컨테이너가 밖으로 못 나가는 것이었고, DNS는 되는데 연결만 안 되는 상태였다. env - prisma - ufw - MTU - docker0 대 compose 브리지로 계층을 좁혀 NAT 유실을 찾고, 결국 clean 재부팅으로 엉킨 iptables 상태를 정리한 기록.'
descriptionEn: 'Only Google login failed with a server-configuration error. The cause was not callback registration but a container that could not reach the internet - it resolved DNS but could not connect. Narrowing through env, prisma, ufw, MTU, and docker0 vs the compose bridge to find a lost NAT rule, then clearing tangled iptables state with a clean reboot.'
pubDate: 2026-07-17
tags: ['infra', 'troubleshooting']
project: 'pnuaicms'
draft: false
---

> 사이트는 멀쩡히 뜨는데 구글 로그인만 "There is a problem with the server configuration"으로 막혔다. 처음엔 콜백 URI 등록 문제인 줄 알았지만 아니었다. NextAuth가 던진 진짜 원인은 `fetch failed` - 앱 컨테이너가 구글로 못 나가고 있었다. 이상한 건 DNS는 됐다는 것이다(이름은 찾는데 연결이 안 됐다). env - prisma 로그 - ufw - MTU - docker0 대 compose 브리지 순으로 계층을 좁히다, compose 네트워크의 NAT(masquerade)가 유실된 걸 찾았다. 손으로 반쯤 복구했지만 accounts.google.com은 되고 token 엔드포인트만 timeout 나는 어중간한 상태가 남았고, 결국 clean 재부팅으로 엉킨 iptables를 통째로 정리하고서야 끝났다.

## 사건

교내 서버에서 돌던 CMS에 접속하니 화면은 정상이었다. 그런데 구글 로그인을 누르면 이 화면이 떴다.

> There is a problem with the server configuration

URL은 `…/api/auth/error?error=Configuration`. 딱 봤을 때 "콜백 URI를 어디 등록해야 하나?" 싶었다. 하지만 `error=Configuration`은 리다이렉트 등록 문제가 아니라 **NextAuth 자체가 설정을 유효하지 않다고 판단할 때** 나는 에러다. redirect_uri 문제였다면 구글 쪽에서 다른 화면이 뜬다. 그러니 우리 서버 안을 봐야 했다.

## 환경

- **앱/DB**: 교내 물리 서버의 Docker (`app` + `postgres` 컨테이너, compose)
- **인증**: NextAuth v5, 구글 OAuth(@pusan.ac.kr)
- **프록시/방화벽**: Caddy(HTTPS), ufw
- **맥락**: 며칠 새 PSU 교체·재부팅, hostname 변경, 그리고 DataGrip 접속용으로 db 컨테이너에 포트를 하나 추가(`up -d db`)하는 등 네트워크를 여러 번 건드린 뒤였다.

## env부터 - 아니었다

self-hosted에서 이 문구는 예전에 `AUTH_TRUST_HOST`가 빠졌을 때도 났다. 그래서 컨테이너의 인증 env부터 확인했다.

```bash
docker compose -f docker-compose.prod.yml exec -T app sh -lc 'env | grep -E "^AUTH_" | sed -E "s/=.*/=SET/"'
```

`AUTH_SECRET`, `AUTH_GOOGLE_ID/SECRET`, `AUTH_TRUST_HOST`, `AUTH_URL` 전부 SET. env는 멀쩡했다. 그럼 다른 데다.

## 로그가 두 개를 가리켰다

```
cms_app | prisma:error ... code: SqlState(E57P01), message: "terminating connection due to administrator command"
cms_app | [auth][error] TypeError: fetch failed
```

두 증상이 동시에 났다. `E57P01`은 DB가 연결을 끊는다는 뜻(관리자 명령/재시작), `fetch failed`는 앱이 외부로 요청을 보내다 실패한다는 뜻. **DB 연결도, 외부 요청도 동시에 깨진다** - 개별 기능이 아니라 앱 컨테이너의 네트워크 자체가 이상하다는 신호였다.

직전에 DataGrip 포트를 붙이려고 `up -d db`로 db만 재생성했다는 게 걸렸다. db만 새로 뜨면서 app 컨테이너는 옛 네트워크에 남았을 수 있다. 그래서 스택 전체를 다시 올렸다.

```bash
docker compose -f docker-compose.prod.yml up -d --force-recreate
```

DB 쪽 `E57P01`은 사라졌다. 하지만 로그인은 여전히 `fetch failed`였다.

## DNS는 되는데 연결이 안 된다

앱이 실제로 구글에 닿는지 컨테이너 안에서 직접 확인했다.

```bash
docker compose ... exec -T app node -e "require('dns').promises.lookup('accounts.google.com').then(a=>console.log('DNS',a)).catch(e=>console.log('DNS FAIL',e.message))"
docker compose ... exec -T app node -e "fetch('https://accounts.google.com/.well-known/openid-configuration').then(r=>console.log('FETCH',r.status)).catch(e=>console.log('FETCH FAIL',e.message))"
```

```
DNS { address: '74.125.138.84', family: 4 }
FETCH FAIL fetch failed
```

DNS는 되는데 fetch는 실패했다. 처음엔 모순처럼 보였지만 아니었다. 컨테이너의 DNS는 도커 내장 리졸버(127.0.0.11)가 처리하므로, **컨테이너 자신의 아웃바운드가 막혀 있어도 이름 해석은 될 수 있다.** 즉 "DNS 된다"가 "밖으로 나간다"를 보장하지 않는다. 진짜 문제는 egress였다.

## ufw는 범인이 아니었다

호스트 자체는 인터넷이 됐다.

```bash
curl -sS -m 8 -o /dev/null -w "HOST %{http_code}\n" https://accounts.google.com/.well-known/openid-configuration
# HOST 200
```

호스트는 되고 컨테이너만 안 된다. `ufw status`를 보니 `Default: deny (routed)` - FORWARD 정책이 deny였다. 도커 컨테이너 트래픽은 FORWARD 체인을 타므로 이게 유력해 보였다.

```bash
sudo sed -i 's/^DEFAULT_FORWARD_POLICY=.*/DEFAULT_FORWARD_POLICY="ACCEPT"/' /etc/default/ufw
sudo ufw reload && sudo systemctl restart docker
```

여전히 실패. ufw FORWARD는 원인이 아니었다. 여기서 가설을 버리고 더 아래를 봤다.

## MTU인 줄 알았다 - 아니었다

에러 코드를 정확히 뽑고, 커널·NAT를 확인했다.

```
ERR ETIMEDOUT
net.ipv4.ip_forward = 1
-A POSTROUTING -s 172.17.0.0/16 ! -o docker0 -j MASQUERADE
-A POSTROUTING -s 172.18.0.0/16 ! -o br-... -j MASQUERADE
```

`ETIMEDOUT`(응답 없음) + ip_forward=1 + masquerade 존재. 나간 패킷의 응답이 안 오는 전형적 모양이라 MTU 블랙홀을 의심했다(작은 패킷은 되고 큰 TLS 패킷만 드롭). 그런데 raw TCP 연결(작은 SYN)조차 timeout이었고, 인터페이스 MTU는 호스트·도커 전부 1500이었다. **SYN이 안 가는 건 MTU가 아니다.** MTU 가설도 버렸다. (이때 넣어 본 도커 MTU 조정은 원인이 아니었고, 뒤에 정리했다.)

## docker0는 되고 compose 브리지만 안 된다

같은 이미지를 **기본 브리지(docker0)** 에서 띄워 봤다.

```bash
docker run --rm --entrypoint node ghcr.io/wlsgur11/pnuaicms:latest -e "const s=require('net').connect(443,'accounts.google.com');s.setTimeout(6000);s.on('connect',()=>{console.log('DEFBRIDGE OK');s.end()});s.on('timeout',()=>{console.log('DEFBRIDGE TIMEOUT')})"
# DEFBRIDGE OK
```

docker0에서는 나갔다. compose 네트워크(br-...)에서만 안 나갔다. **문제는 도커 전체가 아니라 이 compose 브리지 하나였다.** 범위가 확 좁아졌다.

## 범인 - 유실된 NAT

compose 네트워크를 통째로 새로 만들어 봤다.

```bash
docker compose ... down && docker compose ... up -d
```

그런데도 여전히 timeout. 이상했다. 새 브리지를 만들면 도커가 그 subnet의 masquerade를 넣어 줘야 하는데, 방금 만든 네트워크의 NAT가 안 붙어 있었다. **네트워크가 존재하는 상태에서** 도커를 다시 시작하니 그제서야 채워졌다.

```bash
sudo systemctl restart docker
sudo iptables -t nat -S POSTROUTING | grep masq
# -A POSTROUTING -s 172.18.0.0/16 ! -o br-... -j MASQUERADE   ← 이제 있음
# FETCH OK 200
```

한 문장으로: **compose 브리지의 outbound NAT(masquerade)가 유실돼, 컨테이너 패킷이 사설 IP 그대로 나갔다가 응답을 못 받고 있었다.** docker0는 rule이 살아 있어 됐고, compose 브리지만 유실됐던 것이다. 그동안의 `up -d db`(단일 서비스) + ufw reload + 반복된 도커 재시작이 겹치며 iptables 상태가 어긋난 결과였다.

## 그래도 절반만 나았다

egress가 돌아온 줄 알았는데 로그인은 계속 `fetch failed`였다. 구글의 두 호스트를 각각 찔러 봤다.

```
accounts.google.com  → 200
oauth2.googleapis.com/token → ETIMEDOUT
```

discovery는 되는데 token 엔드포인트만 timeout. 로그인은 token 교환에서 죽고 있었다. 여러 번의 수동 조작(ufw reload, 수동 iptables 룰, daemon 설정 변경, 재시작 반복)으로 iptables가 어중간하게 엉킨 상태였다. 손으로 더 만지는 것보다, 상태를 통째로 정합화하는 게 빨랐다.

```bash
sudo reboot
```

재부팅 후 도커는 네트워크와 NAT를 clean하게 다시 깔았다.

```
accounts 200 | token 400
```

둘 다 닿았다(token 400은 빈 POST에 대한 정상 응답 - 연결됐다는 뜻). 로그인도 됐다.

## 근본 원인과 조치

- 근본 원인: **compose 브리지의 outbound NAT(masquerade) 유실**로 컨테이너가 밖으로 못 나갔다. 여러 네트워크 조작이 겹쳐 iptables 상태가 어긋난 것이 방아쇠였다.
- 즉시 조치: 네트워크가 존재하는 상태에서 도커 재시작 → NAT 재삽입.
- 정합화: 부분 손복구가 남긴 어중간한 상태는 **clean 재부팅**으로 정리. 부팅 시 도커가 규칙을 처음부터 다시 깔아 완전히 정상화됐다.

## 교훈

- **"Configuration" 로그인 에러는 콜백 등록 문제가 아니다.** 서버 로그의 실제 원인(`fetch failed`)을 봐야 방향이 잡힌다. 에러 화면의 문구만으로 엉뚱한 곳(구글 콘솔)을 파면 시간을 버린다.
- **DNS 된다 ≠ 밖으로 나간다.** 도커 내장 리졸버 때문에 egress가 죽어도 이름 해석은 된다. 연결을 확인하려면 실제 fetch/TCP로 찔러야 한다.
- **계층을 나눠 격리한다.** env → prisma/auth 로그 → 호스트 vs 컨테이너 → docker0 vs compose 브리지. "docker0는 되고 이 브리지만 안 된다"가 범위를 결정적으로 좁혔다. 틀린 가설(ufw FORWARD, MTU)도 빠르게 버리는 게 진행이었다.
- **iptables를 여러 방식으로 난타하지 않는다.** ufw + 도커 + 수동 룰 + 반복 재시작이 겹치면 재현 어려운 부분 실패(한 호스트는 되고 다른 호스트는 timeout)가 남는다. 상태가 심하게 엉켰으면 손복구보다 clean 부팅이 가장 빠른 정합화다.
- **단일 서비스만 재생성하지 않는다.** `up -d db`로 db만 새로 띄우면 app이 옛 네트워크에 남는다. 네트워크가 걸린 변경은 `up -d`(전체)로.

앞선 온프레미스 이전 기록은 [학생 데이터를 교내로](/blog/pnuaicms-cloud-to-onprem/)에, 같은 서버의 PSU 고장 복구는 [파워서플라이가 죽어 서버가 꺼졌다](/blog/pnuaicms-psu-failure-recovery/)에 적어 뒀다.
