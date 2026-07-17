---
title: 'GPT는 언젠가 실패한다 - 감정 분석에 폴백을 깐 이유'
titleEn: 'The LLM will fail eventually - why I put a fallback under emotion analysis'
description: 'GPT-4o mini로 일기 감정을 분석하는 게 앱의 정중앙 기능이었다. 그런데 클라이언트가 안 뜨고, JSON을 달라 해도 JSON이 아닌 게 왔다. LLM 응답을 신뢰할 인프라로 취급하지 않기로 한 기록.'
descriptionEn: 'Emotion analysis with GPT-4o mini was the core of the app. But the client failed to init, and asking for JSON did not guarantee JSON. How I stopped treating an LLM response as reliable infrastructure.'
pubDate: 2025-07-27
tags: ['troubleshooting', 'llm', 'backend']
project: 'simlog'
draft: false
---

SimLog에서 사용자가 일기를 쓰면 GPT-4o mini가 그날의 감정을 분석해 색으로 돌려준다. 이게 앱의 정중앙 기능이다. 색이 곧 그날의 마음이고, 며칠째 어두운 색이 이어지면 상담을 권하는 흐름까지 여기서 시작된다. 그래서 감정 분석이 실패하면 사용자는 그냥 빈 화면을 본다. 정신건강 앱에서 "분석 중 오류가 발생했습니다"는 다른 앱에서보다 훨씬 나쁜 문장이다.

문제는 이 핵심 기능이 내가 통제할 수 없는 외부 API 위에 서 있다는 것이었다. 데모를 준비하면서 두 번 크게 데였고, 그때부터 LLM 응답을 "신뢰할 수 있는 인프라"로 취급하는 걸 그만뒀다.

## 환경

| | |
|---|---|
| 백엔드 | FastAPI · Python |
| AI | OpenAI GPT-4o mini |
| 배포 | Railway |

## 붙이는 건 쉬웠다

일기 텍스트를 프롬프트에 넣고, 플루치크 감정 바퀴의 8가지 중 하나로 분류해서 JSON으로만 답하라고 시켰다. 온도는 0.3으로 낮춰 흔들림을 줄였다.

```python
prompt = f"""
다음 텍스트의 감정을 로버트 플루치크의 감정의 바퀴 8가지 중에서 분석해주세요:
감정: 기쁨, 신뢰, 두려움, 놀람, 슬픔, 혐오, 분노, 기대

텍스트: {content}

반드시 다음 JSON 형태로만 응답해주세요. 다른 텍스트는 포함하지 마세요:
{{ "primary_emotion": "...", "intensity": 1-10, "confidence": 0.0-1.0, ... }}
"""
response = client.chat.completions.create(model="gpt-4o-mini", messages=[...], temperature=0.3)
result = json.loads(response.choices[0].message.content)
```

로컬에서는 잘 돌았다. 문제는 그 뒤였다.

## 첫 번째: 클라이언트가 아예 안 떴다

배포 환경에서 감정 분석을 처음 태웠더니, OpenAI 클라이언트를 만드는 `OpenAI(api_key=...)` 한 줄에서 `TypeError`가 났다. 에러 메시지에 `proxies`가 있었다. openai 파이썬 패키지 버전과 그 아래 http 클라이언트가 안 맞아서, 내가 넘기지도 않은 `proxies` 인자를 두고 생성자가 넘어지는 문제였다. 코드가 틀린 게 아니라, 같은 requirements로 깔았는데도 환경에 따라 초기화가 깨졌다.

처음엔 내 코드에서 뭘 잘못 넘겼나 한참 봤다. 아무것도 안 넘기고 있었다. 결국 클라이언트 생성을 방어적으로 감쌌다. 기본 생성이 `proxies` 때문에 실패하면, 명시적으로 `base_url`을 줘서 다시 만든다.

```python
try:
    client = OpenAI(api_key=api_key)
except TypeError as e:
    if "proxies" in str(e):
        client = OpenAI(api_key=api_key, base_url="https://api.openai.com/v1")
    else:
        raise
```

깔끔한 해결은 아니다. 근본은 패키지 버전 핀이었겠지만, 데모가 며칠 안 남은 상황에서 "어느 환경에서든 일단 뜨게" 만드는 게 먼저였다. 이 지점에서 배운 게 하나 있다. 외부 SDK의 초기화조차 항상 성공한다고 믿으면 안 된다는 것.

## 두 번째: JSON을 달라 했는데 JSON이 아니었다

클라이언트가 뜬 뒤에도 가끔 `json.loads`가 터졌다. "JSON만, 다른 텍스트 포함하지 말라"고 분명히 시켰는데도 모델은 이따금 설명 문장을 앞에 붙이거나 코드펜스로 감쌌다. 대부분은 시키는 대로 하니까 로컬에서는 안 보이다가, 표본이 늘면 반드시 나오는 종류의 실패였다.

감정 분석 본체는 파싱 실패를 `None`으로 떨어뜨려 폴백으로 넘기게 했지만, 키워드 추출에서는 그걸로 부족했다. 키워드는 배열로 오는데 형식이 더 자주 흔들려서, 파싱을 3단으로 쌓았다. `json.loads`를 먼저 시도하고, 실패하면 본문에서 정규식으로 JSON 객체만 긁어내고, 그것도 안 되면 쉼표로 쪼갠다.

```python
try:
    kws = json.loads(raw).get("keywords", [])
except Exception:
    m = re.search(r"\{[\s\S]*\}", raw)      # 본문에 섞인 JSON만 추출
    kws = json.loads(m.group(0)).get("keywords", []) if m else []
if not kws and raw:
    kws = [k.strip() for k in raw.split(',') if k.strip()]   # 최후의 수단
```

LLM에게 형식을 지시하는 것과 LLM이 형식을 지킨다는 것은 다른 얘기였다. 지시는 확률을 높일 뿐 보장하지 않는다.

## 그래서 실패를 정상 경로에 넣었다

두 사건을 겪고 나니 결론은 하나였다. **감정 분석은 GPT가 성공했을 때의 경로와 실패했을 때의 경로, 둘 다 있어야 한다.** GPT가 죽어도 앱은 무언가를 돌려줘야 하니까.

그래서 API 키가 없거나, 클라이언트가 안 뜨거나, JSON 파싱이 깨지면 전부 키워드 기반 분석으로 폴백하게 했다. 부정·긍정 감정 키워드 사전으로 텍스트를 스캔해 점수를 매기고, 더 높은 쪽에서 세부 감정을 고른다. 정교하진 않지만 항상 답을 낸다.

```python
def analyze_emotion_with_ai(content: str) -> Dict:
    result = analyze_emotion_with_gpt4o(content)   # 1순위: GPT-4o mini
    if result:
        return _convert_ai_result_to_color(result)

    fallback = analyze_emotion_fallback(content)   # 실패 시: 키워드 분석
    fallback["ai_failed"] = True
    fallback["error_message"] = "AI API 호출에 실패하여 키워드 기반 분석을 사용했습니다."
    return fallback
```

그리고 응답에 `ai_used`·`ai_failed` 플래그를 실었다. 폴백 결과는 `confidence`를 0.6으로 낮춰, 이게 확신에 찬 분석이 아니라는 걸 데이터 자체에 남겼다. 나중에 "이 사용자는 GPT 경로였나 폴백이었나"를 로그에서 되짚을 수 있게 하려는 목적도 있었다.

## 배운 것

이 앱을 만들기 전에는 "GPT를 붙인다"를 그냥 API 호출 하나로 생각했다. 붙이고 나니 그건 절반이었다. 나머지 절반은 GPT가 실패할 때 무슨 일이 벌어지느냐였다.

- 외부 SDK는 초기화부터 실패할 수 있다. 내 코드가 멀쩡해도.
- "JSON으로 답해줘"는 요청이지 계약이 아니다. 파싱은 언제나 깨질 수 있다고 보고 짜야 한다.
- 핵심 기능이 외부 AI 위에 있다면, 폴백은 나중에 붙이는 예외 처리가 아니라 처음부터 있는 정상 경로다.

완벽한 감정 분석보다, 실패해도 항상 무언가는 돌려주는 쪽이 정신건강 앱에는 맞았다. 이건 [SimLog](/projects/simlog/) 백엔드를 처음부터 혼자 만들며 얻은, 꽤 오래 남을 감각이다.
