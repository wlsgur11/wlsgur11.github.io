---
title: 'Vercel·Supabase에서 온프레미스로 - 학생 데이터를 교내 서버로 이전하기'
titleEn: 'From Vercel/Supabase to on-prem - migrating student data to a campus server'
description: '실서비스 CMS를 클라우드(Vercel + Supabase)에서 교내 물리 서버로 옮겼다. DB 덤프의 @ 비밀번호 함정, 인증서가 안 나오던 진짜 이유(서버가 아니라 캠퍼스 방화벽), self-hosted Auth.js의 UntrustedHost, 엉뚱한 구글 프로젝트에 있던 OAuth 클라이언트까지 - 이전 과정에서 걸린 함정들의 기록.'
descriptionEn: 'Moved a production CMS off the cloud (Vercel + Supabase) onto an on-campus server. The @ in the DB password, why the TLS cert would not issue (the campus firewall, not the server), self-hosted Auth.js UntrustedHost, and an OAuth client living in the wrong Google project.'
pubDate: 2026-06-30
tags: ['infra', 'troubleshooting']
project: 'pnuaicms'
draft: false
---

> AI융합교육원 CMS는 학생 인턴십·취업연계 같은 개인정보를 다룬다. 클라우드(Vercel + Supabase)에서 잘 돌고 있었지만, 데이터를 교내에 두자는 방향이 생겼다. 앱과 DB를 교내 물리 서버로 직접 옮겼는데, 정작 시간을 잡아먹은 건 이전 자체가 아니라 그 주변의 함정들이었다. DB 비밀번호에 든 `@` 하나가 덤프를 막았고, HTTPS 인증서가 안 나온 진짜 이유는 서버가 아니라 캠퍼스 방화벽이었으며, 로그인은 self-hosted 환경에서 Host를 안 믿어 막혔고, 구글 OAuth 클라이언트는 내가 보던 프로젝트가 아니라 다른 프로젝트에 있었다.

## 왜 옮겼나

이 CMS는 부산대 AI융합교육원에서 실제로 쓰는 시스템이고, 학생 개인정보를 담는다. 클라우드에서 문제없이 돌고 있었지만, 민감한 데이터를 교내 인프라에 두고 직접 통제하자는 요구가 생겼다. 그래서 앱은 Vercel에서 교내 물리 서버의 Docker로, DB는 Supabase에서 같은 서버의 PostgreSQL로 옮기기로 했다.

목표는 단순했다. **무중단에 가깝게, 데이터 손실 없이, 되돌릴 수 있게.** 그래서 Supabase는 바로 지우지 않고 1-2주간 롤백용으로 살려 두기로 했다.

## 환경

| | 이전 | 이후 |
|---|---|---|
| 앱 | Vercel | 교내 서버 Docker (Next.js 이미지, GHCR) |
| DB | Supabase(Postgres) | 같은 서버 `postgres:17` 컨테이너 |
| HTTPS | Vercel 자동 | Caddy + Let's Encrypt |
| 네트워크 | - | 사설 IP 뒤, 공인 IP는 NAT로 80/443만 매핑 |

서버는 교내망 안쪽에 있고, 공인 IP는 NAT를 통해 특정 포트만 안으로 넘어온다. 이 구조가 나중에 인증서 문제의 핵심이 된다.

## DB부터 옮겼다 - `@` 하나에 막히다

순서는 DB를 먼저 세우고, 덤프를 떠서 복원한 뒤, 앱이 새 DB를 보게 하는 것이었다. 코드도 스키마도 그대로고, 바뀌는 건 접속 문자열 하나였다.

덤프는 정석대로 커스텀 포맷으로 떴다.

```bash
pg_dump --schema=public --no-owner --no-acl -Fc "$SUPABASE_URL" > dump.fc
```

그런데 접속이 계속 이상하게 실패했다. Prisma는 같은 접속 문자열로 멀쩡히 붙는데, `pg_dump`만 안 됐다. 차이는 도구였다. Prisma는 URL을 느슨하게 파싱하지만, `pg_dump`가 쓰는 libpq는 URL을 엄격하게 파싱한다. 그리고 이 DB의 비밀번호에는 **리터럴 `@`가 들어 있었다.**

`postgresql://user:pa@ss@host` 같은 문자열에서 libpq는 `@`를 호스트 구분자로 읽어 엉뚱한 곳을 호스트로 잡는다. Prisma는 이걸 관대하게 넘겨서 여태 문제가 안 보였던 것이다. 한 문장으로: **비밀번호 속 `@`가 URL 파서를 속였고, 관대한 파서(Prisma)만 그걸 견디고 있었다.**

해결은 URL을 아예 안 쓰는 것이었다. 호스트·유저·DB를 따로 넘기고 비밀번호는 환경변수로 줬다.

```bash
PGPASSWORD="$PW" pg_restore -h "$HOST" -U "$USER" -d "$DBNAME" --no-owner --no-acl dump.fc
```

복원 중 "schema public already exists" 한 줄이 났지만 무해했다 - 데이터는 정상 적재됐고, 나중에 전 테이블 행 수를 대조해 20개 테이블이 양쪽 동일한 걸 확인했다.

## 앱은 섰는데 인증서가 안 나온다

앱 컨테이너를 올리고 Caddy로 HTTPS를 붙이려 했다. Caddyfile은 단순했다.

```
aicms.pusan.ac.kr {
    reverse_proxy localhost:3000
}
```

그런데 Let's Encrypt 인증서 발급이 계속 실패했다. 로그의 결정적 한 줄은 이거였다.

```
Timeout during connect (likely firewall problem)
```

처음엔 서버 설정을 의심했다. 방화벽(ufw)에 원래 2222·3000만 열려 있어서 80·443을 추가했다. 그래도 안 됐다. 여기서 초점을 **서버에서 네트워크로** 옮겼다. 서버 자체가 문제인지, 서버 바깥이 문제인지 격리해야 했다.

서버는 완전히 정상이었다. Caddy는 `:80`·`:443`을 리스닝 중이었고, 서버 안에서 `curl`로 치면 200이 떨어졌다. 하지만 **외부에서 그 80/443으로 들어오는 길이 막혀 있었다.** 공인 IP는 NAT로 서버에 매핑돼 있었지만, 인바운드 80/443이 실제로 안쪽까지 포워딩되지 않고 있었다. NAT 매핑이 있는 것과, 방화벽이 그 인바운드를 실제로 허용하는 것은 별개였다.

이건 내가 서버에서 고칠 수 있는 게 아니었다. 교내 정보화본부에 "공인 IP의 인바운드 80/443을 내부 서버로 실제 포워딩·허용해 달라"고 재확인을 요청했다. 그동안 중요한 건 **함부로 재시도하지 않는 것**이었다. Let's Encrypt는 실패에도 시간당 한도가 있어서, 포트가 열린 걸 확인하기 전엔 Caddy를 다시 돌리지 않았다. 포트가 열리자 `caddy` 재시작 한 번으로 인증서가 자동 발급됐다.

## 로그인이 "서버 구성 문제"라며 막힌다

도메인·HTTPS가 붙고 나서 로그인을 시도하니 이런 화면이 떴다.

> There is a problem with the server configuration

로그를 보니 원인은 `UntrustedHost`였다. Auth.js(NextAuth)는 프로덕션 모드에서 요청의 Host 헤더를 기본적으로 믿지 않는다. Vercel에선 이걸 알아서 신뢰해 주지만, 자체 호스팅 + 리버스 프록시 환경에선 명시해 줘야 한다.

```
AUTH_TRUST_HOST=true
```

이 한 줄을 서버 `.env`에 넣고 컨테이너를 재생성하자 로그인이 통과했다. 클라우드가 대신 해 주던 걸, 직접 호스팅하면 내가 켜 줘야 한다는 걸 이 지점에서 배웠다.

## 구글 OAuth 클라이언트가 안 보인다

마지막은 구글 로그인 콜백 URI 등록이었다. 새 도메인의 `…/api/auth/callback/google`을 OAuth 클라이언트에 추가해야 했는데, Google Cloud Console의 사용자 인증 정보 화면이 비어 있었다. 분명 이 클라이언트로 로그인이 되고 있는데 클라이언트가 안 보였다.

단서는 클라이언트 ID 앞자리였다. OAuth 클라이언트 ID의 접두 숫자는 그 클라이언트를 소유한 **프로젝트 번호**다. 그 번호가 내가 보고 있던 프로젝트가 아니라 다른 프로젝트를 가리켰다. 계정에 프로젝트가 여러 개였고, 클라이언트는 그중 다른 하나에 들어 있었다. 프로젝트를 그 번호로 찾아 들어가니 클라이언트가 있었고, 거기에 콜백을 등록했다.

## 검증과 롤백

이전을 끝내고도 Supabase를 바로 지우지 않았다. 운영 PII라 검증이 끝나기 전엔 되돌릴 지점을 남겨 둬야 했다. 전 테이블 행 수가 양쪽 동일한 걸 확인했고, 매일 새벽 DB를 덤프하는 백업 cron도 걸어 두고 나서, Supabase는 1-2주 관찰 기간을 둔 뒤에 정리하기로 했다.

## 교훈

- **클라우드가 대신 해 주던 걸, 직접 호스팅하면 하나씩 내가 켜야 한다.** Host 신뢰(`AUTH_TRUST_HOST`), TLS 발급, 인바운드 허용. 이전의 난이도는 앱을 옮기는 데 있지 않고, 클라우드가 조용히 처리하던 이 부수 조건들을 되짚는 데 있었다.
- **도구가 다르면 같은 문자열도 다르게 읽는다.** 비밀번호의 `@`는 Prisma에선 문제가 없었지만 libpq에선 아니었다. "여태 됐으니 이 값은 문제없다"가 항상 참은 아니다.
- **"서버가 정상"과 "밖에서 서버에 닿는다"는 다른 문제다.** 인증서 실패를 서버 설정으로만 보다가, 로컬 `curl`은 200인데 외부만 막힌다는 걸 확인하고 나서야 방화벽으로 초점을 옮겼다. 장애를 서버 안/밖으로 나눠 격리하는 게 이 문제의 열쇠였다.
- **실패에도 한도가 있는 자동화는 함부로 재시도하지 않는다.** Let's Encrypt rate limit 때문에, 근본 조건(포트)이 갖춰졌는지 확인하기 전엔 재발급을 누르지 않았다.

이 이전 뒤에 겪은 대시보드 파싱 회귀는 [멀쩡한 코드를 내가 고쳐서 깨뜨렸다](/blog/pnuaicms-xlsx-self-closing-cell/)에 따로 적었다.
