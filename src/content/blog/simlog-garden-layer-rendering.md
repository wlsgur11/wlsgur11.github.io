---
title: '정원에 물고기가 가라앉았다 - 마음정원의 레이어 렌더링'
titleEn: 'The fish sank into the garden - layer rendering in the mind garden'
description: '흙 위에 꽃을 심고, 연못 안에 물고기를 넣는 정원. 평면 좌표만으로는 무엇이 무엇을 덮을지 정해지지 않았다. 각 아이템에 정수 레이어를 부여하고 정렬해 Stack으로 쌓은 이야기.'
descriptionEn: 'A garden where flowers sit on soil and fish swim in a pond. Flat coordinates could not decide what covers what. How I assigned each item an integer layer, sorted, and stacked them.'
pubDate: 2025-08-06
tags: ['troubleshooting', 'frontend']
project: 'simlog'
draft: false
---

SimLog에는 마음정원이 있다. 매일 출석하면 씨앗을 주고, 그 씨앗으로 상점에서 꽃·울타리·연못·물고기 같은 아이템을 사서 6×12 그리드 정원에 배치하는 게임형 시스템이다. 지루한 마음 건강 관리를 매일 돌아올 이유로 바꾸려는 장치였다.

기능 자체는 간단해 보였다. 아이템을 사서, 원하는 칸에 놓는다. 그런데 "놓는다"를 구현하면서, 앱을 처음 만드는 나로선 예상 못 한 벽에 부딪혔다. 같은 칸에 여러 개가 겹칠 때, 무엇이 무엇을 덮어야 하는가.

## 흙 위의 꽃, 연못 속의 물고기

정원은 평면이 아니다. 정확히는, 평면인데 평면처럼 보이면 안 됐다.

흙이 깔린 칸 위에 꽃이 자라야 하고, 연못 칸 안에는 물고기가 헤엄쳐야 한다. 울타리는 그 앞을 지난다. 이걸 그냥 배치한 순서대로 그렸더니, 나중에 놓은 흙이 먼저 놓은 꽃을 덮고, 물고기가 연못 뒤로 가라앉았다. 물속에 있어야 할 물고기가 물 밑으로 사라지는 화면은, 게임으로서 그냥 고장이었다.

`position_x`, `position_y`만으로는 이 문제가 안 풀린다. 좌표는 "어느 칸에 있나"를 말해줄 뿐, "누가 위에 있나"는 말해주지 않는다. 나에게 필요한 건 z축, 즉 쌓이는 순서였다.

## 각 아이템에 층을 부여하기

해결의 방향은 단순하게 잡았다. 아이템마다 정수 레이어 값을 하나씩 주고, 그릴 때 그 값으로 정렬해 낮은 것부터 쌓는다. DB의 아이템 레코드에 `layer` 컬럼을 뒀다.

```
layer 0: 배경 (잔디·모래·흙)
layer 1: 물 (연못·시냇물·분수), 돌담·벽돌, 연못 테두리
layer 2: 식물·구조물 (꽃·나무·부시·채소, 울타리·다리·벤치·문)
layer 3: 동물 (물고기·새·나비)
```

레이어는 아이템을 배치하는 순간, 이름을 보고 카테고리로 정해진다. 백엔드에서 `equip` 할 때 아이템 이름을 훑어 층을 결정하는 함수를 뒀다.

```python
def _get_item_layer(item_name: str) -> int:
    if any(bg in item_name for bg in ['잔디', '모래', '흙']):
        return 0
    if any(w in item_name for w in ['연못', '물', '시냇물', '분수']):
        return 1
    if any(d in item_name for d in ['울타리', '다리', '벤치', '문']):
        return 2
    if '물고기' in item_name:
        return 3   # 물고기를 가장 앞으로 - 연못 위에 떠 보이게
    ...
    return 2       # 식물 등 기본값
```

이 함수를 짜는 과정 자체가 정원의 규칙을 정하는 일이었다. 처음엔 물고기도 다른 식물과 같은 층에 뒀는데, 그러면 배치 순서에 따라 물고기가 연못 테두리 뒤로 밀렸다. 그래서 물고기만 레이어 3으로 따로 올려 "항상 물 위에 떠 보이게" 못박았다. 연못 테두리는 물의 일부로 봐서 물과 같은 레이어 1에 뒀다. 돌담·벽돌은 식물보다 뒤에 있어야 해서 중간 층으로 내렸다. 이런 결정들이 코드의 분기 하나하나로 남았다.

## 그리는 쪽: 정렬하고 Stack

프론트(Flutter)에서는 각 그리드 칸을 그릴 때, 그 칸에 배치된 아이템을 모아 레이어로 정렬한 뒤 `Stack`으로 쌓는다. `Stack`은 자식들을 그려진 순서대로 위에 얹으니까, 레이어 오름차순으로 정렬해서 넣으면 낮은 층이 아래로 깔린다.

```dart
Widget _buildGridCell(int x, int y) {
  final itemsAtPosition = _gardenItems
      .where((it) => it.position_x == x && it.position_y == y && it.is_equipped)
      .toList();

  // 레이어 순서대로 정렬 (0: 배경 → 3: 동물)
  itemsAtPosition.sort((a, b) => a.layer.compareTo(b.layer));

  return Stack(
    children: itemsAtPosition.map((it) => _buildItemImage(it)).toList(),
  );
}
```

좌표와 레이어의 역할을 나눈 게 핵심이었다. `position_x`/`position_y`는 어디에 놓일지, `layer`는 누가 누구를 덮을지. 이렇게 분리하고 나니, 새 아이템을 추가할 때도 "이건 어느 층이지"만 정하면 나머지는 정렬이 알아서 처리했다.

## 정직하게, 한계

이 방식엔 뻔한 약점이 있다. 레이어를 **아이템 이름 문자열로** 정한다는 것. `'물고기'`가 이름에 들어있으면 3층, 이런 식이라 이름 규칙이 깨지면 층도 어긋난다. 실제로 "연못"과 "연못 테두리"를 구분하느라 조건 순서를 신경 써야 했다. 제대로 하려면 아이템 템플릿에 카테고리·레이어를 데이터로 갖고 이름 매칭을 없애는 게 맞다. 해커톤 기간 안에서는 이름 기반 휴리스틱이 빠르고 충분히 돌아가서 그대로 갔지만, 규모가 커지면 가장 먼저 갈아엎을 부분이다.

## 배운 것

2D 그리드라고 다 평면인 건 아니었다. 겹치는 순간 z축이 생기고, 그걸 명시적으로 관리하지 않으면 "먼저 그린 게 뒤로 간다"는 우연에 화면을 맡기게 된다. 정수 레이어 하나로 그 우연을 규칙으로 바꾼 게 이 기능의 전부이자 핵심이었다.

처음 만든 앱이라 이런 기초적인 렌더링 순서 문제조차 직접 부딪히며 배웠다. [SimLog](/projects/simlog/)에서 겪은, 작지만 오래 기억에 남는 문제였다.
