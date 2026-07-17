---
title: '링크 하나가 곧 열쇠였다 - 7일 일기 요약을 안전하게 공유하기'
titleEn: 'The link itself was the key - sharing a 7-day journal summary safely'
description: '부정 감정이 오래 이어진 사용자의 7일 일기를 상담사에게 넘겨야 했다. 상담사는 앱 계정이 없으니 링크만으로 열려야 했고, 그래서 링크가 곧 자격증명이 됐다. 토큰을 해시로만 저장하고 스냅샷으로 굳힌 이야기.'
descriptionEn: 'I had to hand a struggling user’s 7-day journal to a counselor who has no app account - so the link itself became the credential. Storing only a token hash and freezing the data into a snapshot.'
pubDate: 2025-08-11
tags: ['troubleshooting', 'backend']
project: 'simlog'
draft: false
---

SimLog는 부정적인 감정이 7일간 이어지면 상담을 권한다. 그런데 상담이 실제로 도움이 되려면, 상담사가 그 사용자의 최근 마음 상태를 볼 수 있어야 했다. 그래서 7일치 일기를 요약해 상담사에게 공유하는 기능을 만들었다.

이 기능을 짜기 시작하면서 곧바로 걸린 게 있다. 감정 일기는 내가 다루던 데이터 중 가장 사적인 것이었다. 상담사에게 넘어가는 그 한 번의 순간을, 사용자가 온전히 통제해야 했다. 기능을 어떻게 만드느냐보다 **누가, 언제, 무엇을 볼 수 있느냐**를 먼저 정해야 하는 문제였다.

## 제약: 상담사는 앱 계정이 없다

가장 먼저 마주한 현실적 제약이 설계를 거의 결정했다. 상담사(효원상담원)는 SimLog 사용자가 아니다. 계정도, 로그인도 없다. 그러니 "로그인한 상담사에게만 보여준다"는 흔한 방식을 쓸 수 없었다. 상담사가 가진 건 사용자가 건넨 **링크 하나**뿐이다.

즉 이 시스템에서는 **링크 자체가 곧 자격증명**이다. 링크를 아는 사람은 그 요약을 볼 수 있다. 실제로 공유 요약을 가져오는 엔드포인트는 인증 없이 열려 있다.

```python
@router.get("/shared/{token}")   # 인증 의존성 없음 - 링크만 있으면 조회
def get_shared_report(token: str, db: Session = Depends(get_db)):
    return ReportService.get_shared_report(db, token)
```

이렇게 열어두는 순간, 몇 가지가 반드시 참이어야 했다. 토큰은 추측할 수 없어야 하고, 서버 DB가 새더라도 링크가 통째로 털리면 안 되며, 사용자가 마음을 바꾸면 즉시 막을 수 있어야 했다.

## 토큰은 원문을 저장하지 않는다

먼저 토큰은 추측 불가능하게 만들었다. `secrets.token_urlsafe(32)`로 URL-safe 난수를 뽑는다.

그다음이 핵심인데, **DB에는 토큰 원문을 저장하지 않았다.** 대신 SHA-256 해시만 저장하고, 원문 토큰은 발급 응답으로 딱 한 번 돌려준다. 비밀번호를 평문이 아니라 해시로 저장하는 것과 같은 이유다.

```python
token = secrets.token_urlsafe(32)          # 원문 - 응답에 한 번만 실려 나간다
token_digest = sha256(token.encode()).hexdigest()   # DB엔 이 해시만
```

이렇게 하면 서버 DB가 통째로 유출돼도, 공격자가 손에 쥐는 건 SHA-256 해시들이다. 그걸로는 원문 토큰을 되살릴 수 없으니 유효한 공유 링크를 만들 수 없다. 조회가 인증 없이 열려 있는 시스템에서, 이건 타협할 수 없는 부분이었다.

조회는 이렇게 돈다. 들어온 토큰을 서버가 같은 방식으로 해싱해 저장된 digest와 대조하고, 취소·만료를 확인한 뒤에야 데이터를 내준다.

```python
def get_shared_report(db, token):
    digest = sha256(token.encode()).hexdigest()
    share = db.query(SharedReport).filter(token_digest == digest).first()
    if not share or share.revoked:
        raise ValueError("유효하지 않은 링크입니다.")
    if share.expires_at < now:
        raise ValueError("만료된 링크입니다.")
    return share.snapshot
```

## 스냅샷: 공유한 건 그 순간의 마음이다

두 번째 결정은 무엇을 저장하느냐였다. 처음엔 "토큰을 사용자에 연결해두고, 조회할 때 그 사용자의 최근 7일을 계산해서 보여주면 되지 않나" 싶었다. 그런데 이게 위험했다.

만약 그런 식이라면, 사용자가 오늘 링크를 공유한 뒤 내일 새 일기를 쓰거나 과거 일기를 지우면, 상담사가 보는 내용이 사용자 모르게 바뀐다. 사용자가 동의한 건 "오늘 시점의 내 7일"이지, "언제 열든 그때의 최근 7일"이 아니다. 동의의 범위가 시간에 따라 흘러버리는 셈이다.

그래서 공유를 만드는 순간의 7일 요약을 **스냅샷으로 굳혀** 저장했다. 각 날짜의 요약과 주감정, 부정 감정 비율, 한 줄 요약을 그 시점 그대로 박제한다.

```python
snapshot = {
    "period": 7,
    "items": items,                    # 날짜별 {요약, 주감정}
    "one_line_summary": one_line_summary,
    "negative_ratio": negative_ratio,  # 부정 감정 비율
    "generated_at": now.isoformat(),
}
share = SharedReport(user_id=user_id, token_digest=token_digest,
                     snapshot=snapshot, expires_at=..., revoked=False)
```

원본 일기가 나중에 바뀌거나 지워져도, 상담사가 보는 건 동의한 그 순간의 스냅샷이다. 데이터의 의미와 동의의 범위가 시간이 지나도 어긋나지 않는다.

## 되돌릴 수 있게: 동의와 취소

마지막은 통제권이었다. 공유는 사용자가 명시적으로 동의(consent)해야만 만들어진다. 동의하지 않은 상태로 공유를 요청하면 403으로 막힌다.

```python
if not consent_info["consented"]:
    raise ValueError("사용자가 공유에 동의하지 않았습니다.")   # → 403
```

그리고 한 번 만든 링크도 언제든 취소(revoke)할 수 있다. 취소하면 `revoked` 플래그가 서고, 그 뒤로는 같은 링크로 조회해도 열리지 않는다. 만료일(발급 후 7일)도 함께 걸어, 잊고 방치된 링크가 영원히 살아있지 않게 했다. 마음 체크 화면의 알림 모달도 "동의 없이 바로가기 / 동의하고 바로가기"로 갈라, 상담 연결이라는 행동과 내 데이터를 넘긴다는 행동을 분리했다.

## 남은 함정 하나

구현하며 만난 사소하지만 짜증났던 지점: MySQL이 timezone-aware datetime을 그대로 안 받아줬다. 그래서 만료 시각을 UTC 기준 naive datetime으로 변환해 저장하고, 조회할 때 다시 aware로 되돌려 비교했다. 시간대는 늘 이런 데서 발을 건다.

## 배운 것

이 기능에서 코드를 짠 시간보다 "무엇을, 언제, 누구에게"를 정하는 데 쓴 시간이 길었다. 그리고 그게 맞았다고 생각한다. 민감한 도메인에서는 기능보다 통제권 설계가 먼저다.

- 링크가 곧 자격증명이 되는 구조라면, 토큰은 추측 불가능해야 하고 원문을 저장하면 안 된다.
- 공유는 시점을 박제해야 한다. 안 그러면 동의의 범위가 사용자 모르게 흘러간다.
- 넘긴 것을 되돌릴 수 있어야(취소·만료) 사용자가 진짜로 통제권을 쥔다.

감정 일기 같은 데이터는 한 번 새면 되돌릴 수 없다. 그래서 [SimLog](/projects/simlog/)에서 이 부분만큼은, 기능을 얹기 전에 안전장치부터 세우고 시작했다.
