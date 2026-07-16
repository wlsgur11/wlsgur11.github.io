---
title: '백업 없는 HA는 HA가 아니었다 — CNPG WAL 폭주 이후 Longhorn/CNPG 복구기'
titleEn: "HA without backups isn't HA — recovering a CNPG/Longhorn cluster after a WAL runaway"
description: 'WAL이 디스크를 채워 PostgreSQL이 뜨지 않았다. 원인은 저용량 노드의 죽은 standby가 replication slot으로 WAL을 붙잡은 것. CNPG·Longhorn·노드 장치를 계층별로 나눠 replica 축소→dangling PVC→Pod 정리→multipathd 제거→물리 디스크 추가 순으로 복구한 기록.'
descriptionEn: 'WAL filled the disk and PostgreSQL would not start. A dead standby on a low-capacity node had pinned WAL through its replication slot. A layered recovery across CNPG, Longhorn, and node devices — and why "HA" without backups was never HA.'
pubDate: 2026-04-27
tags: ['troubleshooting', 'infra', 'kubernetes', 'database']
project: 'code-place'
draft: false
---

> Code Place의 PostgreSQL이 어느 날 뜨지 않았다. CNPG는 "low-disk", "system ID를 보고하지 못했다"는 메시지를 뱉었다. 처음엔 DB가 깨진 줄 알았지만, 시작점은 **WAL 폭주로 인한 디스크 압박**이었다. 저용량 노드의 죽은 standby가 replication slot으로 primary의 WAL을 무한정 붙잡은 게 근본 원인이었다. Pod를 성급히 재시작하는 대신 CNPG·Longhorn·노드 장치를 계층별로 나눠, replica 축소 → PVC 복구 → Pod 정리 → `multipathd` 제거 → 물리 디스크 추가 순으로 복구했다. 그리고 **백업이 없다**는 사실이 이 사고의 크기를 정했다. 이 사건은 팀과 함께 대응했고, 인프라 담당인 준영이 특히 많은 부분을 이끌었다.

## 사건

운영 중 PostgreSQL 인스턴스가 정상적으로 뜨지 않았다. CNPG 상태 메시지는 이랬다.

```
Detected low-disk space condition, avoid starting the instance
Waiting for the instances to become active
Instances are present, but none have reported a system ID
```

거기에 상황에 따라 dangling PVC처럼 보이는 상태까지 겹쳤다. 처음 보면 "PostgreSQL 인스턴스 자체가 깨졌다"고 읽기 쉬운 메시지다. 나도 처음엔 DB 내부 손상을 의심했다.

하지만 바로 Pod를 재시작하거나 오퍼레이터를 다시 올리지는 않았다. **원인을 모른 채 재시작하면 증상만 바뀔** 수 있기 때문이다. 이번 장애는 WAL 증가로 서버 용량이 부족해진 뒤 시작됐으므로, "DB가 왜 안 뜨지?"가 아니라 "DB가 뜨기 위한 스토리지 조건이 아직 맞는가?"부터 봐야 했다.

## 환경

- **오케스트레이션**: k3s, 물리 노드 3대 (그중 3번은 디스크가 빠듯한 저용량 워크스테이션)
- **DB**: CloudNativePG(CNPG), `instances: 3` (primary 1 + standby 2), PostgreSQL 14.12
- **스토리지**: Longhorn. 문제의 노드에선 **데이터와 WAL이 같은 볼륨**을 썼다.

이 조합은 평소엔 역할이 나뉘지만, 한 번 문제가 생기면 확인할 곳이 많다. DB가 안 뜬다고 DB만 봐선 안 됐다. Kubernetes 이벤트, PVC, Longhorn 볼륨, 실제 노드의 장치 상태까지 함께 봐야 했다. 특히 Longhorn replica 구성을 유지하려면 각 노드에 **실제 물리 디스크 여유**가 있어야 하는데, PVC나 볼륨을 늘려도 노드 용량이 못 따라오면 replica를 다시 붙이기 어렵다.

## 계층을 나눠서 봤다

장애를 "DB 문제" 하나로 묶지 않고 나눠서 확인했다.

- **CNPG**: 클러스터 상태 메시지, primary/replica 인식, 인스턴스 활성화 여부
- **Kubernetes**: Pod 이벤트, PVC 상태, volume attachment, mount 실패 여부
- **Longhorn**: replica 상태, 볼륨 확장, share-manager, 디스크 스케줄링 가능 여부
- **노드/리눅스**: 실제 mount 충돌, 장치 사용 상태, `multipathd` 같은 시스템 프로세스 간섭
- **PostgreSQL**: replication slot, WAL 유지 상태

이렇게 나누자 CNPG 메시지는 원인이라기보다 **결과**일 수 있다는 게 보였다. "system ID를 보고하지 못했다"는 건 인스턴스가 정상 기동까지 못 갔다는 뜻이지, 반드시 내부 손상은 아니다. 데이터를 올릴 스토리지가 정상 연결되지 않아 기동이 멈췄을 수도 있다. 그래서 "왜 깨졌지"가 아니라 "왜 여기서 멈췄지"로 봤다.

## 근본 원인 — 죽은 standby의 replication slot

스토리지를 파고들자 단서가 늘었다. WAL이 계속 쌓여 디스크 여유가 빠르게 줄었는데, standby 하나는 이미 며칠 전부터 디스크가 차서 replication이 멈춰 있었다.

여기서 replication slot을 짚어야 한다. CNPG는 각 standby마다 slot을 만든다. slot은 "이 standby가 아직 안 받아간 WAL은 지우지 말라"고 primary에 강제한다. standby가 잠깐 끊겼다 돌아와도 따라잡게 해 주는 안전장치다. 그런데 **standby가 며칠째 죽어 있으면**, primary는 죽은 소비자를 하염없이 기다리며 WAL을 하나도 못 지운다.

```sql
-- primary에서: inactive인데 WAL을 붙잡고 있는 slot 찾기
SELECT slot_name, active, wal_status,
       pg_size_pretty(pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)) AS retained
FROM pg_replication_slots;
```

`active=false`인데 `retained`가 수십 GB인 slot이 저용량 3번 노드의 죽은 standby 것이었다. WAL은 데이터와 같은 볼륨을 썼기 때문에, 이 WAL 더미가 그대로 DB 볼륨을 잠식했다. 한 문장으로: **죽은 소비자를 위한 안전장치가, 소비자가 죽은 뒤엔 그대로 폭탄이 됐다.**

## 복구 타임라인

성급한 재시작 대신, 오퍼레이터가 다시 정상으로 볼 수 있는 조건을 만드는 쪽으로 갔다.

1. **replica 3 → 2로 축소.** 3번 노드의 여유가 부족해 replica 3 구성을 그대로 유지할 수 없었다. Longhorn에서 3번 노드를 배제하고 replica를 2로 줄였다. 전부 맞추기보다 **먼저 살아날 수 있는 구성**을 만드는 선택이었다.
2. **용량 확보 후 PVC 복구.** 그런데 PVC가 복구됐다고 CNPG가 곧바로 인스턴스를 살리지는 않았다. 한 번 dangling PVC처럼 본 대상은 단순 재시작만으로 정상 후보로 다시 채택되지 않았다. **"리소스가 존재한다"와 "오퍼레이터가 그걸 정상 후보로 재채택한다"는 다른 문제**였다.
3. **Pod 정리.** 남아 있던 1·3번 Pod가 있는 상태에선 CNPG가 원하는 방향으로 reconciliation을 진행하지 않았다. 나머지 Pod를 정리하자 그제서야 2번 인스턴스를 기준으로 복구가 시작됐다.
4. **mount error → `multipathd` 제거.** 2번을 살리는 중 mount error가 다시 났다. 이건 CNPG·PostgreSQL만 봐선 안 풀렸다. 노드로 내려가니 호스트의 `multipathd`가 Longhorn이 써야 할 블록 장치를 건드리고 있었다. `multipathd`를 중지·비활성화하고 다시 mount하자 풀렸다. 중간에 노드 재부팅도 있었지만, 결정적 조치는 재부팅이 아니라 `multipathd` 간섭 제거였다 — "다시 켜니 됐다"로 정리하지 않은 이유다.
5. **1번 복구, 3번은 물리 디스크 추가.** 1번은 정상 복구됐지만, 3번은 앞서 볼륨을 확장한 탓에 필요한 물리 용량을 못 채웠다. 3번 노드에 빈 디스크를 새로 마운트해 Longhorn 디스크로 추가하고 나서야 3번까지 복구해 replica 3 구성을 되찾았다.
6. **slot·WAL 정리.** 장애의 시작이 WAL이었으니, 복구 후에도 불필요한 replication slot이 남아 WAL을 다시 붙잡지 않는지 확인했다.

### 연결이 되는데 INSERT만 실패한다면

복구 후엔 애플리케이션이 **쓰기 가능한 primary**에 붙는지도 확인했다. CNPG는 역할별 서비스를 따로 만든다 — `-rw`(primary), `-ro`(replica), `-r`(읽기 계열). 이 구분을 놓치면 `cannot execute INSERT in a read-only transaction`를 보고 `@Transactional(readOnly=true)`부터 의심하기 쉽지만, 실제론 read-only replica에 붙은 결과일 수 있다.

```sql
SELECT pg_is_in_recovery();  -- true면 지금 붙은 대상은 standby(읽기전용)
```

## 백업의 부재

클러스터는 위 과정을 거쳐 되살렸다. 하지만 이 사고에서 가장 뼈아팠던 건 따로 있었다 — **백업이 없었다.** CNPG 매니페스트에 `backup`도, WAL을 별도 스토리지에 아카이빙하는 구성도 없었다. 특정 시점으로 되돌리는 PITR(Point-in-Time Recovery) 자체가 불가능했다. 인스턴스를 살려 서비스는 복구했지만, 되돌릴 지점이 없다는 건 "이번엔 운이 좋았다"는 뜻이었다. slot 하나가 조금만 더 오래 방치됐어도 잃을 게 훨씬 컸다.

## 재발 방지

우선순위대로 정리했다. (전부 적용 완료는 아니고, 순서가 곧 우선순위다.)

1. **백업/WAL 아카이빙(barman → 오브젝트 스토리지).** 이게 있어야 애초에 PITR이 가능하다. 다른 무엇보다 먼저다.
2. **`max_slot_wal_keep_size`.** slot이 붙잡을 수 있는 WAL 총량에 상한을 둔다. 죽은 standby 하나가 디스크 전체를 볼모로 잡지 못하게. 뒤처진 standby는 재동기화가 필요해지지만, primary가 죽는 것보다 낫다.
3. **WAL 전용 볼륨 분리(`walStorage`).** WAL이 폭주해도 데이터 볼륨까지 끌고 들어가지 않게 격리한다.
4. **노드 재부팅 절차 고정.** Longhorn 스케줄 비활성화 → replica evict → CNPG switchover로 primary를 먼저 옮긴 뒤 `kubectl drain`, 그다음 물리 재부팅. 강제 종료 금지.
5. **디스크·WAL 사용률 알림.** WAL이 조용히 차오르는 걸 사람이 못 본 게 시작이었다. `cnpg_collector_*` 지표로 임계 알림을 건다.

## 교훈

- **백업 없는 HA는 HA가 아니다.** 복제는 가용성이지 복구가 아니다. 복제본이 세 개여도 되돌릴 지점이 없으면, 잘못된 순간에 잘못된 복제본이 기준이 되는 즉시 데이터는 사라진다.
- **안전장치도 방치되면 흉기가 된다.** replication slot은 standby를 지키려 WAL을 붙잡지만, standby가 영영 안 돌아오면 그 배려가 primary를 죽인다. 자동 회복 장치일수록 **회복을 포기할 선**(`max_slot_wal_keep_size`)을 같이 정해 둬야 했다.
- **오퍼레이터 상태 ≠ 실제 원인.** CNPG도 Longhorn도 많은 걸 자동화하지만, 복구 땐 "리소스가 존재한다"와 "오퍼레이터가 정상 후보로 재채택한다"를 나눠 봐야 했다.

같은 클러스터에서 겪은 다른 재부팅 사고는 [운영 백엔드가 398번 재시작한 이유](/blog/code-place-crashloop-398/)에 따로 적어 뒀다.
